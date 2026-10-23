import type { FeatureIntakeMeasurement } from './feature-intake-measurement.js';
import { findDeliveryMetricIntake, deliveryIntakeTimeline, deliveryMetricTimeline, deliverySubmissionTime, deliveryIntakeRunIds, deliveryIntakeProviderFeedback } from './delivery-metric-intake.js';
import { addDeliveryClarification } from './delivery-metric-clarification.js';
import type { DeliveryRun } from './delivery-contracts.js';
import type { RequestEvent, WorkerRequest } from './request-gates.js';
import type { DeliveryBlockerCategory, DeliveryMetricDistribution, DeliveryMetricObservation, DeliveryMetricRate, DeliveryMetricsInput, DeliveryMetricsQuery, DeliveryMetricsReport, DeliveryMetricTimelineEvent } from './delivery-metrics-contracts.js';
import { deliveryProviderFeedback, deliveryVerificationMetric } from './delivery-metric-evidence.js';
import { deliveryConsumptionMetrics } from './delivery-metrics-usage.js';
const millis = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unique = <T>(rows: readonly T[], key: (row: T) => string): T[] => [...new Map(rows.map(row => [key(row), row])).values()];
const rate = (values: (boolean | null)[]): DeliveryMetricRate => {
  const known = values.filter(value => value !== null), numerator = known.filter(Boolean).length;
  return { numerator, denominator: known.length, unknown: values.length - known.length, percent: known.length ? numerator / known.length * 100 : null };
};
function deliveryMetricDistribution(values: (number | null)[]): DeliveryMetricDistribution {
  const samples = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a,b) => a - b);
  const percentile = (p: number) => samples.length ? samples[Math.max(0, Math.ceil(samples.length * p) - 1)]! : null;
  return { samples: samples.length, unknown: values.length - samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95), totalMs: samples.length ? samples.reduce((sum, value) => sum + value, 0) : null };
}
function identity(request: WorkerRequest) {
  const context = record(request.input.context) ? request.input.context : {};
  const policy = record(context.deliveryPolicy) ? context.deliveryPolicy : {};
  return { projectId: typeof context.repositoryId === 'string' ? context.repositoryId : null, profileId: record(policy.profile) && typeof policy.profile.id === 'string' ? policy.profile.id : null };
}
function observations(events: RequestEvent[]): DeliveryMetricObservation[] { return events.flatMap(event => event.measurement?.observations ?? []); }
const runsFor = (request: WorkerRequest, until: number) => unique([...(request.deliveryHistory ?? []), ...(request.delivery ? [request.delivery] : [])], run => run.id).filter(run => millis(run.startedAt) <= until);
function reviewedAt(request: WorkerRequest, events: RequestEvent[], runs: DeliveryRun[], until: number) {
  const observed = events.filter(event => event.measurement?.lifecycle === 'in_review' || event.phase === 'review' && ['gate_passed', 'delivery_review_packaged'].includes(event.type)).map(event => millis(event.at));
  const retained = runs.filter(run => run.status === 'completed' && run.review).map(run => millis(run.finishedAt));
  return [...observed, ...retained].filter(at => Number.isFinite(at) && at >= millis(request.createdAt) && at <= until).sort((a,b) => a-b)[0] ?? null;
}
function settledAt(request: WorkerRequest, events: RequestEvent[], until: number): boolean {
  const latest = events.at(-1);
  return latest ? ['done', 'cancelled'].includes(latest.phase) : millis(request.updatedAt) <= until && ['done', 'cancelled'].includes(request.phase);
}
/** Canonical delivery intent exists before readiness passes or any implementation run is prepared. */
export function isDeliveryMetricsRequest(request: WorkerRequest, intake: readonly FeatureIntakeMeasurement[] = []): boolean {
  if (request.delivery || request.deliveryHistory?.length || findDeliveryMetricIntake(request, intake)) return true;
  const context = request.input.context;
  return request.input.kind === 'patch' && !!request.owner.taskId
    && record(context) && (record(context.deliveryPolicy) || record(context.implementation));
}
/** An admitted-request cohort, never a count of model invocations or a productivity estimate. */
export function buildDeliveryMetrics(input: DeliveryMetricsInput, query: DeliveryMetricsQuery = {}, now = new Date().toISOString()): DeliveryMetricsReport {
  const capture = millis(now), end = Math.min(query.until ? millis(query.until) : capture, capture), start = query.since ? millis(query.since) : -Infinity;
  if (!Number.isFinite(end) || Number.isNaN(start) || start > end) throw Error('Choose a valid delivery metrics time window.');
  const complete = new Set(input.completeRequestIds);
  const intake = unique(input.intake ?? [], item => item.feature.key);
  const all = unique(input.requests, request => request.id).filter(request => isDeliveryMetricsRequest(request, intake));
  const intakeFor = new Map(all.map(request => [request.id, findDeliveryMetricIntake(request, intake)]));
  const linked = new Set([...intakeFor.values()].flatMap(item => item ? [item.feature.key] : []));
  const pending = intake.filter(item => !linked.has(item.feature.key));
  const events = unique(input.events, event => event.id).filter(event => millis(event.at) <= end).sort((a,b) => a.sequence - b.sequence);
  const identities = new Map(all.map(request => { const id = identity(request), source = intakeFor.get(request.id); return [request.id, { projectId: id.projectId ?? source?.projectId ?? null, profileId: id.profileId ?? source?.profileId ?? null }]; }));
  const matchesIdentity = (id: { projectId: string | null; profileId: string | null }) => (!query.projectId || id.projectId === query.projectId) && (!query.profileId || id.profileId === query.profileId);
  const inWindow = (submittedAt: number | null, firstObserved: number) => submittedAt === null ? !query.since && !query.until && firstObserved <= end : submittedAt >= start && submittedAt <= end;
  const firstObserved = (item: FeatureIntakeMeasurement) => Math.min(millis(item.observedAt), ...item.events.map(event => millis(event.at)));
  const selected = all.filter(request => matchesIdentity(identities.get(request.id)!) && inWindow(deliverySubmissionTime(request, intakeFor.get(request.id)), Math.min(millis(request.createdAt), intakeFor.get(request.id) ? firstObserved(intakeFor.get(request.id)!) : Infinity)));
  const selectedIntake = pending.filter(item => matchesIdentity(item) && inWindow(deliverySubmissionTime(undefined, item), firstObserved(item)));
  const unknownSubmissionTimes = all.filter(request => matchesIdentity(identities.get(request.id)!) && deliverySubmissionTime(request, intakeFor.get(request.id)) === null && Math.min(millis(request.createdAt), firstObserved(intakeFor.get(request.id)!)) <= end).length
    + pending.filter(item => matchesIdentity(item) && item.submittedAt === null && firstObserved(item) <= end).length;
  const eventMap = new Map(selected.map(request => [request.id, events.filter(event => event.requestId === request.id)]));
  const report: DeliveryMetricsReport = {
    schemaVersion: 1, scope: 'canonical_delivery_requests', capturedAt: new Date(capture).toISOString(),
    cohort: { since: query.since ?? null, until: new Date(end).toISOString(), projectId: query.projectId ?? null, profileId: query.profileId ?? null, requests: selected.length + selectedIntake.length, completeHistories: selected.filter(request => complete.has(request.id) && (intakeFor.get(request.id)?.complete ?? true)).length + selectedIntake.filter(item => item.complete).length, unknownSubmissionTimes, excludedUnknownSubmissionTimes: query.since || query.until ? unknownSubmissionTimes : 0 },
    projects: [...new Set([...identities.values(), ...intake].flatMap(id => id.projectId ? [id.projectId] : []))].sort(), profiles: [...new Set([...identities.values(), ...intake].flatMap(id => id.profileId ? [id.profileId] : []))].sort(),
    autonomousReview: rate([]), firstFeedback: { ...deliveryMetricDistribution([]), providerPortion: deliveryMetricDistribution([]) },
    clarification: { cycles: 0, completedCycles: 0, pendingCycles: 0, unknownCycles: 0, observedRequests: 0, unknownRequests: 0, completionMeasuredRequests: 0, unknownCompletionRequests: 0, groups: [] },
    verification: { firstPass: rate([]), eventualPass: rate([]), humanFailures: 0, humanReviewedRequests: 0 },
    review: { effort: deliveryMetricDistribution([]), effortSources: [], changesRequested: rate([]) }, recovery: rate([]),
    integrity: { incidents: 0, auditedRequests: 0, unknownRequests: 0, releaseAudits: 0, categories: [] },
    blockers: [], blockerCoverage: { measuredRequests: 0, unknownRequests: 0 },
    consumption: deliveryConsumptionMetrics(selected, events, input.runs, end, intake),
    notes: ['The cohort includes observed eligible submitted Feature Requests in intake and their admitted canonical request history, correlated once by retained feature identity. Drafts and malformed files are not eligible submissions.', 'New intake observations retain submission, feedback and waits before admission. Older intake without an observed submission time remains unknown and is excluded from dated submission filters; an admitted request without older intake evidence uses its known journal admission time. Retries remain part of the same request.', 'Rates show their measured denominator; missing or older evidence remains unknown. Ongoing requests have not yet reached their eventual outcome.', 'Review time is explicitly reported or instrumented. No productivity gain or provider ranking is inferred.', 'Historical acceptance, branch verification, remote publication and integration are distinct outcomes.'],
  };
  const autonomous: (boolean|null)[] = [], feedback: (number|null)[] = [], providerFeedback: (number|null)[] = [], first: (boolean|null)[] = [], eventual: (boolean|null)[] = [], changes: (boolean|null)[] = [], effort: (number|null)[] = [], recoveries: (boolean|null)[] = [];
  const incidents = new Map<string, string>(), effortSources = new Set<string>();
  for (const request of selected) {
    const timeline = eventMap.get(request.id)!, source = intakeFor.get(request.id), submittedAt = deliverySubmissionTime(request, source);
    const historyComplete = complete.has(request.id) && (source?.complete ?? true), runs = runsFor(request, end), reviewAt = reviewedAt(request, timeline, runs, end);
    const metricTimeline = deliveryMetricTimeline(timeline, source, end, millis(request.createdAt));
    const observed = observations(timeline), measuredHistory = historyComplete && metricTimeline.length > 0 && metricTimeline.every(event => !!event.measurement);
    const intervention = timeline.some(event => ['delivery_retry', 'delivery_resume', 'delivery_reopen', 'assigned', 'rework_queued'].includes(event.type) && (reviewAt === null || millis(event.at) < reviewAt));
    const settled = settledAt(request, timeline, end);
    autonomous.push(!historyComplete ? null : intervention ? false : reviewAt !== null ? true : settled ? false : null);
    const firstAt = [...metricTimeline.filter(event => event.type === 'intake_feedback').map(event => millis(event.at)), ...request.evaluations.filter(value => value.stage === 'ready').map(value => millis(value.at)), ...timeline.filter(event => ['gate_passed', 'gate_held', 'input_requested', 'execution_started', 'delivery_step_started'].includes(event.type) || event.measurement?.observations?.some(item => item.kind === 'clarification')).map(event => millis(event.at))].filter(at => submittedAt !== null && at >= submittedAt && at <= end).sort((a,b) => a-b)[0];
    feedback.push(historyComplete && submittedAt !== null && firstAt !== undefined ? firstAt - submittedAt : null);
    providerFeedback.push(deliveryProviderFeedback(request, timeline, input.runs, firstAt, measuredHistory, submittedAt ?? NaN, deliveryIntakeRunIds(source, firstAt ?? end)));
    addDeliveryClarification(report.clarification, metricTimeline, measuredHistory, identities.get(request.id)!.profileId ?? 'unrecorded');
    const verified = deliveryVerificationMetric(request, runs, timeline, end, settled, historyComplete); first.push(verified.first); eventual.push(verified.eventual);
    const humanOutcomes = runs.flatMap(run => run.humanOutcomes ?? []).filter(outcome => millis(outcome.at) <= end);
    const humanFailures = unique(observed.filter((item): item is Extract<DeliveryMetricObservation, {kind:'human_review_failure'}> => item.kind === 'human_review_failure'), item => item.candidateDigest + ':' + item.criterionId);
    const failedCriteria = new Set(humanFailures.map(item => item.candidateDigest + ':' + item.criterionId));
    for (const run of runs) for (const outcome of run.humanOutcomes ?? []) if (outcome.outcome === 'failed' && millis(outcome.at) <= end) failedCriteria.add((run.review?.candidate.candidateDigest ?? run.id) + ':' + outcome.criterionId);
    report.verification.humanFailures += failedCriteria.size;
    if (humanOutcomes.length || humanFailures.length) report.verification.humanReviewedRequests++;
    if (reviewAt !== null) {
      const changed = timeline.some(event => event.type === 'review_changes_requested' && millis(event.at) >= reviewAt);
      changes.push(changed ? true : historyComplete && settled ? false : null);
      const durations = observed.filter((item): item is Extract<DeliveryMetricObservation, {kind:'review_effort'}> => item.kind === 'review_effort' && Number.isFinite(item.durationMs) && item.durationMs >= 0);
      effort.push(durations.length ? durations.reduce((sum,item) => sum + item.durationMs, 0) : null); durations.forEach(item => effortSources.add(item.source));
    }
    const recovery = unique(observed.filter((item): item is Extract<DeliveryMetricObservation, {kind:'recovery'}> => item.kind === 'recovery'), item => item.operationId);
    recovery.forEach(item => recoveries.push(item.duplicateActions === true ? false : item.outcome === 'known' && item.duplicateActions === false ? true : null));
    if (!recovery.length && timeline.some(event => ['recovered_interrupted', 'delivery_interrupt', 'delivery_stop_unknown'].includes(event.type))) recoveries.push(null);
    const audits = unique(observed.filter((item): item is Extract<DeliveryMetricObservation, {kind:'integrity_audit'}> => item.kind === 'integrity_audit'), item => item.auditId);
    if (audits.length) report.integrity.auditedRequests++; else report.integrity.unknownRequests++;
    report.integrity.releaseAudits += audits.filter(item => item.scope === 'release_acceptance').length;
    for (const observation of observed) if (observation.kind === 'integrity_incident') incidents.set(request.id + ':' + observation.incidentId, observation.incident);
    for (const audit of audits) for (const id of audit.incidentIds) if (!incidents.has(request.id + ':' + id)) incidents.set(request.id + ':' + id, 'unclassified');
    if (measuredHistory) report.blockerCoverage.measuredRequests++; else report.blockerCoverage.unknownRequests++;
    if (source && !source.complete) {
      recordBlockers(report, deliveryIntakeTimeline(source, end, millis(request.createdAt)), Math.min(end, millis(source.observedAt), millis(request.createdAt)), false);
      recordBlockers(report, timeline, end);
    } else recordBlockers(report, metricTimeline, end);
  }
  for (const source of selectedIntake) {
    const timeline = deliveryIntakeTimeline(source, end), submittedAt = deliverySubmissionTime(undefined, source);
    const firstAt = timeline.filter(event => event.type === 'intake_feedback' && submittedAt !== null && millis(event.at) >= submittedAt).map(event => millis(event.at)).sort((a,b) => a-b)[0];
    autonomous.push(source.complete && timeline.at(-1)?.phase === 'cancelled' ? false : null);
    feedback.push(source.complete && submittedAt !== null && firstAt !== undefined ? firstAt - submittedAt : null);
    providerFeedback.push(deliveryIntakeProviderFeedback(source, input.runs, firstAt, submittedAt));
    addDeliveryClarification(report.clarification, timeline, source.complete, source.profileId ?? 'unrecorded');
    first.push(null); eventual.push(null); report.integrity.unknownRequests++;
    if (source.complete) report.blockerCoverage.measuredRequests++; else report.blockerCoverage.unknownRequests++;
    recordBlockers(report, timeline, source.complete ? end : Math.min(end, millis(source.observedAt)), source.complete);
  }
  report.autonomousReview = rate(autonomous); report.firstFeedback = { ...deliveryMetricDistribution(feedback), providerPortion: deliveryMetricDistribution(providerFeedback) };
  report.clarification.groups.sort((a,b) => b.cycles - a.cycles || a.cause.localeCompare(b.cause));
  report.verification.firstPass = rate(first); report.verification.eventualPass = rate(eventual);
  report.review = { effort: deliveryMetricDistribution(effort), effortSources: [...effortSources].sort(), changesRequested: rate(changes) }; report.recovery = rate(recoveries);
  report.integrity.incidents = incidents.size;
  for (const category of new Set(incidents.values())) report.integrity.categories.push({ category, count: [...incidents.values()].filter(value => value === category).length });
  return report;
}
function recordBlockers(report: DeliveryMetricsReport, timeline: readonly DeliveryMetricTimelineEvent[], end: number, currentKnown = true) {
  const current = new Map<DeliveryBlockerCategory, number>();
  const row = (category: DeliveryBlockerCategory) => { let value = report.blockers.find(item => item.category === category); if (!value) { value = { category, waits: 0, totalMs: 0, active: 0 }; report.blockers.push(value); } return value; };
  for (const event of timeline) {
    const categories = new Set(event.measurement?.blockers.map(item => item.category) ?? []), at = millis(event.at);
    if (!event.measurement || !Number.isFinite(at)) { for (const [category, started] of current) row(category).totalMs += Math.max(0, at - started) || 0; current.clear(); continue; }
    for (const [category, started] of current) if (!categories.has(category)) { row(category).totalMs += Math.max(0, at - started); current.delete(category); }
    for (const category of categories) if (!current.has(category)) { current.set(category, at); row(category).waits++; }
  }
  for (const [category, started] of current) { row(category).totalMs += Math.max(0, end - started); if (currentKnown) row(category).active++; }
}
