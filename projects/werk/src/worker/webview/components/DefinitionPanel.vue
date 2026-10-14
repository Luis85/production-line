<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import { state, request, refresh, type DefinitionAgent } from '../store';
const reviewedYaml = ref('');
const yaml = ref(''), name = ref(''), preview = ref<DefinitionAgent[] | null>(null), busy = ref(false), error = ref(''), notice = ref('');
watch(yaml, () => { preview.value = null; reviewedYaml.value = ''; notice.value = ''; });
async function file(event: Event) { const selected = (event.target as HTMLInputElement).files?.[0]; if (!selected) return; if (selected.size > 65536) { error.value = 'Choose a YAML file smaller than 64 KiB.'; return; } try { yaml.value = await selected.text(); name.value ||= selected.name.replace(/\.ya?ml$/i, ''); error.value = ''; } catch { error.value = 'The file could not be read. Try choosing it again, or paste its YAML.'; } }
async function act(action: 'preview' | 'import' | 'delete', id?: string) {
  if (busy.value) return;
  if (action === 'import' && (!preview.value || reviewedYaml.value !== yaml.value)) {
    error.value = 'Preview the current YAML before importing.';
    return;
  }
  const submittedYaml = yaml.value, submittedName = name.value;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await request('/api/definitions', 'POST', { action, yaml: submittedYaml, name: submittedName, id });
    if (action === 'preview') {
      if (yaml.value === submittedYaml) {
        preview.value = result.agents;
        reviewedYaml.value = submittedYaml;
      }
      return;
    }
    await refresh();
    if (action === 'import') {
      const newerEdits = yaml.value !== submittedYaml || name.value !== submittedName;
      if (!newerEdits) {
        yaml.value = ''; preview.value = null; name.value = '';
        await nextTick();
      }
      notice.value = newerEdits
        ? 'Definition saved. Your newer definition edits are kept. Preview them before importing again.'
        : 'Definition saved. Choose it when creating a new task.';
    } else {
      notice.value = 'Definition removed. Existing tasks keep their saved instructions.';
    }
  } catch (failure) {
    error.value = (failure as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template><section class="definition-panel" aria-labelledby="definitions-title"><h2 id="definitions-title">Docker Agent definitions</h2><p class="page-note">Use an agent’s instructions and model settings with this worker’s provider connection. Importing a definition does not run it. Docker tools, hooks, containers and team delegation are not executed.</p><ul v-if="state.definitions.length" class="definition-list"><li v-for="definition in state.definitions" :key="definition.id"><div><strong>{{ definition.name }}</strong><span class="muted">{{ definition.agents.map(agent => agent.name).join(', ') }}</span></div><UButton color="neutral" variant="ghost" :disabled="busy" :aria-label="'Remove definition ' + definition.name" @click="act('delete', definition.id)">Remove</UButton></li></ul><form class="settings-form" @submit.prevent="act('preview')"><label for="definition-file">Choose a YAML file</label><input id="definition-file" type="file" accept=".yaml,.yml,text/yaml,application/yaml" @change="file"><label for="definition-name">Definition name</label><UInput id="definition-name" v-model="name" maxlength="120" placeholder="e.g. Code reviewer" class="w-full" /><label for="definition-yaml">Or paste Docker Agent YAML</label><UTextarea id="definition-yaml" v-model="yaml" :rows="6" :maxlength="65536" spellcheck="false" placeholder="agents:&#10;  root:&#10;    model: openai/gpt-4.1&#10;    instruction: Review the proposed change." class="w-full" /><UButton type="submit" color="neutral" variant="outline" :loading="busy" :disabled="!yaml.trim()">Preview definition</UButton></form><div v-if="preview" class="definition-preview"><h3>Review before importing</h3><article v-for="agent in preview" :key="agent.name"><h4>{{ agent.name }} <span class="muted">{{ agent.model || 'Uses your configured model' }}</span></h4><p>{{ agent.description }}</p><details><summary>Read agent instructions</summary><pre>{{ agent.instruction }}</pre></details><div v-if="agent.requiresAdaptation" class="compatibility-note"><strong>Instructions-only adaptation required</strong><ul><li v-for="issue in agent.unsupported" :key="issue">{{ issue }}</li></ul><p>You must explicitly accept these limits when selecting this agent for a task.</p></div><p v-else class="page-note">Instructions and model settings are compatible.</p></article><UButton :loading="busy" :disabled="!name.trim() || reviewedYaml !== yaml" @click="act('import')">Import definition</UButton></div><p v-if="error" role="alert" class="error-text">{{ error }}</p><p v-if="notice" role="status" class="page-note">{{ notice }}</p></section></template>
