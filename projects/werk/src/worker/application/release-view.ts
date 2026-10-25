import { deliveryAccepted } from './delivery-acceptance.js';
export { deliveryAccepted as releaseAccepted } from './delivery-acceptance.js';
import { DomainError } from '../../shared/errors.js';
import { validateDeliveryPolicySnapshot } from './delivery-policy.js';
import { releasePending, type ReleaseView } from './release-contracts.js';
import { gateDigest, type WorkerRequest } from './request-gates.js';

export function releaseSubject(request: WorkerRequest) {
  const context = request.input.context as Record<string, unknown> | undefined;
  if (!context?.deliveryPolicy || typeof context.repositoryId !== 'string') throw new DomainError('conflict', 'This request has no accepted repository delivery policy.');
  const snapshot = validateDeliveryPolicySnapshot(context.deliveryPolicy), target = snapshot.configuration.release;
  if (!target) throw new DomainError('conflict', 'Merge, build and release publication are not configured for this request.');
  const remote = snapshot.configuration.remoteDelivery;
  if (!remote || remote.repository.toLowerCase() !== target.repository.toLowerCase() || remote.base !== target.base) throw new DomainError('conflict', 'Release and PR publication must use the same approved repository and base.');
  const run = request.delivery, candidate = run?.review?.candidate;
  if (!run || !candidate || run.id !== candidate.runId || candidate.requestId !== request.id || candidate.inputRevision !== request.inputRevision || candidate.inputHash !== request.inputHash || candidate.policyDigest !== request.policyDigest)
    throw new DomainError('conflict', 'Release requires the current verified delivery candidate.');
  const publication = run.publications?.findLast(item => item.action === 'pull_request' && item.status === 'confirmed' && item.observation?.pullRequest && gateDigest(item.candidate) === gateDigest(candidate));
  const pullRequest = publication?.observation?.pullRequest;
  if (!publication || !pullRequest || publication.target.repository.toLowerCase() !== target.repository.toLowerCase() || publication.target.base !== target.base) throw new DomainError('conflict', 'Confirm the current candidate pull request before starting release operations.');
  return { snapshot, target, repositoryId: context.repositoryId, candidate, pullRequest: { number: pullRequest.number, url: pullRequest.url, branch: publication.observation!.branch } };
}
export function releaseView(request: WorkerRequest, authorized: boolean, reason: string | null = null, busy = false): ReleaseView {
  let subject: ReturnType<typeof releaseSubject> | undefined;
  try { subject = releaseSubject(request); } catch (error) { reason = error instanceof DomainError ? error.message : 'Release configuration is unavailable.'; }
  const state = structuredClone(request.delivery?.release ?? { operations: [] });
  const pending = releasePending(state), accepted = deliveryAccepted(request), ready = !!subject && authorized && !reason && !busy && !pending && accepted;
  const configured = !!(request.input.context as { deliveryPolicy?: { configuration?: { release?: unknown } } } | undefined)?.deliveryPolicy?.configuration?.release;
  return { configured, authorized: configured && authorized, reason: reason ?? (busy ? 'A release operation is active.' : pending ? 'Reconcile the saved release outcome before continuing.' : !accepted ? 'Record human acceptance of the exact current candidate before release.' : null),
    target: subject?.target ?? null, candidate: subject?.candidate ?? null, state,
    canMerge: ready && !state.merge, canBuild: ready && !!state.merge && !state.build, canPublish: ready && !!state.build && !state.published,
    canConfirmStopped: !!subject && authorized && !busy && state.operations.some(item => item.action === 'build' && item.status === 'unknown'),
    canReconcile: !!subject && authorized && !busy && pending };
}
