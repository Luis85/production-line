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
  definitions: [] as AgentDefinition[], accessChecked: false, accessMessage: '', workspaceBusy: false, unlocked: false, paused: false, loading: false, error: '', actionError: '', lastRead: '', draft: '',
});
let generation = 0;
const drafts = new Map<string, string>();
function adoptSessions(sessions: NonNullable<typeof state.sessions>) {
  if (sessions.selected !== state.sessions?.selected) {
    if (state.sessions?.selected) drafts.set(state.sessions.selected, state.draft);
    state.draft = drafts.get(sessions.selected) ?? '';
  }
  state.sessions = sessions;
}
export function taskStatus(value: string) { return ({ draft: 'Draft', queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[value] ?? value); }
export interface DefinitionAgent { name: string; description: string; instruction: string; model: string; provider: string; unsupported: string[]; requiresAdaptation: boolean; }
export interface AgentDefinition { id: string; name: string; digest: string; createdAt: string; agents: DefinitionAgent[]; }
export async function newTask(options: { provider?: string; title?: string; definitionId?: string; agent?: string; useInstructionsOnly?: boolean } = {}) {
  const current = state.sessions?.records.find(item => item.id === state.sessions?.selected);
  const provider = current?.provider ?? state.settings?.providers.find(item => item.configured)?.id ?? 'codex-cli';
  return workspaceAction('/api/sessions', { action: 'create', title: 'New task', provider, ...options });
}
export async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { 'X-Werk-Request': 'webview', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/access') { relock(); state.accessMessage = 'Your access expired or the worker restarted. Unlock to return to your task. Your unsent draft is kept in this tab.'; }
    throw Error(data.error ?? `Request failed (${response.status})`);
  }
  return data;
}
function relock() {
  if (state.sessions?.selected) drafts.set(state.sessions.selected, state.draft);
  generation++; state.unlocked = false; state.environment = null; state.history = null; state.chat = null; state.settings = null; state.sessions = null; state.board = null; state.definitions = []; state.actionError = ''; state.workspaceBusy = false;
}
export async function lock() {
  try { await request('/api/access', 'DELETE'); relock(); state.draft = ''; drafts.clear(); state.accessMessage = 'This browser is locked and unsent drafts were cleared. Running tasks continue on the worker.'; }
  catch (error) { state.error = (error as Error).message; }
}
export async function checkAccess() {
  try { const access = await request('/api/access'); state.unlocked = access.authenticated; if (state.unlocked) await refresh(); }
  catch { state.accessMessage = 'The worker could not be reached. Check that it is running, then try again.'; }
  finally { state.accessChecked = true; }
}
export async function unlock(candidate: string) {
  await request('/api/access', 'POST', { token: candidate.trim() });
  generation++; state.unlocked = true; state.accessMessage = '';
  await refresh();
}
export async function refresh() {
  if (state.loading || !state.unlocked) return;
  state.loading = true; const current = generation;
  try {
    const [status, monitoring, environment, history, pair, settings, board, definitions] = await Promise.all([request('/status'), request('/monitoring'), request('/api/environment'), request('/api/history'), request('/api/chat/session'), request('/api/settings'), request('/api/taskboard'), request('/api/definitions')]);
    if (current !== generation) return;
    state.status = status; state.monitoring = monitoring;
    if (state.unlocked) { state.environment = environment; state.history = history; state.chat = pair.chat; state.settings = settings; adoptSessions(pair.sessions); state.board = board; state.definitions = definitions.definitions; }
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
    const pair = await request('/api/chat/session');
    if (applied === generation) { state.chat = pair.chat; adoptSessions(pair.sessions); }
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
      else if (path !== '/api/sessions') state.board = result;
      if (path === '/api/settings' || path === '/api/sessions') { const pair = await request('/api/chat/session'); if (applied !== generation) return; state.chat = pair.chat; adoptSessions(pair.sessions); }
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
