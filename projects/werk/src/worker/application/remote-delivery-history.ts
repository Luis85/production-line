import { gateDigest, type WorkerRequest } from './request-gates.js';
import type { RemoteDeliveryPolicy } from './remote-delivery-policy.js';
import type { RemotePublicationPredecessor } from './remote-delivery-contracts.js';

/** Only a prior confirmed PR receipt can authorize replacing a branch on a later candidate. */
export function remotePublicationPredecessor(request: WorkerRequest, target: RemoteDeliveryPolicy): RemotePublicationPredecessor | undefined {
  const runs = [...(request.deliveryHistory ?? []), ...(request.delivery ? [request.delivery] : [])];
  for (const run of runs.reverse()) for (const publication of [...(run.publications ?? [])].reverse()) {
    const observed = publication.observation;
    if (publication.action !== 'pull_request' || publication.status !== 'confirmed' || !observed?.pullRequest ||
      publication.candidate.requestId !== request.id || gateDigest(publication.target) !== gateDigest(target)) continue;
    return { candidate: structuredClone(publication.candidate), branch: observed.branch, pullRequest: structuredClone(observed.pullRequest) };
  }
  return undefined;
}
