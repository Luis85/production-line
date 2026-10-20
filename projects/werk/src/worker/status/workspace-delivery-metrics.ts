import type { FeatureRequests } from '../application/feature-requests.js';
import type { SharedFeatureIntake } from '../application/shared-feature-intake.js';
import type { FeatureIntakeMeasurement } from '../application/feature-intake-measurement.js';
import { deliveryIntakeRunIds, findDeliveryMetricIntake, deliverySubmissionTime } from '../application/delivery-metric-intake.js';
import { object, identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import { buildDeliveryMetrics, isDeliveryMetricsRequest } from '../application/delivery-metrics.js';
import type { DeliveryMetricsInput, DeliveryMetricsQuery } from '../application/delivery-metrics-contracts.js';
import type { RequestEvent, WorkerRequest } from '../application/request-gates.js';
import type { WorkerRun } from '../application/run-evidence.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Complete retained histories, with explicit refusal instead of silently truncated denominators. */
export function deliveryMetrics(workspace: WorkspaceContext, input: unknown) {
  const body = object(input, 'Delivery metrics query', ['action', 'since', 'until', 'projectId', 'profileId']);
  if (body.action !== 'metrics') throw new DomainError('invalid_input', 'Use the metrics action.');
  const query: DeliveryMetricsQuery = {};
  for (const key of ['since', 'until'] as const) if (body[key] !== undefined) {
    const value = body[key];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new DomainError('invalid_input', 'Metrics dates must be ISO timestamps with a timezone.');
    query[key] = new Date(value).toISOString();
  }
  for (const key of ['projectId', 'profileId'] as const) if (body[key] !== undefined) query[key] = identifier(body[key], key);
  const capturedAt = new Date().toISOString();
  if (query.since && Date.parse(query.since) > Math.min(Date.parse(query.until ?? capturedAt), Date.parse(capturedAt))) throw new DomainError('invalid_input', 'The metrics start must precede its end.');
  const gates = workspace.sessions.requests, requests: WorkerRequest[] = [], events: RequestEvent[] = [], runs: WorkerRun[] = [];
  let bytes = 0;
  const bounded = (value: unknown) => { bytes += Buffer.byteLength(JSON.stringify(value)); if (bytes > 67108864) throw new DomainError('conflict', 'This metrics query exceeds the 64 MiB analysis limit. Select a shorter submission window or one project; no partial rate was returned.'); };
  const relevant = (value: { projectId: string | null; profileId: string | null }, submittedAt: number | null) => (!query.projectId || value.projectId === query.projectId) && (!query.profileId || value.profileId === query.profileId)
    && (submittedAt === null || (!query.since || submittedAt >= Date.parse(query.since)) && submittedAt <= Date.parse(query.until ?? capturedAt));
  const allIntake: FeatureIntakeMeasurement[] = workspace.featureProjects?.all().flatMap(project => {
    const features: FeatureRequests | undefined = project.features, shared: SharedFeatureIntake = project.sharedRuntime.intake;
    return [...(features?.measurements() ?? []), ...shared.measurements()];
  }) ?? [];
  const intake = allIntake.filter(item => relevant(item, deliverySubmissionTime(undefined, item)));
  bounded(intake);
  let after = 0;
  for (;;) {
    const page = gates.list({ after, limit: 100 });
    for (const row of page.requests) {
      const request = gates.get(row.id);
      if (!isDeliveryMetricsRequest(request, allIntake)) continue;
      const source = findDeliveryMetricIntake(request, allIntake), context = request.input.context as { repositoryId?: string; deliveryPolicy?: { profile?: { id?: string } } } | undefined;
      if (!relevant({ projectId: context?.repositoryId ?? source?.projectId ?? null, profileId: context?.deliveryPolicy?.profile?.id ?? source?.profileId ?? null }, deliverySubmissionTime(request, source))) continue;
      if (source && !intake.some(item => item.feature.key === source.feature.key)) { bounded(source); intake.push(source); }
      bounded(request); requests.push(request);
      let eventAfter = 0;
      for (;;) {
        const history = gates.events(request.id, eventAfter, 100);
        bounded(history.events); events.push(...history.events);
        if (!history.hasMore) break;
        eventAfter = history.nextAfter;
      }
    }
    if (!page.hasMore) break;
    after = page.nextAfter;
  }
  const intakeRunIds = new Set(intake.flatMap(item => deliveryIntakeRunIds(item, Date.parse(query.until ?? capturedAt))));
  const selected = new Set(requests.map(request => request.id)), sessions = new Set(requests.map(request => request.owner.sessionId));
  let cursor: string | undefined;
  if (requests.length || intakeRunIds.size) for (;;) {
    const page = workspace.sessions.runs.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const run of page.rows) if (intakeRunIds.has(run.id) || (run.requestId ? selected.has(run.requestId) : sessions.has(run.sessionId))) { bounded(run); runs.push(run); }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const evidence: DeliveryMetricsInput = { requests, events, runs, intake, completeRequestIds: requests.map(request => request.id) };
  return buildDeliveryMetrics(evidence, query, capturedAt);
}
