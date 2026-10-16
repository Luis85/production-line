<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import TaskIntake from './TaskIntake.vue';
import RunTask from './RunTask.vue';
import MessageContent from './MessageContent.vue';
import AssistantMessage from './AssistantMessage.vue';
import RequestGatePanel from './RequestGatePanel.vue';
import InteractionPanel from './InteractionPanel.vue';
import type { InteractionTurn, InteractionView } from '../../application/interactions';
import { state, chatAction, date, request, taskStatus, workspaceAction } from '../store';
const emit = defineEmits<{ busy: [boolean] }>();
const mode = ref<'new' | 'followup'>('new');
const controlsOpen = ref(false), evidenceOpen = ref(false), gateDetails = ref<HTMLDetailsElement | null>(null);
const intake = ref<InstanceType<typeof TaskIntake> | null>(null);
const sending = ref(false), intakeBusy = ref(false), interactionBusy = ref(false), settingsBusy = ref(false);
const interaction = ref<InteractionView | null>(null);
const savedModel = ref(''), modelError = ref(false), rename = ref(''), removing = ref(false), settingsError = ref('');
let modelGeneration = 0, modelIdentity = '';
const active = ref(true);
onActivated(() => { active.value = true; });
onDeactivated(() => { active.value = false; modelGeneration++; });
onBeforeUnmount(() => { active.value = false; modelGeneration++; });
const current = computed(() => state.sessions?.records.find(item => item.id === state.sessions?.selected));
const connection = computed(() => state.settings?.providers.find(item => item.id === current.value?.provider));
const executing = computed(() => !!current.value && state.sessions?.execution.currentSessionId === current.value.id);
const busy = computed(() => sending.value || intakeBusy.value || interactionBusy.value || settingsBusy.value);
const checkpointBlocked = computed(() => !!interaction.value?.pending || !!interaction.value?.latestTurn && ['failed', 'cancelled', 'interrupted'].includes(interaction.value.phase));
const available = computed(() => state.unlocked && !!current.value && state.chat?.available && !state.workspaceBusy && !busy.value && !checkpointBlocked.value && !current.value?.busy && !state.chat?.busy && !executing.value);
const firstMessage = computed(() => !state.chat?.messages.length);
// The latest completed reply of a file task links to its retained patch.
const patchReply = computed(() => {
  const task = state.board?.tasks.find(item => item.sessionId === current.value?.id && item.hasPatch);
  const reply = state.chat?.messages.findLast(message => message.role === 'assistant' && message.state === 'complete');
  return task && reply ? { taskId: task.id, messageId: reply.id } : null;
});
const phase = computed(() => state.chat?.phase ?? 'idle');
watch(busy, value => emit('busy', value));
watch(() => current.value?.id, (id, previous) => {
  interaction.value = null; savedModel.value = ''; modelError.value = false; modelGeneration++;
  removing.value = false; settingsError.value = ''; controlsOpen.value = false; evidenceOpen.value = false;
  if (id && previous && id !== previous) mode.value = 'followup';
});
watch(() => [current.value?.id, current.value?.title].join('|'), () => { rename.value = current.value?.title ?? ''; }, { immediate: true });
watch(() => [active.value, state.unlocked, current.value?.id, interaction.value?.latestTurn?.id, interaction.value?.latestTurn?.status, state.refreshRevision].join('|'), async () => {
  const generation = ++modelGeneration, id = current.value?.id, turnId = interaction.value?.latestTurn?.id;
  const identity = [id, turnId].join(':');
  if (identity !== modelIdentity) { savedModel.value = ''; modelIdentity = identity; }
  modelError.value = false;
  if (!active.value || !state.unlocked || !id || !turnId) return;
  try {
    const turn: InteractionTurn = await request('/api/interactions', 'POST', { action: 'turn', sessionId: id, turnId });
    if (generation === modelGeneration && state.unlocked && current.value?.id === id) savedModel.value = turn.dispatch ? turn.dispatch.provider.model || 'Provider default' : '';
  } catch { if (generation === modelGeneration && state.unlocked) modelError.value = true; }
});
async function openNewTask() {
  if (busy.value || state.workspaceBusy) return;
  mode.value = 'new'; await nextTick(); await intake.value?.focusInstructions();
}
async function focusConversation() {
  mode.value = 'followup'; controlsOpen.value = false;
  await nextTick(); document.getElementById('chat-task-title')?.focus();
}
async function focusControls() {
  mode.value = 'followup'; controlsOpen.value = true;
  await nextTick();
  gateDetails.value?.querySelector('summary')?.focus({ preventScroll: true });
  gateDetails.value?.scrollIntoView({ block: 'nearest' });
}
function toggleEvidence(event: Event) {
  if (!checkpointBlocked.value) evidenceOpen.value = (event.target as HTMLDetailsElement).open;
}
async function created(sessionId: string) {
  if (!state.unlocked) return;
  if (state.sessions?.selected !== sessionId) {
    const creationError = state.actionError;
    const selected = await workspaceAction('/api/sessions', { action: 'select', id: sessionId });
    if (selected && creationError) state.actionError = creationError;
  }
  mode.value = 'followup'; await nextTick(); document.getElementById('chat-message')?.focus();
}
function switchMode(next: 'new' | 'followup') { if (!busy.value && !state.workspaceBusy && (next === 'new' || current.value)) mode.value = next; }
function tabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy.value || state.workspaceBusy) return;
  event.preventDefault(); const next = event.key === 'Home' ? 'new' : event.key === 'End' ? 'followup' : mode.value === 'new' ? 'followup' : 'new';
  switchMode(next); document.getElementById(mode.value === 'new' ? 'new-task-tab' : 'followup-task-tab')?.focus();
}
async function act(action: 'send' | 'cancel') {
  if (busy.value || state.workspaceBusy || !state.unlocked || action === 'send' && (!available.value || !state.draft.trim())) return;
  const sessionId = current.value?.id;
  sending.value = true;
  try {
    await chatAction(action);
    if (action === 'send' && state.unlocked && !state.actionError && !state.draft && current.value?.id === sessionId) {
      await nextTick();
      if (state.unlocked && current.value?.id === sessionId) document.querySelector('.task-conversation .task-message:last-of-type')?.scrollIntoView({ block: 'nearest' });
    }
  } finally { sending.value = false; }
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && available.value && state.draft.trim()) { event.preventDefault(); void act('send'); }
}
async function taskAction(action: 'rename' | 'archive' | 'delete') {
  if (!current.value || busy.value || state.workspaceBusy) return;
  const id = current.value.id; settingsBusy.value = true; settingsError.value = '';
  try {
    const result = await workspaceAction('/api/sessions', { action, id, ...(action === 'rename' ? { title: rename.value } : {}) });
    if (!result) settingsError.value = state.actionError || 'The task could not be updated. Your input is retained.';
    else removing.value = false;
  } finally { settingsBusy.value = false; }
}
defineExpose({ openNewTask, focusConversation, focusControls });
</script>
<template>
  <aside class="task-interaction" aria-labelledby="task-interaction-title">
    <h2 id="task-interaction-title" tabindex="-1">Task interaction</h2>
    <div class="interaction-tabs" role="tablist" aria-label="Task interaction mode" @keydown="tabKey">
      <button id="new-task-tab" role="tab" :aria-selected="mode === 'new'" :tabindex="mode === 'new' ? 0 : -1" aria-controls="new-task-pane" :disabled="busy || state.workspaceBusy" @click="switchMode('new')"><UIcon name="i-lucide-plus" />New task</button>
      <button id="followup-task-tab" role="tab" :aria-selected="mode === 'followup'" :tabindex="mode === 'followup' ? 0 : -1" aria-controls="followup-task-pane" :disabled="!current || busy || state.workspaceBusy" @click="switchMode('followup')"><UIcon name="i-lucide-message-circle" />Follow up</button>
    </div>
    <div v-show="mode === 'new'" id="new-task-pane" role="tabpanel" aria-labelledby="new-task-tab">
      <TaskIntake ref="intake" @created="created" @busy="intakeBusy = $event" />
      <div class="file-task-entry"><RunTask trigger-label="Prepare a file task" /></div>
    </div>
    <div v-show="mode === 'followup'" id="followup-task-pane" role="tabpanel" aria-labelledby="followup-task-tab">
      <template v-if="current">
        <header class="pinned-task">
          <div class="pinned-task-meta"><UIcon name="i-lucide-pin" /><span>Selected task</span><UBadge :color="['waiting_input', 'escalated', 'review', 'needs_rework'].includes(current.status) ? 'warning' : current.status === 'running' ? 'primary' : 'neutral'" variant="subtle">{{ taskStatus(current.status) }}</UBadge></div>
          <h3 id="chat-task-title" tabindex="-1">{{ current.title }}</h3>
          <p>{{ connection?.label ?? current.provider }}<span v-if="savedModel"> · {{ savedModel }}</span></p>
          <p class="model-source">{{ savedModel ? 'Model recorded in the latest conversation request' : modelError ? 'Saved conversation model unavailable · refresh this worker to retry' : 'Conversation model not yet recorded' }}</p>
        </header>
        <p v-if="state.settings?.board.paused" class="interaction-notice" role="status">New starts are paused. Queued work waits until you resume the queue.</p>
        <p v-if="state.chat?.persistenceError" class="interaction-notice error-text" role="alert">This reply could not be saved. Check disk space and state-directory permissions before restarting.</p>
        <p v-if="state.paused && state.chat?.busy" class="interaction-notice" role="status">Task updates are paused. Resume updates in the header to see progress.</p>
        <details class="task-checkpoint" :class="{ 'has-checkpoint': checkpointBlocked }" :open="checkpointBlocked || evidenceOpen" @toggle="toggleEvidence">
          <summary>Saved task context &amp; evidence</summary>
          <InteractionPanel :current-status="current.status" @change="interaction = $event" @busy="interactionBusy = $event" />
        </details>
        <p v-if="firstMessage" class="followup-empty">Describe the outcome you need. The first message queues this task.</p>
        <div v-else :key="current.id" class="task-conversation" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Task conversation">
          <article v-for="message in state.chat?.messages" :key="message.id" class="task-message" :class="message.role">
            <div class="task-message-label"><UIcon :name="message.role === 'user' ? 'i-lucide-user-round' : 'i-lucide-sparkles'" /><strong>{{ message.role === 'user' ? 'You' : 'Worker model' }}</strong><time :datetime="message.at">{{ date(message.at) }}</time></div>
            <UBadge v-if="['error', 'cancelled'].includes(message.state)" :color="message.state === 'error' ? 'error' : 'neutral'" variant="subtle">{{ message.state === 'error' ? 'Failed' : 'Cancelled' }}</UBadge>
            <p v-if="message.state === 'pending'" class="pending-message">{{ phase === 'queued' ? state.settings?.board.paused ? 'Queued · new starts are paused.' : 'Queued · waiting for this worker.' : 'Working on this task…' }}</p>
            <AssistantMessage v-else-if="message.role === 'assistant' && message.state === 'complete'" :text="message.text" :patch-task-id="patchReply?.messageId === message.id ? patchReply.taskId : undefined" />
            <MessageContent v-else :text="message.text" :markdown="false" :class="{ 'error-text': message.state === 'error' }" />
          </article>
        </div>
        <p v-if="!state.chat?.available" class="interaction-notice">This connection is not ready. Open <RouterLink to="/dashboard#provider-connections">Dashboard</RouterLink> to configure it.</p>
        <p v-if="checkpointBlocked" class="followup-guidance" role="status">Use the answer or resume controls above to continue. Your follow-up draft stays here.</p>
        <p v-else-if="current.busy || state.chat?.busy || executing" class="followup-guidance">{{ executing && !current.busy && !state.chat?.busy ? 'This task is still active. Draft a follow-up now; send it when the worker finishes.' : 'Draft a follow-up now; send it when this task finishes.' }} New task queues separate work.</p>
        <form class="followup-composer" @submit.prevent="act('send')">
          <label for="chat-message">{{ firstMessage ? 'Task instructions' : 'Follow-up for this task' }}</label>
          <UTextarea id="chat-message" v-model="state.draft" :rows="4" :maxrows="10" autoresize :maxlength="8000" :disabled="sending || state.workspaceBusy" :placeholder="firstMessage ? 'Describe the outcome you need…' : 'Add context or revise what this task should do next…'" class="w-full" aria-describedby="followup-draft-note" @keydown="keydown" />
          <p id="followup-draft-note" class="followup-draft-note">{{ state.draft.length.toLocaleString() }} / 8,000 · Ctrl / ⌘ + Enter to send</p>
          <div class="followup-actions">
            <UButton v-if="state.chat?.busy" type="button" color="error" variant="outline" icon="i-lucide-square" :loading="sending" :disabled="interactionBusy || state.workspaceBusy" @click="act('cancel')">{{ phase === 'queued' ? 'Cancel queued task' : 'Stop task' }}</UButton>
            <UButton v-else type="submit" icon="i-lucide-arrow-up" :loading="sending" :disabled="!available || !state.draft.trim()">{{ firstMessage ? 'Queue task' : 'Send follow-up' }}</UButton>
          </div>
          <p v-if="state.actionError" class="error-text" role="alert">{{ state.actionError }}</p>
        </form>
        <p class="draft-privacy">Drafts stay with each task in this tab until you reload or lock it.</p>
        <details v-if="current.requestId" ref="gateDetails" class="task-secondary request-controls" :open="controlsOpen" @toggle="controlsOpen = ($event.target as HTMLDetailsElement).open">
          <summary>Request review &amp; controls</summary>
          <RequestGatePanel :request-id="current.requestId" :session-id="current.id" />
        </details>
        <details v-if="current.definition" class="task-secondary">
          <summary>Saved agent · {{ current.definition.name }} / {{ current.definition.agent }}</summary>
          <p>This task keeps the instructions and model selected at creation.{{ current.definition.adapted ? ' Uses instructions-only adaptation.' : '' }}</p>
          <p>{{ current.definition.model || 'Configured provider model' }}</p><pre>{{ current.definition.instruction }}</pre>
        </details>
        <details class="task-secondary task-settings">
          <summary>Task settings</summary>
          <form class="settings-form" @submit.prevent="taskAction('rename')">
            <label for="rename-task">Task name</label><UInput id="rename-task" v-model="rename" required :maxlength="120" :disabled="busy || state.workspaceBusy" class="w-full" />
            <UButton type="submit" color="neutral" variant="outline" :loading="settingsBusy" :disabled="busy || state.workspaceBusy">Rename task</UButton>
            <div class="actions"><UButton type="button" color="neutral" variant="ghost" :disabled="busy || state.workspaceBusy || current.busy" @click="taskAction('archive')">Archive</UButton><UButton type="button" color="error" variant="ghost" :disabled="busy || state.workspaceBusy || current.busy" @click="removing = !removing">Delete</UButton></div>
            <div v-if="removing" class="confirm-row"><p>Delete this task and all its saved messages?</p><UButton type="button" color="error" :disabled="busy || state.workspaceBusy || current.busy" @click="taskAction('delete')">Confirm deletion</UButton><UButton type="button" color="neutral" variant="ghost" @click="removing = false">Keep task</UButton></div>
            <p v-if="settingsError" class="error-text" role="alert">{{ settingsError }}</p>
          </form>
        </details>
      </template>
      <p v-else class="followup-empty">Select a task on the board to view its conversation.</p>
    </div>
  </aside>
