import { stopSessionProcesses } from './workspace-processes.js';
import type { WorkspaceContext } from './workspace-context.js';
import { publicTaskConversation } from '../application/public-task-transcript.js';
import { object, identifier } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import { assertDirectFeatureCreation, isSharedFeatureSession } from './workspace-feature-authoring.js';
import { withRepositoryAdmission } from './workspace-settings.js';

/** Keep Markdown projections current before acknowledging task commands, including partial failures. */
export async function withFeatureTracking<T>(workspace: WorkspaceContext, action: () => Promise<T>): Promise<T>{
  try { return await action(); } finally { await workspace.featureTracking.sync(); }
}

export function taskDetail(workspace: WorkspaceContext, id: string){
  const detail = workspace.sessions.detail(id);
  const task = detail.session.kind === 'local' ? workspace.board.view().tasks.find(item => item.sessionId === id) : undefined;
  const local = task && workspace.board.executionDetail(task.id);
  return { ...detail, chat: publicTaskConversation(detail.chat, local ? { instruction: local.instruction, paths: local.admissionFailure?.paths ?? local.files.map(file => file.path) } : undefined) };
}

export function chatSnapshot(workspace: WorkspaceContext, id = workspace.sessions.current.id){ return taskDetail(workspace, id).chat; }

export async function cancelChat(workspace: WorkspaceContext){
  const id = workspace.sessions.current.id;
  await withFeatureTracking(workspace, () => workspace.chat.cancel());
  await stopSessionProcesses(workspace, id);
  return chatSnapshot(workspace, id);
}

export async function chatSession(workspace: WorkspaceContext){
  await workspace.featureTracking.sync();
  return { sessions: workspace.sessions.view(), chat: chatSnapshot(workspace) };
}

export async function featureTrackingCommand(workspace: WorkspaceContext, input: unknown){
  const body = object(input, 'Feature tracking command', ['action', 'sessionId']);
  if (body.action !== 'get') throw new DomainError('invalid_input', 'Use get with a task session ID.');
  const id = identifier(body.sessionId, 'sessionId');
  workspace.sessions.detail(id);
  await workspace.featureTracking.sync();
  return workspace.featureTracking.get(id);
}

export function taskboardDetail(workspace: WorkspaceContext, id: string){
  return workspace.board.detail(id);
}

export async function taskboardAction(workspace: WorkspaceContext, input: unknown){
  if ((input as Record<string, unknown> | null)?.action === 'retry') {
    const id = String((input as Record<string, unknown>).id);
    const task = workspace.board.view().tasks.find(item => item.id === id);
    if (task && isSharedFeatureSession(workspace, task.sessionId))
      throw new DomainError('conflict', 'Continue this shared Feature Request through its current Task checkpoint in the interaction controls or Markdown note.');
    return withRepositoryAdmission(workspace, () => workspace.board.action(input));
  }
  const result = await workspace.board.action(input);
  await workspace.processes?.reconcileGrants();
  return result;
}

export function assertTaskCanContinue(workspace: WorkspaceContext, sessionId: string){
  const reason = workspace.sessions.view().records.find(session => session.id === sessionId)?.continuationBlockedReason;
  if (reason) throw new DomainError('conflict', reason);
  const task = workspace.board.view().tasks.find(task => task.sessionId === sessionId);
  if (task?.admissionFailure)
    throw new DomainError('conflict', task.error ?? 'This interrupted request has no accepted file snapshots. Inspect its retained worktree and create a new request.');
}

export async function startChat(workspace: WorkspaceContext, message: unknown){
  if (workspace.configurationUpdating || workspace.executionProfiles?.pending())
    throw new DomainError("conflict", "Finish the execution profile change before starting new work.");
  if (!workspace.acceptingTasks)
    throw new DomainError("unavailable", "Worker is stopping.");
  if (
    (workspace.sessions.admissionActive ?? workspace.sessions.chatActive) + workspace.board.active >=
    workspace.settings.value.board.queueCapacity
  )
    throw new DomainError("conflict", "Worker task queue is full.");
  const id = workspace.sessions.current.id;
  if (isSharedFeatureSession(workspace, id))
    throw new DomainError('conflict', 'Use this Feature Request’s current Task checkpoint to answer or resume. Create a new Feature Request for new scope.');
  if (!workspace.sessions.detail(id).chat.messages.length) assertDirectFeatureCreation(workspace);
  assertTaskCanContinue(workspace, id);
  await withFeatureTracking(workspace, () => workspace.sessions.start(message, id));
  return chatSnapshot(workspace, id);
}
