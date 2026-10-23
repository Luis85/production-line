import { ObservedDuplicatePublication } from './remote-delivery-integrity.js';
import { DomainError } from '../../shared/errors.js';
import { gateDigest } from './request-gates.js';
import type { RemoteDeliveryPort, RemotePublication, RemotePublicationAuthorization, RemotePublicationResult } from './remote-delivery-contracts.js';

export function publicationMarker(publication: Pick<RemotePublication, 'candidate' | 'target'>): string {
  return `<!-- werk-publication:${gateDigest({ candidate: publication.candidate, target: publication.target })} -->`;
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
  const observeBranch = async () => { await authorize(); return port.branch(target, candidate.branch, signal); };
  const observed = { branch: candidate.branch, commit: candidate.candidateCommit };
  try {
    await authorize();
    if (input.mode === 'execute') await port.verify(candidate, signal);
    let branch = await observeBranch();
    if (branch !== null && branch !== candidate.candidateCommit)
      return { status: 'failed', detail: 'The remote branch contains another commit. It was not overwritten; inspect the destination before continuing.' };
    if (publication.action === 'push') {
      if (branch === candidate.candidateCommit) return { status: 'confirmed', recoveryEvidence: 'single_remote_ref', detail: 'The exact candidate commit is present on the remote branch. No pull request, human acceptance or merge is implied.', observation: observed };
      if (input.mode === 'reconcile') return { status: 'not_observed', recoveryEvidence: 'single_remote_ref', detail: 'The candidate branch was not observed remotely. A new explicit push action will inspect it again before attempting publication.' };
      if (!target.push) throw new DomainError('conflict', 'The approved policy does not permit candidate pushes.');
      await authorize(true);
      try { await port.push(target, candidate, signal); } catch { /* Observe a possible successful push after a lost acknowledgement. */ }
      branch = await observeBranch();
      return branch === candidate.candidateCommit
        ? { status: 'confirmed', recoveryEvidence: 'single_remote_ref', detail: 'The exact candidate branch push is confirmed. Pull request creation, human acceptance and merge remain separate.', observation: observed }
        : branch === null
          ? { status: 'not_observed', recoveryEvidence: 'single_remote_ref', detail: 'The push did not produce an observed candidate branch. Inspect connectivity and authorization; any explicit retry reconciles first.' }
          : { status: 'failed', detail: 'The destination now points to another commit. No further push was attempted.' };
    }
    if (branch !== candidate.candidateCommit) return { status: 'not_observed', detail: 'The exact candidate branch is not present remotely. Publish that branch separately before creating its pull request.' };
    const find = async () => { await authorize(); return port.findPullRequest(publication, signal); };
    let pullRequest = await find();
    if (pullRequest) return { status: 'confirmed', recoveryEvidence: 'complete_pull_request_lookup', detail: 'An existing pull request for this exact candidate and destination was reconciled. No duplicate was created.', observation: { ...observed, pullRequest } };
    if (input.mode === 'reconcile') return { status: 'not_observed', recoveryEvidence: 'complete_pull_request_lookup', detail: 'No matching pull request was observed. A new explicit creation action will inspect the destination again before attempting creation.' };
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
