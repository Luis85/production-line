<script lang="ts">
import { createQueueSettingsEditor, queuePolicy } from '../worker-policy-editors';
import { state as workerState, guardedSettingsAction, refresh } from '../store';
const editor = createQueueSettingsEditor({
  saved: () => queuePolicy(workerState.settings), unlocked: () => workerState.unlocked, epoch: () => workerState.draftEpoch,
  write: async command => { const settings = await guardedSettingsAction(command); return settings ? queuePolicy(settings)! : undefined; }, refresh,
});
</script>
<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import { state } from '../store';
const { draft, dirty, stale, locked, validation, canSave } = editor;
</script>
<template>
  <section class="policy-settings queue-settings" aria-labelledby="queue-settings-title">
    <h2 id="queue-settings-title">Queue capacity</h2>
    <p class="page-note">Choose how much work this worker can accept. It executes one task at a time; additional tasks wait.</p>
    <form v-if="draft.baseline" :aria-busy="draft.busy" @submit.prevent="editor.save">
      <fieldset class="policy-fields" :disabled="locked">
        <legend class="sr-only">Worker queue settings</legend>
        <div class="policy-grid">
          <div class="policy-field"><label for="local-capacity">Local request capacity</label><UInput id="local-capacity" v-model.number="draft.values.queueCapacity" type="number" min="1" max="64" step="1" required class="w-full" aria-describedby="local-capacity-help" /><p id="local-capacity-help" class="page-note">1–64 tasks, including queued and running work. Lowering this keeps tasks already accepted.</p></div>
          <div class="policy-field"><label for="remote-queue">Extra orchestrator queue places</label><UInput id="remote-queue" v-model.number="draft.values.orchestratorQueue" type="number" min="0" max="64" step="1" required class="w-full" aria-describedby="remote-queue-help" /><p id="remote-queue-help" class="page-note">0–64 additional waiting assignments. The orchestrator keeps their leases active.</p></div>
          <div class="policy-field"><label for="queue-order">File-task and assignment order</label><USelect id="queue-order" v-model="draft.values.order" :items="[{ label: 'First in, first out', value: 'fifo' }, { label: 'High priority first', value: 'priority' }]" class="w-full" aria-describedby="queue-order-help" /><p id="queue-order-help" class="page-note">Orders waiting file tasks and orchestrator assignments within their queues. Chat messages keep their normal order.</p></div>
        </div>
        <div class="policy-actions"><UButton type="submit" :loading="draft.busy" :disabled="!canSave">Save queue settings</UButton><UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="editor.reload">Discard edits and reload</UButton></div>
      </fieldset>
      <p v-if="validation && dirty" role="status" class="error-text">{{ validation }}</p>
      <p v-if="stale" role="status" class="settings-conflict">Saved queue settings changed while you were editing. Your draft is kept. Discard edits and reload before saving.</p>
    </form>
    <p v-else class="page-note">Saved queue settings are not available yet. Refresh to try again.</p>
    <p v-if="draft.error" role="alert" class="error-text">{{ draft.error }}</p>
    <p v-if="draft.notice" role="status">{{ draft.notice }}</p>
    <div v-if="draft.uncertain" role="status" class="settings-conflict">
      <p>The save acknowledgement is uncertain. Your submitted settings are kept.</p>
      <div class="policy-actions"><UButton type="button" color="neutral" variant="outline" :loading="draft.busy" :disabled="draft.checking || !state.unlocked" @click="editor.retry">Retry same save</UButton><UButton type="button" color="neutral" variant="ghost" :disabled="draft.busy || draft.checking || !state.unlocked" @click="editor.reload">Discard edits and reload</UButton></div>
    </div>
    <UButton v-if="!draft.baseline || draft.uncertain" type="button" color="neutral" variant="outline" :loading="draft.checking" :disabled="draft.busy || !state.unlocked" @click="editor.check">Refresh saved settings</UButton>
    <p class="page-note">Saving settings does not pause or resume the queue. Control new starts from <RouterLink to="/taskboard">Taskboard</RouterLink>.</p>
  </section>
</template>
<style scoped>
.policy-settings { min-width: 0; }
.policy-settings h2 { margin: 0 0 var(--space-3); }
.policy-settings p { max-width: 75ch; }
.policy-fields { min-width: 0; border: 0; padding: 0; margin: var(--space-6) 0 0; }
.policy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.policy-field { display: grid; align-content: start; gap: var(--space-2); min-width: 0; }
.policy-field label { font-weight: 600; }
.policy-field p { margin: 0; }
.policy-field :deep(input), .policy-field :deep(button), .policy-actions :deep(button) { min-height: 44px; }
.policy-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-6); }
.settings-conflict { margin: var(--space-4) 0; padding: var(--space-4); background: var(--ui-bg-elevated); border: 1px solid var(--ui-border); border-radius: 12px; }
.settings-conflict p { margin: 0; }
@media (max-width: 700px) { .policy-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 480px) { .policy-actions { flex-direction: column; align-items: stretch; } .policy-actions :deep(button) { justify-content: center; } }
</style>
