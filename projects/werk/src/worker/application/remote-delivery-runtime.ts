import { ObservedDuplicatePublication } from './remote-delivery-integrity.js';
import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import { remotePublicationBranch } from './remote-delivery-contracts.js';
import type { RemoteDeliveryPort, RemotePublication, RemotePublicationAuthorization, RemotePublicationResult } from './remote-delivery-contracts.js';

export function candidatePublicationMarker(publication: Pick<RemotePublication, 'candidate' | 'target'>): string {
  return `<!-- werk-publication:${gateDigest({ candidate: publication.candidate, target: publication.target })} -->`;
}
export function publicationMarker(publication: Pick<RemotePublication, 'candidate' | 'target' | 'predecessor'>): string {
  const identity = { requestId: publication.candidate.requestId, repository: publication.target.repository, base: publication.target.base, branch: remotePublicationBranch(publication) };
  return `<!-- werk-request-publication:${gateDigest(identity)} -->\n${candidatePublicationMarker(publication)}`;
}
/** An explicit retry observes the destination first. A reconciliation action never writes. */
export async function runRemotePublication(input: {
  publication: RemotePublication;
  mode: 'execute' | 'reconcile';
  title: string;
  body: string;
  port: RemoteDeliveryPort;
  authority: RemotePublicationAuthorization;
  signal: AbortSignal;
}): Promise<RemotePublicationResult> {
  const { publication, port, authority, signal } = input, { candidate, target } = publication;
  const authorize = async (mutation = false) => { signal.throwIfAborted(); await authority.authorize(publication.repositoryId, publication.configurationDigest, mutation); };
  const destinationBranch = remotePublicationBranch(publication), predecessor = publication.predecessor;
  const observeBranch = async () => { await authorize(); return port.branch(target, destinationBranch, signal); };
  const observed = { branch: destinationBranch, commit: candidate.candidateCommit };
  try {
    await authorize();
    if (input.mode === 'execute') await port.verify(candidate, signal);
    let branch = await observeBranch();
    if (branch !== null && branch !== candidate.candidateCommit && branch !== predecessor?.candidate.candidateCommit)
      return { status: 'failed', detail: 'The remote branch contains another commit. It was not overwritten; inspect the destination before continuing.' };
    if (publication.action === 'push') {
      if (branch === candidate.candidateCommit) return { status: 'confirmed', recoveryEvidence: 'single_remote_ref', detail: 'The exact candidate commit is present on the remote branch. No pull request, human acceptance or merge is implied.', observation: observed };
      if (input.mode === 'reconcile') return { status: 'not_observed', recoveryEvidence: 'single_remote_ref', detail: 'The candidate branch was not observed remotely. A new explicit push action will inspect it again before attempting publication.' };
      if (!target.push) throw new DomainError('conflict', 'The approved policy does not permit candidate pushes.');
      if (predecessor) {
        if (branch !== predecessor.candidate.candidateCommit) return { status: 'failed', detail: 'The retained PR branch is missing or changed. No branch was recreated or overwritten.' };
        await authorize();
        const prior = await port.findPullRequest({ ...publication, candidate: predecessor.candidate }, signal);
        if (!prior || prior.number !== predecessor.pullRequest.number || prior.state !== 'open')
          return { status: 'failed', detail: 'Only the same open worker pull request can receive review rework.' };
      }
      await authorize(true);
      try { await port.push(target, candidate, signal, predecessor ? { branch: destinationBranch, commit: predecessor.candidate.candidateCommit } : undefined); } catch { /* Observe a possible successful push after a lost acknowledgement. */ }
      branch = await observeBranch();
      return branch === candidate.candidateCommit
        ? { status: 'confirmed', recoveryEvidence: 'single_remote_ref', detail: 'The exact candidate branch push is confirmed. Pull request creation, human acceptance and merge remain separate.', observation: observed }
        : branch === null || branch === predecessor?.candidate.candidateCommit
          ? { status: 'not_observed', recoveryEvidence: 'single_remote_ref', detail: 'The push did not produce an observed candidate branch. Inspect connectivity and authorization; any explicit retry reconciles first.' }
          : { status: 'failed', detail: 'The destination now points to another commit. No further push was attempted.' };
    }
    if (branch !== candidate.candidateCommit) return { status: 'not_observed', detail: 'The exact candidate branch is not present remotely. Publish that branch separately before creating its pull request.' };
    const find = async (previousEvidence = false) => { await authorize(); return port.findPullRequest(publication, signal, previousEvidence); };
    let pullRequest = await find(!!predecessor && input.mode === 'execute');
    if (pullRequest && predecessor && input.mode === 'execute') {
      if (pullRequest.state !== 'open' || pullRequest.number !== predecessor.pullRequest.number || !port.updatePullRequest)
        throw new DomainError('conflict', 'The original open worker PR and its update adapter are required for rework.');
      await authorize(true);
      try { await port.updatePullRequest(publication, input.title, input.body, signal); } catch { /* Observe a potentially successful update before retry. */ }
      pullRequest = await find();
    }
    if (pullRequest) return { status: 'confirmed', recoveryEvidence: 'complete_pull_request_lookup', detail: 'An existing pull request for this exact candidate and destination was reconciled. No duplicate was created.', observation: { ...observed, pullRequest } };
    if (input.mode === 'reconcile') return { status: 'not_observed', recoveryEvidence: 'complete_pull_request_lookup', detail: 'No matching pull request was observed. A new explicit creation action will inspect the destination again before attempting creation.' };
    if (predecessor) return { status: 'not_observed', recoveryEvidence: 'complete_pull_request_lookup', detail: 'The retained PR does not yet carry confirmed evidence for this candidate. A replacement PR was not created; a new explicit update may retry after inspection.' };
    if (!target.pullRequest) throw new DomainError('conflict', 'The approved policy does not permit pull request creation.');
    await authorize(true);
    try { await port.createPullRequest(publication, input.title, input.body, signal); } catch { /* Creation can succeed remotely despite a lost client acknowledgement. */ }
    pullRequest = await find();
    return pullRequest
      ? { status: 'confirmed', recoveryEvidence: 'complete_pull_request_lookup', detail: 'The pull request is confirmed for the exact candidate. Its remote state is observed separately from worker acceptance.', observation: { ...observed, pullRequest } }
      : { status: 'not_observed', recoveryEvidence: 'complete_pull_request_lookup', detail: 'No matching pull request was observed after the creation attempt. Any new explicit attempt must reconcile before creating another.' };
  } catch (error) {
    // CLI/network errors can include private host details. Only worker-authored conflicts are exposed.
    return { status: 'unknown', ...(error instanceof ObservedDuplicatePublication ? { integrityIncident: 'duplicate_publication' as const } : {}), detail: error instanceof DomainError && error.code === 'conflict'
      ? error.message : 'The remote outcome could not be confirmed. Restore connectivity and approved policy, then reconcile this saved operation before retrying.' };
  }
}
