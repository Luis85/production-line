import { sharedFeatureRequestReference } from './feature-request-reference.js';
import { featureInputHash } from './feature-workflow.js';
import { appendFeatureIntake, observeFeatureIntake, featureIntakeReadiness, type FeatureIntakeMeasurementUpdate } from './feature-intake-measurement.js';
import type { DeliveryMetricObservation } from './delivery-metrics-contracts.js';
import type { SharedFeatureRecord, SharedFeatureState, SharedReadyReviewCheckpoint } from './shared-feature-state.js';

export function sharedIntakeQuestions(state: SharedReadyReviewCheckpoint, kind: 'clarification' | 'clarification_answer' = 'clarification'): DeliveryMetricObservation[] {
  return (state.result?.findings ?? []).flatMap((finding, index) => finding.blocking ? [{ kind, questionId: state.input.operationId + ':' + index,
    cycleId: state.input.operationId, cause: 'readiness', ...(kind === 'clarification' ? { answerTracking: true as const } : {}) }] : []);
}
/** Records only the intake prefix. Once admitted, the canonical request journal owns subsequent measurements. */
export function observeSharedIntake(state: SharedFeatureState, record: SharedFeatureRecord, update?: Partial<FeatureIntakeMeasurementUpdate>) {
  const revision = featureInputHash(record.accepted), review = record.readyReviewState;
  const metric = observeFeatureIntake(state, sharedFeatureRequestReference(record), revision, { historical: true,
    projectId: record.binding.repositoryId, profileId: record.deliveryPolicy?.profile.id ?? record.accepted.qualityProfile,
    ...(record.taskId ? { sessionId: record.accepted.mode === 'patch' ? 'local-' + record.taskId : record.taskId } : {}) });
  if (metric.events.at(-1)?.phase === 'queued' && record.submitted) return;
  const prior = metric.events.at(-1), providerRunId = review?.attempt?.runId ?? undefined;
  const waiting = review?.status === 'waiting_input';
  const questions = waiting ? [...sharedIntakeQuestions(review), ...(review.gateIssues?.length ? featureIntakeReadiness(metric, revision, review.gateIssues.map(code => ({ code }))) : [])] : review?.status === 'passed' ? featureIntakeReadiness(metric, revision) : [];
  const blockers = record.submitted || record.status === 'cancelled' ? [] : waiting ? [{ code: 'ready_review_questions', category: 'requirements' as const }]
    : review?.status === 'failed' ? [{ code: 'ready_review_failed', category: 'unknown' as const }]
    : record.error || !review || review.status === 'queued' && !providerRunId ? prior?.blockers.length ? prior.blockers : record.error ? [{ code: 'intake_unavailable', category: 'unknown' as const }] : [] : [];
  appendFeatureIntake(metric, { inputRevision: revision, phase: record.status === 'cancelled' ? 'cancelled' : record.submitted ? 'queued' : waiting || blockers.length ? 'waiting_input' : 'readiness',
    blockers, ...(providerRunId ? { providerRunId } : {}), ...(blockers.length || waiting || review?.status === 'passed' || review?.status === 'failed' || record.error ? { feedback: true as const } : {}),
    ...(questions.length ? { observations: questions } : {}), ...update });
}
