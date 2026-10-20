import type { SharedFeatureAuthoring } from '../application/feature-authoring.js';
import { identifier } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { WorkspaceContext } from './workspace-context.js';
import { withRepositoryAdmission } from './workspace-settings.js';

/** Transport selection cannot create an alternate lifecycle for a bound project. */
export function assertDirectFeatureCreation(workspace: WorkspaceContext, input?: unknown) {
  const body = input as { projectId?: unknown; repository?: unknown; files?: { repository?: unknown }; id?: unknown } | undefined;
  const repository = body?.repository ?? body?.files?.repository;
  const retained = typeof body?.id === 'string' ? workspace.sessions.view().records.find(record => record.id === body.id) : undefined;
  const projectId = body?.projectId ?? retained?.feature?.repositoryId;
  const project = projectId !== undefined ? workspace.featureProjects.resolve(identifier(projectId, 'projectId')) : typeof repository === 'string' ? workspace.featureProjects.forRepository(repository) ?? workspace.featureProjects.primary : workspace.featureProjects.primary;
  if (project.sharedRuntime.intake.binding?.repositoryId)
    throw new DomainError('conflict', 'Shared Git intake owns this project’s Feature Requests. Use New request in the webview or feature prepare/publish to save the project template and publish it before execution.');
}

export function isSharedFeatureSession(workspace: WorkspaceContext, sessionId: string) {
  const session = workspace.sessions.view().records.find(item => item.id === sessionId);
  if (session?.feature?.source === 'shared_git') return true;
  const task = workspace.board.view().tasks.find(item => item.sessionId === sessionId);
  const taskId = task?.id ?? (session?.kind === 'local' && sessionId.startsWith('local-') ? sessionId.slice(6) : undefined);
  return !!taskId && !!workspace.featureProjects.sharedForTask(taskId, session?.feature?.key);
}

/** Authoring publishes the canonical note; shared intake alone owns its admission. */
export async function authorFeature(workspace: WorkspaceContext, input: unknown) {
  if (!workspace.acceptingTasks) throw new DomainError('unavailable', 'Worker is stopping.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('invalid_input', 'Feature authoring requires a command.');
  const { projectId, ...command } = input as Record<string, unknown>;
  const project = workspace.featureProjects.resolve(projectId === undefined ? undefined : identifier(projectId, 'projectId'));
  const authoring: SharedFeatureAuthoring = project.sharedRuntime.authoring;
  return withRepositoryAdmission(workspace, () => authoring.command(command));
}
