import { DomainError } from '../../shared/errors.js';
import { FeatureGitIo, commitId } from './features/git-io.js';

/** Observe literal committed ancestry without changing a branch, checkout or remote. */
export function localMergeBaselineGit(repository: string, stateDirectory: string, signal: AbortSignal) {
  const io = new FeatureGitIo({ repository, stateDirectory, remote: 'origin', literalObjects: true });
  return async (commit: string, baseline: string): Promise<boolean> => {
    if (!commitId(commit) || !commitId(baseline)) throw new DomainError('conflict', 'Retained merge and request baseline identities must be full Git commit IDs.');
    const root = await io.root(signal), result = await io.git(root.path, ['merge-base', '--is-ancestor', commit, baseline], signal, undefined, true);
    if (![0, 1].includes(result.exitCode ?? -1)) throw new DomainError('conflict', 'The accepted main checkout merge or selected request baseline cannot be inspected. Restore its Git objects and recheck intake; the worker will preserve its retained merge history.');
    return result.exitCode === 0;
  };
}
