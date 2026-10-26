<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import { workboardLane, workboardAction } from '../workboard-view';
import WorkerCapacityPanel from '../components/WorkerCapacityPanel.vue';
import ExecutionRecoveryPanel from '../components/ExecutionRecoveryPanel.vue';
import { buildWorkerCapacityView } from '../worker-capacity';
import RepositoryDiscovery from '../components/RepositoryDiscovery.vue';
import OverviewTaskCard from '../components/OverviewTaskCard.vue';
import { buildTaskOverview, type TaskOverviewInput, type TaskOverviewItem } from '../task-overview';
import { taskActivityChanges, type TaskNotification } from '../task-notifications';
import { supportsLocalRequestSetup, hasRequestActivity } from '../worker-mode-view';
import { readRequestSummaries } from '../request-summary-reader';
import type { RequestSummary } from '../../application/request-gates';
import type { RunPage, WorkerRun } from '../../application/run-evidence';
import { state, request, workspaceAction, refresh, date, getCapacityFreshness, refreshFromUser } from '../store';

const router = useRouter();
const search = ref(''), projectId = ref(''), view = ref<'board' | 'list'>('board');
const queueBusy = ref(false), stopping = ref(false), actionError = ref('');
const features = ref<TaskOverviewInput['features']>(null), activeRuns = ref<WorkerRun[]>([]), evidenceError = ref('');
const requests = ref<RequestSummary[]>([]);
const notifications = ref<TaskNotification[]>([]);
let observedItems: TaskOverviewItem[] | null = null;
let active = true, evidenceRevision = 0, evidencePending = false;
const allTasks = computed(() => buildTaskOverview({ sessions: state.sessions, board: state.board, history: state.history, features: features.value, requests: requests.value, sharedRequests: state.environment?.sharedIntake?.requests, runs: activeRuns.value }));
const overview = computed(() => buildTaskOverview({ sessions: state.sessions, board: state.board, history: state.history, features: features.value, requests: requests.value, sharedRequests: state.environment?.sharedIntake?.requests, runs: activeRuns.value }, { search: search.value, projectId: projectId.value }));
const running = computed(() => allTasks.value.groups.running.find(item => item.sessionId === currentExecutionId.value));
const projectChoices = computed(() => [...new Set(allTasks.value.items.flatMap(item => item.projectId ? [item.projectId] : []))].sort());
const capacity = computed(() => buildWorkerCapacityView(state.sessions?.capacity, getCapacityFreshness(), state.environment?.repositories?.nativeWork));
const showRemoteCapacity = computed(() => !!state.environment?.orchestratorUrl || (state.sessions?.capacity?.remote.accepted ?? 0) > 0);
const queueNote = computed(() => capacity.value.stale || capacity.value.state === 'unknown' ? 'Refresh to check current start conditions.' : capacity.value.startBlocked ? 'New starts are on hold. See the worker conditions above.' : 'Waiting work uses the shared and project execution limits.');
const currentExecutionId = computed(() => state.sessions?.execution.currentSessionId);
const activeRun = computed(() => activeRuns.value.find(run => run.sessionId === currentExecutionId.value) ?? null);
const currentSession = computed(() => state.sessions?.records.find(item => item.id === currentExecutionId.value));
const originalAssignment = computed(() => currentSession.value?.kind === 'orchestrator' && ['queued', 'running'].includes(currentSession.value.taskState ?? ''));
const activePurpose = computed(() => running.value?.deliveryPhaseLabel ?? (activeRun.value?.purpose === 'gate_review' ? (running.value?.id.startsWith('shared-feature:') ? 'Feature Request Ready Check' : 'Advisory review') : activeRun.value?.purpose === 'rework' ? 'Rework proposal' : originalAssignment.value && state.status?.mode === 'mock' ? 'Simulation · no implementation' : 'Task execution'));
const canStop = computed(() => !running.value?.deliveryRunId && !!activeRun.value && activeRun.value.sessionId === currentSession.value?.id && (!activeRun.value.purpose || activeRun.value.purpose === 'execution') && !originalAssignment.value);
const selectionBusy = computed(() => stopping.value || state.workspaceBusy);
const runModel = computed(() => activeRun.value && activeRun.value.sessionId === currentExecutionId.value ? activeRun.value.model || 'Provider default' : 'Not yet recorded');
const runProvider = computed(() => activeRun.value && activeRun.value.sessionId === currentExecutionId.value ? activeRun.value.provider : currentSession.value?.provider ?? 'Connection unavailable');
const runElapsed = computed(() => {
  const started = activeRun.value?.startedAt;
  if (!started || activeRun.value?.sessionId !== currentExecutionId.value) return 'Elapsed unavailable';
  const elapsed = Math.max(0, Math.floor((Date.parse(state.sessionsReadAt || new Date().toISOString()) - Date.parse(started)) / 1000));
  return Math.floor(elapsed / 60) + 'm ' + elapsed % 60 + 's elapsed';
});
const usage = computed(() => {
  const value = activeRun.value?.usage;
  if (activeRun.value?.sessionId !== currentExecutionId.value || !value || value.inputTokens === null || value.outputTokens === null) return 'Token usage unavailable';
  return (value.inputTokens + value.outputTokens).toLocaleString() + ' tokens reported';
});
const visibleItems = computed(() => overview.value.items.filter(item => hasRequestActivity([item], state.sessions?.records)));
const groups = computed(() => [
  { id: 'attention', title: 'Needs you', icon: 'i-lucide-circle-alert' },
  { id: 'review', title: 'Review & merge', icon: 'i-lucide-git-pull-request' },
  { id: 'running', title: 'In progress', icon: 'i-lucide-loader-circle' },
  { id: 'queued', title: 'Up next', icon: 'i-lucide-list-ordered' },
].map(group => ({ ...group, items: visibleItems.value.filter(item => workboardLane(item) === group.id).map(workboardAction) })));
const closedRequests = computed(() => visibleItems.value.filter(item => item.group === 'completed' && item.status === 'done'));
const pastAttempts = computed(() => visibleItems.value.filter(item => item.group === 'completed' && item.status !== 'done'));
const drafts = computed(() => visibleItems.value.filter(item => item.group === 'draft'));


