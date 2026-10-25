import { deliveryCompletion } from './delivery-completion.js';
import { localMergeProjection } from './local-merge-markdown.js';
import { gateDigest, type WorkerRequest } from './request-gates.js';

export { localMergeProjection };
export function localMergeConfigured(request: WorkerRequest | null | undefined): boolean {
  return !!request && deliveryCompletion(request) === 'local_merge';
}
export function sameLocalMerge(left: ReturnType<typeof localMergeProjection> | undefined, right: ReturnType<typeof localMergeProjection>): boolean {
  return gateDigest(left ?? { operations: [] }) === gateDigest(right);
}
export function sharedLocalMergePhase(request: WorkerRequest | null | undefined): string | null {
  if (!request || !localMergeConfigured(request)) return null;
  const state = request.delivery?.localMerge;
  if (state?.merged) return 'done';
  const operation = state?.operations.at(-1);
  const accepted = request.phase === 'done' && !!request.attestation;
  if (!operation && !accepted) return null;
  if (request.recoveryHold || request.deliveryHolds?.length || request.delivery?.holds.length || request.delivery?.control) return 'merge_blocked';
  if (operation) return operation.status === 'pending' ? 'merging' : operation.status === 'unknown' ? 'merge_outcome_unknown' : 'merge_failed';
  return accepted ? 'accepted' : null;
}
