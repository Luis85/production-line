import { boundedSignal, requestJson } from '../../shared/webview/http';
import type { ConsumptionStatus } from '../application/consumption';
import type { ConsumptionCommand } from './consumption-editor';
import type { ToolAccessView, ToolAccessUpdate } from '../application/tool-policy';
import type { ExecutionProfilesView } from '../application/execution-profiles';
import type { WorkerSettingsView, SessionView, LocalTaskboardView } from '../application/workspace-view';
import { reactive } from 'vue';
import type { CapacityFreshness } from './worker-capacity';
import type { Status } from '../status/server';
import type { WorkerWorkspace } from '../status/workspace';
import type { WorkerConversation } from '../application/conversation';
import type { workerMonitoring } from '../status/server';
export type HistoryRow = Awaited<ReturnType<WorkerWorkspace['history']>>['rows'][number];
export const state = reactive({
  executionProfiles: null as ExecutionProfilesView | null,
  toolAccess: null as ToolAccessView | null,
  consumption: null as ConsumptionStatus | null, consumptionError: '',
  settings: null as WorkerSettingsView | null, sessions: null as SessionView | null, board: null as LocalTaskboardView | null,
  status: null as Status | null, environment: null as Awaited<ReturnType<WorkerWorkspace['environment']>> | null,
  history: null as Awaited<ReturnType<WorkerWorkspace['history']>> | null,
  chat: null as ReturnType<WorkerConversation['snapshot']> | null,
  monitoring: null as ReturnType<typeof workerMonitoring> | null,
  sessionsReadAt: '', sessionsStale: false, refreshingManually: false,
  definitions: [] as AgentDefinition[], draftEpoch: 0, partialError: '', refreshRevision: 0, accessChecked: false, accessMessage: '', workspaceBusy: false, unlocked: false, paused: false, loading: false, error: '', actionError: '', lastRead: '', draft: '',
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
  state.sessionsReadAt = new Date().toISOString();
  state.sessionsStale = false;
}
/** Freshness follows the authoritative capacity response, independent of optional panels. */
export function getCapacityFreshness(): CapacityFreshness {
  if (!state.sessions?.capacity || !state.sessionsReadAt) return 'unknown';
  return state.paused || state.sessionsStale || !!state.error || Date.now() - Date.parse(state.sessionsReadAt) > 15000 ? 'stale' : 'fresh';
}
export function taskStatus(value: string) { return ({ draft: 'Draft', queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted', waiting_input: 'Waiting for your answer', escalated: 'Decision needed' }[value] ?? value); }
export interface DefinitionAgent { name: string; description: string; instruction: string; model: string; provider: string; unsupported: string[]; requiresAdaptation: boolean; }
export interface AgentDefinition { id: string; ref?: string; name: string; digest: string; createdAt: string; agents: DefinitionAgent[]; }
export async function newTask(options: { provider?: string; title?: string; definitionId?: string; agent?: string; useInstructionsOnly?: boolean } = {}) {
  const current = state.sessions?.records.find(item => item.id === state.sessions?.selected);
  const provider = current?.provider ?? state.settings?.providers.find(item => item.configured)?.id ?? 'codex-cli';
  return workspaceAction('/api/sessions', { action: 'create', title: 'New task', provider, ...options });
}
export interface FeatureRequestCommand {
  action: 'create'; id: string; title: string; message: string; provider: string;
  definitionId?: string; agent?: string; useInstructionsOnly?: boolean;
  files?: { repository: string; paths: string[] };
}
export interface FeatureRequestDetail { session: SessionView['records'][number]; chat: NonNullable<typeof state.chat>; featureTracking?: SessionView['featureTracking']; }
/** One durable admission owns its first message; replaying its exact command cannot dispatch twice. */
export async function createFeatureRequest(command: FeatureRequestCommand): Promise<FeatureRequestDetail | undefined> {
  if (!state.unlocked || state.workspaceBusy) return;
  const access = accessGeneration;
  state.workspaceBusy = true; state.actionError = ''; const current = ++generation;
  let accepted: FeatureRequestDetail | undefined;
  try {
    const result: FeatureRequestDetail = await request('/api/tasks', 'POST', JSON.parse(JSON.stringify(command)));
    if (access !== accessGeneration || !state.unlocked) return;
    if (!result?.session?.id || !result.chat) throw Error('The worker did not confirm the created request. Retry the same request to recover its result.');
    // Preserve admission evidence if later reads fail, without changing anyone's selected conversation.
    if (current === generation && state.sessions) {
      if (result.featureTracking) state.sessions.featureTracking = result.featureTracking;
      if (!state.sessions.records.some(record => record.id === result.session.id)) state.sessions.records.push(result.session);
    }
    generation++;
    accepted = result;
  } catch (error) { if (access === accessGeneration && state.unlocked) throw error; }
  finally {
    if (access === accessGeneration) { state.workspaceBusy = false; await refresh(); }
  }
  return access === accessGeneration && state.unlocked ? accepted : undefined;
}
export async function request<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const access = accessGeneration;
  return requestJson<T>(path, { method, credentials: 'same-origin', cache: 'no-store', signal: boundedSignal(undefined, 10000), headers: { 'X-Werk-Request': 'webview', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, {
    onResponse: response => { if (response.status === 401 && path !== '/api/access' && access === accessGeneration) { relock(); state.accessMessage = 'Your access expired or the worker restarted. Unlock to return to your task. Your unsent draft is kept in this tab.'; } },
    invalidJson: status => status >= 400 ? `Request failed (${status})` : 'The worker returned unreadable JSON.',
  });
}
function relock() {
  if (state.sessions?.selected) drafts.set(state.sessions.selected, state.draft);
  generation++; accessGeneration++; state.unlocked = false; state.environment = null; state.executionProfiles = null; state.toolAccess = null; state.consumption = null; state.consumptionError = ''; state.history = null; state.chat = null; state.settings = null; state.sessions = null; state.sessionsReadAt = ''; state.sessionsStale = false; state.board = null; state.definitions = []; state.actionError = ''; state.workspaceBusy = false;
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
  if (state.sessionsReadAt && Date.now() - Date.parse(state.sessionsReadAt) > 15000) state.sessionsStale = true;
  try {
    const results = await Promise.allSettled([request('/status'), request('/monitoring'), request('/api/environment'), request('/api/history'), request('/api/chat/session'), request('/api/settings'), request('/api/taskboard'), request('/api/definitions'), request('/api/execution-profiles'), request('/api/tool-access'), request('/api/consumption')]);
    if (current !== generation) return;
    const [status, monitoring, environment, history, pair, settings, board, definitions, executionProfiles, toolAccess, consumption] = results;
    if (status.status === 'fulfilled') state.status = status.value;
    if (monitoring.status === 'fulfilled') state.monitoring = monitoring.value;
    if (environment.status === 'fulfilled') state.environment = environment.value;
    if (history.status === 'fulfilled') state.history = history.value;
    if (pair.status === 'fulfilled') { state.chat = pair.value.chat; adoptSessions(pair.value.sessions); }
    else state.sessionsStale = true;
    if (settings.status === 'fulfilled') state.settings = settings.value;
    if (board.status === 'fulfilled') state.board = board.value;
    if (definitions.status === 'fulfilled') state.definitions = definitions.value.definitions;
    if (executionProfiles.status === 'fulfilled') state.executionProfiles = executionProfiles.value;
    if (toolAccess.status === 'fulfilled') state.toolAccess = toolAccess.value;
    if (consumption.status === 'fulfilled') { state.consumption = consumption.value; state.consumptionError = ''; }
    else state.consumptionError = 'Consumption could not be refreshed. Check that the worker is running, then refresh.';
    const labels = ['Worker status', 'Monitoring', 'Environment', 'History', 'Task conversation', 'Settings', 'File tasks', 'Agent definitions', 'Execution profiles', 'Tool access', 'Consumption'];
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [labels[index]] : []);
    state.error = status.status === 'rejected' ? 'Worker status could not be refreshed. Check the worker process and retry.' : '';
    state.partialError = failures.length && !state.error ? `${failures.join(', ')} could not be refreshed. Those values may be stale. Refresh to retry.` : '';
    if (!failures.length) state.lastRead = new Date().toISOString();
    // Completion invalidates independent resources even when one optional snapshot failed.
    state.refreshRevision++;
  } catch (error) { if (current === generation) state.error = error instanceof Error ? error.message : 'Worker could not be reached. Check the process and retry.'; }
  finally { state.loading = false; }
}
/** Only explicit refreshes animate action buttons; scheduled reads stay visually quiet. */
export async function refreshFromUser() {
  if (state.loading || state.refreshingManually || !state.unlocked) return;
  state.refreshingManually = true;
  try { await refresh(); } finally { state.refreshingManually = false; }
}
async function readConversation(applied: number, access: number) {
  try {
    const pair = await request('/api/chat/session');
    if (applied === generation && access === accessGeneration) { state.chat = pair.chat; adoptSessions(pair.sessions); }
  } catch {
    if (access === accessGeneration) { state.sessionsStale = true; state.partialError = 'Your action was saved, but the task conversation could not be refreshed. Refresh to see the latest state.'; }
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
    if (path === '/api/settings' || path === '/api/repositories' || path === '/api/sessions' || path === '/api/taskboard' || path === '/api/taskboard/action') {
      // A successful write remains acknowledged even when another mutation invalidated its snapshot.
      const adoptResult = current === generation, applied = ++generation;
      if (path === '/api/repositories') {
        if (adoptResult && state.environment) state.environment.repositories = result;
        if (adoptResult && state.settings) state.settings.repositories = { pollMs: result.pollMs, items: result.items.map(({ id, path, remote, branch, watch }: WorkerSettingsView['repositories']['items'][number]) => ({ id, path, remote, watch, ...(branch ? { branch } : {}) })) };
      } else if (adoptResult && path === '/api/settings') state.settings = result;
      else if (adoptResult && path !== '/api/sessions') state.board = result;
      if (path === '/api/settings' || path === '/api/sessions') await readConversation(applied, access);
    } else if (current !== generation) return; // Detail reads must not escape a changed workspace.
    await refresh();
    if (access === accessGeneration) return result;
  }
  catch (error) { if (access === accessGeneration) state.actionError = error instanceof Error ? error.message : 'Action failed. Refresh and retry.'; }
  finally { if (path === '/api/sessions' && access === accessGeneration) state.workspaceBusy = false; }
}
/** Preserve conflicts for the profile editor while invalidating older background reads. */
export async function executionProfilesAction(body: { expectedConfigurationHash: string; profiles: ExecutionProfilesView['profiles'] }): Promise<ExecutionProfilesView | undefined> {
  if (!state.unlocked) return;
  const access = accessGeneration;
  try {
    const result: ExecutionProfilesView = await request('/api/execution-profiles', 'POST', body);
    if (access !== accessGeneration || !state.unlocked) return;
    state.executionProfiles = result;
    generation++;
    await refresh();
    if (access === accessGeneration && state.unlocked) return result;
  } catch (error) { if (access === accessGeneration && state.unlocked) throw error; }
}
export const bytes = (value: number | null | undefined) => value == null ? 'Unavailable' : value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GiB` : `${(value / 1048576).toFixed(1)} MiB`;
export const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
export const duration = (value: number | null | undefined) => value == null ? 'Unavailable' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
export const outcome = (value: string) => ({ simulated: 'Simulated', change_set: 'Review required', 'change-set': 'Review required', failed: 'Failed', interrupted: 'Interrupted', running: 'Running', incomplete: 'Incomplete evidence' }[value] ?? value.replaceAll('_', ' '));

/** Tool access acknowledgements survive refresh failures and invalidate older reads. */
async function toolAccessMutation(path: string, body: unknown): Promise<ToolAccessView | undefined> {
  if (!state.unlocked) return;
  const access = accessGeneration;
  try {
    const result: ToolAccessView = await request(path, 'POST', body);
    if (access !== accessGeneration || !state.unlocked) return;
    state.toolAccess = result; generation++;
    await refresh();
    if (access === accessGeneration && state.unlocked) return result;
  } catch (error) { if (access === accessGeneration && state.unlocked) throw error; }
}
export const toolAccessAction = (body: ToolAccessUpdate) => toolAccessMutation('/api/tool-access', body);
export const toolAccessDiscover = (body: { id: string; expectedRevision: number }) => toolAccessMutation('/api/tool-access/discover', body);

/** Consumption shares guarded settings transport while returning its own policy acknowledgement. */
export async function consumptionAction(body: ConsumptionCommand) {
  return (await guardedSettingsAction(body))?.consumption;
}

/** Guarded forms need conflict status and their acknowledgement, even if its full snapshot is older. */
export async function guardedSettingsAction(body: unknown): Promise<WorkerSettingsView | undefined> {
  if (!state.unlocked) return;
  const current = generation, access = accessGeneration;
  try {
    const result: WorkerSettingsView = await request('/api/settings', 'POST', body);
    if (access !== accessGeneration || !state.unlocked) return;
    if (current === generation) state.settings = result;
    generation++;
    await refresh();
    if (access === accessGeneration && state.unlocked) return result;
  } catch (error) { if (access === accessGeneration && state.unlocked) throw error; }
}
