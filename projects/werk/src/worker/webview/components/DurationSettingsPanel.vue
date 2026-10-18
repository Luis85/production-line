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
import SettingsSaveFeedback from '../../../shared/webview/components/SettingsSaveFeedback.vue';
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
        <p v-if="draft.baseline.fromEnvironment" class="page-note">The maximum is set by <code>WERK_WORKER_MAX_RUNTIME_MS</code>. Change it in the worker environment and restart to update it. You can still edit the warning, tool limits and repository limits here.</p>
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
        <details class="tool-budget-options repository-inspection-options">
          <summary>Repository inspection limits</summary>
          <p class="page-note">Bound the repository snapshot used to verify an implementation. Every tracked and non-ignored file is still inspected and fingerprinted; a limit stops inspection instead of skipping files.</p>
          <div class="policy-grid">
            <div class="policy-field"><label for="execution-source-mib">Total inspected source · MiB</label><UInput id="execution-source-mib" v-model.number="draft.values.sourceMiB" type="number" min="1" max="1024" step="any" required class="w-full" aria-describedby="execution-source-mib-help" /><p id="execution-source-mib-help" class="page-note">1–1,024 MiB across all inspected files. Default: 64 MiB.</p></div>
            <div class="policy-field"><label for="execution-source-files">Maximum files</label><UInput id="execution-source-files" v-model.number="draft.values.sourceFiles" type="number" min="1" max="200000" step="1" required class="w-full" aria-describedby="execution-source-files-help" /><p id="execution-source-files-help" class="page-note">1–200,000 tracked and non-ignored files. Default: 20,000.</p></div>
            <div class="policy-field"><label for="execution-file-mib">Largest individual file · MiB</label><UInput id="execution-file-mib" v-model.number="draft.values.fileMiB" type="number" min="0.0625" max="256" step="any" required class="w-full" aria-describedby="execution-file-mib-help" /><p id="execution-file-mib-help" class="page-note">0.0625–256 MiB, up to the total source limit. Default: 8 MiB.</p></div>
          </div>
          <p class="page-note">1 MiB is 1,048,576 bytes. Raise these limits for larger repositories only when the worker has enough memory. New attempts use the saved limits; accepted attempts keep their original limits.</p>
        </details>
        <div class="policy-actions"><UButton type="submit" :loading="draft.busy" :disabled="!canSave">Save execution limits</UButton><UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="editor.reload">Discard edits and reload</UButton></div>
      </fieldset>
      <p v-if="validation && dirty" role="status" class="error-text">{{ validation }}</p>
      <p v-if="stale" role="status" class="settings-conflict">Saved execution limits changed while you were editing. Your draft is kept. Discard edits and reload before saving.</p>
    </form>
    <p v-else class="page-note">Saved execution limits are not available yet. Refresh to try again.</p>
    <SettingsSaveFeedback :state="draft" :unlocked="state.unlocked" :notice="draft.notice" :unavailable="!draft.baseline" @retry="editor.retry" @reload="editor.reload" @refresh="editor.check" />
  </section>
</template>
<style scoped src="./policy-settings.css"></style>
<style scoped>
.tool-budget-options { margin-top: var(--space-6); border-top: 1px solid var(--ui-border); }
.tool-budget-options summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-weight: 600; }
.tool-budget-options > p { margin-block: var(--space-3); }
.tool-budget-options .policy-grid { margin-block: var(--space-4); }
</style>
