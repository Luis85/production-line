<script setup lang="ts">
import { computed, nextTick } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import { serviceLimits } from '../../application/service-policy';
import type { ToolAccessEditor } from '../tool-access-editor';
import { serviceDraftError } from '../service-presets-draft';
const props = defineProps<{ editor: ToolAccessEditor }>();
const validation = computed(() => serviceDraftError(props.editor.draft.services));
async function add() {
  const count = props.editor.draft.services.presets.length;
  props.editor.addService();
  if (props.editor.draft.services.presets.length !== count) {
    await nextTick(); document.getElementById(`service-name-${count}`)?.focus();
  }
}
async function remove(index: number) {
  if (props.editor.locked.value) return;
  props.editor.draft.services.presets.splice(index, 1);
  await nextTick();
  (document.getElementById(`service-name-${index}`) ?? document.getElementById('service-add'))?.focus();
}
</script>
<template>
  <section class="service-editor" aria-labelledby="tool-services-title" :aria-describedby="validation ? 'tool-services-validation' : undefined">
    <div class="section-heading">
      <h3 id="tool-services-title">Development services</h3>
      <UButton
        id="service-add"
        type="button"
        color="neutral"
        variant="outline"
        icon="i-lucide-plus"
        :disabled="editor.locked.value || editor.draft.services.presets.length >= serviceLimits.maximumPresets"
        @click="add"
      >Add service preset</UButton>
    </div>
    <p class="page-note">Let the model start a configured development server or watcher for its Feature Request. Services run in that request’s pinned worktree and can remain after a successful model turn, within their maximum lifetime.</p>
    <label class="check-label service-grant" for="tool-services-enabled">
      <input id="tool-services-enabled" v-model="editor.draft.services.enabled" type="checkbox" aria-describedby="tool-services-help">
      <span><strong>Allow models to manage development services</strong><span>Off by default. Enable this grant and individual presets, then save tool access.</span></span>
    </label>
    <p id="tool-services-help" class="authority-note">The model chooses an enabled preset; the executable, arguments and worktree stay fixed. Services run with the worker account’s file and network permissions. Stop services in Metrics; expiry, revocation and worker shutdown also stop them.</p>
    <div class="service-capacity">
      <label for="tool-services-active">Maximum concurrent services · this worker</label>
      <UInput
        id="tool-services-active"
        v-model.number="editor.draft.services.maxActive"
        type="number"
        min="1"
        :max="serviceLimits.maximumActive"
        step="1"
        required
        class="w-full"
        aria-describedby="tool-services-capacity-help"
      />
      <p id="tool-services-capacity-help" class="page-note">Shared across Feature Requests. A service uses a slot until it stops; this is separate from model execution capacity.</p>
    </div>
    <p v-if="!editor.draft.services.presets.length" class="page-note">No service presets configured. Add a fixed command for a project server or watcher.</p>
    <section v-for="(preset, index) in editor.draft.services.presets" :key="index" class="service-preset" :aria-labelledby="`service-title-${index}`">
      <div class="section-heading">
        <h4 :id="`service-title-${index}`">{{ preset.name || 'New service preset' }}</h4>
        <UButton
          type="button"
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          :aria-label="`Remove service ${preset.name || index + 1}`"
          :disabled="editor.locked.value"
          @click="remove(index)"
        >Remove</UButton>
      </div>
      <div class="service-fields">
        <div><label :for="`service-name-${index}`">Service name</label><UInput :id="`service-name-${index}`" v-model="preset.name" required maxlength="120" placeholder="Project preview server" class="w-full" /></div>
        <div><label :for="`service-id-${index}`">Preset ID</label><UInput :id="`service-id-${index}`" v-model="preset.id" required maxlength="64" class="w-full" /></div>
      </div>
      <label :for="`service-executable-${index}`">Executable · absolute path</label>
      <div class="executable-row">
        <UInput :id="`service-executable-${index}`" v-model="preset.executable" required placeholder="/absolute/path/to/node" class="w-full" />
        <UButton
          v-if="editor.workerNode()"
          type="button"
          color="neutral"
          variant="outline"
          :aria-label="`Use the worker's Node.js for service ${preset.name || index + 1}`"
          @click="preset.executable = editor.workerNode()"
        >Use worker Node.js</UButton>
      </div>
      <label :for="`service-args-${index}`">Fixed arguments · JSON array</label>
      <UTextarea
        :id="`service-args-${index}`"
        v-model="preset.arguments"
        :rows="2"
        placeholder='["scripts/dev-server.mjs", "--host", "127.0.0.1"]'
        class="w-full"
        :aria-describedby="`service-args-help-${index}`"
      />
      <p :id="`service-args-help-${index}`" class="page-note">Relative paths resolve inside the request’s worktree. The model cannot append arguments or choose another working directory.</p>
      <label :for="`service-lifetime-${index}`">Maximum lifetime · minutes</label>
      <UInput
        :id="`service-lifetime-${index}`"
        v-model.number="preset.lifetimeMinutes"
        type="number"
        :min="1 / 60"
        :max="serviceLimits.maxTtlMs / 60000"
        step="any"
        required
        class="w-full service-number"
        :aria-describedby="`service-lifetime-help-${index}`"
      />
      <p :id="`service-lifetime-help-${index}`" class="page-note">At most 24 hours from the original start. Restarts do not extend this deadline.</p>
      <details class="service-options">
        <summary>Readiness signal and automatic restart</summary>
        <div class="service-options-content">
          <label :for="`service-ready-${index}`">Ready text · optional literal output</label>
          <UInput
            :id="`service-ready-${index}`"
            v-model="preset.readyText"
            maxlength="256"
            placeholder="Server listening"
            class="w-full"
            :aria-describedby="`service-ready-help-${index}`"
          />
          <p :id="`service-ready-help-${index}`" class="page-note">When this exact text appears in output, Werk records readiness as reported by the service. It does not verify application health. Leave blank to track process liveness only.</p>
          <div class="service-fields">
            <div><label :for="`service-startup-${index}`">Startup wait · seconds</label><UInput
              :id="`service-startup-${index}`"
              v-model.number="preset.startupSeconds"
              type="number"
              min="0.1"
              max="60"
              step="0.001"
              required
              class="w-full"
            /></div>
            <div><label :for="`service-restarts-${index}`">Automatic restart attempts</label><UInput
              :id="`service-restarts-${index}`"
              v-model.number="preset.restartAttempts"
              type="number"
              min="0"
              :max="serviceLimits.maxRestarts"
              step="1"
              required
              class="w-full"
            /></div>
            <div><label :for="`service-backoff-${index}`">Delay before restart · seconds</label><UInput
              :id="`service-backoff-${index}`"
              v-model.number="preset.backoffSeconds"
              type="number"
              min="0.1"
              max="60"
              step="0.001"
              required
              class="w-full"
            /></div>
          </div>
          <p class="page-note">Startup wait applies when ready text is configured; the service stops if it does not report readiness in time. Zero restart attempts disables automatic restarts. Each restart rechecks the grant and worktree and uses the same fixed command.</p>
        </div>
      </details>
      <label class="check-label" :for="`service-enabled-${index}`"><input :id="`service-enabled-${index}`" v-model="preset.enabled" type="checkbox"> Allow models to use this preset</label>
    </section>
    <p v-if="validation" id="tool-services-validation" class="error-text">{{ validation }}</p>
  </section>
