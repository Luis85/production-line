<script lang="ts">
import { reactive, watch as watchPrivateDraft } from 'vue';
import { state as workerState } from '../store';
import type { ProviderId } from '../../infrastructure/providers';
const emptyDraft = () => ({ message: '', provider: undefined as ProviderId | undefined, title: '', definitionId: 'none', agent: '', adapt: false });
// Keep private drafts in tab memory; explicit locking clears them with the other editors.
const intake = reactive(emptyDraft());
watchPrivateDraft(() => workerState.draftEpoch, () => Object.assign(intake, emptyDraft()), { flush: 'sync' });
</script>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import { createTaskAndSend, state } from '../store';
const emit = defineEmits<{ created: [sessionId: string]; busy: [boolean] }>();
const sending = ref(false);
const definition = computed(() => state.definitions.find(item => item.id === intake.definitionId));
const agent = computed(() => definition.value?.agents.find(item => item.name === intake.agent));
const connection = computed(() => state.settings?.providers.find(item => item.id === intake.provider));
const missingAgent = computed(() => intake.definitionId !== 'none' && !agent.value);
const incompatible = computed(() => agent.value?.provider && !(intake.provider ?? '').startsWith(agent.value.provider === 'anthropic' ? 'claude' : 'codex') && intake.provider !== `${agent.value.provider}-api`);
const canCreate = computed(() => state.unlocked && !state.workspaceBusy && !sending.value && connection.value?.configured && intake.message.trim() && !incompatible.value && !missingAgent.value && (!agent.value?.requiresAdaptation || intake.adapt));
const model = computed(() => agent.value?.model || connection.value?.model || 'Provider default');
const toolSummary = computed(() => {
  const tools = state.toolAccess;
  if (!tools) return 'Access not loaded';
  return tools.builtins.files || tools.builtins.commands.some(item => item.enabled) || tools.builtins.webOrigins.length || tools.mcp.some(item => item.enabled && item.allowedTools.length) ? 'Grants configured' : 'All tools off';
});
watch(() => state.settings?.providers, () => {
  if (!intake.provider) intake.provider = state.settings?.providers.find(item => item.configured)?.id ?? state.settings?.providers[0]?.id;
}, { immediate: true });
watch(() => intake.definitionId, () => { intake.agent = definition.value?.agents.find(item => item.name === 'root')?.name ?? definition.value?.agents[0]?.name ?? ''; intake.adapt = false; });
watch(() => intake.agent, () => { intake.adapt = false; });
async function focusInstructions() { await nextTick(); document.getElementById('new-task-instructions')?.focus(); }
async function create() {
  if (!canCreate.value) return;
  const message = intake.message, epoch = state.draftEpoch;
  sending.value = true; emit('busy', true);
  try {
    const result = await createTaskAndSend({ provider: intake.provider, ...(intake.title.trim() ? { title: intake.title.trim() } : {}), ...(definition.value ? { definitionId: definition.value.id, agent: intake.agent, useInstructionsOnly: intake.adapt } : {}) }, message);
    if (epoch !== state.draftEpoch) return;
    if (result.sessionId) {
      // A created task owns the retained draft even if its first send needs a retry.
      if (intake.message === message) intake.message = '';
      intake.title = '';
      emit('created', result.sessionId);
    }
  } finally { sending.value = false; emit('busy', false); }
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && canCreate.value) { event.preventDefault(); void create(); }
}
defineExpose({ focusInstructions });
</script>
<template>
  <section class="task-intake" aria-labelledby="task-intake-title">
    <h3 id="task-intake-title">Give this worker a task</h3>
    <p class="intake-intro">Describe the outcome. Your first message creates the task.</p>
    <form :aria-busy="sending" @submit.prevent="create">
      <fieldset :disabled="sending || state.workspaceBusy" class="contents">
        <div class="intake-field">
          <label for="new-task-connection">Connection</label>
          <USelect id="new-task-connection" v-model="intake.provider" :items="state.settings?.providers.map(item => ({ label: item.label + (item.configured ? '' : ' · needs setup'), value: item.id })) ?? []" class="w-full" />
          <p v-if="!connection?.configured" class="intake-help">Set up this connection in <RouterLink to="/dashboard#provider-connections">Dashboard</RouterLink> before creating a task.</p>
        </div>
        <div class="intake-field">
          <span class="field-label" id="new-task-model-label">{{ agent?.model ? 'Model from agent definition' : 'Configured model' }}</span>
          <div class="intake-model" aria-labelledby="new-task-model-label">{{ model }}</div>
          <p class="intake-help">{{ agent?.model ? 'This task keeps a copy of the selected instructions and model.' : 'Uses this connection’s configuration when the task starts.' }}</p>
        </div>
        <p class="intake-tool-access">Tool access: {{ toolSummary }} · <RouterLink to="/dashboard#tool-access">Manage access</RouterLink><span v-if="state.toolAccess?.builtins.files">File tools need an approved file-task worktree.</span></p>
        <details class="intake-definition">
          <summary>Name &amp; agent definition · {{ definition?.name ?? 'optional' }}</summary>
          <div class="intake-field">
            <label for="new-task-definition">Agent definition</label>
            <USelect id="new-task-definition" v-model="intake.definitionId" :items="[{ value: 'none', label: 'No definition · use my instructions' }, ...state.definitions.map(item => ({ value: item.id, label: item.name }))]" class="w-full" />
          </div>
          <template v-if="definition">
            <div class="intake-field">
              <label for="new-task-agent">Agent</label>
              <USelect id="new-task-agent" v-model="intake.agent" :items="definition.agents.map(item => ({ value: item.name, label: item.name }))" class="w-full" />
            </div>
            <details v-if="agent" class="intake-instructions"><summary>Review agent instructions</summary><pre>{{ agent.instruction }}</pre></details>
            <div v-if="agent?.requiresAdaptation" class="compatibility-note">
              <strong>Some agent features cannot run here</strong>
              <ul><li v-for="issue in agent.unsupported" :key="issue">{{ issue }}</li></ul>
              <label class="check-label"><input v-model="intake.adapt" type="checkbox" /> Use instructions only. I accept the omitted features listed above.</label>
            </div>
          </template>
          <p v-if="missingAgent" class="error-text" role="alert">This definition or agent is no longer available. Choose another definition.</p>
          <p v-if="incompatible" class="error-text" role="alert">Choose a {{ agent?.provider }} connection for this agent’s model.</p>
          <div class="intake-field">
            <label for="new-task-name">Task name · optional</label>
            <UInput id="new-task-name" v-model="intake.title" :maxlength="120" placeholder="Named from your first message" class="w-full" />
          </div>
          <RouterLink class="intake-help" to="/dashboard#agent-definitions">Manage agent definitions</RouterLink>
        </details>
        <div class="intake-field intake-message">
          <label for="new-task-instructions">Task instructions</label>
          <UTextarea id="new-task-instructions" v-model="intake.message" :rows="5" :maxrows="12" autoresize :maxlength="8000" required placeholder="What would you like this worker to do?" class="w-full" aria-describedby="new-task-draft-note" @keydown="keydown" />
          <p id="new-task-draft-note" class="intake-help">{{ intake.message.length.toLocaleString() }} / 8,000 · Ctrl / ⌘ + Enter to create</p>
        </div>
        <div class="intake-submit">
          <p>{{ state.settings?.board.paused ? 'Queue paused. Resume new starts to run this task.' : state.sessions?.execution.currentSessionId ? 'Will wait behind the current task.' : 'Runs when this worker is ready.' }}</p>
          <UButton type="submit" :loading="sending" :disabled="!canCreate">Create task</UButton>
        </div>
        <p v-if="state.actionError" class="error-text" role="alert">{{ state.actionError }}</p>
      </fieldset>
    </form>
    <p class="intake-privacy">Unsent instructions stay in this tab until you reload or lock it.</p>
  </section>
