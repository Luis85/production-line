<script lang="ts">
import { createDurationSettingsEditor, durationPolicy } from '../worker-policy-editors';
import { state as workerState, guardedSettingsAction, refresh } from '../store';
const editor = createDurationSettingsEditor({
  saved: () => durationPolicy(workerState.settings), unlocked: () => workerState.unlocked, epoch: () => workerState.draftEpoch,
  write: async command => { const settings = await guardedSettingsAction(command); return settings ? durationPolicy(settings)! : undefined; }, refresh,
});
</script>
<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import { state } from '../store';
const { draft, dirty, stale, locked, validation, canSave } = editor;
</script>
<template>
  <section class="policy-settings duration-settings" aria-labelledby="duration-settings-title">
    <h2 id="duration-settings-title">Task duration</h2>
    <p class="page-note">Set a reminder for long-running work and a maximum duration for each execution attempt.</p>
    <form v-if="draft.baseline" :aria-busy="draft.busy" @submit.prevent="editor.save">
      <fieldset class="policy-fields" :disabled="locked">
        <legend class="sr-only">Task duration settings</legend>
        <div class="policy-grid">
          <div class="policy-field"><label for="resource-warning-hours">Warn after · hours</label><UInput id="resource-warning-hours" v-model.number="draft.values.warningHours" type="number" min="0.000001" max="24" step="any" required class="w-full" aria-describedby="duration-warning-help" /><p id="duration-warning-help" class="page-note">Reports elapsed time without stopping work. A warning does not mean the task is stuck.</p></div>
          <div class="policy-field"><label for="resource-maximum-hours">Maximum attempt duration · hours</label><UInput id="resource-maximum-hours" v-model.number="draft.values.maximumHours" :disabled="draft.baseline.fromEnvironment" type="number" min="0.000001" max="24" step="any" required class="w-full" aria-describedby="duration-maximum-help" /><p id="duration-maximum-help" class="page-note">Ends a new execution attempt when its time is up. Inspect the saved context before explicitly continuing.</p></div>
        </div>
        <p v-if="draft.baseline.fromEnvironment" class="page-note">The maximum is set by <code>WERK_WORKER_MAX_RUNTIME_MS</code>. Change it in the worker environment and restart to update it. You can still edit the warning and tool limits here.</p>
        <p class="page-note">Use hours, including decimals, from one second to 24 hours. New maximums apply to future attempts.</p>
        <details class="tool-budget-options">
          <summary>Tool execution limits</summary>
          <p class="page-note">Bound how much tool work a model can perform in one attempt. These limits do not grant access to any tool.</p>
          <div class="policy-grid">
            <div class="policy-field"><label for="execution-tool-calls">Maximum tool calls per attempt</label><UInput id="execution-tool-calls" v-model.number="draft.values.maxToolCalls" type="number" min="1" max="512" step="1" required class="w-full" aria-describedby="execution-tool-calls-help" /><p id="execution-tool-calls-help" class="page-note">1–512 calls, including file reads, edits and checks. Default: 128.</p></div>
            <div class="policy-field"><label for="execution-command-seconds">Command timeout · seconds</label><UInput id="execution-command-seconds" v-model.number="draft.values.commandSeconds" type="number" min="1" max="3600" step="any" required class="w-full" aria-describedby="execution-command-seconds-help" /><p id="execution-command-seconds-help" class="page-note">1–3,600 seconds for each command preset, CLI tool or feature check. Default: 300 seconds (5 minutes). The remaining attempt duration may end it earlier.</p></div>
          </div>
          <p class="page-note">MCP calls default to 30 seconds; configure individual command and MCP timeouts in <RouterLink to="/settings#tool-access">Tools &amp; MCP</RouterLink>. Web requests retain 10 seconds. Budget changes apply to future attempts.</p>
        </details>
        <div class="policy-actions"><UButton type="submit" :loading="draft.busy" :disabled="!canSave">Save duration settings</UButton><UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="editor.reload">Discard edits and reload</UButton></div>
      </fieldset>
      <p v-if="validation && dirty" role="status" class="error-text">{{ validation }}</p>
      <p v-if="stale" role="status" class="settings-conflict">Saved duration settings changed while you were editing. Your draft is kept. Discard edits and reload before saving.</p>
    </form>
    <p v-else class="page-note">Saved duration settings are not available yet. Refresh to try again.</p>
    <p v-if="draft.error" role="alert" class="error-text">{{ draft.error }}</p>
    <p v-if="draft.notice" role="status">{{ draft.notice }}</p>
    <div v-if="draft.uncertain" role="status" class="settings-conflict">
      <p>The save acknowledgement is uncertain. Your submitted settings are kept.</p>
      <div class="policy-actions"><UButton type="button" color="neutral" variant="outline" :loading="draft.busy" :disabled="draft.checking || !state.unlocked" @click="editor.retry">Retry same save</UButton><UButton type="button" color="neutral" variant="ghost" :disabled="draft.busy || draft.checking || !state.unlocked" @click="editor.reload">Discard edits and reload</UButton></div>
    </div>
    <UButton v-if="!draft.baseline || draft.uncertain" type="button" color="neutral" variant="outline" :loading="draft.checking" :disabled="draft.busy || !state.unlocked" @click="editor.check">Refresh saved settings</UButton>
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
.tool-budget-options { margin-top: var(--space-6); border-top: 1px solid var(--ui-border); }
.tool-budget-options summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-weight: 600; }
.tool-budget-options > p { margin-block: var(--space-3); }
.tool-budget-options .policy-grid { margin-block: var(--space-4); }
.policy-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-6); }
.settings-conflict { margin: var(--space-4) 0; padding: var(--space-4); background: var(--ui-bg-elevated); border: 1px solid var(--ui-border); border-radius: 12px; }
.settings-conflict p { margin: 0; }
@media (max-width: 700px) { .policy-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 480px) { .policy-actions { flex-direction: column; align-items: stretch; } .policy-actions :deep(button) { justify-content: center; } }
</style>
