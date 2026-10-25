import { DomainError } from '../../shared/errors.js';
import { FeatureIntakeBlocked } from '../application/feature-intake-measurement.js';
import { localMergeBaselineHold } from '../application/local-merge-baseline.js';
import { localMergeBaselineGit } from '../infrastructure/local-merge-baseline-git.js';
import { localMergeActive } from './workspace-local-merge.js';
import type { WorkspaceContext } from './workspace-context.js';

/** Cursor pagination includes accepted increments beyond the first request catalog page. */
function* retainedRequests(workspace: WorkspaceContext, replayTaskId?: string) {
  const journal = workspace.sessions.requests;
  let after = 0;
  while (true) {
    const page = journal.list({ after, limit: 100 });
    for (const row of page.requests) {
      // An already admitted task may replay a lost submission acknowledgement without becoming a second increment.
      if (replayTaskId && row.owner.taskId === replayTaskId) continue;
      yield journal.get(row.id);
    }
    if (!page.hasMore) return;
    if (page.nextAfter <= after) throw new DomainError('conflict', 'Retained request history pagination did not advance. Restore its catalog before admitting shared work.');
    after = page.nextAfter;
  }
}
/** Shared preparation and final admission both fence the exact source commit used for execution. */
export async function assertLocalMergeBaseline(workspace: WorkspaceContext, repository: string, repositoryId: string, baseline: string, replayTaskId?: string) {
  try {
    if (localMergeActive(workspace, repositoryId)) throw new DomainError('conflict', 'Wait for the active main checkout merge to record its outcome before admitting another shared Feature Request.');
    const signal = AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(30000)]);
    const hold = await localMergeBaselineHold(retainedRequests(workspace, replayTaskId), repositoryId, baseline, localMergeBaselineGit(repository, workspace.config.stateDir, signal));
    if (hold) throw new DomainError('conflict', hold + ' If this request was prepared before the merge, refresh or replace it against the synchronized baseline.');
    if (localMergeActive(workspace, repositoryId)) throw new DomainError('conflict', 'A main checkout merge started during baseline inspection. Recheck this request after its outcome is recorded.');
  } catch (error) { throw new FeatureIntakeBlocked(error, 'local_merge_baseline', 'dependency'); }
}
