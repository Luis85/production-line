<script setup lang="ts">
import { computed, watch } from 'vue';
import type { FeatureTemplateView } from '../../application/feature-authoring-contracts';
import { request } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
const props = defineProps<{ id: string; projectId?: string; disabled: boolean }>();
const selected = defineModel<string>({ required: true });
const emit = defineEmits<{ configured: [boolean] }>();
const { data, error, loading } = useWorkerSnapshot(() => request<FeatureTemplateView>('/api/features/templates' + (props.projectId ? '?projectId=' + encodeURIComponent(props.projectId) : '')), [() => props.projectId]);
const choices = computed(() => data.value?.templates ?? []);
watch([() => data.value, () => props.projectId, selected], () => {
  emit('configured', !!data.value?.configured);
  if (!selected.value && data.value?.defaultTemplateId) selected.value = data.value.defaultTemplateId;
});
const missing = computed(() => !!selected.value && !!data.value?.configured && !choices.value.some(choice => choice.id === selected.value));
</script>
<template>
  <div class="feature-template-selection">
    <label :for="id + '-template'">Feature Request template</label>
    <select :id="id + '-template'" v-model="selected" :disabled="disabled || loading || !data?.configured || !choices.length"><option v-if="!choices.length" value="">{{ loading ? 'Loading project templates…' : 'Worker default template' }}</option><option v-if="missing" :value="selected">{{ selected }} · unavailable</option><option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ choice.label }}{{ choice.default ? ' · project default' : '' }}</option></select>
    <p v-if="error" role="alert" class="error-text">{{ error }} Refresh the worker to reload project templates.</p><p v-else-if="missing" role="alert" class="error-text">The selected template is no longer available. Choose a committed project template.</p><p v-else-if="data?.reason" class="caption">{{ data.reason }}</p><p v-else-if="data?.configured" class="caption">{{ choices.find(choice => choice.id === selected)?.path }} · committed project template</p>
  </div>
</template>
<style scoped>
.feature-template-selection { min-width:0;margin-block:var(--space-4); }label { display:block;font-size:.875rem;font-weight:600;margin-bottom:var(--space-2); }select { min-height:44px;width:100%;background:var(--ui-bg);color:var(--ui-text);border:1px solid var(--ui-border);padding-inline:12px;border-radius:6px; }p { font-size:.75rem;line-height:1.6;margin-block:var(--space-2);overflow-wrap:anywhere; }.caption { color:var(--ui-text-muted); }
</style>
