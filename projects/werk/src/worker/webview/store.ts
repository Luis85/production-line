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
  definitions: [] as AgentDefinition[], draftEpoch: 0, partialError: '', accessChecked: false, accessMessage: '', workspaceBusy: false, unlocked: false, paused: false, loading: false, error: '', actionError: '', lastRead: '', draft: '',
});
// Read revisions invalidate stale snapshots; access revisions also invalidate private results.
let generation = 0, accessGeneration = 0;
const drafts = new Map<string, string>();
function adoptSessions(sessions: NonNullable<typeof state.sessions>) {
  if (sessions.selected !== state.sessions?.selected) {
    if (state.sessions?.selected) drafts.set(state.sessions.selected, state.draft);
    state.draft = drafts.get(sessions.selected) ?? '';
  }
  state.sessions = sessions;
}
export function taskStatus(value: string) { return ({ draft: 'Draft', queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted', waiting_input: 'Waiting for your answer', escalated: 'Decision needed' }[value] ?? value); }
export interface DefinitionAgent { name: string; description: string; instruction: string; model: string; provider: string; unsupported: string[]; requiresAdaptation: boolean; }
export interface AgentDefinition { id: string; name: string; digest: string; createdAt: string; agents: DefinitionAgent[]; }
export async function newTask(options: { provider?: string; title?: string; definitionId?: string; agent?: string; useInstructionsOnly?: boolean } = {}) {
  const current = state.sessions?.records.find(item => item.id === state.sessions?.selected);
  const provider = current?.provider ?? state.settings?.providers.find(item => item.configured)?.id ?? 'codex-cli';
  return workspaceAction('/api/sessions', { action: 'create', title: 'New task', provider, ...options });
}
export async function request(path: string, method = 'GET', body?: unknown) {
  const access = accessGeneration;
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { 'X-Werk-Request': 'webview', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/access' && access === accessGeneration) { relock(); state.accessMessage = 'Your access expired or the worker restarted. Unlock to return to your task. Your unsent draft is kept in this tab.'; }
    const failure = Error(data.error ?? `Request failed (${response.status})`) as Error & { status: number };
    failure.status = response.status;
    throw failure;
  }
  return data;
}
function relock() {
  if (state.sessions?.selected) drafts.set(state.sessions.selected, state.draft);
  generation++; accessGeneration++; state.unlocked = false; state.environment = null; state.history = null; state.chat = null; state.settings = null; state.sessions = null; state.board = null; state.definitions = []; state.actionError = ''; state.workspaceBusy = false;
}
export async function lock() {
  try { await request('/api/access', 'DELETE'); state.draftEpoch++; relock(); state.draft = ''; drafts.clear(); state.accessMessage = 'This browser is locked and unsent drafts were cleared. Running tasks continue on the worker.'; }
  catch (error) { state.error = (error as Error).message; }
}
export async function checkAccess() {
  try { const access = await request('/api/access'); state.unlocked = access.authenticated; if (state.unlocked) await refresh(); }
  catch { state.accessMessage = 'The worker could not be reached. Check that it is running, then try again.'; }
  finally { state.accessChecked = true; }
}
export async function unlock(candidate: string) {
  await request('/api/access', 'POST', { token: candidate.trim() });
  generation++; accessGeneration++; state.unlocked = true; state.accessMessage = '';
  await refresh();
}
export async function refresh() {
  if (state.loading || !state.unlocked) return;
  state.loading = true; const current = generation;
  try {
    const results = await Promise.allSettled([request('/status'), request('/monitoring'), request('/api/environment'), request('/api/history'), request('/api/chat/session'), request('/api/settings'), request('/api/taskboard'), request('/api/definitions')]);
    if (current !== generation) return;
    const [status, monitoring, environment, history, pair, settings, board, definitions] = results;
    if (status.status === 'fulfilled') state.status = status.value;
    if (monitoring.status === 'fulfilled') state.monitoring = monitoring.value;
    if (environment.status === 'fulfilled') state.environment = environment.value;
    if (history.status === 'fulfilled') state.history = history.value;
    if (pair.status === 'fulfilled') { state.chat = pair.value.chat; adoptSessions(pair.value.sessions); }
    if (settings.status === 'fulfilled') state.settings = settings.value;
    if (board.status === 'fulfilled') state.board = board.value;
    if (definitions.status === 'fulfilled') state.definitions = definitions.value.definitions;
    const labels = ['Worker status', 'Monitoring', 'Environment', 'History', 'Task conversation', 'Settings', 'File tasks', 'Agent definitions'];
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [labels[index]] : []);
    state.error = status.status === 'rejected' ? 'Worker status could not be refreshed. Check the worker process and retry.' : '';
    state.partialError = failures.length && !state.error ? `${failures.join(', ')} could not be refreshed. Those values may be stale. Refresh to retry.` : '';
    if (!failures.length) state.lastRead = new Date().toISOString();
  } catch (error) { if (current === generation) state.error = error instanceof Error ? error.message : 'Worker could not be reached. Check the process and retry.'; }
  finally { state.loading = false; }
}
async function readConversation(applied: number, access: number) {
  try {
    const pair = await request('/api/chat/session');
    if (applied === generation && access === accessGeneration) { state.chat = pair.chat; adoptSessions(pair.sessions); }
  } catch {
    if (access === accessGeneration) state.partialError = 'Your action was saved, but the task conversation could not be refreshed. Refresh to see the latest state.';
  }
}
export async function chatAction(action: 'send' | 'cancel') {
  if (state.workspaceBusy) return;
  state.actionError = '';
  const current = generation, access = accessGeneration, sessionId = state.sessions?.selected, draft = state.draft;
  try {
    const result = await request(action === 'send' ? '/api/chat' : '/api/chat/cancel', 'POST', action === 'send' ? { message: draft, sessionId } : { sessionId });
    if (access !== accessGeneration) return;
    // Acknowledgement belongs to the submitted task, even if an unrelated action changed the view.
    if (action === 'send') {
      if (sessionId === state.sessions?.selected && state.draft === draft) state.draft = '';
      if (sessionId && drafts.get(sessionId) === draft) drafts.delete(sessionId);
    }
    if (current === generation && sessionId === state.sessions?.selected) state.chat = result;
    await readConversation(++generation, access);
  } catch (error) {
    if (access === accessGeneration) state.actionError = error instanceof Error ? error.message : 'The action failed. Refresh before trying again.';
    await refresh();
  }
}
export async function workspaceAction(path: string, body: unknown): Promise<any> {
  if (path === '/api/sessions' && state.workspaceBusy) return;
  if (path === '/api/sessions') state.workspaceBusy = true;
  state.actionError = '';
  const current = generation, access = accessGeneration;
  try {
    const result = await request(path, 'POST', body);
    if (access !== accessGeneration) return;
    if (path === '/api/settings' || path === '/api/sessions' || path === '/api/taskboard' || path === '/api/taskboard/action') {
      // A successful write remains acknowledged even when another mutation invalidated its snapshot.
      const adoptResult = current === generation, applied = ++generation;
      if (adoptResult && path === '/api/settings') state.settings = result;
      else if (adoptResult && path !== '/api/sessions') state.board = result;
      if (path === '/api/settings' || path === '/api/sessions') await readConversation(applied, access);
    } else if (current !== generation) return; // Detail reads must not escape a changed workspace.
    await refresh();
    if (access === accessGeneration) return result;
  }
  catch (error) { if (access === accessGeneration) state.actionError = error instanceof Error ? error.message : 'Action failed. Refresh and retry.'; }
  finally { if (path === '/api/sessions' && access === accessGeneration) state.workspaceBusy = false; }
}
export const bytes = (value: number | null | undefined) => value == null ? 'Unavailable' : value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GiB` : `${(value / 1048576).toFixed(1)} MiB`;
export const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
export const duration = (value: number | null | undefined) => value == null ? 'Unavailable' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
export const outcome = (value: string) => ({ simulated: 'Simulated', change_set: 'Review required', 'change-set': 'Review required', failed: 'Failed', interrupted: 'Interrupted', running: 'Running', incomplete: 'Incomplete evidence' }[value] ?? value.replaceAll('_', ' '));
