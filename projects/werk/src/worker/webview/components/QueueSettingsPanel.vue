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
import SettingsSaveFeedback from '../../../shared/webview/components/SettingsSaveFeedback.vue';
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
    <SettingsSaveFeedback :state="draft" :unlocked="state.unlocked" :notice="draft.notice" :unavailable="!draft.baseline" @retry="editor.retry" @reload="editor.reload" @refresh="editor.check" />
    <p class="page-note">Saving settings does not pause or resume the queue. Control new starts from <RouterLink to="/taskboard">Taskboard</RouterLink>.</p>
  </section>
</template>
<style scoped src="./policy-settings.css"></style>
