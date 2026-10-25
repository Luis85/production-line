import type { WorkerRequest } from './request-gate-contracts.js';
import type { DeliveryProjectPolicy } from './delivery-policy.js';
import { localMergePending } from './local-merge-contracts.js';

/** Accepted policy determines the completion target; legacy notes retain their existing semantics. */
export function deliveryCompletion(request: WorkerRequest): 'local_merge' | 'release' | undefined {
  const policy = (request.input.context as { deliveryPolicy?: { configuration?: DeliveryProjectPolicy } } | undefined)?.deliveryPolicy?.configuration;
  return policy?.release ? 'release' : policy?.localMerge === true ? 'local_merge' : undefined;
}
export function deliveryCompletionPending(request: WorkerRequest): boolean {
  const completion = deliveryCompletion(request);
  return completion === 'release' ? !request.delivery?.release?.published : completion === 'local_merge' ? !request.delivery?.localMerge?.merged : false;
}
export function localMergeUnsettled(request: WorkerRequest): boolean {
  return localMergePending(request.delivery?.localMerge) || request.phase === 'done' && deliveryCompletion(request) === 'local_merge' && !request.delivery?.localMerge?.merged;
}

/** Retention preserves ancestry evidence independently of active reviews and provider configuration. */
function localMergeRetained(request: WorkerRequest): boolean {
  return !!request.delivery?.localMerge?.merged || localMergeUnsettled(request);
}
export function localMergeRetentionReason(request: WorkerRequest): string | null {
  if (!localMergeRetained(request)) return null;
  return request.delivery?.localMerge?.merged
    ? 'Confirmed main checkout merge history is retained to protect later shared request baselines. Its receipt cannot be deleted in this release; preserve this worker state.'
    : 'Finish or reconcile the retained main checkout merge before deleting request history.';
}
