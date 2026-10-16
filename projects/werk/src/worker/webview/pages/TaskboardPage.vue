<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import TaskInteraction from '../components/TaskInteraction.vue';
import RepositoryDiscovery from '../components/RepositoryDiscovery.vue';
import OverviewTaskCard from '../components/OverviewTaskCard.vue';
import { buildTaskOverview, type TaskOverviewInput, type TaskOverviewItem } from '../task-overview';
import type { RunPage, WorkerRun } from '../../application/run-evidence';
import { state, request, workspaceAction, refresh, date } from '../store';

const route = useRoute(), router = useRouter();
const interaction = ref<InstanceType<typeof TaskInteraction> | null>(null);
const search = ref(''), view = ref<'board' | 'list'>('board');
const interactionBusy = ref(false), opening = ref(false), queueBusy = ref(false), stopping = ref(false), actionError = ref('');
const features = ref<TaskOverviewInput['features']>(null), activeRun = ref<WorkerRun | null>(null), evidenceError = ref('');
let active = true, evidenceRevision = 0;
const allTasks = computed(() => buildTaskOverview({ sessions: state.sessions, board: state.board, history: state.history, features: features.value, runs: activeRun.value ? [activeRun.value] : [] }));
const overview = computed(() => buildTaskOverview({ sessions: state.sessions, board: state.board, history: state.history, features: features.value }, { search: search.value }));
const running = computed(() => allTasks.value.groups.running[0]);
const currentSession = computed(() => state.sessions?.records.find(item => item.id === state.sessions?.execution.currentSessionId));
const originalAssignment = computed(() => currentSession.value?.kind === 'orchestrator' && ['queued', 'running'].includes(currentSession.value.taskState ?? ''));
const activePurpose = computed(() => activeRun.value?.purpose === 'gate_review' ? 'Advisory review' : activeRun.value?.purpose === 'rework' ? 'Rework proposal' : originalAssignment.value && state.status?.mode === 'mock' ? 'Simulation · no implementation' : 'Task execution');
const canStop = computed(() => !!activeRun.value && activeRun.value.sessionId === currentSession.value?.id && (!activeRun.value.purpose || activeRun.value.purpose === 'execution') && !originalAssignment.value);
const selectionBusy = computed(() => interactionBusy.value || opening.value || stopping.value || state.workspaceBusy);
const runModel = computed(() => activeRun.value && activeRun.value.sessionId === currentSession.value?.id ? activeRun.value.model || 'Provider default' : 'Not yet recorded');
const runProvider = computed(() => activeRun.value && activeRun.value.sessionId === currentSession.value?.id ? activeRun.value.provider : currentSession.value?.provider ?? 'Connection unavailable');
const runElapsed = computed(() => {
  const started = activeRun.value?.startedAt;
  if (!started || activeRun.value?.sessionId !== currentSession.value?.id) return 'Elapsed unavailable';
  const elapsed = Math.max(0, Math.floor((Date.parse(state.lastRead || new Date().toISOString()) - Date.parse(started)) / 1000));
  return Math.floor(elapsed / 60) + 'm ' + elapsed % 60 + 's elapsed';
});
const usage = computed(() => {
  const value = activeRun.value?.usage;
  if (activeRun.value?.sessionId !== currentSession.value?.id || !value || value.inputTokens === null || value.outputTokens === null) return 'Token usage unavailable';
  return (value.inputTokens + value.outputTokens).toLocaleString() + ' tokens reported';
});
const groups = computed(() => [
  { id: 'attention', title: 'Needs you', items: overview.value.groups.attention, icon: 'i-lucide-circle-alert' },
  { id: 'queued', title: 'Up next', items: overview.value.groups.queued, icon: 'i-lucide-list-ordered' },
] as const);

