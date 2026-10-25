import { DomainError } from '../../shared/errors.js';
import { validateDeliveryPolicySnapshot } from './delivery-policy.js';
import { deliveryAccepted } from './delivery-acceptance.js';
import { localMergePending, type LocalMergeView } from './local-merge-contracts.js';
import type { WorkerRequest } from './request-gates.js';

export function localMergeSubject(request: WorkerRequest) {
  const context = request.input.context as { repositoryId?: unknown; deliveryPolicy?: unknown } | undefined;
  const run = request.delivery, candidate = run?.review?.candidate;
  if (typeof context?.repositoryId !== 'string' || !request.owner.taskId || !run || !candidate || candidate.requestId !== request.id || candidate.runId !== run.id || candidate.inputRevision !== request.inputRevision || candidate.inputHash !== request.inputHash || candidate.policyDigest !== request.policyDigest || run.inputRevision !== request.inputRevision || run.inputHash !== request.inputHash || run.policyDigest !== request.policyDigest)
    throw new DomainError('conflict', 'Local merge requires the assigned project and current verified delivery candidate.');
  if (!context.deliveryPolicy) throw new DomainError('conflict', 'Local merge requires the accepted project delivery policy.');
  const snapshot = validateDeliveryPolicySnapshot(context.deliveryPolicy);
  if (snapshot.configuration.localMerge !== true) throw new DomainError('conflict', 'Main checkout merge is disabled in this accepted project policy. Enable localMerge explicitly and approve the new policy before submitting a new Feature Request.');
  if (snapshot.configuration.release) throw new DomainError('conflict', 'This request uses its configured GitHub release merge target. Continue its retained release workflow.');
  return { repositoryId: context.repositoryId, candidate, snapshot };
}
export function localMergeView(request: WorkerRequest, target: LocalMergeView['target'], reason: string | null = null, busy = false): LocalMergeView {
  let subject: ReturnType<typeof localMergeSubject> | undefined;
  try { subject = localMergeSubject(request); } catch (error) { reason = error instanceof DomainError ? error.message : 'The local merge destination is unavailable.'; }
  const state = structuredClone(request.delivery?.localMerge ?? { operations: [] });
  const pending = localMergePending(state), accepted = deliveryAccepted(request);
  return { configured: !!subject && !!target, reason: reason ?? (busy ? 'A main checkout merge is active for this project.' : pending ? 'Reconcile the saved main checkout merge before continuing.' : !accepted ? 'Accept the exact current verified candidate before approving its merge.' : null),
    candidate: subject ? structuredClone(subject.candidate) : null, target: target ? { ...target } : null, state,
    canMerge: !!subject && !!target && !reason && !busy && !pending && accepted && !state.merged,
    canReconcile: !!subject && !!target && !busy && pending };
}
