import type { WorkerSettings } from '../infrastructure/settings';
import type { WorkerSessions } from '../application/sessions';
import type { LocalTaskboard } from '../application/local-tasks';
import { reactive } from 'vue';
import type { Status } from '../status/server';
import type { WorkerWorkspace } from '../status/workspace';
import type { WorkerConversation } from '../application/conversation';
import type { workerMonitoring } from '../status/server';
export type HistoryRow = Awaited<ReturnType<WorkerWorkspace['history']>>['rows'][number];
export const state = reactive({
  settings: null as ReturnType<WorkerSettings['publicView']> | null, sessions: null as ReturnType<WorkerSessions['view']> | null, board: null as ReturnType<LocalTaskboard['view']> | null,
  status: null as Status | null, environment: null as Awaited<ReturnType<WorkerWorkspace['environment']>> | null,
  history: null as Awaited<ReturnType<WorkerWorkspace['history']>> | null,
  chat: null as ReturnType<WorkerConversation['snapshot']> | null,
  monitoring: null as ReturnType<typeof workerMonitoring> | null,
  workspaceBusy: false, unlocked: false, paused: false, loading: false, error: '', actionError: '', lastRead: '', draft: '',
});
let token = '', generation = 0;
const drafts = new Map<string, string>();
function adoptSessions(sessions: NonNullable<typeof state.sessions>) {
  if (sessions.selected !== state.sessions?.selected) {
    if (state.sessions?.selected) drafts.set(state.sessions.selected, state.draft);
    state.draft = drafts.get(sessions.selected) ?? '';
  }
  state.sessions = sessions;
}
export function taskStatus(value: string) { return ({ draft: 'Draft', queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[value] ?? value); }
export async function newTask() {
  const current = state.sessions?.records.find(item => item.id === state.sessions?.selected);
  const provider = current?.provider ?? state.settings?.providers.find(item => item.configured)?.id ?? 'codex-cli';
  return workspaceAction('/api/sessions', { action: 'create', title: 'New task', provider });
}
async function request(path: string, method = 'GET', body?: unknown, credential = token) {
  const response = await fetch(path, { method, cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && credential === token) lock(); throw Error(data.error ?? `Request failed (${response.status})`); }
  return data;
}
export function lock() { generation++; token = ''; state.unlocked = false; state.environment = null; state.history = null; state.chat = null; state.settings = null; state.sessions = null; state.board = null; state.draft = ''; drafts.clear(); state.actionError = ''; state.workspaceBusy = false; }
export async function unlock(candidate: string) {
  const environment = await request('/api/environment', 'GET', undefined, candidate.trim());
  generation++; token = candidate.trim(); state.environment = environment; state.unlocked = true;
  await refresh();
}
export async function refresh() {
  if (state.loading) return;
  state.loading = true; const current = generation;
  try {
    const [status, monitoring, environment, history, chat, settings, sessions, board] = await Promise.all([request('/status'), request('/monitoring'), ...(state.unlocked ? [request('/api/environment'), request('/api/history'), request('/api/chat'), request('/api/settings'), request('/api/sessions'), request('/api/taskboard')] : [])]);
    if (current !== generation) return;
    state.status = status; state.monitoring = monitoring;
    if (state.unlocked) { state.environment = environment; state.history = history; state.chat = chat; state.settings = settings; adoptSessions(sessions); state.board = board; }
    state.error = ''; state.lastRead = new Date().toISOString();
  } catch (error) { if (current === generation) state.error = error instanceof Error ? error.message : 'Worker could not be reached. Check the process and retry.'; }
  finally { state.loading = false; }
}
export async function chatAction(action: 'send' | 'cancel') {
  if (state.workspaceBusy) return;
  state.actionError = ''; let current = generation; const sessionId = state.sessions?.selected, draft = state.draft;
  try {
    const result = await request(action === 'send' ? '/api/chat' : '/api/chat/cancel', 'POST', action === 'send' ? { message: draft, sessionId } : { sessionId });
    if (current !== generation || sessionId !== state.sessions?.selected) return;
    const applied = ++generation; current = applied;
    state.chat = result;
    if (action === 'send' && state.draft === draft) { state.draft = ''; if (sessionId) drafts.delete(sessionId); }
    const sessions = await request('/api/sessions');
    if (applied === generation) adoptSessions(sessions);
  } catch (error) { if (current === generation) state.actionError = error instanceof Error ? error.message : 'The action failed. Refresh before trying again.'; await refresh(); }
}
export async function workspaceAction(path: string, body: unknown): Promise<any> {
  if (path === '/api/sessions' && state.workspaceBusy) return;
  if (path === '/api/sessions') state.workspaceBusy = true;
  state.actionError = ''; let current = generation;
  try {
    const result = await request(path, 'POST', body); if (current !== generation) return;
    if (path === '/api/settings' || path === '/api/sessions' || path === '/api/taskboard' || path === '/api/taskboard/action') {
      const applied = ++generation; current = applied; // Ignore reads captured before the acknowledged mutation.
      if (path === '/api/settings') state.settings = result;
      else if (path === '/api/sessions') adoptSessions(result);
      else state.board = result;
      if (path === '/api/settings' || path === '/api/sessions') { const chat = await request('/api/chat'); if (applied !== generation) return; state.chat = chat; }
    }
    await refresh(); return result;
  }
  catch (error) { if (current === generation) state.actionError = error instanceof Error ? error.message : 'Action failed. Refresh and retry.'; }
  finally { if (path === '/api/sessions') state.workspaceBusy = false; }
}
export const bytes = (value: number | null | undefined) => value == null ? 'Unavailable' : value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GiB` : `${(value / 1048576).toFixed(1)} MiB`;
export const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
export const duration = (value: number | null | undefined) => value == null ? 'Unavailable' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
export const outcome = (value: string) => ({ simulated: 'Simulated', change_set: 'Review required', 'change-set': 'Review required', failed: 'Failed', interrupted: 'Interrupted', running: 'Running', incomplete: 'Incomplete evidence' }[value] ?? value.replaceAll('_', ' '));
