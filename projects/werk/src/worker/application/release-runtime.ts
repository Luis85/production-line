import { DomainError } from '../../shared/errors.js';
import type { ReleaseAuthority, ReleaseMergeReceipt, ReleaseOperation, ReleasePort, ReleaseResult } from './release-contracts.js';

const conflict = (message: string): never => { throw new DomainError('conflict', message); };
/** Durable intents are created by the request journal before any adapter is invoked. Reconciliation only reads. */
export async function runReleaseOperation(input: { operation: ReleaseOperation; mode: 'execute' | 'reconcile'; port: ReleasePort; authority: ReleaseAuthority; signal: AbortSignal }): Promise<ReleaseResult> {
  const { operation, mode, port, authority, signal } = input;
  const authorize = async (mutation = false) => { signal.throwIfAborted(); await authority.authorize(operation.repositoryId, operation.configurationDigest, mutation); };
  try {
    await authorize();
    const observe = async () => { await authorize(); return port.pullRequest(operation, signal); };
    let pull = await observe();
    if (pull.number !== operation.pullRequest.number || pull.url !== operation.pullRequest.url || pull.branch !== operation.pullRequest.branch || pull.base !== operation.target.base || pull.headCommit !== operation.candidate.candidateCommit)
      conflict('The pull request head, branch or destination changed after human acceptance. Rework and verify the new candidate before merging.');
    const merged = (): ReleaseMergeReceipt => {
      if (!pull.merged || !pull.mergeCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pull.mergeCommit) || !pull.mergedAt || !Number.isFinite(Date.parse(pull.mergedAt))) conflict('The exact accepted pull request merge has not been established.');
      return { pullRequest: pull.number, headCommit: pull.headCommit, mergeCommit: pull.mergeCommit!, url: pull.url, mergedAt: pull.mergedAt! };
    };
    if (operation.action === 'merge') {
      if (pull.merged) return { status: 'confirmed', detail: 'The accepted pull request merge is confirmed at its actual merged commit.', merge: merged() };
      if (pull.closed) return { status: 'failed', detail: 'The accepted pull request was closed without merging.' };
      if (mode === 'reconcile') return { status: 'not_observed', detail: 'The accepted pull request remains open. No merge was retried.' };
      await authorize(true);
      try { await port.merge(operation, signal); } catch { /* A lost acknowledgement must be observed before any retry. */ }
      pull = await observe();
      if (pull.headCommit !== operation.candidate.candidateCommit || pull.branch !== operation.pullRequest.branch || pull.base !== operation.target.base) conflict('The pull request changed while its merge outcome was being observed.');
      return pull.merged ? { status: 'confirmed', detail: 'The Git host confirmed the accepted candidate merge.', merge: merged() }
        : { status: 'not_observed', detail: pull.closed ? 'The pull request closed without an observed merge.' : 'No merge was observed. Review Git host checks and merge protections before a separate retry.' };
    }
    const integration = merged();
    if (integration.mergeCommit !== operation.mergeCommit) conflict('The merged commit differs from the retained release intent.');
    if (operation.action === 'build') {
      await authorize();
      const previous = await port.inspectBuild(operation, signal);
      if (previous) return { status: 'confirmed', detail: 'The exact merged-commit build and artifact manifest were recovered.', built: previous };
      if (mode === 'reconcile') return { status: 'unknown', detail: 'No completed build receipt exists. Inspect and stop any surviving build process before explicitly confirming it stopped.' };
      await authorize(true);
      const built = await port.build(operation, signal);
      return { status: 'confirmed', detail: 'The exact merged commit built successfully and its artifact checksums are retained.', built };
    }
    await authorize();
    let published = await port.inspectRelease(operation, signal);
    if (published) return { status: 'confirmed', detail: 'The exact published release and complete checksummed asset set were observed.', published };
    if (mode === 'reconcile') return { status: 'not_observed', detail: 'The exact release is not published. A separate explicit action may resume its owned draft.' };
    await authorize(true);
    try { await port.publish(operation, signal); } catch { /* Reconcile a possibly successful publication before another mutation. */ }
    await authorize(); published = await port.inspectRelease(operation, signal);
    return published ? { status: 'confirmed', detail: 'The release is published with the exact retained merged commit and artifact checksums.', published }
      : { status: 'not_observed', detail: 'A published release with the complete expected asset set was not observed. Any draft remains available for a separate retry.' };
  } catch (error) {
    return { status: error instanceof DomainError && error.code === 'conflict' ? 'failed' : 'unknown',
      detail: error instanceof DomainError && ['conflict', 'invalid_input'].includes(error.code) ? error.message : 'The release operation outcome could not be established. Restore access and reconcile its saved intent before retrying.' };
  }
}
