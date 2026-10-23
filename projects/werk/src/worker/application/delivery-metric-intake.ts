import { deliveryProviderWallTime } from './delivery-metric-evidence.js';
import type { WorkerRun } from './run-evidence.js';
import type { FeatureIntakeMeasurement } from './feature-intake-measurement.js';
import type { WorkerRequest } from './request-gates.js';
import type { DeliveryMetricTimelineEvent } from './delivery-metrics-contracts.js';
/** Existing Feature Request identity correlates intake observations; no execution identity is invented. */
export function findDeliveryMetricIntake(request: WorkerRequest, intake: readonly FeatureIntakeMeasurement[] = []): FeatureIntakeMeasurement | undefined {
  const matches = intake.filter(item => request.owner.featureId ? item.feature.key === request.owner.featureId : item.sessionId === request.owner.sessionId);
  return matches.length === 1 ? matches[0] : undefined;
}
export function deliveryIntakeTimeline(intake: FeatureIntakeMeasurement | undefined, until: number, admittedAt = Infinity): DeliveryMetricTimelineEvent[] {
  return (intake?.events ?? []).filter(event => Date.parse(event.at) <= Math.min(until, admittedAt)).map(event => ({
    id: event.id, at: event.at, inputRevision: event.inputRevision, phase: event.phase,
    type: event.feedback ? 'intake_feedback' : 'intake_observed',
    measurement: { blockers: event.blockers, ...(event.observations ? { observations: event.observations } : {}) },
  }));
}
export function deliveryIntakeRunIds(intake: FeatureIntakeMeasurement | undefined, until: number): string[] {
  return [...new Set((intake?.events ?? []).filter(event => Date.parse(event.at) <= until).flatMap(event => event.providerRunId ? [event.providerRunId] : []))];
}
export function deliverySubmissionTime(request: WorkerRequest | undefined, intake?: FeatureIntakeMeasurement): number | null {
  const at = intake ? intake.submittedAt : request?.createdAt;
  const parsed = at ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
export function deliveryMetricTimeline(events: readonly DeliveryMetricTimelineEvent[], intake: FeatureIntakeMeasurement | undefined, until: number, admittedAt = Infinity) {
  return [...deliveryIntakeTimeline(intake, until, admittedAt), ...events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/** Pending intake has no canonical execution identity; only its real reviewer invocation receipts contribute. */
export function deliveryIntakeProviderFeedback(intake: FeatureIntakeMeasurement, runs: readonly WorkerRun[], firstAt: number | undefined, submittedAt: number | null): number | null {
  if (firstAt === undefined || submittedAt === null || !intake.complete) return null;
  const ids = deliveryIntakeRunIds(intake, firstAt), calls = ids.map(id => runs.find(run => run.id === id)).filter((run): run is WorkerRun => !!run);
  return calls.length === ids.length ? deliveryProviderWallTime(calls, submittedAt, firstAt) : null;
}
