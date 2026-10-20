<script setup lang="ts">
import { computed, shallowReactive, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import type { WorkerRun } from '../../application/run-evidence';
import { ExecutionRecoveryController, type ExecutionRecoveryResult } from '../execution-recovery-controller';
import { request, state, date, refresh as refreshWorker } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
const { data, error, refreshing, readAt, now, refresh } = useWorkerSnapshot(() => request<{ schemaVersion: 1; runs: WorkerRun[] }>('/api/requests', 'POST', { action: 'execution_recovery' }));
const controller: ExecutionRecoveryController = shallowReactive(new ExecutionRecoveryController(command => request<ExecutionRecoveryResult>('/api/requests', 'POST', command), () => crypto.randomUUID()));
const selected = ref<WorkerRun | null>(null), note = ref(''), acknowledged = ref(false), actionError = ref(''), notice = ref('');
const fresh = computed(() => !!data.value && !state.paused && !error.value && !!readAt.value && now.value - Date.parse(readAt.value) < 15000);
const current = computed(() => data.value?.runs.find(run => run.id === selected.value?.id) ?? null);
const sameRevision = computed(() => !!current.value && current.value.executionRecovery?.revision === selected.value?.executionRecovery?.revision);
const canConfirm = computed(() => state.unlocked && !controller.busy && (!!controller.pending || fresh.value && sameRevision.value && acknowledged.value && !!note.value.trim() && note.value.trim().length <= 4000));
function inspect(run: WorkerRun) { if (controller.pending || controller.busy) return; selected.value = run; note.value = ''; acknowledged.value = false; notice.value = ''; actionError.value = ''; }
async function confirm() {
  actionError.value = ''; const epoch = state.draftEpoch;
  try {
    const result = await controller.confirm(current.value, note.value, { unlocked: state.unlocked, fresh: fresh.value && sameRevision.value, acknowledged: acknowledged.value });
    if (!result || epoch !== state.draftEpoch) return;
    selected.value = null; note.value = ''; acknowledged.value = false;
    notice.value = 'The operator-attested stop is recorded. The previous model outcome remains unknown. Resume the Feature Request or retry its Ready Check separately when ready.';
    await refresh(); await refreshWorker();
  } catch (cause) { if (epoch === state.draftEpoch) actionError.value = (cause as Error).message; }
}
watch(() => state.draftEpoch, () => { controller.reset(); selected.value = null; note.value = ''; acknowledged.value = false; actionError.value = ''; notice.value = ''; });
</script>
<template>
  <section v-if="data?.runs.length || selected || error || notice" class="execution-recovery" aria-labelledby="execution-recovery-title">
    <header><h2 id="execution-recovery-title">Provider process recovery</h2><UButton color="neutral" variant="outline" :loading="refreshing" :disabled="!state.unlocked || controller.busy" @click="refresh">Refresh recovery evidence</UButton></header>
    <p>An uncertain readiness or review session reserves execution capacity. Inspect the original processes before releasing that reservation. This does not establish the model’s result or continue work.</p>
    <p v-if="error || actionError" class="error-text" role="alert">{{ error || actionError }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ul v-if="data?.runs.length"><li v-for="run in data.runs" :key="run.id"><strong>{{ run.title || run.id }}</strong><span>{{ run.purpose?.replaceAll('_', ' ') || 'Model attempt' }} · {{ run.provider }} · {{ run.model || 'Model not recorded' }}</span><span>{{ run.executionRecovery?.reason.replaceAll('_', ' ') }} · {{ date(run.executionRecovery?.detectedAt) }}</span><RouterLink :to="'/history?view=runs&runSession=' + encodeURIComponent(run.sessionId)">Inspect attempt evidence</RouterLink><UButton color="neutral" variant="outline" :disabled="!!controller.pending || controller.busy || !fresh" @click="inspect(run)">Inspect recovery for {{ run.title || run.id }}</UButton></li></ul>
    <form v-if="selected" @submit.prevent="confirm">
      <h3>Confirm stopped processes for {{ selected.title || selected.id }}</h3><p>Attempt <code>{{ selected.id }}</code> · Recovery revision {{ selected.executionRecovery?.revision }}</p>
      <fieldset :disabled="controller.busy || !!controller.pending"><label class="check-label"><input v-model="acknowledged" type="checkbox" /> I inspected and stopped any remaining processes from this provider attempt.</label><label for="execution-recovery-note">Inspection and stop notes</label><UTextarea id="execution-recovery-note" v-model="note" :rows="3" :maxlength="4000" /></fieldset>
      <p v-if="controller.pending">Confirmation is unconfirmed. Retry sends the same run, revision, note and operation ID; it does not start another model session.</p><p v-else-if="!fresh || !sameRevision">Recovery evidence changed or is stale. Refresh and inspect the current attempt again before confirming.</p>
      <div class="actions"><UButton type="submit" :loading="controller.busy" :disabled="!canConfirm">{{ controller.pending ? 'Retry same stop confirmation' : 'Record operator-confirmed stop' }}</UButton><UButton v-if="!controller.pending" type="button" color="neutral" variant="ghost" :disabled="controller.busy" @click="selected = null">Close inspection</UButton></div>
    </form>
  </section>
</template>
<style scoped>
.execution-recovery { border-block:1px solid var(--ui-border);padding-block:var(--space-5);margin-bottom:var(--space-6);min-width:0; }header,.actions { display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap; }h2 { font-size:1rem; }h3 { font-size:.9375rem; }p,li,label { font-size:.8125rem;line-height:1.65; }p { max-width:80ch; }ul { list-style:none;padding:0; }li { display:grid;gap:var(--space-2);margin-block:var(--space-4);padding-block:var(--space-3);border-bottom:1px solid var(--ui-border); }li span { color:var(--ui-text-muted); }li button { justify-self:start; }fieldset { border:0;padding:0;display:grid;gap:var(--space-3); }form { margin-top:var(--space-5); }label { display:block; }code { overflow-wrap:anywhere; }.check-label { display:flex;gap:var(--space-3);align-items:flex-start; }.check-label input { margin-top:5px; }.actions { justify-content:flex-start;margin-top:var(--space-4); }:deep(button) { min-height:44px; }
</style>