</template>
<style scoped>
.service-editor { display: grid; gap: 12px; padding-block: 0 24px; margin-bottom: 24px; border-bottom: 1px solid var(--ui-border); min-width: 0; }
h3, h4 { margin: 0; color: var(--ui-text-highlighted); font-weight: 650; overflow-wrap: anywhere; }
h3 { font-size: 1rem; } h4 { font-size: .9375rem; }
.section-heading { flex-wrap: wrap; gap: 12px; }
.service-preset { display: grid; gap: 12px; min-width: 0; padding: 20px; border: 1px solid var(--ui-border); border-radius: 10px; }
.service-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.service-fields > div, .service-capacity { display: grid; gap: 8px; min-width: 0; }
.service-capacity :deep(input), .service-number { max-width: 20rem; }
.executable-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
.service-grant { align-items: start; padding-block: 12px; }
.service-grant > span { display: grid; gap: 4px; }
.service-grant > span > span { font-weight: 400; color: var(--ui-text-muted); line-height: 1.6; }
label, summary { font-size: .8125rem; font-weight: 600; color: var(--ui-text-highlighted); }
.check-label { min-height: 44px; gap: 12px; }
input[type=checkbox] { width: 20px; height: 20px; min-height: 20px; flex: 0 0 20px; accent-color: var(--ui-primary); }
:deep(input:not([type=checkbox])), :deep(button) { min-height: 44px; }
.service-options summary { min-height: 44px; padding-block: 12px; cursor: pointer; }
.service-options-content { display: grid; gap: 12px; }
.authority-note { padding: 14px; font-size: .8125rem; line-height: 1.6; background: var(--ui-bg-elevated); border-left: 2px solid var(--ui-border-accented); }
p { overflow-wrap: anywhere; }
@media (max-width: 620px) { .service-fields { grid-template-columns: minmax(0, 1fr); } .service-preset { padding: 14px; } .executable-row { flex-direction: column; align-items: stretch; } }
</style>
