<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import { state, newTask } from '../store';
const emit = defineEmits<{ created: []; close: []; setup: []; definitions: [] }>();
const provider = ref(state.settings?.providers.find(item => item.configured)?.id ?? 'codex-cli'), title = ref(''), definitionId = ref('none'), agent = ref(''), adapt = ref(false);
const definition = computed(() => state.definitions.find(item => item.id === definitionId.value));
const selected = computed(() => definition.value?.agents.find(item => item.name === agent.value));
const configured = computed(() => state.settings?.providers.find(item => item.id === provider.value)?.configured);
const incompatible = computed(() => selected.value?.provider && !provider.value.startsWith(selected.value.provider === 'anthropic' ? 'claude' : 'codex') && provider.value !== `${selected.value.provider}-api`);
const missingAgent = computed(() => definitionId.value !== 'none' && !selected.value);
const canCreate = computed(() => !state.workspaceBusy && !!configured.value && !incompatible.value && !missingAgent.value && (!selected.value?.requiresAdaptation || adapt.value));
watch(definitionId, () => { agent.value = definition.value?.agents.find(item => item.name === 'root')?.name ?? definition.value?.agents[0]?.name ?? ''; adapt.value = false; });
watch(agent, () => { adapt.value = false; });
async function create() { if (!canCreate.value) return; if (await newTask({ title: title.value.trim() || 'New task', provider: provider.value, ...(definition.value ? { definitionId: definition.value.id, agent: agent.value, useInstructionsOnly: adapt.value } : {}) })) emit('created'); }
</script>
<template>
  <section class="new-task-panel" aria-labelledby="new-task-title">
    <div class="section-heading">
      <h2 id="new-task-title">Start a new task</h2>
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        aria-label="Close new task options"
        :disabled="state.workspaceBusy"
        @click="emit('close')"
      />
    </div>
    <p class="page-note">Choose how this worker will handle the task. Send its first message next.</p>
    <form class="settings-form" :aria-busy="state.workspaceBusy" @submit.prevent="create">
      <fieldset class="contents" :disabled="state.workspaceBusy">
      <div class="task-option-grid">
        <div>
          <label for="session-provider">Provider connection</label>
          <USelect
            id="session-provider"
            v-model="provider"
            :items="
              state.settings?.providers.map((item) => ({
                label: item.label + (item.configured ? '' : ' · needs setup'),
                value: item.id,
              })) ?? []
            "
            class="w-full"
          />
        </div>
        <div>
          <label for="task-definition">Agent definition</label>
          <USelect
            id="task-definition"
            v-model="definitionId"
            :items="[
              { value: 'none', label: 'No definition · use my instructions' },
              ...state.definitions.map((item) => ({ value: item.id, label: item.name })),
            ]"
            class="w-full"
          />
        </div>
      </div>
      <template v-if="definition">
        <label for="definition-agent">Agent in this definition</label>
        <USelect
          id="definition-agent"
          v-model="agent"
          :items="
            definition.agents.map((item) => ({
              value: item.name,
              label: item.name + (item.description ? ' · ' + item.description : ''),
            }))
          "
          class="w-full"
        />
        <details v-if="selected">
          <summary>Instructions &amp; model · {{ selected.model || "configured model" }}</summary>
          <pre>{{ selected.instruction }}</pre>
        </details>
        <div v-if="selected?.requiresAdaptation" class="compatibility-note">
          <strong>Some Docker Agent features cannot run here</strong>
          <ul>
            <li v-for="issue in selected.unsupported" :key="issue">{{ issue }}</li>
          </ul>
          <label class="check-label">
            <input v-model="adapt" type="checkbox" /> Use instructions only. I accept the omitted features
            listed above.</label
          >
        </div>
        <p v-if="incompatible" class="error-text" role="alert">
          Choose a {{ selected?.provider }} provider connection for this agent’s model.
        </p>
      </template>
      <p v-if="missingAgent" class="error-text" role="alert">
        This definition or agent is no longer available. Choose another definition before creating the task.
      </p>
      <label for="session-title">Task name · optional</label>
      <UInput
        id="session-title"
        v-model="title"
        maxlength="120"
        placeholder="Named from your first message"
        class="w-full"
      />
      <p v-if="!configured" class="page-note">This provider needs a connection before you can send work.</p>
      <div class="actions">
        <UButton type="submit" :loading="state.workspaceBusy" :disabled="!canCreate"
          >Create draft task</UButton
        >
        <UButton v-if="!configured" color="neutral" variant="outline" @click="emit('setup')"
          >Connect provider</UButton
        >
        <UButton color="neutral" variant="ghost" @click="emit('definitions')">Manage definitions</UButton>
      </div>
      <p v-if="state.actionError" role="alert" class="error-text">{{ state.actionError }}</p>
      </fieldset>
    </form>
  </section>
</template>