</template>
<style scoped>
.task-intake { min-width: 0; }
h3 { margin: 0; color: var(--ui-text-highlighted); font-size: 1.25rem; line-height: 1.4; font-weight: 650; }
.intake-intro { margin: 10px 0 28px; color: var(--ui-text-muted); font-size: .875rem; line-height: 1.6; }
.intake-field { display: grid; gap: 8px; margin: 0 0 22px; min-width: 0; }
.intake-field label, .field-label { font-size: .8125rem; font-weight: 600; color: var(--ui-text-highlighted); }
.intake-model { padding: 11px 13px; border: 1px solid var(--ui-border); border-radius: 7px; background: #132129; overflow-wrap: anywhere; font-size: .875rem; }
.intake-help { margin: 0; color: var(--ui-text-muted); font-size: .75rem; line-height: 1.55; }
.intake-tool-access { margin: -4px 0 22px; font-size: .75rem; color: var(--ui-text-muted); line-height: 1.6; }
.intake-tool-access span { display: block; margin-top: 4px; }
.intake-definition { margin: 0 0 28px; font-size: .8125rem; }
.intake-definition > summary { padding: 4px 0; cursor: pointer; color: var(--ui-text-toned); }
.intake-definition[open] > summary { margin-bottom: 18px; }
.intake-instructions { margin-bottom: 18px; }
.intake-instructions pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; font-size: .75rem; }
.intake-message { margin-bottom: 28px; }
.intake-field :deep(textarea) { min-height: 132px; line-height: 1.6; background: #111e26; font-size: .875rem; }
.intake-field :deep(button[role="combobox"]) { min-height: 42px; background: #132129; }
.intake-submit { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.intake-submit p { margin: 0; color: var(--ui-text-muted); font-size: .75rem; line-height: 1.5; max-width: 185px; }
.intake-submit button { min-height: 44px; padding-inline: 20px; justify-content: center; white-space: nowrap; font-weight: 650; }
.intake-privacy { margin: 16px 0 0; font-size: .6875rem; color: var(--ui-text-dimmed); line-height: 1.5; }
a { color: var(--ui-primary); text-underline-offset: 3px; }
@media (max-width: 420px) { .intake-submit { align-items: stretch; flex-direction: column-reverse; } .intake-submit p { max-width: none; } }
</style>
