import type { WorkerRequest } from './request-gates.js';
import { localMergePending } from './local-merge-contracts.js';

type MergeHistory = Pick<WorkerRequest, 'input' | 'delivery'>;
/** New shared work must include every locally accepted increment; observing Git never publishes main. */
export async function localMergeBaselineHold(
  requests: Iterable<MergeHistory>, repositoryId: string, baseline: string,
  containsCommit: (commit: string, baseline: string) => Promise<boolean>,
): Promise<string | null> {
  const commits = new Set<string>();
  for (const request of requests) {
    const context = request.input.context as { repositoryId?: unknown } | undefined;
    if (context?.repositoryId !== repositoryId) continue;
    const state = request.delivery?.localMerge;
    if (localMergePending(state)) return 'Reconcile the retained main checkout merge before admitting another shared Feature Request.';
    if (state?.merged) commits.add(state.merged.mergeCommit);
  }
  for (const commit of commits) if (!await containsCommit(commit, baseline))
    return 'Publish or synchronize the accepted main checkout merge to the shared branch, then recheck intake before starting another Feature Request. The worker does not push main automatically.';
  return null;
}
