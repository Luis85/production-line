import type { FeatureIntakeMeasurement } from './feature-intake-measurement.js';
import { deliverySubmissionTime, findDeliveryMetricIntake } from './delivery-metric-intake.js';
import { isDeliveryMetricsRequest } from './delivery-metrics.js';
import { deliveryCompletion } from './delivery-completion.js';
import type { DeliveryRun } from './delivery-contracts.js';
import type { WorkerRequest, RequestEvent } from './request-gates.js';
import type { DeliveryMetricsInput, DeliveryMetricDistribution } from './delivery-metrics-contracts.js';
import type { WorkflowMetricsQuery, WorkflowStageId } from './workflow-metrics-contracts.js';
const workflowMillis = (value: string | null | undefined): number => value ? Date.parse(value) : NaN;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unique = <T>(rows: readonly T[], key: (row: T) => string) => [...new Map(rows.map(row => [key(row), row])).values()];
export interface WorkflowObservation {
  request?: WorkerRequest; source?: FeatureIntakeMeasurement; events: RequestEvent[]; runs: DeliveryRun[];
  projectId: string | null; profileId: string | null; submittedAt: number | null; complete: boolean;
}
export function workflowDistribution(values: readonly (number | null)[]): DeliveryMetricDistribution {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a,b) => a-b);
  return { samples: known.length, unknown: values.length - known.length, p50Ms: known.length ? known[Math.ceil(known.length * .5) - 1]! : null,
    p95Ms: known.length ? known[Math.ceil(known.length * .95) - 1]! : null, totalMs: known.length ? known.reduce((sum, item) => sum + item, 0) : null };
}
/** Group the retained journal once; retries remain children of their canonical request. */
export function workflowObservations(input: DeliveryMetricsInput, query: WorkflowMetricsQuery, end: number): WorkflowObservation[] {
  const intake = unique(input.intake ?? [], row => row.feature.key), complete = new Set(input.completeRequestIds), linked = new Set<string>();
  const events = new Map<string, RequestEvent[]>();
  for (const event of unique(input.events, row => row.id)) if (workflowMillis(event.at) <= end) { const rows = events.get(event.requestId) ?? []; rows.push(event); events.set(event.requestId, rows); }
  for (const rows of events.values()) rows.sort((a,b) => workflowMillis(a.at) - workflowMillis(b.at) || a.sequence - b.sequence);
  const selected = (id: { projectId: string | null; profileId: string | null }) => (!query.projectId || query.projectId === id.projectId) && (!query.profileId || query.profileId === id.profileId);
  const result: WorkflowObservation[] = [];
  for (const request of unique(input.requests, row => row.id)) {
    if (!isDeliveryMetricsRequest(request, intake) || workflowMillis(request.createdAt) > end) continue;
    const source = findDeliveryMetricIntake(request, intake), context = record(request.input.context) ? request.input.context : {}, policy = record(context.deliveryPolicy) ? context.deliveryPolicy : {};
    const projectId = typeof context.repositoryId === 'string' ? context.repositoryId : source?.projectId ?? null;
    const profileId = record(policy.profile) && typeof policy.profile.id === 'string' ? policy.profile.id : source?.profileId ?? null;
    if (!selected({ projectId, profileId })) continue;
    if (source) linked.add(source.feature.key);
    const runs = unique([...(request.deliveryHistory ?? []), ...(request.delivery ? [request.delivery] : [])], row => row.id)
      .filter(run => workflowMillis(run.startedAt) <= end).sort((a,b) => workflowMillis(a.startedAt) - workflowMillis(b.startedAt));
    result.push({ request, source, projectId, profileId, events: events.get(request.id) ?? [], runs, submittedAt: deliverySubmissionTime(request, source), complete: complete.has(request.id) && (source?.complete ?? true) });
  }
  for (const source of intake) if (!linked.has(source.feature.key) && selected(source) && Math.min(workflowMillis(source.observedAt), ...source.events.map(event => workflowMillis(event.at))) <= end)
    result.push({ source, projectId: source.projectId, profileId: source.profileId, events: [], runs: [], submittedAt: deliverySubmissionTime(undefined, source), complete: source.complete });
  return result;
}
const oid = (value: string) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
/** Human acceptance is a handoff; only the actual required integration receipt completes throughput. */
export function workflowCompletion(row: WorkflowObservation, end: number): { at: number | null; unknownTime: boolean } {
  const times: number[] = []; let unknownTime = false;
  for (const run of row.runs) {
    const published = run.release?.published, local = run.localMerge?.merged;
    const receipt = published ? { at: published.publishedAt, commit: published.commit } : deliveryCompletion(row.request!) !== 'release' && local ? { at: local.mergedAt, commit: local.mergeCommit } : undefined;
    if (!receipt) continue;
    const at = workflowMillis(receipt.at);
    if (!Number.isFinite(at) || !oid(receipt.commit) || at < workflowMillis(run.startedAt)) unknownTime ||= workflowMillis(row.request?.updatedAt) <= end;
    else if (at <= end) times.push(at);
  }
  return { at: times.length ? Math.min(...times) : null, unknownTime };
}
const phaseStage = (phase: string): WorkflowStageId | null => phase === 'assessing' || phase === 'planning' || phase === 'preparing' ? 'pre_production'
  : phase === 'implementing' || phase === 'repairing' ? 'production' : phase === 'verifying' || phase === 'packaging' ? 'post_production' : null;