async function readEvidence() {
  if (!active || !state.unlocked || evidencePending) return;
  evidencePending = true;
  const revision = ++evidenceRevision;
  const sessionId = currentExecutionId.value;
  const activeIds = new Set(state.sessions?.execution.activeSessions?.map(item => item.sessionId) ?? (sessionId ? [sessionId] : []));
  activeRuns.value = activeRuns.value.filter(run => activeIds.has(run.sessionId));
  const results = await Promise.allSettled([
    request('/api/features'),
    activeIds.size ? request('/api/runs', 'POST', { action: 'list', outcome: 'running', limit: 100 }) : Promise.resolve(null),
    readRequestSummaries(request),
  ]);
  evidencePending = false;
  if (revision !== evidenceRevision || !active || !state.unlocked) return;
  const notes: string[] = [];
  if (results[0].status === 'fulfilled') features.value = results[0].value;
  else notes.push('Project requests could not be refreshed. Their last view may be stale.');
  if (results[1].status === 'fulfilled') {
    const page = results[1].value as RunPage | null;
    const currentIds = new Set(state.sessions?.execution.activeSessions?.map(item => item.sessionId) ?? (currentExecutionId.value ? [currentExecutionId.value] : []));
    activeRuns.value = (page?.rows ?? []).filter(run => run.startedAt && !run.after && currentIds.has(run.sessionId) && page!.rows.filter(item => item.sessionId === run.sessionId).length === 1);
  } else { activeRuns.value = []; notes.push('Current attempt evidence is unavailable.'); }
  if (results[2].status === 'fulfilled') requests.value = results[2].value;
  else notes.push('Request lifecycle details could not be refreshed. Their last view may be stale.');
  evidenceError.value = notes.join(' ');
}
async function openSession(id: string, controls = false) {
  if (selectionBusy.value || !state.unlocked) return;
  await router.push({ path: '/request', query: { session: id }, ...(controls ? { hash: '#request-controls' } : {}) });
}
async function openTask(item: TaskOverviewItem) {
  if (selectionBusy.value) return;
  await router.push(workboardAction(item).primaryAction.href);
}
async function toggleQueue() {
  if (queueBusy.value || !state.settings) return;
  queueBusy.value = true; actionError.value = '';
  try {
    if (!await workspaceAction('/api/settings', { board: { paused: !state.settings.board.paused } })) actionError.value = state.actionError || 'The queue could not be updated.';
  } finally { queueBusy.value = false; }
}
async function stopTask() {
  const item = running.value, id = currentSession.value?.id, runId = activeRun.value?.id;
  if (!id || !canStop.value || selectionBusy.value) return;
  stopping.value = true; actionError.value = '';
  try {
    const file = state.board?.tasks.find(task => task.id === item?.localTaskId);
    const fileExecution = file?.runId === runId && file?.status === 'running';
    if (!fileExecution && state.sessions?.selected !== id && !await workspaceAction('/api/sessions', { action: 'select', id })) throw Error(state.actionError || 'This task could not be selected.');
    const live: RunPage = await request('/api/runs', 'POST', { action: 'list', sessionId: id, outcome: 'running', limit: 2 });
    if (live.total !== 1 || live.rows[0]?.id !== runId || live.rows[0]?.after || state.sessions?.execution.currentSessionId !== id) throw Error('The running attempt changed. Refresh and review its current status before stopping.');
    if (fileExecution && item?.localTaskId) {
      if (!await workspaceAction('/api/taskboard/action', { action: 'cancel', id: item.localTaskId })) throw Error(state.actionError || 'This task could not be stopped.');
    } else {
      await request('/api/chat/cancel', 'POST', { sessionId: id });
      await refresh();
    }
  } catch (error) { if (state.unlocked) actionError.value = (error as Error).message; }
  finally { stopping.value = false; }
}
async function newTask() {
  if (!selectionBusy.value) await router.push({ path: '/requests/new', query: projectId.value ? { project: projectId.value } : {} });
}
watch(() => allTasks.value.items, items => {
  if (!state.unlocked) { observedItems = null; notifications.value = []; return; }
  if (observedItems) notifications.value = [...new Map([...taskActivityChanges(observedItems, items.map(workboardAction)), ...notifications.value].map(item => [item.id, item])).values()].slice(0, 8);
  observedItems = items.map(workboardAction);
});
watch(() => state.refreshRevision, () => { void readEvidence(); });
watch(() => state.unlocked, value => {
  if (!value) { observedItems = null; notifications.value = []; evidenceRevision++; features.value = null; activeRuns.value = []; evidenceError.value = ''; actionError.value = ''; search.value = ''; }
}, { flush: 'sync' });
onActivated(() => { active = true; void readEvidence(); });
onDeactivated(() => { active = false; evidenceRevision++; });
</script>
<template>
  <div class="taskboard-workspace">
    <section class="taskboard-home" aria-labelledby="taskboard-heading">
      <header class="taskboard-page-heading page-heading">
        <div><h1 id="taskboard-heading" tabindex="-1">Workboard</h1><p>Choose the request that needs your next action.</p></div>
        <div class="taskboard-heading-tools"><div class="taskboard-view" role="group" aria-label="Workboard view">
          <button :aria-pressed="view === 'board'" @click="view = 'board'"><UIcon name="i-lucide-columns-2" />Board</button>
          <button :aria-pressed="view === 'list'" @click="view = 'list'"><UIcon name="i-lucide-list" />List</button>
        </div><UButton id="new-feature-request" class="taskboard-new" icon="i-lucide-plus" :disabled="selectionBusy" @click="newTask">New Feature Request</UButton>
      <div class="taskboard-toolbar">
        <UInput v-model="search" aria-label="Search feature requests" placeholder="Find a request…" icon="i-lucide-search" class="taskboard-search" />
        <label class="sr-only" for="taskboard-project">Filter project</label><select id="taskboard-project" v-model="projectId" class="project-filter"><option value="">All projects</option><option v-for="id in projectChoices" :key="id" :value="id">{{ id }}</option></select>
        <span>{{ visibleItems.length }} {{ visibleItems.length === 1 ? 'request' : 'requests' }}<template v-if="search"> matching</template></span>
      </div></div>
      </header>

      <p v-if="state.unlocked && supportsLocalRequestSetup(state.environment, state.status?.state) && !hasRequestActivity(allTasks.items, state.sessions?.records)" class="board-onboarding">Start by <RouterLink to="/projects">connecting a project</RouterLink> and <RouterLink to="/settings#provider-connections">setting up a provider</RouterLink>, then create your first Feature Request.</p>
      <nav class="lane-shortcuts" aria-label="Workboard lanes"><a v-for="group in groups" :key="group.id" :href="'#group-' + group.id">{{ group.title }} <span>{{ group.items.length }}</span></a></nav>
      <details class="worker-conditions"><summary>Worker conditions & execution limits</summary><RepositoryDiscovery /><WorkerCapacityPanel :view="capacity" :projects="state.sessions?.capacity?.execution.projects" :remaining="state.sessions?.capacity?.local.remaining" :show-remote="showRemoteCapacity" :consumption-blocked="state.sessions?.capacity?.starts.consumption?.blocked" :refreshing="state.refreshingManually" :refresh-disabled="!state.unlocked" @refresh="refreshFromUser" /></details>
      <ExecutionRecoveryPanel />
      <section v-if="currentExecutionId && (!projectId || running?.projectId === projectId)" class="active-run occupied" aria-labelledby="active-run-heading">
        <div class="active-run-heading"><span class="activity-dot" /><h2 id="active-run-heading">{{ capacity.stale ? 'Last reported task' : 'Current task' }}</h2></div>
        <template v-if="currentExecutionId">
          <div class="active-run-content"><div class="active-run-title"><button v-if="currentSession" :disabled="selectionBusy" @click="openSession(currentSession.id)">{{ running?.title ?? currentSession.title }}<UIcon name="i-lucide-arrow-up-right" /></button><RouterLink v-else :to="running?.primaryAction.href ?? '/history?view=runs'">{{ running?.title ?? activeRun?.title ?? 'Worker execution' }}<UIcon name="i-lucide-arrow-up-right" /></RouterLink></div>
          <div class="active-run-meta"><span>{{ activePurpose }}</span><span>{{ runProvider }}</span><span>{{ runModel }}</span><span>{{ runElapsed }}</span></div>
          <p class="active-run-readout">{{ usage }} · {{ capacity.stale ? 'Activity needs refresh' : 'Live progress updates' }}</p>
          <p v-if="originalAssignment" class="active-run-empty">Managed by its owning orchestrator.</p></div>
          <div class="active-run-actions"><UButton v-if="running?.deliveryRunId" :to="running.primaryAction.href + '#review-decision'" color="neutral" variant="outline">Delivery controls</UButton><UButton v-else-if="canStop" color="error" variant="outline" icon="i-lucide-square" :loading="stopping" :disabled="selectionBusy" @click="stopTask">Stop task</UButton><UButton v-else-if="currentSession && !originalAssignment" color="neutral" variant="outline" :disabled="selectionBusy" @click="openSession(currentSession.id, true)">Open task controls</UButton><RouterLink :to="running?.evidenceHref ?? '/history?view=runs&runSession=' + encodeURIComponent(currentExecutionId)">Inspect attempt</RouterLink></div>
        </template>
      </section>

      <p v-if="actionError" class="board-error" role="alert">{{ actionError }}</p>
      <p v-if="evidenceError" class="board-warning" role="status">{{ evidenceError }}</p>

      <div class="taskboard-groups" :class="{ 'list-view': view === 'list' }">
        <section v-for="group in groups" :key="group.id" class="overview-group" :aria-labelledby="'group-' + group.id">
          <header class="overview-group-heading"><h2 :id="'group-' + group.id"><UIcon :name="group.icon" />{{ group.title }}<span class="group-count">{{ group.items.length }}</span></h2></header>

          <div class="overview-cards"><OverviewTaskCard v-for="item in group.items" :key="item.id" :item="item" :selected="!!item.sessionId && item.sessionId === state.sessions?.selected" :disabled="selectionBusy" :compact="view === 'list'" @open="openTask" /></div>
          <div v-if="!group.items.length" class="board-empty"><UIcon :name="group.id === 'attention' ? 'i-lucide-circle-check' : 'i-lucide-inbox'" /><h3>{{ search ? 'No matching tasks' : group.id === 'attention' ? 'Nothing needs your attention' : group.id === 'review' ? 'No increment awaiting review' : group.id === 'running' ? 'No implementation running' : 'Your queue is clear' }}</h3><p>{{ search ? 'Try another title, task ID or status.' : group.id === 'attention' ? 'Questions, blockers and failed attempts appear here.' : group.id === 'review' ? 'Review delivered changes before explicitly allowing a merge.' : group.id === 'running' ? 'Ready requests move here when this worker claims them.' : 'Publish a ready Feature Request to enter the shared queue.' }}</p></div>
          <div v-if="group.id === 'queued'" class="queue-control"><UButton color="neutral" variant="outline" :icon="state.settings?.board.paused ? 'i-lucide-play' : 'i-lucide-pause'" :loading="queueBusy" :disabled="!state.settings" @click="toggleQueue">{{ state.settings?.board.paused ? 'Resume new starts' : 'Pause new starts' }}</UButton><p>{{ queueNote }}</p></div>
        </section>
      </div>
      <p class="sr-only" role="status">{{ notifications[0] ? notifications[0].title + ': ' + notifications[0].message : '' }}</p><details v-if="notifications.length" class="task-notifications"><summary><UIcon name="i-lucide-chevron-right" class="updates-chevron" aria-hidden="true" />Recent worker updates · {{ notifications.length }}</summary><header><UButton color="neutral" variant="ghost" @click="notifications = []">Dismiss updates</UButton></header><ul aria-live="polite" aria-relevant="additions"><li v-for="item in notifications" :key="item.id"><RouterLink :to="item.href">{{ item.title }}</RouterLink><span>{{ item.message }}</span></li></ul><p>Recorded request changes since this Workboard was opened. Open a request for its full activity and Git evidence.</p></details>
      <details v-if="drafts.length" class="taskboard-disclosure"><summary><UIcon name="i-lucide-file-pen-line" />Drafts<span class="group-count">{{ drafts.length }}</span></summary><div class="disclosure-cards"><OverviewTaskCard v-for="item in drafts" :key="item.id" :item="item" :selected="!!item.sessionId && item.sessionId === state.sessions?.selected" :disabled="selectionBusy" :compact="view === 'list'" @open="openTask" /></div></details>
      <details v-if="closedRequests.length" class="taskboard-disclosure"><summary><UIcon name="i-lucide-circle-check" />Done requests<span class="group-count">{{ closedRequests.length }}</span></summary><div class="disclosure-cards"><OverviewTaskCard v-for="item in closedRequests" :key="item.id" :item="item" :disabled="selectionBusy" :compact="view === 'list'" @open="openTask" /></div></details>
      <details class="taskboard-disclosure"><summary><UIcon name="i-lucide-history" />Past attempts &amp; stopped work<span class="group-count">{{ pastAttempts.length }}</span></summary><div class="disclosure-cards"><OverviewTaskCard v-for="item in pastAttempts" :key="item.id" :item="item" :disabled="selectionBusy" :compact="view === 'list'" @open="openTask" /><p v-if="!pastAttempts.length" class="completed-empty">Completed model turns and stopped work appear here. A completed turn alone is not a delivered increment.</p></div></details>
      <div class="taskboard-footnote"><span>{{ state.sessionsReadAt ? 'Task activity refreshed ' + date(state.sessionsReadAt) : 'Waiting for worker data' }}</span><RouterLink to="/history">All history<UIcon name="i-lucide-arrow-up-right" /></RouterLink></div>
    </section>
  </div>