async function readEvidence() {
  if (!active || !state.unlocked) return;
  const revision = ++evidenceRevision;
  const sessionId = currentSession.value?.id;
  if (activeRun.value?.sessionId !== sessionId) activeRun.value = null;
  const results = await Promise.allSettled([
    request('/api/features'),
    sessionId ? request('/api/runs', 'POST', { action: 'list', sessionId, outcome: 'running', limit: 2 }) : Promise.resolve(null),
  ]);
  if (revision !== evidenceRevision || !active || !state.unlocked) return;
  const notes: string[] = [];
  if (results[0].status === 'fulfilled') features.value = results[0].value;
  else notes.push('Project requests could not be refreshed. Their last view may be stale.');
  if (results[1].status === 'fulfilled') {
    const page = results[1].value as RunPage | null;
    const run = page?.total === 1 && page.rows.length === 1 ? page.rows[0] : null;
    activeRun.value = run?.startedAt && !run.after && run.sessionId === sessionId && currentSession.value?.id === sessionId ? run : null;
  } else { activeRun.value = null; notes.push('Current attempt evidence is unavailable.'); }
  evidenceError.value = notes.join(' ');
}
async function openSession(id: string, controls = false) {
  if (selectionBusy.value || !state.unlocked) return;
  opening.value = true; actionError.value = '';
  try {
    if (state.sessions?.selected !== id && !await workspaceAction('/api/sessions', { action: 'select', id })) {
      actionError.value = state.actionError || 'This task could not be opened. Refresh and try again.'; return;
    }
    await nextTick(); if (controls) await interaction.value?.focusControls(); else await interaction.value?.focusConversation();
    if (matchMedia('(max-width: 1000px)').matches) document.getElementById('task-interaction-title')?.scrollIntoView({ block: 'start' });
  } finally { opening.value = false; }
}
async function openTask(item: TaskOverviewItem) {
  if (item.primaryAction.kind !== 'session' || !item.primaryAction.sessionId) { await router.push(item.primaryAction.href); return; }
  await openSession(item.primaryAction.sessionId, ['needs_rework', 'gate_blocked', 'review'].includes(item.status));
  if (state.sessions?.selected === item.primaryAction.sessionId && route.query.session) await router.replace({ path: '/taskboard', query: { session: item.primaryAction.sessionId } });
}
async function openDeepLink() {
  if (active && state.unlocked && route.path === '/taskboard' && typeof route.query.session === 'string') await openSession(route.query.session);
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
async function newTask() { await interaction.value?.openNewTask(); document.getElementById('task-interaction-title')?.scrollIntoView({ block: 'nearest' }); }
watch(() => state.refreshRevision, () => { void readEvidence(); });
watch(() => [route.fullPath, state.unlocked], () => { void openDeepLink(); });
watch(() => state.sessions?.selected, id => {
  if (id && active && route.path === '/taskboard' && route.query.session && route.query.session !== id && !opening.value) void router.replace({ path: '/taskboard', query: { session: id } });
});
watch(() => state.unlocked, value => {
  if (!value) { evidenceRevision++; features.value = null; activeRun.value = null; evidenceError.value = ''; actionError.value = ''; search.value = ''; }
}, { flush: 'sync' });
onActivated(() => { active = true; void readEvidence(); void openDeepLink(); });
onDeactivated(() => { active = false; evidenceRevision++; });
</script>
<template>
  <div class="taskboard-workspace">
    <section class="taskboard-home" aria-labelledby="taskboard-heading">
      <header class="taskboard-page-heading page-heading">
        <div><h1 id="taskboard-heading" tabindex="-1">Taskboard</h1><p>Keep work moving.</p></div>
        <div class="taskboard-heading-tools"><div class="taskboard-view" role="group" aria-label="Taskboard view">
          <button :aria-pressed="view === 'board'" @click="view = 'board'"><UIcon name="i-lucide-columns-2" />Board</button>
          <button :aria-pressed="view === 'list'" @click="view = 'list'"><UIcon name="i-lucide-list" />List</button>
        </div>
      <div class="taskboard-toolbar">
        <UInput v-model="search" aria-label="Search tasks" placeholder="Search tasks…" icon="i-lucide-search" class="taskboard-search" />
        <span>{{ overview.counts.total }} {{ overview.counts.total === 1 ? 'task' : 'tasks' }}<template v-if="search"> matching</template></span>
        <button class="mobile-interaction-link" @click="newTask">New task<UIcon name="i-lucide-arrow-down" /></button>
      </div></div>
      </header>

      <RepositoryDiscovery />
      <section class="active-run" :class="{ occupied: !!currentSession }" aria-labelledby="active-run-heading">
        <div class="active-run-heading"><span class="activity-dot" :class="{ idle: !currentSession }" /><h2 id="active-run-heading">{{ currentSession ? 'Running now' : !state.sessions ? 'Loading taskboard…' : state.settings?.board.paused ? 'New starts paused' : 'Worker available' }}</h2><span class="serial-note">One task at a time</span></div>
        <template v-if="currentSession">
          <div class="active-run-content"><div class="active-run-title"><button :disabled="selectionBusy" @click="openSession(currentSession.id)">{{ running?.title ?? currentSession.title }}<UIcon name="i-lucide-arrow-up-right" /></button></div>
          <div class="active-run-meta"><span>{{ activePurpose }}</span><span>{{ runProvider }}</span><span>{{ runModel }}</span><span>{{ runElapsed }}</span></div>
          <p class="active-run-readout">{{ usage }} · {{ state.error ? 'Status may be stale' : state.paused ? 'Updates paused' : 'Updates every 3s' }}</p>
          <p v-if="originalAssignment" class="active-run-empty">Managed by its owning orchestrator.</p></div>
          <div class="active-run-actions"><UButton v-if="canStop" color="error" variant="outline" icon="i-lucide-square" :loading="stopping" :disabled="selectionBusy" @click="stopTask">Stop task</UButton><UButton v-else-if="!originalAssignment" color="neutral" variant="outline" :disabled="selectionBusy" @click="openSession(currentSession.id, true)">Open task controls</UButton><RouterLink :to="running?.evidenceHref ?? '/history?view=runs'">Inspect attempt</RouterLink></div>
        </template>
        <p v-else class="active-run-empty">{{ !state.sessions ? 'Reading saved tasks and current activity.' : state.settings?.board.paused ? 'Waiting tasks start when you resume. You can still add new work.' : 'Choose a task to follow up, or add instructions in Task interaction.' }}</p>
      </section>
      <p v-if="actionError" class="board-error" role="alert">{{ actionError }}</p>
      <p v-if="evidenceError" class="board-warning" role="status">{{ evidenceError }}</p>

      <div class="taskboard-groups" :class="{ 'list-view': view === 'list' }">
        <section v-for="group in groups" :key="group.id" class="overview-group" :aria-labelledby="'group-' + group.id">
          <header class="overview-group-heading"><h2 :id="'group-' + group.id"><UIcon :name="group.icon" />{{ group.title }}<span class="group-count">{{ group.items.length }}</span></h2></header>

          <div class="overview-cards"><OverviewTaskCard v-for="item in group.items" :key="item.id" :item="item" :selected="!!item.sessionId && item.sessionId === state.sessions?.selected" :disabled="selectionBusy" :compact="view === 'list'" @open="openTask" /></div>
          <div v-if="!group.items.length" class="board-empty"><UIcon :name="group.id === 'attention' ? 'i-lucide-circle-check' : 'i-lucide-inbox'" /><h3>{{ search ? 'No matching tasks' : group.id === 'attention' ? 'Nothing needs your attention' : 'Your queue is clear' }}</h3><p>{{ search ? 'Try another title, task ID or status.' : group.id === 'attention' ? 'Questions, review requests and failed tasks appear here.' : 'Use New task to add work to this queue.' }}</p></div>
          <div v-if="group.id === 'queued'" class="queue-control"><UButton color="neutral" variant="outline" :icon="state.settings?.board.paused ? 'i-lucide-play' : 'i-lucide-pause'" :loading="queueBusy" :disabled="!state.settings" @click="toggleQueue">{{ state.settings?.board.paused ? 'Resume new starts' : 'Pause new starts' }}</UButton><p>{{ currentSession ? 'The active task can finish.' : state.settings?.board.paused ? 'Waiting tasks stay in the queue.' : 'Waiting work starts automatically.' }}</p></div>
        </section>
      </div>
      <details v-if="overview.groups.draft.length" class="taskboard-disclosure"><summary><UIcon name="i-lucide-file-pen-line" />Drafts<span class="group-count">{{ overview.groups.draft.length }}</span></summary><div class="disclosure-cards"><OverviewTaskCard v-for="item in overview.groups.draft" :key="item.id" :item="item" :selected="!!item.sessionId && item.sessionId === state.sessions?.selected" :disabled="selectionBusy" :compact="view === 'list'" @open="openTask" /></div></details>
      <details class="taskboard-disclosure"><summary><UIcon name="i-lucide-circle-check" />Completed &amp; stopped<span class="group-count">{{ overview.groups.completed.length }}</span></summary><div class="disclosure-cards"><OverviewTaskCard v-for="item in overview.groups.completed" :key="item.id" :item="item" :selected="!!item.sessionId && item.sessionId === state.sessions?.selected" :disabled="selectionBusy" :compact="view === 'list'" @open="openTask" /><p v-if="!overview.groups.completed.length" class="completed-empty">Completed turns and stopped tasks appear here. Proposed patches stay in Needs you until reviewed.</p></div></details>
      <div class="taskboard-footnote"><span>{{ state.lastRead ? 'Last refreshed ' + date(state.lastRead) : 'Waiting for worker data' }}</span><RouterLink to="/history">All history<UIcon name="i-lucide-arrow-up-right" /></RouterLink></div>
    </section>
    <TaskInteraction ref="interaction" @busy="interactionBusy = $event" />
  </div>
</template>
<style scoped>
.taskboard-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 30%); min-height: calc(100dvh - 148px); align-items: stretch; }
.taskboard-workspace > :deep(.task-interaction) { padding: 30px 28px; border-left: 1px solid #30434d; background: #17262f; }
.taskboard-home { min-width: 0; padding: 34px 32px 28px; }
.taskboard-page-heading { margin-bottom: 26px; align-items: center; gap: 16px; }
.taskboard-page-heading h1 { font-size: 2.25rem; line-height: 1.25; font-weight: 650; letter-spacing: -.035em; }
.taskboard-page-heading p { margin-top: 7px; font-size: .875rem; }
.taskboard-heading-tools { display: flex; align-items: center; gap: 16px; margin-left: auto; }
.taskboard-view { display: flex; border: 1px solid #31424d; border-radius: 7px; padding: 3px; background: #15232c; }
.taskboard-view button { display: flex; align-items: center; gap: 7px; padding: 8px 12px; min-height: 40px; font-size: .75rem; border-radius: 5px; color: #adbfca; cursor: pointer; }
.taskboard-view button[aria-pressed='true'] { background: #8be0b8; color: #10271e; box-shadow: 0 1px 2px #0005; }
.taskboard-toolbar { display: flex; align-items: center; gap: 14px; }
.taskboard-search { width: 240px; }
.taskboard-search :deep(input) { min-height: 43px; font-size: .8125rem; background: #15232c; }
.taskboard-toolbar > span { display: none; color: #a4b7c2; font-size: .75rem; white-space: nowrap; }
.mobile-interaction-link { display: none; }
.active-run { padding: 20px 22px; border: 1px solid #344c4c; border-radius: 8px; background: #192b2d; margin-bottom: 30px; }
.active-run.occupied { display: grid; grid-template-columns: 145px minmax(0, 1fr) auto; gap: 18px; align-items: center; border-color: #46645c; background: linear-gradient(110deg, #1d3434, #1a2b30); }
.active-run.occupied .active-run-heading { align-self: stretch; border-right: 1px solid #38504f; padding-right: 12px; }
.active-run.occupied .serial-note { display: none; }
.active-run-content { min-width: 0; }
.active-run-heading { display: flex; gap: 9px; align-items: center; }
.activity-dot { height: 7px; width: 7px; border-radius: 50%; background: #8be0b8; flex-shrink: 0; }
.activity-dot.idle { background: #98b3b1; }
.active-run-heading h2 { font-size: .8125rem; font-weight: 650; color: #b9e7d1; }
.serial-note { margin-left: auto; font-size: .6875rem; color: #a5c1bb; }
.active-run-title { margin: 0 0 4px; }
.active-run-title button { display: inline-flex; text-align: left; align-items: center; gap: 10px; font-size: 1.0625rem; font-weight: 600; color: #edf4f7; cursor: pointer; min-height: 32px; overflow-wrap: anywhere; }
.active-run-title button :deep(.iconify) { flex-shrink: 0; }
.active-run-title button:disabled { cursor: default; opacity: .6; }
.active-run-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: .75rem; color: #b6cbc7; }
.active-run-meta span + span::before { content: '·'; padding-right: 10px; color: #7d9c98; }
.active-run-readout { margin-top: 6px; font-size: .6875rem; color: #a4bbb7; }
.active-run-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 0; }
.active-run-actions a { display: inline-flex; align-items: center; min-height: 32px; color: #b8e4cd; font-size: .75rem; }
.active-run-actions :deep(button) { font-size: .8125rem; }
.active-run-empty { margin: 10px 0 0; color: #b5c8c5; font-size: .8125rem; line-height: 1.7; }
.taskboard-groups { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 24px; margin-bottom: 26px; }
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
.board-empty { padding: 34px 20px; border: 1px dashed #33454f; border-radius: 8px; color: #aabfc9; }
.board-empty > :deep(.iconify) { width: 22px; height: 22px; color: #83b6a0; margin-bottom: 12px; }
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
.taskboard-footnote a { color: #b7d9c8; display: flex; align-items: center; gap: 6px; }
.board-error, .board-warning { font-size: .8125rem; line-height: 1.7; margin-bottom: 20px; }
.board-error { color: #ffa6a6; } .board-warning { color: #edc47e; }
@media (min-width: 1700px) { .taskboard-home { padding: 40px 44px; } .taskboard-workspace { grid-template-columns: minmax(0, 1fr) 440px; } }
@media (max-width: 1200px) { .taskboard-page-heading { flex-wrap: wrap; } .taskboard-heading-tools { width: 100%; margin-left: 0; } .taskboard-toolbar { flex: 1; } .taskboard-search { width: 100%; } .active-run.occupied { grid-template-columns: minmax(0, 1fr) auto; } .active-run.occupied .active-run-heading { grid-column: 1 / -1; border: 0; } .taskboard-home { padding: 28px 24px; } .taskboard-groups { gap: 16px; grid-template-columns: 1fr; } .serial-note { display: none; } }
@media (max-width: 1000px) { .taskboard-workspace > :deep(.task-interaction) { border-left: 0; border-top: 1px solid #30434d; padding: 28px 24px; } .taskboard-workspace { grid-template-columns: 1fr; } .taskboard-groups:not(.list-view) { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 24px; } .mobile-interaction-link { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; color: #9de3bf; white-space: nowrap; font-size: .75rem; cursor: pointer; } }
@media (max-width: 600px) { .taskboard-workspace > :deep(.task-interaction) { padding: 26px 20px; } .taskboard-home { padding: 24px 20px; } .taskboard-page-heading h1 { font-size: 1.75rem; } .taskboard-view button { padding-inline: 9px; } .taskboard-groups:not(.list-view) { grid-template-columns: 1fr; } .taskboard-heading-tools { flex-wrap: wrap; gap: 12px; } .taskboard-toolbar { flex-basis: 100%; flex-wrap: wrap; gap: 10px; } .taskboard-search { flex: 1; width: auto; min-width: 0; } .mobile-interaction-link { margin-left: auto; } .active-run { padding: 18px; } .active-run.occupied { grid-template-columns: 1fr; gap: 10px; } .active-run-actions { flex-direction: row; justify-content: space-between; align-items: center; } }
</style>
