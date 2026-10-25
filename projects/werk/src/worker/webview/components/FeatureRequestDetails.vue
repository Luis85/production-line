<script setup lang="ts">
import { computed, ref } from 'vue';
import UInput from '@nuxt/ui/components/Input.vue';
import ProjectExecutionSelection from './ProjectExecutionSelection.vue';
import ModelSelectionFields from './ModelSelectionFields.vue';
import { state } from '../store';
import { featurePriorityOptions } from '../feature-priority';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import { featureDetailFields, readFeatureDetails, writeFeatureDetail, type FeatureDetailField, type FeatureModelField } from '../feature-authoring-fields';
const markdown = defineModel<string>({ required: true });
defineProps<{ disabled: boolean; projectId?: string }>();
const projectProfiles = ref(false);
const error = ref('');
const details = computed(() => {
  try { return { value: readFeatureDetails(markdown.value), error: '' }; }
  catch (cause) { return { value: null, error: (cause as Error).message }; }
});
function update(key: FeatureDetailField | FeatureModelField | 'paths' | 'title', value: string | number) {
  try { markdown.value = writeFeatureDetail(markdown.value, key, String(value)); error.value = ''; }
  catch (cause) { error.value = (cause as Error).message; }
}
</script>
<template>
  <fieldset :disabled="disabled" class="feature-details">
    <legend>Request details</legend>
    <template v-if="details.value">
      <div class="feature-field"><label for="feature-detail-title">Request name</label><UInput id="feature-detail-title" :model-value="details.value.title" :maxlength="120" class="w-full" @update:model-value="update('title', $event)" /></div>
      <ProjectExecutionSelection id="feature-detail" :model-value="details.value.executionProfile" :project-id="projectId" :quality-profile="details.value.qualityProfile || undefined" mode="patch" :priority="details.value.priority" :disabled="disabled" @configured="projectProfiles = $event" @update:model-value="update('execution_profile', $event)" />
      <div class="feature-field"><label for="feature-detail-quality">Quality profile · optional project profile name</label><UInput id="feature-detail-quality" :model-value="details.value.qualityProfile" @update:model-value="update('quality_profile', $event)" /><label for="feature-detail-priority">Queue priority</label><select id="feature-detail-priority" :value="details.value.priority" @change="update('priority', ($event.target as HTMLSelectElement).value)"><option v-if="details.value.priority === 0" :value="0">Urgent · legacy request</option><option v-for="priority in featurePriorityOptions" :key="priority.value" :value="priority.value">{{ priority.label }}</option></select><label for="feature-detail-dependencies">Dependencies · one Feature Request ID per line</label><UTextarea id="feature-detail-dependencies" :model-value="details.value.dependsOn" :rows="3" @update:model-value="update('depends_on', $event)" /><p>Use FR-ID for this project or repositoryId:FR-ID for another project. Acceptance and incorporation into the execution baseline are checked separately.</p></div>
      <details v-if="!projectProfiles" class="request-model-options"><summary>Provider, model &amp; effort</summary><ModelSelectionFields id="feature-detail" :provider="details.value.selection.provider ?? state.settings?.defaultProvider" :model="details.value.selection.model" :effort="details.value.selection.effort" :providers="state.settings?.providers ?? []" :disabled="disabled" @update:provider="update('provider', $event)" @update:model="update('model', $event)" @update:effort="update('effort', $event)" /></details>
      <div v-for="field in featureDetailFields" :key="field.key" class="feature-field">
        <label :for="'feature-detail-' + field.key.replaceAll(' ', '-')">{{ field.label }}</label>
        <UTextarea :id="'feature-detail-' + field.key.replaceAll(' ', '-')" :model-value="details.value.fields[field.key]" :rows="field.rows" :maxrows="12" autoresize :maxlength="8000" class="w-full" :aria-describedby="'feature-help-' + field.key.replaceAll(' ', '-')" @update:model-value="update(field.key, $event)" />
        <p :id="'feature-help-' + field.key.replaceAll(' ', '-')">{{ field.hint }}</p>
      </div>
      <div class="feature-field">
        <label for="feature-detail-paths">Approved repository paths</label>
        <UTextarea id="feature-detail-paths" :model-value="details.value.paths" :rows="3" :maxrows="8" autoresize class="w-full" aria-describedby="feature-help-paths" @update:model-value="update('paths', $event)" />
        <p id="feature-help-paths">One relative file path per line. Only approve files this feature may change.</p>
      </div>
    </template>
    <p v-if="details.error || error" class="error-text" role="alert">{{ details.error || error }}</p>
    <details class="advanced-template" :open="!!details.error">
      <summary>Advanced template editing</summary>
      <label for="shared-request-markdown">Complete request Markdown</label>
      <p>Custom template sections and metadata stay here. Preserve the request ID and template ID.</p>
      <UTextarea id="shared-request-markdown" v-model="markdown" :rows="14" :maxlength="65536" class="w-full markdown-editor" />
    </details>
  </fieldset>
</template>
<style scoped>
.feature-details { padding: 0; margin: 20px 0; border: 0; min-width: 0; }
legend { font-size: 1rem; font-weight: 650; margin-bottom: 16px; }
.feature-field { margin-bottom: 20px; }
select { min-height:44px;width:100%;background:var(--ui-bg);color:var(--ui-text);border:1px solid var(--ui-border);padding-inline:12px;border-radius:6px; }
label { display: block; margin-bottom: 8px; font-size: .875rem; font-weight: 600; }
p { margin: 8px 0 12px; color: var(--ui-text-muted); font-size: .75rem; line-height: 1.6; }
:deep(textarea) { background: #111e26; line-height: 1.6; }
.advanced-template { border-top: 1px solid var(--ui-border); padding-top: 4px; }
summary { min-height: 44px; padding-block: 12px; cursor: pointer; font-size: .8125rem; font-weight: 600; }
.markdown-editor :deep(textarea) { font-family: var(--font-mono, monospace); font-size: .8125rem; }
</style>
