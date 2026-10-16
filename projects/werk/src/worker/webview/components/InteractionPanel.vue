<script lang="ts">
import { reactive, watch as watchPrivateDrafts } from 'vue';
import { state as workerState } from '../store';
import type { InteractionCommand } from '../../application/interactions';
// Tab memory survives access expiry, but never writes private answers into browser storage.
const answerDrafts = reactive(new Map<string, string>());
type CheckpointCommand = InteractionCommand | { action: 'cancel'; sessionId: string; pendingId: string; expectedRevision: number; operationId: string };
const operations = reactive(new Map<string, CheckpointCommand>());
watchPrivateDrafts(() => workerState.draftEpoch, () => { answerDrafts.clear(); operations.clear(); }, { flush: 'sync' });
</script>
<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import MessageContent from './MessageContent.vue';
import type { InteractionView, InteractionTurn } from '../../application/interactions';
import { state, request, refresh, date } from '../store';
const props = defineProps<{ currentStatus?: string }>();
const emit = defineEmits<{ change: [InteractionView | null]; busy: [boolean] }>();
const view = ref<InteractionView | null>(null), lastTurn = ref<InteractionTurn | null>(null);
const loading = ref(false), busy = ref(false), active = ref(true), error = ref(''), readError = ref(''), notice = ref('');
let generation = 0, consumptionKey = '';
const sessionId = computed(() => state.sessions?.selected ?? '');
const resumable = computed(() => !!view.value?.latestTurn && ['failed', 'cancelled', 'interrupted'].includes(view.value.phase));
const checkpoint = computed(() => view.value?.pending?.id ?? (resumable.value ? view.value?.latestTurn?.id : ''));
const draftKey = computed(() => `${sessionId.value}:${checkpoint.value}`);
const draft = computed({ get: () => answerDrafts.get(draftKey.value) ?? '', set: value => answerDrafts.set(draftKey.value, value) });
const earlierDrafts = computed(() => [...answerDrafts.entries()].filter(([key, text]) => key.startsWith(sessionId.value + ':') && key !== draftKey.value && text.trim()).map(([key, text]) => ({ key, text })));
const retry = computed(() => [...operations.entries()].find(([, command]) => command.sessionId === sessionId.value));
const legacyStopped = computed(() => !view.value?.latestTurn && ['failed', 'cancelled', 'interrupted'].includes(props.currentStatus ?? ''));
const measured = (value: number | null | undefined) => value == null ? 'Unavailable' : value.toLocaleString();
const cost = (value: number | null | undefined) => value == null ? 'Unavailable' : '$' + value.toFixed(4) + ' USD';
const budgetSummary = (budget: NonNullable<InteractionTurn['toolBudget']>) => `${budget.reason === 'calls' ? 'Call limit reached' : 'Tool window ended'} · ${budget.callsUsed} of ${budget.maxCalls} calls used · ${Math.round(budget.windowMs / 1000)} s window · ${budget.refusedCalls} ${budget.refusedCalls === 1 ? 'call' : 'calls'} refused`;
const costHeading = (basis?: string) => basis === 'reported_estimate' ? 'Provider-reported estimate' : basis === 'reported_billed' ? 'Provider-reported billed cost' : basis === 'unavailable' ? 'Cost unavailable' : 'Reported cost · basis unknown';
const phaseLabel = computed(() => ({ waiting_input: 'Waiting for your answer', escalated: 'Your decision is needed', cancelled: 'Task stopped', failed: 'This attempt failed', interrupted: 'Worker interrupted', queued: 'Continuation queued', running: 'Continuation running', completed: 'Turn completed', idle: 'No checkpoint' }[view.value?.phase ?? 'idle']));
async function load() {
  if (!active.value || !state.unlocked || !sessionId.value || loading.value || busy.value) return;
  const current = ++generation, id = sessionId.value; loading.value = true;
  try {
    const result: InteractionView = await request('/api/interactions', 'POST', { action: 'get', sessionId: id });
    if (current !== generation || !state.unlocked || id !== sessionId.value) return;
    readError.value = ''; view.value = result; emit('change', result);
    const turn = result.latestTurn, key = turn ? turn.id + ':' + turn.status : '';
    if (turn?.id !== lastTurn.value?.id) { lastTurn.value = null; consumptionKey = ''; }
    if (!turn) { lastTurn.value = null; consumptionKey = ''; }
    else if (turn.finishedAt && key !== consumptionKey) {
      const detail: InteractionTurn = await request('/api/interactions', 'POST', { action: 'turn', sessionId: id, turnId: turn.id });
      if (current === generation && state.unlocked && id === sessionId.value) { lastTurn.value = detail; consumptionKey = key; }
    }
  } catch (failure) { if (current === generation && state.unlocked) readError.value = (failure as Error).message; }
  finally { if (current === generation) loading.value = false; }
}
async function useChoice(label: string) { draft.value = label; await nextTick(); document.getElementById('checkpoint-answer')?.focus(); }
async function submit() {
  if (!view.value || !state.unlocked || busy.value || loading.value || retry.value) return;
  const pending = view.value.pending, turn = view.value.latestTurn;
  if (pending && !draft.value.trim() || !pending && !resumable.value) return;
  const command: InteractionCommand = pending
    ? { action: 'answer', sessionId: sessionId.value, pendingId: pending.id, expectedRevision: view.value.revision, operationId: crypto.randomUUID(), answer: draft.value.trim() }
    : { action: 'resume', sessionId: sessionId.value, turnId: turn!.id, expectedRevision: view.value.revision, operationId: crypto.randomUUID(), ...(draft.value.trim() ? { message: draft.value.trim() } : {}) };
  const key = draftKey.value; operations.set(key, command); await send(key, command);
}
async function retryCommand() { if (retry.value) await send(retry.value[0], retry.value[1]); }
async function stopPending() {
  if (!view.value?.pending || busy.value || loading.value || retry.value) return;
  const command: CheckpointCommand = { action: 'cancel', sessionId: sessionId.value, pendingId: view.value.pending.id, expectedRevision: view.value.revision, operationId: crypto.randomUUID() };
  const key = draftKey.value + ':cancel'; operations.set(key, command); await send(key, command);
}
async function send(key: string, command: CheckpointCommand) {
  if (!state.unlocked || busy.value) return;
  const current = generation; busy.value = true; emit('busy', true); error.value = ''; notice.value = '';
  try {
    const result: InteractionView = await request('/api/interactions', 'POST', command);
    operations.delete(key);
    if (command.action !== 'cancel' && answerDrafts.get(key)?.trim() === (command.answer ?? command.message ?? '')) answerDrafts.delete(key);
    if (current !== generation || !state.unlocked || command.sessionId !== sessionId.value) return;
    view.value = result; if (result.latestTurn?.id !== lastTurn.value?.id) { lastTurn.value = null; consumptionKey = ''; } emit('change', result);
    notice.value = command.action === 'cancel' ? 'Task stopped. Its saved context and earlier question remain available for an explicit continuation.' : command.action === 'answer' ? 'Answer accepted. The continuation uses this task’s retained context.' : 'Continuation accepted. A new attempt keeps the earlier evidence.';
    await refresh();
  } catch (failure) {
    if (current !== generation || !state.unlocked || command.sessionId !== sessionId.value) return;
    if ((failure as Error & { status?: number }).status === 409) {
      operations.delete(key); error.value = 'This checkpoint changed. Your draft is kept. Refresh the task state, review the current question, then submit again.';
    } else error.value = 'The request result is not confirmed. Your draft is kept. Retry the same request or refresh the task state.';
  } finally {
    busy.value = false; emit('busy', false);
    if (active.value && state.unlocked && command.sessionId === sessionId.value) void load();
  }
}
function resetVisible() { generation++; view.value = null; lastTurn.value = null; consumptionKey = ''; loading.value = false; error.value = ''; readError.value = ''; notice.value = ''; emit('change', null); }
watch(sessionId, () => { resetVisible(); void load(); });
watch(() => state.unlocked, unlocked => { resetVisible(); if (unlocked) void load(); });
watch(() => state.refreshRevision, () => { void load(); });
onMounted(() => { void load(); });
onActivated(() => { active.value = true; void load(); });
onDeactivated(() => { active.value = false; generation++; loading.value = false; });
</script>
<template>
<section v-if="view?.pending || resumable || retry || lastTurn?.usage || lastTurn?.toolBudget || lastTurn?.dispatch || error || readError || legacyStopped || notice" class="interaction-panel" :aria-labelledby="view?.pending || resumable || legacyStopped ? 'checkpoint-title' : undefined" :aria-busy="busy || loading">
  <template v-if="view?.pending || resumable || legacyStopped">
    <div class="section-heading"><h3 id="checkpoint-title">{{ legacyStopped ? 'No saved execution checkpoint' : phaseLabel }}</h3><UButton color="neutral" variant="ghost" :disabled="busy || loading" @click="load">Refresh task state</UButton></div>
    <p class="sr-only" role="status">{{ phaseLabel }}{{ view?.pending ? '. ' + view.pending.message : '' }}</p>
    <template v-if="view?.pending"><MessageContent :text="view.pending.message" /><p v-if="view.pending.reason" class="page-note">{{ view.pending.reason }}</p><p class="page-note">Asked {{ date(view.pending.createdAt) }}. This question or decision request is saved with the task. Opening it does not answer it. Unsent drafts survive automatic refresh and access expiry, but a page reload clears them.</p></template>
    <p v-else-if="legacyStopped" class="page-note">This older conversation has no durable model checkpoint. A follow-up starts a new turn with its saved transcript.</p>
    <p v-else class="page-note">Continue from the task’s saved context in a new attempt. The worker replays its context; it does not restore a native provider process. Existing run evidence remains unchanged.</p>
    <form v-if="!legacyStopped" class="settings-form checkpoint-form" @submit.prevent="submit"><fieldset :disabled="busy || !!retry" class="contents"><div v-if="view?.pending?.choices?.length" class="actions checkpoint-choices" role="group" aria-label="Suggested answers"><UButton v-for="choice in view.pending.choices" :key="choice.id" type="button" color="neutral" variant="outline" @click="useChoice(choice.label)">{{ choice.label }}</UButton></div><label for="checkpoint-answer">{{ view?.pending ? 'Your answer or decision' : 'Revised instructions · optional' }}</label><UTextarea id="checkpoint-answer" v-model="draft" :rows="3" :maxrows="8" autoresize :maxlength="8000" :required="!!view?.pending" :placeholder="view?.pending ? 'Answer the question or explain how the worker should proceed…' : 'Clarify or revise the goal before continuing…'" class="w-full" /><p class="page-note">{{ view?.pending ? 'Review suggested answers before sending. Selecting one does not submit it.' : 'Leave blank to continue the saved task. Add instructions to revise its next attempt.' }}</p><UButton type="submit" :loading="busy" :disabled="loading || !!retry || (!!view?.pending && !draft.trim())">{{ view?.pending ? 'Answer & continue' : 'Resume with context' }}</UButton><UButton v-if="view?.pending" type="button" color="neutral" variant="outline" :disabled="busy || loading || !!retry" @click="stopPending">Stop this task</UButton></fieldset></form>
  </template>
  <p v-if="readError" role="alert" class="error-text">{{ readError }} Task checkpoint data may be stale. Refresh the task state to retry.</p>
  <p v-if="error" role="alert" class="error-text">{{ error }}</p><p v-if="notice" role="status" class="page-note">{{ notice }}</p>
  <div v-if="retry" class="actions"><UButton color="neutral" variant="outline" :loading="busy" @click="retryCommand">Retry the same request</UButton><UButton color="neutral" variant="ghost" :disabled="busy || loading" @click="load">Refresh task state</UButton></div>
  <details v-if="earlierDrafts.length" class="checkpoint-turn-history"><summary>Earlier unsent drafts · {{ earlierDrafts.length }}</summary><p class="page-note">These drafts belong to earlier checkpoints in this task. Review the current question before reusing one.</p><div v-for="earlier in earlierDrafts" :key="earlier.key"><pre>{{ earlier.text }}</pre><UButton color="neutral" variant="outline" :disabled="busy || !!retry || !checkpoint" @click="useChoice(earlier.text)">Use this draft</UButton></div></details>
  <div v-if="lastTurn?.usage" class="turn-consumption"><h4>Latest turn consumption</h4><dl class="facts"><div><dt>Input / output tokens</dt><dd>{{ measured(lastTurn.usage.inputTokens) }} / {{ measured(lastTurn.usage.outputTokens) }}</dd></div><div><dt>{{ costHeading(lastTurn.usage.costBasis) }}</dt><dd>{{ cost(lastTurn.usage.providerReportedCostUsd) }}</dd></div></dl><p class="page-note">{{ lastTurn.usage.reason || 'Reported by the provider for this turn.' }} Missing measurements are unavailable, never zero. Reported costs are not a verified invoice or a subscription balance.</p><UButton v-if="lastTurn.runId" :to="'/history?view=runs&runSession=' + encodeURIComponent(sessionId) + '&runId=' + encodeURIComponent(lastTurn.runId)" color="neutral" variant="ghost">Inspect this turn’s evidence</UButton></div>
  <div v-if="lastTurn?.toolBudget" class="turn-consumption"><h4>Tool budget exhausted</h4><p>{{ budgetSummary(lastTurn.toolBudget) }}</p><p class="page-note">The model received a tool error for each refused call and was told to finish with what it had. Results may be incomplete; review them before relying on them.</p></div>
  <details v-if="lastTurn && !lastTurn.dispatch" class="checkpoint-turn-history"><summary>Inspect saved turn input</summary><pre>{{ lastTurn.input }}</pre><p class="page-note">No model dispatch was prepared for this turn. Its saved input remains available for an explicit continuation.</p></details>
  <details v-if="lastTurn?.dispatch" class="checkpoint-turn-history"><summary>Inspect saved model request</summary><p class="page-note">This is the immutable request saved for this turn. A continuation builds a new request from retained context; it does not overwrite this checkpoint.</p><dl class="facts"><div><dt>Saved provider / model</dt><dd>{{ lastTurn.dispatch.provider.id }} / {{ lastTurn.dispatch.provider.model || 'Provider default' }}</dd></div><div><dt>Request digest</dt><dd class="break-anywhere">{{ lastTurn.dispatchDigest || 'Not recorded' }}</dd></div><div><dt>Continuation capability</dt><dd>Worker context replay · native provider resume unavailable</dd></div></dl><details><summary>Saved semantic prompt</summary><pre>{{ lastTurn.dispatch.renderedPrompt }}</pre></details></details>
  <details v-if="view?.turns.length" class="checkpoint-turn-history"><summary>Model turn history · {{ view.totalTurns }}</summary><ol><li v-for="turn in view.turns" :key="turn.id"><strong>{{ turn.kind === 'answer' ? 'Answer' : turn.kind === 'resume' ? 'Context continuation' : 'Instructions' }}</strong> · {{ turn.status.replaceAll('_', ' ') }}<span class="muted">{{ date(turn.createdAt) }}{{ turn.priorTurnId ? ' · continues an earlier turn' : '' }}</span><RouterLink v-if="turn.runId" :to="'/history?view=runs&runSession=' + encodeURIComponent(sessionId) + '&runId=' + encodeURIComponent(turn.runId)">Inspect attempt evidence</RouterLink></li></ol></details>
</section>
</template>