</template>
<style scoped>
.task-interaction { min-width: 0; color: var(--ui-text); }
h2 { margin: 0 0 18px; font-size: 1.5rem; line-height: 1.3; font-weight: 650; letter-spacing: -.02em; color: var(--ui-text-highlighted); }
.interaction-tabs { display: grid; grid-template-columns: 1fr 1fr; padding: 3px; gap: 3px; border: 1px solid #3a4c56; border-radius: 9px; margin-bottom: 28px; background: #14232b; }
.interaction-tabs button { display: flex; align-items: center; justify-content: center; gap: 10px; border-radius: 6px; min-height: 39px; padding: 7px; font-size: .8125rem; cursor: pointer; }
.interaction-tabs button[aria-selected="true"] { color: #09221c; background: #8be0b8; font-weight: 650; }
.interaction-tabs button:disabled { opacity: .5; cursor: default; }
.interaction-tabs :deep(.iconify) { width: 19px; height: 19px; }
.pinned-task { padding-bottom: 20px; margin-bottom: 16px; border-bottom: 1px solid var(--ui-border); }
.pinned-task-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; color: var(--ui-text-muted); font-size: .75rem; }
.pinned-task-meta > :last-child { margin-left: auto; }
.pinned-task h3 { margin: 12px 0 8px; font-size: 1.125rem; line-height: 1.4; font-weight: 650; overflow-wrap: anywhere; color: var(--ui-text-highlighted); }
.pinned-task p { margin: 0; color: var(--ui-text-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.pinned-task .model-source { margin-top: 5px; font-size: .6875rem; color: var(--ui-text-dimmed); }
.interaction-notice { padding: 12px; margin: 12px 0; font-size: .8125rem; line-height: 1.6; background: #26332e; border-left: 2px solid #8be0b8; border-radius: 0 6px 6px 0; }
.task-conversation { margin-block: 20px; min-width: 0; max-height: 540px; overflow-y: auto; scrollbar-gutter: stable; overscroll-behavior: contain; }
.task-message { margin-bottom: 20px; padding: 3px 0; font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere; }
.task-message.user { padding: 14px; border-radius: 8px; background: #1d303b; }
.task-message-label { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 9px; }
.task-message-label :deep(.iconify) { color: #8be0b8; }
.task-message-label time { color: var(--ui-text-muted); font-size: .625rem; margin-left: auto; }
.task-message :deep(pre) { max-width: 100%; overflow: auto; font-size: .75rem; }
.pending-message, .followup-empty, .followup-guidance { font-size: .8125rem; line-height: 1.6; color: var(--ui-text-muted); margin: 12px 0; }
.followup-composer { display: grid; gap: 9px; margin-top: 20px; }
.followup-composer > label { font-weight: 600; font-size: .8125rem; }
.followup-composer :deep(textarea) { background: #111e26; font-size: .875rem; line-height: 1.6; }
.followup-draft-note { font-size: .6875rem; color: var(--ui-text-muted); margin: 0; }
.followup-actions { display: flex; justify-content: flex-end; margin-top: 7px; }
.followup-actions button { min-height: 42px; }
.draft-privacy { font-size: .6875rem; line-height: 1.5; color: var(--ui-text-dimmed); margin: 14px 0 24px; }
.task-checkpoint { margin-bottom: 18px; font-size: .8125rem; }
.task-checkpoint > summary { cursor: pointer; color: var(--ui-text-muted); padding-block: 5px; }
.task-checkpoint.has-checkpoint > summary { display: none; }
.task-checkpoint.has-checkpoint :deep(.interaction-panel) { margin-top: 0; padding-top: 0; border-top: 0; }
.request-controls :deep(.request-gate-panel) { margin-top: 16px; }
.task-secondary { border-top: 1px solid var(--ui-border); padding-block: 15px; font-size: .8125rem; }
.task-secondary summary { cursor: pointer; }
.task-secondary p { margin-block: 12px; color: var(--ui-text-muted); font-size: .75rem; }
.task-secondary pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; }
.task-secondary .settings-form { margin-top: 15px; }
.file-task-entry { border-top: 1px solid var(--ui-border); margin-top: 24px; padding-top: 18px; }
.file-task-entry :deep(.run-task) { margin: 0; padding: 0; border: 0; }
.file-task-entry :deep(.run-task > .actions) { align-items: flex-start; flex-direction: column; gap: 7px; }
.file-task-entry :deep(.run-task > .actions > button) { border: 0; box-shadow: none; padding-inline: 0; background: transparent; color: var(--ui-primary); font-size: .875rem; }
.file-task-entry :deep(.run-task > .actions > .muted) { font-size: .75rem; line-height: 1.6; }
.file-task-entry :deep(.settings-form) { margin-top: 18px; }
:deep(.interaction-panel), :deep(.request-gate-panel) { font-size: .8125rem; }
:deep(.interaction-panel .facts) { grid-template-columns: 1fr; }
:deep(.interaction-panel .section-heading) { align-items: flex-start; flex-wrap: wrap; }
:deep(.interaction-panel h3) { font-size: .9375rem; }
:deep(.interaction-panel button) { max-width: 100%; white-space: normal; }
a { color: var(--ui-primary); }
@media (max-width: 1000px) { .task-conversation { max-height: none; overflow: visible; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
</style>
