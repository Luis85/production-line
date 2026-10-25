import type { WorkerRequest } from '../application/request-gates';
import type { DeliveryCandidate } from '../application/delivery-review-contracts';
/** Compare retained candidate identities without implying acceptance or integration authority. */
export function deliveryCandidateMatches(request: WorkerRequest, view: { candidate: DeliveryCandidate | null }): boolean {
  const candidate = request.delivery?.review?.candidate;
  return !!candidate && !!view.candidate && candidate.requestId === request.id && candidate.runId === request.delivery?.id && candidate.inputRevision === request.inputRevision && candidate.inputHash === request.inputHash && candidate.policyDigest === request.policyDigest &&
    ['requestId', 'runId', 'inputRevision', 'inputHash', 'policyDigest', 'candidateCommit', 'candidateDigest', 'baseline', 'branch', 'tree', 'patchDigest', 'checkDefinitionDigest'].every(key => candidate[key as keyof typeof candidate] === view.candidate![key as keyof typeof candidate]);
}
