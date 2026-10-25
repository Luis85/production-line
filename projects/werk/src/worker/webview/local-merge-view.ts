import type { WorkerRequest } from '../application/request-gates';
import type { LocalMergeOperation, LocalMergeView } from '../application/local-merge-contracts';
import type { GateCommandFields } from './request-gate-controller';
import { deliveryCandidateMatches } from './delivery-candidate-view';
export const localMergeStatusLabels = { pending: 'Merge pending', unknown: 'Outcome unknown · reconcile first', confirmed: 'Confirmed', not_observed: 'Not found', failed: 'Failed' };
/** Bind local merge consent to both the exact candidate and the inspected main checkout head. */
export function localMergeCommand(request: WorkerRequest, view: LocalMergeView, receipt?: LocalMergeOperation): GateCommandFields | null {
  if (!view.configured || !view.target || !deliveryCandidateMatches(request, view)) return null;
  if (receipt && (!deliveryCandidateMatches(request, { candidate: receipt.candidate }) || !view.canReconcile || !['pending', 'unknown'].includes(receipt.status) || !view.state.operations.some(saved => saved.operationId === receipt.operationId && saved.checkoutPath === receipt.checkoutPath && saved.mainHead === receipt.mainHead && saved.candidate.candidateCommit === view.candidate!.candidateCommit))) return null;
  if (!receipt && !view.canMerge) return null;
  const candidate = view.candidate!;
  return { action: receipt ? 'reconcile_local_merge' : 'merge_local_candidate', deliveryRunId: candidate.runId, inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest,
    ...(receipt ? { localMergeOperationId: receipt.operationId } : { mainCheckout: view.target.checkoutPath, mainBranch: view.target.branch, mainHead: view.target.head }) };
}
