<script lang="ts">
import { reactive, watch as watchDraftEpoch } from 'vue';
import type { ProviderId } from '../../infrastructure/providers';
import { state as workerState } from '../store';
const emptyEditor = () => ({ open: false, title: '', repository: '', paths: '', instruction: '', provider: undefined as ProviderId | undefined, definitionId: 'none', agent: '', adapt: false });
// Private tab memory survives session expiry without persisting approved paths or instructions to browser storage.
const editor = reactive(emptyEditor());
watchDraftEpoch(() => workerState.draftEpoch, () => Object.assign(editor, emptyEditor()), { flush: 'sync' });
</script>
<script setup lang="ts">
import { computed, nextTick, ref, toRefs, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import { state, workspaceAction } from '../store';
withDefaults(defineProps<{ triggerLabel?: string }>(), { triggerLabel: 'Run task' });
const { open, title, repository, paths, instruction, provider, definitionId, agent, adapt } = toRefs(editor);
const busy = ref(false), submitted = ref(false), error = ref('');
const definition = computed(() => state.definitions.find(item => item.id === definitionId.value));
const selectedAgent = computed(() => definition.value?.agents.find(item => item.name === agent.value));
const repositories = computed(() => state.settings?.repositories?.items ?? []);
const selectedRepository = computed(() => repositories.value.find(item => item.id === repository.value));
const repositoryValid = computed(() => repositories.value.length ? repositories.value.some(item => item.id === repository.value) : !!repository.value.trim());
const configured = computed(() => state.settings?.providers.find(item => item.id === provider.value)?.configured);
const incompatible = computed(() => selectedAgent.value?.provider && !(provider.value ?? '').startsWith(selectedAgent.value.provider === 'anthropic' ? 'claude' : 'codex') && provider.value !== `${selectedAgent.value.provider}-api`);
const canSubmit = computed(() => state.unlocked && !busy.value && !!configured.value && !!instruction.value.trim() && !!title.value.trim() && repositoryValid.value && !!paths.value.trim() && !incompatible.value && (definitionId.value === 'none' || !!selectedAgent.value) && (!selectedAgent.value?.requiresAdaptation || adapt.value));
watch(definitionId, () => { agent.value = definition.value?.agents.find(item => item.name === 'root')?.name ?? definition.value?.agents[0]?.name ?? ''; adapt.value = false; });
watch(agent, () => { adapt.value = false; });
async function closeEditor() {
  if (busy.value) return;
  open.value = false;
  await nextTick(); document.getElementById('file-task-toggle')?.focus();
}
async function toggleEditor() {
  if (busy.value) return;
  if (open.value) { await closeEditor(); return; }
  submitted.value = false; error.value = ''; open.value = true;
  if (!provider.value) provider.value = state.sessions?.records.find(item => item.id === state.sessions?.selected)?.provider ?? state.settings?.providers.find(item => item.configured)?.id ?? 'codex-cli';
  if (!repository.value && repositories.value.length === 1) repository.value = repositories.value[0].id;
  if (!instruction.value) instruction.value = state.draft;
  await nextTick(); document.getElementById('file-task-instruction')?.focus();
}
async function run() {
  if (!canSubmit.value) return;
  busy.value = true; error.value = '';
  const epoch = state.draftEpoch;
  const body = { title: title.value.trim(), instruction: instruction.value, provider: provider.value, ...(definition.value ? { definitionId: definition.value.id, agent: agent.value, useInstructionsOnly: adapt.value } : {}), repository: repository.value.trim(), paths: paths.value.split('\n').map(item => item.trim()).filter(Boolean) };
  try {
    const result = await workspaceAction('/api/taskboard', body);
    if (state.draftEpoch !== epoch) return;
    if (result) { Object.assign(editor, emptyEditor()); submitted.value = true; }
    else error.value = state.actionError || 'The file task could not be queued. Your inputs are retained. Unlock or refresh this worker, then try again.';
  } finally { busy.value = false; }
}
</script>
<template>
  <div class="run-task">
    <div class="actions">
      <UButton
        id="file-task-toggle"
        color="neutral"
        variant="outline"
        icon="i-lucide-play"
        :disabled="!state.unlocked || busy"
        :aria-expanded="open"
        aria-controls="local-task-form"
        @click="toggleEditor"
        >{{ triggerLabel }}</UButton
      ><span class="muted">Prepare instructions and approved files for a review patch.</span>
    </div>
    <p v-if="submitted" role="status">
      File task queued in its own session. <RouterLink to="/history">View file task history →</RouterLink>
    </p>
    <form v-if="open" id="local-task-form" class="settings-form" :aria-busy="busy" @submit.prevent="run" @keydown.esc.stop.prevent="closeEditor">
      <fieldset :disabled="busy" class="contents">
        <div class="section-heading"><h2>Prepare a local change</h2><UButton type="button" color="neutral" variant="ghost" aria-label="Close file task editor" @click="closeEditor">Close</UButton></div>
        <p>
          A new task session receives these instructions and snapshots of the approved files. The worker saves
          a patch for review. Assigned repositories use an isolated Git worktree. Tests are not run automatically.
        </p>
        <label for="file-task-provider">Provider connection</label
        ><USelect
          id="file-task-provider"
          v-model="provider"
          :items="
            state.settings?.providers.map((item) => ({
              label: item.label + (item.configured ? '' : ' · needs setup'),
              value: item.id,
            })) ?? []
          "
          :disabled="busy"
          class="w-full"
        />
        <p v-if="!configured" class="page-note">
          Set up this provider in <RouterLink to="/dashboard#provider-connections">Dashboard</RouterLink> before queueing a file task.
        </p>
        <label for="file-task-instruction">File task instructions</label
        ><UTextarea
          id="file-task-instruction"
          v-model="instruction"
          required
          :maxlength="8000"
          :rows="4"
          :disabled="busy"
          placeholder="Describe the change and the outcome you need…"
          class="w-full"
        />
        <p class="page-note">
          This editor keeps its own instructions and provider when you switch chat tasks.
        </p>
        <label for="file-task-definition">Agent definition for this file task</label
        ><USelect
          id="file-task-definition"
          v-model="definitionId"
          :items="[
            { value: 'none', label: 'No definition · use my instructions' },
            ...state.definitions.map((item) => ({ value: item.id, label: item.name })),
          ]"
          class="w-full"
        /><template v-if="definition"
          ><label for="file-task-agent">Agent</label
          ><USelect
            id="file-task-agent"
            v-model="agent"
            :items="definition.agents.map((item) => ({ value: item.name, label: item.name }))"
            class="w-full"
          />
          <details v-if="selectedAgent">
            <summary>Review agent instructions &amp; model</summary>
            <p>{{ selectedAgent.model || "Configured provider model" }}</p>
            <pre>{{ selectedAgent.instruction }}</pre>
          </details>
          <div v-if="selectedAgent?.requiresAdaptation" class="compatibility-note">
            <strong>Instructions-only adaptation</strong>
            <ul>
              <li v-for="issue in selectedAgent.unsupported" :key="issue">{{ issue }}</li>
            </ul>
            <label class="check-label"
              ><input v-model="adapt" type="checkbox" /> Use instructions only. I accept the omitted features
              listed above.</label
            >
          </div></template
        >
        <p v-if="incompatible" role="alert" class="error-text">
          Choose a {{ selectedAgent?.provider }} provider connection for this agent’s model.
        </p>
        <label for="local-title">Task title</label
        ><UInput id="local-title" v-model="title" required maxlength="200" class="w-full" /><label
          for="local-repository"
          >{{ repositories.length ? 'Assigned repository' : 'Repository directory on the worker machine' }}</label
        ><USelect v-if="repositories.length" id="local-repository" v-model="repository" :items="repositories.map(item => ({ label: item.id, value: item.id }))" placeholder="Select a repository" :aria-describedby="selectedRepository ? 'file-task-checkout' : undefined" class="w-full" /><UInput v-else
          id="local-repository"
          v-model="repository"
          required
          placeholder="/home/you/project"
          class="w-full"
        /><p v-if="selectedRepository" id="file-task-checkout" class="page-note repository-context">Checkout directory<code>{{ selectedRepository.path }}</code></p><label for="local-paths">Approved files · one relative path per line</label
        ><UTextarea id="local-paths" v-model="paths" required placeholder="src/example.ts" class="w-full" />
        <p class="page-note">
          Only these text files are sent to the provider. Up to 32 files and 48,000 characters total. New
          files are supported.
        </p>
        <UButton type="submit" :loading="busy" :disabled="!canSubmit">Queue file task</UButton>
        <p v-if="error" id="file-task-error" role="alert" class="error-text">{{ error }}</p>
      </fieldset>
    </form>
  </div>
</template>
<style scoped>
.repository-context code { display: block; white-space: normal; overflow-wrap: anywhere; }
</style>
