import type { FeatureRequestDetail } from './store';
import type { LocalTaskDetailView, LocalTaskboardView } from '../application/workspace-view';
import type { WorkerRequest } from '../application/request-gates';
import type { SharedFeatureView, SharedIntakeView } from '../application/shared-intake-contract';

interface ReviewIdentity { sessionId: string; fileId: string }
export interface FeatureReviewSnapshot {
  session: FeatureRequestDetail['session'];
  chat: FeatureRequestDetail['chat'];
  task: LocalTaskDetailView | null;
  request: WorkerRequest | null;
  shared: SharedFeatureView | null;
}
type Read = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
/** Repeated query values are ambiguous; never silently inspect a different request. */
export function reviewIdentity(query: Record<string, unknown>): ReviewIdentity {
  const one = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  return { sessionId: one(query.session), fileId: one(query.fileId) };
}
export function reviewActionHref(action: string | undefined, sessionId: string): string {
  if (action === 'answer' || action === 'resume') return '/request?session=' + encodeURIComponent(sessionId);
  if (action === 'inspect_history') return '/history?view=runs&runSession=' + encodeURIComponent(sessionId);
  if (action === 'inspect_checks') return '#review-checks';
  if (action === 'delivery_controls') return '#review-decision';
  if (action === 'review_patch') return '#review-changes';
  if (action === 'review_shared' || action === 'open_source') return '#review-handoff';
  return '#review-decision';
}
/** Read-only joins use retained identity, never the browser's selected conversation. */
export async function readFeatureReview(identity: ReviewIdentity, read: Read): Promise<FeatureReviewSnapshot> {
  let task: LocalTaskDetailView | null = null;
  if (identity.fileId) {
    task = await read<LocalTaskDetailView>('/api/taskboard/detail', 'POST', { id: identity.fileId });
    if (task.id !== identity.fileId || identity.sessionId && task.sessionId !== identity.sessionId)
      throw new Error('The saved task does not belong to this feature request. Return to Workboard and open it again.');
  }
  const sessionId = identity.sessionId || task?.sessionId;
  if (!sessionId) throw new Error('Choose a feature request from Workboard to open its review.');
  const detail = await read<FeatureRequestDetail>('/api/tasks', 'POST', { action: 'get', id: sessionId });
  if (detail.session.id !== sessionId) throw new Error('The returned conversation does not match this feature request.');
  const session = detail.session;
  if (!task && session.kind === 'local') {
    const board = await read<LocalTaskboardView>('/api/taskboard');
    const matching = board.tasks.filter(item => item.sessionId === session.id);
    if (matching.length !== 1) throw new Error('The local task for this conversation is unavailable or ambiguous. Return to Workboard and open it again.');
    task = await read('/api/taskboard/detail', 'POST', { id: matching[0]!.id });
    if (!task || task.id !== matching[0]!.id) throw new Error('The returned local task does not match this conversation.');
  }
  // Local catalog taskId historically aliases its own session ID; the board owns the actual task ID.
  if (task && (task.sessionId !== session.id || session.kind !== 'local' || ![task.id, session.id].includes(session.taskId)))
    throw new Error('Task and conversation identities no longer agree. Refresh this review before continuing.');
  if (session.interaction?.sessionId && session.interaction.sessionId !== session.id || task?.interaction?.sessionId && task.interaction.sessionId !== session.id)
    throw new Error('Interaction evidence belongs to another conversation. Refresh before continuing.');
  const references = [session.feature, task?.feature].filter(reference => !!reference);
  if (references.some(reference => (['key', 'id', 'source', 'scope', 'repositoryId'] as const).some(field => reference[field] !== references[0]![field])))
    throw new Error('Feature Request identities do not agree. Refresh to inspect one matching request.');
  const feature = session.feature ?? task?.feature;
  if (task?.requestId && session.requestId && task.requestId !== session.requestId)
    throw new Error('The accepted request changed while this review was loading. Refresh to see its current scope.');
  const requestId = session.requestId ?? task?.requestId;
  const request = requestId ? await read<WorkerRequest>('/api/requests', 'POST', { action: 'get', requestId }) : null;
  if (request && (request.id !== requestId || request.owner.sessionId !== session.id ||
    feature && request.owner.featureId && request.owner.featureId !== feature.key ||
    task && request.owner.taskId && request.owner.taskId !== task.id ||
    session.requestRevision !== undefined && request.revision !== session.requestRevision))
    throw new Error('Request evidence changed while loading. Refresh to review one matching request revision.');
  let shared: SharedFeatureView | null = null;
  if (feature?.source === 'shared_git') {
    const projectId = feature.repositoryId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(projectId)))
      throw new Error('The retained Feature Request project identity is invalid. Refresh before continuing.');
    const intake = await read<SharedIntakeView>('/api/shared-intake' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : ''));
    if (projectId && intake.config?.repositoryId !== projectId)
      throw new Error('Shared Feature Request project identity changed. Refresh to inspect its assigned project.');
    const matching = intake.requests.filter(item => item.feature?.key === feature.key);
    if (matching.length !== 1) throw new Error('Shared Feature Request ownership is unavailable. Refresh before making a decision.');
    shared = matching[0]!;
    if (!shared.isLocal || shared.feature && (['id', 'source', 'scope', 'repositoryId'] as const).some(field => shared!.feature![field] !== feature[field]))
      throw new Error('Shared Feature Request ownership changed. Refresh to inspect its current owner.');
    if (shared.taskId && task && shared.taskId !== task.id)
      throw new Error('Shared Feature Request task identity changed. Refresh before continuing.');
  }
  return { session, chat: detail.chat, task, request, shared };
}
