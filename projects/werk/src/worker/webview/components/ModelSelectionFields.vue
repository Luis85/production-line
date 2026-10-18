<script setup lang="ts">
import { computed } from 'vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import type { ProviderId } from '../../application/provider-contract';
import { providerEfforts, type ModelEffort } from '../../application/model-effort';
import type { WorkerSettingsView } from '../../application/workspace-view';
const props = withDefaults(defineProps<{ id: string; provider?: ProviderId; providers: WorkerSettingsView['providers']; disabled?: boolean; defaults?: boolean; definitionModel?: string; showProvider?: boolean }>(), { showProvider: true });
const emit = defineEmits<{ 'update:provider': [ProviderId] }>();
const model = defineModel<string>('model', { required: true });
const effort = defineModel<ModelEffort | ''>('effort', { required: true });
const selected = computed(() => props.providers.find(item => item.id === props.provider));
const supported = computed(() => props.provider ? providerEfforts[props.provider] ?? ['default'] as const : ['default'] as const);
const inheritedModel = computed(() => props.definitionModel || selected.value?.model || 'provider default');
const efforts = computed(() => [
  ...(!props.defaults ? [{ value: 'inherit', label: 'Inherit worker default · ' + (selected.value?.effort || 'default') }] : []),
  ...supported.value.map(value => ({ value, label: value === 'default' ? 'Provider default' : value[0].toUpperCase() + value.slice(1) })),
]);
const selectedEffort = computed({ get: () => effort.value || 'inherit', set: (value: string) => { effort.value = value === 'inherit' ? '' : value as ModelEffort; } });
function selectProvider(value: ProviderId) {
  if (value === props.provider) return;
  emit('update:provider', value);
  if (!props.defaults) { model.value = ''; effort.value = ''; }
}
</script>
<template>
  <div class="model-selection">
    <div v-if="showProvider" class="model-field">
      <label :for="id + '-provider'">Provider</label>
      <USelect :id="id + '-provider'" :model-value="provider" :items="providers.map(item => ({ label: item.label + (item.configured ? '' : ' · needs setup'), value: item.id }))" :disabled="disabled" class="w-full" @update:model-value="selectProvider($event as ProviderId)" />
    </div>
    <div class="model-field">
      <label :for="id + '-model'">{{ defaults ? 'Default model' : 'Model · optional' }}</label>
      <UInput :id="id + '-model'" v-model="model" :maxlength="200" :required="defaults && !!provider?.endsWith('-api')" :placeholder="defaults ? provider?.endsWith('-api') ? 'An available model ID' : 'Use the CLI default model' : 'Inherit: ' + inheritedModel" :disabled="disabled" :aria-describedby="id + '-model-help'" class="w-full" />
      <p :id="id + '-model-help'">{{ defaults ? 'Applies to new requests that inherit this provider’s model. Accepted requests keep their saved selection.' : definitionModel ? 'Leave blank to use the imported agent model. An explicit model overrides it; the provider must remain compatible with the definition.' : 'Leave blank to inherit this provider’s configured model. The worker saves the resolved selection when it accepts the request.' }}</p>
    </div>
    <div class="model-field">
      <label :for="id + '-effort'">{{ defaults ? 'Default effort' : 'Effort' }}</label>
      <USelect :id="id + '-effort'" v-model="selectedEffort" :items="efforts" :disabled="disabled" :aria-describedby="id + '-effort-help'" class="w-full" />
      <p :id="id + '-effort-help'">{{ supported.length === 1 ? 'This adapter has no separate effort control. Its model or native configuration determines effort.' : 'Only effort settings supported by this adapter are listed. Availability also depends on the selected model and account.' }}</p>
    </div>
    <p v-if="provider === 'cursor-cli'" class="native-permissions">Cursor CLI uses Cursor’s own permissions and hooks. Worker file, command and MCP grants do not constrain its native tools. Review the local Cursor policy before dispatching.</p>
  </div>
</template>
<style scoped>
.model-selection { min-width: 0; margin-block: 16px; }
.model-field { display: grid; gap: 8px; margin-bottom: 20px; min-width: 0; }
label { color: var(--ui-text-highlighted); font-size: .875rem; font-weight: 600; }
p { margin: 0; color: var(--ui-text-muted); font-size: .75rem; line-height: 1.6; overflow-wrap: anywhere; }
.model-field :deep(input), .model-field :deep(button[role='combobox']) { min-height: 44px; background: #132129; }
.native-permissions { margin-bottom: 20px; }
</style>
