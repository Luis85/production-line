import { DomainError } from '../../shared/errors.js';
import type { WorkspaceContext } from './workspace-context.js';
import { withRepositoryAdmission } from './workspace-settings.js';

/** Transport selection cannot create an alternate lifecycle for a bound project. */
export function assertDirectFeatureCreation(workspace: WorkspaceContext) {
  if (workspace.sharedRuntime.intake.binding?.repositoryId)
    throw new DomainError('conflict', 'Shared Git intake owns this project’s Feature Requests. Use New request in the webview or feature prepare/publish to save the project template and publish it before execution.');
}

export function isSharedFeatureSession(workspace: WorkspaceContext, sessionId: string) {
  const session = workspace.sessions.view().records.find(item => item.id === sessionId);
  if (session?.feature?.source === 'shared_git') return true;
  const task = workspace.board.view().tasks.find(item => item.sessionId === sessionId);
  const taskId = task?.id ?? (session?.kind === 'local' && sessionId.startsWith('local-') ? sessionId.slice(6) : undefined);
  return !!taskId && !!workspace.sharedRuntime.intake.referenceForTask(taskId, session?.feature?.key);
}

/** Authoring publishes the canonical note; shared intake alone owns its admission. */
export async function authorFeature(workspace: WorkspaceContext, input: unknown) {
  if (!workspace.acceptingTasks) throw new DomainError('unavailable', 'Worker is stopping.');
  return withRepositoryAdmission(workspace, () => workspace.sharedRuntime.authoring.command(input));
}
