import type { DeliveryRun, DeliveryStep } from './delivery-contracts.js';
import type { RequestEvent, WorkerRequest } from './request-gates.js';
import type { WorkerRun } from './run-evidence.js';
const metricMillis = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
/** Invocation identities survive run-ledger retention and expose missing usage/timing coverage. */
function deliveryMetricRunIds(request: WorkerRequest, events: readonly RequestEvent[], until: number): Set<string> {
  const ids = new Set(events.filter(event => event.requestId === request.id && metricMillis(event.at) <= until).flatMap(event => event.runId ? [event.runId] : []));
  for (const run of [...(request.deliveryHistory ?? []), ...(request.delivery ? [request.delivery] : [])])
    for (const step of run.steps) if (step.invocationRunId && metricMillis(step.startedAt) <= until) ids.add(step.invocationRunId);
  for (const review of request.reviews) if (review.runId && metricMillis(review.createdAt) <= until) ids.add(review.runId);
  if (request.execution?.runId && metricMillis(request.updatedAt) <= until) ids.add(request.execution.runId);
  return ids;
}
export function deliveryMetricCalls(request: WorkerRequest, events: readonly RequestEvent[], runs: readonly WorkerRun[], until: number, intakeRunIds: readonly string[] = []) {
  const intake = new Set(intakeRunIds), ids = new Set([...deliveryMetricRunIds(request, events, until), ...intake]);
  const calls = [...new Map(runs.map(run => [run.id, run])).values()].filter(run => (run.requestId === request.id || intake.has(run.id) || !run.requestId && ids.has(run.id)) && metricMillis(run.acceptedAt) <= until);
  const observed = new Set(calls.map(run => run.id));
  const complete = [...ids].every(id => observed.has(id)) && !runs.some(run => !run.requestId && run.sessionId === request.owner.sessionId && metricMillis(run.acceptedAt) <= until && !ids.has(run.id));
  return { calls, complete };
}
/** Union overlapping provider intervals, including delegation, instead of adding concurrent wall time. */
export function deliveryProviderFeedback(request: WorkerRequest, events: RequestEvent[], runs: readonly WorkerRun[], firstAt: number | undefined, measuredHistory: boolean, submittedAt = metricMillis(request.createdAt), intakeRunIds: readonly string[] = []): number | null {
  if (firstAt === undefined || !measuredHistory || !Number.isFinite(submittedAt)) return null;
  const { calls, complete } = deliveryMetricCalls(request, events, runs, firstAt, intakeRunIds);
  return complete ? deliveryProviderWallTime(calls, submittedAt, firstAt) : null;
}
/** Both intake and execution use the same observed provider wall-time union. */
export function deliveryProviderWallTime(calls: readonly WorkerRun[], submittedAt: number, firstAt: number): number | null {
  const intervals: [number, number][] = [];
  for (const run of calls) {
    const started = metricMillis(run.startedAt);
    if (!Number.isFinite(started)) { if (run.outcome === 'queued') continue; return null; }
    if (started > firstAt) continue;
    const finished = run.after ? metricMillis(run.after.capturedAt) : run.outcome === 'running' ? firstAt : NaN;
    if (!Number.isFinite(finished) || finished < started) return null;
    intervals.push([Math.max(started, submittedAt), Math.min(finished, firstAt)]);
  }
  intervals.sort((a,b) => a[0] - b[0]);
  let total = 0, right = submittedAt;
  for (const [start, end] of intervals) { total += Math.max(0, end - Math.max(start, right)); right = Math.max(right, end); }
  return total;
}
function checkOutcome(request: WorkerRequest, run: DeliveryRun, step: DeliveryStep): boolean | null {
  const evidence = step.evidence;
  if (!evidence?.candidateDigest || !evidence.changedPaths.length || !evidence.checks.length) return null;
  const context = request.input.context as { implementation?: { checks?: { id: string; fingerprint: string }[] } } | undefined;
  const current = run.inputRevision === request.inputRevision && run.inputHash === request.inputHash && run.policyDigest === request.policyDigest;
  const definitions = current && Array.isArray(context?.implementation?.checks) ? context.implementation.checks : [];
  const expected = [...new Set(definitions.length ? definitions.map(check => check.id) : run.plan?.steps.flatMap(item => item.verification) ?? run.review?.criteria.flatMap(item => item.evaluator === 'check' && item.mandatory && item.checkId ? [item.checkId] : []) ?? [])];
  if (!expected.length || new Set(evidence.checks.map(check => check.presetId)).size !== evidence.checks.length || evidence.checks.some(check => !expected.includes(check.presetId))) return null;
  const outcomes = expected.map(id => {
    const check = evidence.checks.find(value => value.presetId === id), fingerprint = definitions.find(value => value.id === id)?.fingerprint;
    if (!check || check.candidateDigest !== evidence.candidateDigest || fingerprint && check.presetFingerprint !== fingerprint) return null;
    return check.status === 'passed' && check.exitCode === 0 ? true : check.status === 'failed' && check.exitCode !== null ? false : null;
  });
  if (outcomes.includes(false)) return false;
  return outcomes.every(value => value === true) && step.status === 'completed' ? true : null;
}
export function deliveryVerificationMetric(request: WorkerRequest, runs: DeliveryRun[], events: RequestEvent[], until: number, settled: boolean, historyComplete: boolean) {
  const retained = new Set(runs.map(run => run.id));
  const complete = historyComplete && events.every(event => !event.deliveryRunId || retained.has(event.deliveryRunId));
  const attempts = runs.flatMap(run => run.steps.filter(step => step.phase === 'verifying' && step.purpose !== 'candidate_review' && metricMillis(step.startedAt) <= until).map(step => ({ run, step })))
    .sort((a,b) => metricMillis(a.step.startedAt) - metricMillis(b.step.startedAt));
  const outcomes = attempts.map(({ run, step }) => Number.isFinite(metricMillis(step.finishedAt)) && metricMillis(step.finishedAt) <= until ? checkOutcome(request, run, step) : null);
  return { first: complete ? outcomes[0] ?? null : null, eventual: outcomes.includes(true) ? true : complete && settled && outcomes.length > 0 && !outcomes.includes(null) ? false : null };
}
