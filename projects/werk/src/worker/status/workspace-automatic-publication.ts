import { gateDigest, type RequestCommand } from '../application/request-gates.js';
import { remoteDeliverySubject } from '../application/remote-delivery-view.js';
import { publicationView, publishRequest } from './workspace-publication.js';
import type { WorkspaceContext } from './workspace-context.js';

interface Cursor { at: number; offset: number; pending?: Promise<void>; }
const cursors = new WeakMap<WorkspaceContext, Cursor>();
/** An approved opt-in permits one attempt per immutable candidate; uncertain/failed operations need an operator. */
export function tickAutomaticPublication(workspace: WorkspaceContext, ports: { view?: typeof publicationView; publish?: typeof publishRequest; now?: () => number } = {}): Promise<void> {
  const viewPublication = ports.view ?? publicationView, publish = ports.publish ?? publishRequest, now = ports.now ?? Date.now;
  let cursor = cursors.get(workspace);
  if (!cursor) { cursor = { at: 0, offset: 0 }; cursors.set(workspace, cursor); }
  if (cursor.pending) return cursor.pending;
  if (now() - cursor.at < 1000 || !workspace.acceptingTasks || workspace.nativeWorkState !== 'ready' || workspace.configurationUpdating || workspace.repositoriesUpdating || workspace.executionProfiles?.pending()) return Promise.resolve();
  cursor.at = now();
  const selected = cursor;
  const run = async () => {
    const page = workspace.sessions.requests.list({ limit: 25, offset: selected.offset });
    selected.offset = page.nextOffset ?? 0;
    for (const summary of page.rows) {
      if (!workspace.acceptingTasks || !['review', 'done'].includes(summary.phase)) continue;
      try {
        let request = workspace.sessions.requests.get(summary.id);
        const { target } = remoteDeliverySubject(request);
        if (!target.automatic || request.delivery?.holds.length || request.delivery?.control) continue;
        for (const action of ['push_candidate', 'create_pull_request'] as const) {
          const view = await viewPublication(workspace, request.id), candidate = view.candidate;
          if (!candidate || !view.authorized || (action === 'push_candidate' ? !view.canPush : !view.canCreatePullRequest)) continue;
          const kind = action === 'push_candidate' ? 'push' : 'pull_request';
          if (view.publications.some(item => item.action === kind && gateDigest(item.candidate) === gateDigest(candidate))) continue;
          const command: RequestCommand = { action, requestId: request.id, expectedRevision: request.revision,
            operationId: 'auto-' + kind + '-' + gateDigest(candidate).slice(0, 32), deliveryRunId: candidate.runId,
            inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest };
          const result = await publish(workspace, command);
          request = result.request;
        }
      } catch { /* Policy, stale source and remote failures stay in their existing request/operator surfaces. */ }
    }
  };
  selected.pending = run().finally(() => { selected.pending = undefined; });
  return selected.pending;
}
