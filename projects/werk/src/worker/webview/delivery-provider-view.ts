import type { WorkerRequest } from '../application/request-gates';
import type { DeliveryExecutionSnapshot } from '../application/delivery-execution-snapshot';
import { deliveryReviewStages } from './delivery-review-stages';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function acceptedExecutionProfile(request: WorkerRequest): DeliveryExecutionSnapshot | null {
  const context = request.input.context;
  if (!record(context) || !record(context.deliveryExecution)) return null;
  const value = context.deliveryExecution;
  return record(value.resolution) && record(value.resolution.profile) && typeof value.resolution.profile.id === 'string' && record(value.selection) && record(value.policy) ? value as unknown as DeliveryExecutionSnapshot : null;
}
export function deliveryAssessments(request: WorkerRequest) {
  const review = request.delivery ? deliveryReviewStages(request).review : null;
  const subject = review?.candidate;
  const keys = ['requestId', 'inputRevision', 'inputHash', 'runId', 'baseline', 'candidateCommit', 'candidateDigest', 'policyDigest', 'checkDefinitionDigest'] as const;
  return (request.delivery?.assessments ?? []).map(assessment => ({ assessment, current: !!subject && keys.every(key => subject[key] === assessment.candidate[key]) }));
}
