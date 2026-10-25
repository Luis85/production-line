import { DomainError } from '../../shared/errors.js';
import type { DeliveryCandidate } from '../application/delivery-review-contracts.js';
import { remoteDeliveryBranch, validateRemoteDeliveryPolicy, type RemoteDeliveryPolicy } from '../application/remote-delivery-policy.js';
import { FeatureGitIo, commitId } from './features/git-io.js';

const conflict = (message: string): never => { throw new DomainError('conflict', message); };
/** Only an exact configured GitHub destination is eligible; credentials never appear in receipt data. */
function githubRemoteRepository(value: string): string | null {
  const scp = /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(value);
  if (scp) return scp[1]!;
  try {
    const url = new URL(value);
    if (url.hostname !== 'github.com' || url.port || url.search || url.hash || url.password ||
      !['https:', 'ssh:'].includes(url.protocol) || url.protocol === 'https:' && url.username || url.protocol === 'ssh:' && url.username !== 'git') return null;
    return /^\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}
/** The remote name resolves immediately before each operation; push uses an absent-ref or exact predecessor lease. */
export function createRemoteDeliveryGit(options: { repository: string; stateDirectory: string; authorize?: (mutation: boolean) => void | Promise<void> }, io = new FeatureGitIo({ ...options, remote: 'origin' })) {
  async function destination(target: RemoteDeliveryPolicy, signal: AbortSignal) {
    validateRemoteDeliveryPolicy(target);
    const root = await io.root(signal);
    const urls = (await io.output(root.path, ['remote', 'get-url', '--push', '--all', target.remote], signal)).trim().split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1 || githubRemoteRepository(urls[0]!)?.toLowerCase() !== target.repository.toLowerCase())
      conflict('The configured Git push destination does not match the approved GitHub repository. No publication was attempted.');
    return { root, url: urls[0]! };
  }
  return {
    async branch(target: RemoteDeliveryPolicy, branch: string, signal: AbortSignal): Promise<string | null> {
      remoteDeliveryBranch(branch);
      const { root, url } = await destination(target, signal), ref = `refs/heads/${branch}`;
      await options.authorize?.(false); signal.throwIfAborted();
      const lines = (await io.output(root.path, ['ls-remote', '--refs', '--', url, ref], signal)).trim().split(/\r?\n/).filter(Boolean);
      if (!lines.length) return null;
      const [commit, actual] = lines[0]!.split(/\s+/);
      if (lines.length !== 1 || actual !== ref || !commitId(commit ?? '')) conflict('The remote branch response could not establish its exact commit.');
      return commit!;
    },
    async push(target: RemoteDeliveryPolicy, candidate: DeliveryCandidate, signal: AbortSignal, previous?: { branch: string; commit: string }): Promise<void> {
      if (!target.push || !commitId(candidate.candidateCommit) || !candidate.branch.startsWith('werk/delivery/')) conflict('Only an explicitly authorized worker delivery candidate may be pushed.');
      const branch = previous?.branch ?? candidate.branch;
      remoteDeliveryBranch(branch);
      if (!branch.startsWith('werk/delivery/') || previous && !commitId(previous.commit)) conflict('A branch update requires an exact retained worker predecessor.');
      const { root, url } = await destination(target, signal), ref = `refs/heads/${branch}`;
      await options.authorize?.(true); signal.throwIfAborted();
      // Initial publication is create-only; rework replaces only its exact retained prior head.
      await io.output(root.path, ['push', '--porcelain', '--no-verify', '--no-follow-tags', `--force-with-lease=${ref}:${previous?.commit ?? ''}`, '--', url, `${candidate.candidateCommit}:${ref}`], signal);
    },
  };
}