const requestStage = (phase: string): WorkflowStageId | null => ['readiness', 'needs_rework', 'ready'].includes(phase) ? 'pre_production' : phase === 'review' ? 'review' : null;
export function workflowCycleStart(row: WorkflowObservation, completion: number): number | null {
  if (!row.complete) return null;
  const typed = new Map(row.runs.map(run => [run.id, run.steps.filter(step => ['implementing', 'repairing'].includes(step.phase)).map(step => workflowMillis(step.startedAt)).filter(at => Number.isFinite(at) && at <= completion)]));
  const legacy = row.events.filter(event => event.type === 'execution_started').flatMap(event => {
    const at = workflowMillis(event.at), run = event.deliveryRunId ? row.runs.find(run => run.id === event.deliveryRunId)
      : row.runs.filter(run => run.inputRevision === event.inputRevision && workflowMillis(run.startedAt) <= at).at(-1);
    return run && typed.get(run.id)?.length ? [] : [at];
  });
  return [...typed.values()].flat().concat(legacy).filter(at => Number.isFinite(at) && at <= completion).sort((a,b) => a-b)[0] ?? null;
}
/** Missing historical state is explicit; mutable current fields are used only when observed by the snapshot end. */
export function workflowSnapshot(row: WorkflowObservation, end: number) {
  const request = row.request;
  if (!request) {
    const observed = row.source?.events.filter(event => workflowMillis(event.at) <= end).at(-1), blockers = observed?.blockers;
    return { closed: observed?.phase === 'cancelled', unknown: !observed, stage: 'intake' as WorkflowStageId, blocked: !!blockers?.length, blockedKnown: !!observed,
      age: row.complete && row.submittedAt !== null && row.submittedAt <= end ? end - row.submittedAt : null, closedWithoutIntegration: false };
  }
  const latest = row.events.at(-1), currentKnown = workflowMillis(request.updatedAt) <= end;
  const phase = latest?.phase ?? (currentKnown ? request.phase : undefined), lifecycle = latest?.measurement?.lifecycle ?? (currentKnown ? request.lifecycle : undefined);
  const completion = workflowCompletion(row, end), closed = completion.at !== null || phase === 'cancelled' || lifecycle === 'cancelled'
    || (phase === 'done' || lifecycle === 'done') && !deliveryCompletion(request);
  const measurement = latest?.measurement;
  const blocked = !!measurement?.blockers.length || phase === 'waiting_input' || phase === 'escalated' || phase === 'failed' || phase === 'interrupted'
    || currentKnown && (!!request.recoveryHold || !!request.deliveryHolds?.length || !!request.delivery?.holds.length || !!request.delivery?.control || ['paused', 'failed', 'interrupted', 'outcome_unknown'].includes(request.delivery?.status ?? ''));
  const blockedKnown = !!measurement || blocked;
  let stage: WorkflowStageId = requestStage(phase ?? '') ?? 'unknown', entered: number | null = null;
  if (phase === 'done' && !closed) {
    stage = 'merge';
    if (deliveryCompletion(request) === 'release') {
      const run = row.runs.at(-1);
      if (workflowMillis(run?.release?.build?.builtAt) <= end) stage = 'publish';
      else if (workflowMillis(run?.release?.merge?.mergedAt) <= end) stage = 'build';
    }
  }
  const transitions: { at: number; stage: WorkflowStageId }[] = [];
  for (const run of row.runs) for (const step of run.steps) {
    const at = workflowMillis(step.startedAt), id = phaseStage(step.phase); if (id && at <= end) transitions.push({ at, stage: id });
  }
  for (const event of row.events) {
    const at = workflowMillis(event.at), run = event.deliveryRunId ? row.runs.find(run => run.id === event.deliveryRunId)
      : row.runs.filter(run => run.inputRevision === event.inputRevision && workflowMillis(run.startedAt) <= at).at(-1);
    const hasSteps = run?.steps.some(step => workflowMillis(step.startedAt) <= end) ?? false;
    const id = (!hasSteps && event.type === 'execution_started' ? 'production' : null) ?? requestStage(event.phase) ?? (event.phase === 'done' && event.measurement?.lifecycle === 'in_progress' ? 'merge' : null);
    if (id) transitions.push({ at: workflowMillis(event.at), stage: id });
  }
  transitions.sort((a,b) => a.at - b.at);
  const last = transitions.at(-1), activeRun = latest?.deliveryRunId ? row.runs.find(run => run.id === latest.deliveryRunId) : row.runs.at(-1);
  const activeSteps = activeRun?.steps.filter(step => workflowMillis(step.startedAt) <= end).sort((a,b) => workflowMillis(a.startedAt) - workflowMillis(b.startedAt)) ?? [], activeStep = activeSteps.at(-1);
  if (stage === 'unknown' && activeStep) stage = phaseStage(activeStep.phase) ?? 'unknown';
  if (stage === 'unknown' && last) stage = last.stage;
  if (stage === 'unknown' && row.events.some(event => event.type === 'execution_started')) stage = 'production';
  if (stage === 'build' || stage === 'publish') {
    const release = row.runs.at(-1)?.release; entered = workflowMillis(stage === 'build' ? release?.merge?.mergedAt : release?.build?.builtAt);
  } else {
    let previous: WorkflowStageId | undefined;
    for (const transition of transitions) { if (transition.stage !== previous) entered = transition.at; previous = transition.stage; }
    if (previous !== stage) entered = null;
    if (entered === null && activeStep && phaseStage(activeStep.phase) === stage) {
      for (let index = activeSteps.length - 1; index >= 0 && phaseStage(activeSteps[index]!.phase) === stage; index--) entered = workflowMillis(activeSteps[index]!.startedAt);
    }
  }
  return { closed, unknown: !phase, stage, blocked, blockedKnown, age: entered !== null && Number.isFinite(entered) && entered <= end ? end - entered : null,
    closedWithoutIntegration: closed && phase === 'done' && completion.at === null };
}
/** Event counts describe recorded observations, not inferred defects or innovation investment. */
export function workflowEvidenceCounts(row: WorkflowObservation, start: number, end: number, kind: 'rework' | 'failure'): number {
  const evidence = new Set<string>(), within = (at: string | null) => workflowMillis(at) >= start && workflowMillis(at) < end;
  for (const event of row.events) if (within(event.at)) {
    if (kind === 'rework' && event.type === 'review_changes_requested') evidence.add('review:' + event.id);
    if (kind === 'failure' && ['execution_failed', 'delivery_step_failed', 'review_failed'].includes(event.type)) evidence.add(event.deliveryStepId ? 'step:' + event.deliveryRunId + ':' + event.deliveryStepId : 'event:' + event.id);
  }
  for (const run of row.runs) for (const step of run.steps) {
    if (kind === 'rework' && step.phase === 'repairing' && within(step.startedAt)) evidence.add('step:' + run.id + ':' + step.id);
    if (kind === 'failure' && step.status === 'failed' && within(step.finishedAt)) evidence.add('step:' + run.id + ':' + step.id);
  }
  return evidence.size;
}
