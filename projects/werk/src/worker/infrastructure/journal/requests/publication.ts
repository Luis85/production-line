import { remotePublicationPredecessor } from '../../../application/remote-delivery-history.js';
import type { DeliveryMetricObservation } from '../../../application/delivery-metrics-contracts.js';
import { currentRemoteCandidate, remoteDeliverySubject, remotePublicationContent } from '../../../application/remote-delivery-view.js';
import { remotePublicationBranch, remotePublicationPending, type RemotePublication, type RemotePublicationUpdate } from '../../../application/remote-delivery-contracts.js';
import { gateDigest, type RequestCommand, type WorkerRequest } from '../../../application/request-gates.js';
import type { RequestStore } from './store.js';
import { clone, conflict, identifier, invalid, iso } from './values.js';

export function requestPublicationCommand(store: RequestStore, request: WorkerRequest, input: RequestCommand) {
  const run = request.delivery, review = run?.review;
  if (!run || !review || input.deliveryRunId !== run.id || input.inputRevision !== request.inputRevision ||
      input.candidateCommit !== review.candidate.candidateCommit || input.candidateDigest !== review.candidate.candidateDigest)
    conflict('Publication must identify the exact current delivery run, input revision and review candidate.');
  if (input.action === 'reconcile_publication') {
    identifier(input.publicationOperationId, 'publication operation ID');
    const publication = run.publications?.find(item => item.operationId === input.publicationOperationId);
    if (!publication || !['pending', 'unknown'].includes(publication.status)) conflict('Only a saved unresolved publication may be reconciled.');
    if (gateDigest(publication.candidate) !== gateDigest(review.candidate)) conflict('The saved publication belongs to another candidate; retain its history and inspect its destination.');
    publication.lastReconciliationOperationId = input.operationId;
    publication.status = 'pending'; publication.updatedAt = iso(); publication.detail = 'Read-only reconciliation was requested for this saved remote operation.';
    store.save(request, 'publication_reconciliation_requested'); return;
  }
  if (!currentRemoteCandidate(request) || remotePublicationPending(run)) conflict('Publication needs a current completed review candidate and no unresolved remote operation.');
  const { snapshot, target, repositoryId } = remoteDeliverySubject(request);
  const action = input.action === 'push_candidate' ? 'push' : 'pull_request';
  if (action === 'push' ? !target.push : !target.pullRequest) conflict('The accepted project policy does not allow this publication action.');
  const confirmed = (kind: 'push' | 'pull_request') => run.publications?.some(item => item.action === kind && item.status === 'confirmed' && gateDigest(item.candidate) === gateDigest(review.candidate));
  if (confirmed(action)) conflict('This candidate already has a confirmed publication for that action. Inspect its recorded result.');
  if (action === 'pull_request' && !confirmed('push')) conflict('Publish and confirm the exact candidate branch before creating its pull request.');
  if ((run.publications?.length ?? 0) >= 32) conflict('This delivery reached its bounded publication history. Retain its evidence and inspect the destination.');
  if (action === 'pull_request') remotePublicationContent(request);
  const predecessor = remotePublicationPredecessor(request, target);
  if (predecessor && predecessor.pullRequest.state !== 'open') conflict('The retained pull request is closed or merged. Use a successor Feature Request for additional work.');
  const at = iso();
  const publication: RemotePublication = { operationId: input.operationId, action, candidate: clone(review.candidate), target: clone(target), repositoryId,
    configurationDigest: snapshot.configurationDigest, ...(predecessor ? { predecessor } : {}), status: 'pending', createdAt: at, updatedAt: at, detail: 'The exact candidate publication intent is saved; its remote outcome is not yet confirmed.' };
  run.publications = [...(run.publications ?? []), publication]; store.save(request, 'publication_requested');
}
export function requestPublicationResult(store: RequestStore, request: WorkerRequest, update: RemotePublicationUpdate) {
  const run = request.delivery, publication = run?.publications?.find(item => item.operationId === update.operationId);
  if (!run || run.id !== update.deliveryRunId || !publication) conflict('The saved publication identity changed before its outcome was recorded.');
  if (publication.status !== 'pending' && publication.status !== 'unknown') {
    if (publication.status === update.result.status && gateDigest(publication.observation ?? null) === gateDigest(update.result.observation ?? null)) return request;
    conflict('A settled publication observation is immutable.');
  }
  const result = update.result;
  if (!['unknown', 'confirmed', 'not_observed', 'failed'].includes(result.status) || typeof result.detail !== 'string' || !result.detail.trim() || result.detail.length > 4000) invalid('Publication outcomes need a bounded state and explanation.');
  if (result.status === 'confirmed') {
    const observation = result.observation;
    if (!observation || observation.branch !== remotePublicationBranch(publication) || observation.commit !== publication.candidate.candidateCommit) conflict('Publication confirmation must identify the exact candidate branch and commit.');
    if (publication.action === 'pull_request' && (!observation.pullRequest || publication.predecessor && observation.pullRequest.number !== publication.predecessor.pullRequest.number || !Number.isSafeInteger(observation.pullRequest.number) || observation.pullRequest.number < 1 ||
      !['open', 'closed', 'merged'].includes(observation.pullRequest.state) || typeof observation.pullRequest.url !== 'string' || observation.pullRequest.url.toLowerCase() !== `https://github.com/${publication.target.repository}/pull/${observation.pullRequest.number}`.toLowerCase()))
      conflict('Pull request confirmation requires the exact GitHub number, URL and observed state.');
    if (publication.action === 'push' && observation.pullRequest) conflict('A branch push cannot confirm pull request creation.');
  } else if (result.observation) invalid('Unconfirmed publication cannot carry a successful remote receipt.');
  if (result.integrityIncident !== undefined && (result.integrityIncident !== 'duplicate_publication' || result.status !== 'unknown')) invalid('An integrity incident requires an observed duplicate publication conflict.');
  if (result.recoveryEvidence !== undefined && (!['confirmed', 'not_observed'].includes(result.status) || result.recoveryEvidence !== (publication.action === 'push' ? 'single_remote_ref' : 'complete_pull_request_lookup'))) invalid('Recovery evidence must match the observed publication action and known remote outcome.');
  const observations: DeliveryMetricObservation[] = [];
  if (result.status === 'unknown' || publication.lastReconciliationOperationId) observations.push({ kind: 'recovery', operationId: publication.operationId, outcome: result.status === 'unknown' ? 'unknown' : 'known',
    // Read-only reconciliation uses exact candidate/branch and complete all-state PR lookup; it never retries a mutation.
    duplicateActions: result.integrityIncident || publication.integrityIncident ? true : publication.lastReconciliationOperationId && result.recoveryEvidence ? false : null });
  if (result.integrityIncident) observations.push({ kind: 'integrity_incident', incidentId: 'publication:' + gateDigest({ candidate: publication.candidate, target: publication.target }), incident: result.integrityIncident });
  Object.assign(publication, clone(result), { updatedAt: iso() });
  if (run.control?.action === 'cancel' && !remotePublicationPending(run) && !run.steps.some(step => ['running', 'outcome_unknown'].includes(step.status))) {
    run.status = 'cancelled'; run.finishedAt = iso(); request.phase = 'cancelled';
  }
  store.save(request, 'publication_' + result.status, { observations }); return request;
}