</template>
<style scoped>
.updates-chevron { transition:transform 150ms ease-out; }.task-notifications[open] .updates-chevron { transform:rotate(90deg); }
.board-onboarding { font-size:.875rem;line-height:1.65;color:var(--ui-text-muted);margin-bottom:var(--space-4); }.board-onboarding a { color:var(--ui-primary);min-height:44px;display:inline-flex;align-items:center; }.lane-shortcuts { display:flex;gap:var(--space-3);flex-wrap:wrap;margin-bottom:var(--space-4); }.lane-shortcuts a { min-height:44px;display:inline-flex;align-items:center;gap:var(--space-2);font-size:.8125rem;color:var(--ui-text-muted); }.lane-shortcuts a:hover { color:var(--ui-primary); }.lane-shortcuts span { font-variant-numeric:tabular-nums; }.task-notifications > summary { min-height:44px;display:flex;align-items:center;gap:var(--space-2);cursor:pointer;font-size:.875rem; }

.taskboard-home { max-width:1700px;margin-inline:auto; }.taskboard-heading-tools { flex-wrap:wrap; }.worker-conditions { margin-bottom:var(--space-6); }.worker-conditions summary { cursor:pointer;min-height:44px;display:flex;align-items:center;font-size:.8125rem;color:var(--ui-text-muted); }

