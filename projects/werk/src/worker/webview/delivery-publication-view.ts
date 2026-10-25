import type { WorkerRequest } from '../application/request-gates';
import { remotePublicationBranch, type RemotePublication, type RemotePublicationCommand, type RemotePublicationView } from '../application/remote-delivery-contracts';
import { deliveryCandidateMatches } from './delivery-candidate-view';
import { deliveryReviewStages } from './delivery-review-stages';
export const publicationStatusLabels = { pending: 'Publication pending', unknown: 'Outcome unknown · reconcile first', confirmed: 'Confirmed remotely', not_observed: 'Not found remotely', failed: 'Publication failed' };
export function publicationCandidateMatches(request: WorkerRequest, view: RemotePublicationView): boolean {
  const candidate = request.delivery ? deliveryReviewStages(request).review?.candidate : null;
  return !!candidate && deliveryCandidateMatches(request, view);
}
/** Commands carry the inspected immutable subject; the application rechecks every grant. */
export function publicationCommand(request: WorkerRequest, view: RemotePublicationView, action: RemotePublicationCommand, receipt?: RemotePublication) {
  if (!view.authorized || !request.delivery) return null;
  const reconcile = action === 'reconcile_publication';
  if (reconcile ? !view.canReconcile || !receipt || !['pending', 'unknown'].includes(receipt.status) || !view.publications.some(item => item.operationId === receipt.operationId) : !publicationCandidateMatches(request, view) || !(action === 'push_candidate' ? view.canPush : view.canCreatePullRequest)) return null;
  const candidate = reconcile ? receipt!.candidate : view.candidate!;
  if (candidate.requestId !== request.id || candidate.runId !== request.delivery.id) return null;
  return { action, deliveryRunId: candidate.runId, inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, ...(reconcile ? { publicationOperationId: receipt!.operationId } : {}) };
}
export function publicationLink(receipt: RemotePublication): string | null {
  const observed = receipt.observation;
  if (receipt.status !== 'confirmed' || observed?.commit !== receipt.candidate.candidateCommit || observed.branch !== remotePublicationBranch(receipt) || !observed.pullRequest) return null;
  try { const url = new URL(observed.pullRequest.url); return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname === '/' + receipt.target.repository + '/pull/' + observed.pullRequest.number && !url.username && !url.password ? url.href : null; } catch { return null; }
}