.task-notifications { margin-bottom:var(--space-6);padding:var(--space-4);border:1px solid var(--ui-border);border-radius:8px;min-width:0; }.task-notifications header { display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap; }.task-notifications h2 { font-size:.875rem; }.task-notifications ul { list-style:none;padding:0; }.task-notifications ol { list-style:decimal;padding-left:var(--space-4);font-size:.8125rem; }.task-notifications ol li { display:list-item;margin-block:var(--space-3); }.task-notifications ol a,.task-notifications ol span { display:flex; }.task-notifications li { display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:baseline;font-size:.8125rem;overflow-wrap:anywhere; }.task-notifications a { color:var(--ui-primary);display:inline-flex;align-items:center;min-height:44px; }.task-notifications span,.task-notifications p { font-size:.75rem;color:var(--ui-text-muted);line-height:1.65; }
.project-filter { max-width: 190px; min-height: 44px; padding-inline: var(--space-3); background: var(--ui-bg); color: var(--ui-text); border: 1px solid var(--ui-border); border-radius: 6px; font-size: .8125rem; }.additional-running { margin-bottom: var(--space-6); }.additional-running h2 { font-size: 1rem; margin-bottom: var(--space-4); }
.taskboard-workspace { display: block; min-height: calc(100dvh - 148px); align-items: stretch; }
.taskboard-home { min-width: 0; padding: 34px 32px 28px; }
.taskboard-page-heading { margin-bottom: 26px; align-items: center; gap: 16px; }
.taskboard-page-heading h1 { font-size: 2.25rem; line-height: 1.25; font-weight: 650; letter-spacing: -.035em; }
.taskboard-page-heading p { margin-top: 7px; font-size: .875rem; }
.taskboard-heading-tools { display: flex; align-items: center; gap: 16px; margin-left: auto; }
.taskboard-view { display: flex; border: 1px solid #31424d; border-radius: 7px; padding: 3px; background: #15232c; }
.taskboard-view button { display: flex; align-items: center; gap: 7px; padding: 8px 12px; min-height: 44px; font-size: .8125rem; border-radius: 5px; color: #adbfca; cursor: pointer; }
.taskboard-view button[aria-pressed='true'] { background: #8be0b8; color: #10271e; box-shadow: 0 1px 2px #0005; }
.taskboard-toolbar { display: flex; align-items: center; gap: 14px; }
.taskboard-search { width: 240px; }
.taskboard-search :deep(input) { min-height: 44px; font-size: .8125rem; background: #15232c; }
.taskboard-toolbar > span { display: none; color: #a4b7c2; font-size: .75rem; white-space: nowrap; }
.taskboard-new { min-height: 44px; white-space: nowrap; }
.active-run { padding: 20px 22px; border: 1px solid #344c4c; border-radius: 8px; background: #192b2d; margin-bottom: 30px; }
.active-run.occupied { display: grid; grid-template-columns: 145px minmax(0, 1fr) auto; gap: 18px; align-items: center; border-color: #46645c; background: #192b2d; }
.active-run.occupied .active-run-heading { align-self: stretch; border-right: 1px solid #38504f; padding-right: 12px; }
.active-run-content { min-width: 0; }
.active-run-heading { display: flex; gap: 9px; align-items: center; }
.activity-dot { height: 7px; width: 7px; border-radius: 50%; background: #8be0b8; flex-shrink: 0; }
.active-run-heading h2 { font-size: .8125rem; font-weight: 650; color: #b9e7d1; }
.active-run-title { margin: 0 0 4px; }
.active-run-title button, .active-run-title a { display: inline-flex; text-align: left; align-items: center; gap: 10px; font-size: 1.0625rem; font-weight: 600; color: #edf4f7; cursor: pointer; min-height: 44px; overflow-wrap: anywhere; }
.active-run-title button :deep(.iconify) { flex-shrink: 0; }
.active-run-title button:disabled { cursor: default; opacity: .6; }
.active-run-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: .75rem; color: #b6cbc7; }
.active-run-meta span + span::before { content: '·'; padding-right: 10px; color: #7d9c98; }
.active-run-readout { margin-top: 6px; font-size: .6875rem; color: #a4bbb7; }
.active-run-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 0; }
.active-run-actions a { display: inline-flex; align-items: center; min-height: 44px; color: #b8e4cd; font-size: .75rem; }
.active-run-actions :deep(button) { font-size: .8125rem; }
.active-run-empty { margin: 10px 0 0; color: #b5c8c5; font-size: .8125rem; line-height: 1.7; }
.taskboard-groups { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); align-items:start; gap: 24px; margin-bottom: 26px; }
.overview-group { min-width: 0; }
.overview-group-heading { margin-bottom: 16px; }
.overview-group-heading h2 { display: flex; align-items: center; gap: 9px; font-size: 1rem; font-weight: 620; }
.overview-group-heading h2 :deep(.iconify) { color: #bacbd3; }
.overview-group:first-child .overview-group-heading h2 :deep(.iconify) { color: #edc47e; }
.group-count { display: inline-flex; align-items: center; justify-content: center; min-width: 23px; height: 22px; padding-inline: 6px; border-radius: 5px; background: #2b3d48; color: #cbd8e0; font-size: .6875rem; font-weight: 550; }
.overview-cards { display: grid; gap: 16px; }
.queue-control { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin-top: 16px; }
.queue-control :deep(button) { font-size: .75rem; }
.queue-control p { font-size: .6875rem; color: #aabcc7; margin: 0; }
.board-empty { padding: 18px 16px; border: 1px dashed #33454f; border-radius: 8px; color: #aabfc9; }
.board-empty > :deep(.iconify) { display:none; }
.board-empty h3 { font-size: .875rem; font-weight: 550; color: #d4e1e6; margin-bottom: 7px; }
.board-empty p { font-size: .8125rem; line-height: 1.7; }
.list-view { grid-template-columns: 1fr; gap: 26px; }
.list-view .queue-control { border: 0; padding: 0; }
.taskboard-disclosure { border-top: 1px solid #30404b; }
.taskboard-disclosure summary { display: flex; align-items: center; gap: 10px; padding-block: 18px; min-height: 56px; font-size: .875rem; color: #c7d5dd; cursor: pointer; list-style: none; }
.taskboard-disclosure summary::after { content: '+'; margin-left: auto; font-size: 1.125rem; }
.taskboard-disclosure[open] summary::after { content: '−'; }
.taskboard-disclosure summary::-webkit-details-marker { display: none; }
.taskboard-disclosure summary > :deep(.iconify) { color: #89bda3; }
.disclosure-cards { display: grid; gap: 14px; padding-bottom: 20px; }
.completed-empty { color: #aebfca; font-size: .8125rem; }
.taskboard-footnote { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-top: 20px; border-top: 1px solid #30404b; font-size: .6875rem; color: #9cb1bd; }
.taskboard-footnote a { min-height:44px;align-items:center;color: #b7d9c8; display: flex; align-items: center; gap: 6px; }
.board-error, .board-warning { font-size: .8125rem; line-height: 1.7; margin-bottom: 20px; }
.board-error { color: #ffa6a6; } .board-warning { color: #edc47e; }
@media (min-width: 1700px) { .taskboard-home { padding: 40px 44px; }  }
@media (max-width: 1200px) { .taskboard-page-heading { flex-wrap: wrap; } .taskboard-heading-tools { width: 100%; margin-left: 0; } .taskboard-toolbar { flex: 1; } .taskboard-search { width: 100%; } .active-run.occupied { grid-template-columns: minmax(0, 1fr) auto; } .active-run.occupied .active-run-heading { grid-column: 1 / -1; border: 0; } .taskboard-home { padding: 28px 24px; } .taskboard-groups:not(.list-view) { gap: 16px; grid-template-columns: repeat(2,minmax(0,1fr)); }  }
@media (max-width: 1000px) {  .taskboard-workspace { grid-template-columns: 1fr; } .taskboard-groups:not(.list-view) { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 24px; } .taskboard-page-heading { margin-bottom:var(--space-4); } }
@media (max-width: 600px) {  .taskboard-home { padding: 24px 20px; } .taskboard-page-heading h1 { font-size: 1.75rem; } .taskboard-view button { padding-inline: 9px; } .taskboard-groups:not(.list-view) { grid-template-columns: 1fr; } .taskboard-heading-tools { flex-wrap: wrap; gap: 12px; } .taskboard-toolbar { flex-basis: 100%; flex-wrap: wrap; gap: 10px; } .taskboard-search { flex: 1; width: auto; min-width: 0; } .taskboard-new { margin-left: auto; } .active-run { padding: 18px; } .active-run.occupied { grid-template-columns: 1fr; gap: 10px; } .active-run-actions { flex-direction: row; justify-content: space-between; align-items: center; } }
</style>
