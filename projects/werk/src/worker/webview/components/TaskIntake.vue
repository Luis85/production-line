<script lang="ts">
import { reactive, watch as watchPrivateDraft } from 'vue';
import { state as workerState, type FeatureRequestCommand } from '../store';
import type { ProviderId } from '../../application/provider-contract';
const emptyDraft = () => ({ message: '', provider: undefined as ProviderId | undefined, title: '', definitionId: 'none', agent: '', adapt: false, fileChanges: false, repository: '', paths: '', pending: null as FeatureRequestCommand | null, error: '' });
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
import { createFeatureRequest, getCapacityFreshness, state, type FeatureRequestPreparation } from '../store';
import { validateApprovedPaths } from '../../application/approved-paths';
import RunTask from './RunTask.vue';
import SharedFeatureComposer from './SharedFeatureComposer.vue';
import { buildWorkerCapacityView } from '../worker-capacity';
const sharedComposer = ref<InstanceType<typeof SharedFeatureComposer> | null>(null);
const sharedBinding = computed(() => !!state.environment?.sharedIntake?.config.repositoryId);
const emit = defineEmits<{ created: [sessionId: string, previousSessionId: string]; busy: [boolean] }>();
const sending = ref(false), optionsOpen = ref(false), filesOpen = ref(false);
const preparation = ref<FeatureRequestPreparation | null>(null);
const preparationNote = computed(() => preparation.value?.phase === 'waiting' ? 'Waiting for an earlier request to finish preparation…' : preparation.value?.phase === 'worktree' ? 'Preparing this request’s Git worktree…' : 'Saving approved files and the feature request…');
const options = ref<HTMLDetailsElement | null>(null);
const capacity = computed(() => buildWorkerCapacityView(state.sessions?.capacity, getCapacityFreshness()));
const definition = computed(() => state.definitions.find(item => item.id === intake.definitionId));
const agent = computed(() => definition.value?.agents.find(item => item.name === intake.agent));
const connection = computed(() => state.settings?.providers.find(item => item.id === intake.provider));
const missingAgent = computed(() => intake.definitionId !== 'none' && !agent.value);
const incompatible = computed(() => agent.value?.provider && !(intake.provider ?? '').startsWith(agent.value.provider === 'anthropic' ? 'claude' : 'codex') && intake.provider !== `${agent.value.provider}-api`);
const repositories = computed(() => state.settings?.repositories.items ?? []);
const approvedPaths = () => intake.paths.split('\n').map(path => path.trim()).filter(Boolean);
const fileIssue = computed(() => {
  if (!intake.fileChanges) return '';
  if (repositories.value.length ? !repositories.value.some(item => item.id === intake.repository) : !intake.repository.trim()) return 'Choose a repository for the approved file changes.';
  try { validateApprovedPaths(approvedPaths()); return ''; } catch (error) { return (error as Error).message; }
});
const canCreate = computed(() => state.unlocked && !state.workspaceBusy && !sending.value && (!!intake.pending || connection.value?.configured && capacity.value.admissionAvailable !== false && !!intake.message.trim() && !incompatible.value && !missingAgent.value && !fileIssue.value && (!agent.value?.requiresAdaptation || intake.adapt)));
const model = computed(() => agent.value?.model || connection.value?.model || 'Provider default');
const optionIssue = computed(() => missingAgent.value ? 'This definition or agent is no longer available. Choose another definition.' : incompatible.value ? 'Choose a ' + agent.value?.provider + ' connection for this agent’s model.' : agent.value?.requiresAdaptation && !intake.adapt ? 'Review this agent’s omitted features and accept instructions-only use before creating the task.' : '');
const admissionNote = computed(() => sending.value && preparation.value ? 'Your request is being prepared. It has not joined the queue yet.' : intake.pending ? 'Retry checks the same request. It does not create a second request.' : capacity.value.admissionAvailable === false ? 'Local admission is full. Your instructions stay here while accepted work finishes.' : capacity.value.stale || capacity.value.state === 'unknown' ? 'Capacity needs refresh. The worker checks admission when you submit.' : capacity.value.startBlocked ? 'You can add this request to the queue. New model calls wait until the start conditions below are resolved.' : capacity.value.state === 'running' ? 'Joins the queue behind the active task.' : 'Joins this worker’s shared execution queue.');
async function reviewOptions() { optionsOpen.value = true; await nextTick(); options.value?.querySelector('summary')?.focus(); }
const toolSummary = computed(() => {
  const tools = state.toolAccess;
  if (!tools) return 'Access not loaded';
  return tools.builtins.files || tools.builtins.commands.some(item => item.enabled) || (tools.builtins.cliTools ?? []).some(item => item.enabled) || tools.builtins.webOrigins.length || tools.mcp.some(item => item.enabled && item.allowedTools.length) ? 'Grants configured' : 'All tools off';
});
watch(() => state.settings?.providers, () => {
  if (!intake.provider) intake.provider = state.settings?.providers.find(item => item.configured)?.id ?? state.settings?.providers[0]?.id;
}, { immediate: true });
watch(() => intake.definitionId, () => { intake.agent = definition.value?.agents.find(item => item.name === 'root')?.name ?? definition.value?.agents[0]?.name ?? ''; intake.adapt = false; });
watch(() => intake.agent, () => { intake.adapt = false; });
watch(repositories, () => { if (!intake.repository && repositories.value.length === 1) intake.repository = repositories.value[0].id; }, { immediate: true });
async function focusInstructions() { await nextTick(); if (sharedBinding.value) await sharedComposer.value?.focusInstructions(); else document.getElementById('new-task-instructions')?.focus(); }
async function create() {
  if (!canCreate.value) return;
  const epoch = state.draftEpoch, previousSessionId = state.sessions?.selected ?? '';
  if (!intake.pending) intake.pending = {
    action: 'create', id: crypto.randomUUID(), title: intake.title.trim() || intake.message.trim().slice(0, 80),
    message: intake.message, provider: intake.provider!,
    ...(definition.value ? { definitionId: definition.value.id, agent: intake.agent, useInstructionsOnly: intake.adapt } : {}),
    ...(intake.fileChanges ? { background: true as const, files: { repository: intake.repository.trim(), paths: approvedPaths() } } : {}),
  };
  const command = JSON.parse(JSON.stringify(intake.pending)) as FeatureRequestCommand;
  sending.value = true; preparation.value = null; intake.error = ''; emit('busy', true);
  try {
    const result = await createFeatureRequest(command, progress => {
      if (epoch === state.draftEpoch && state.unlocked) { preparation.value = progress; emit('busy', false); }
    });
    if (epoch !== state.draftEpoch) return;
    if (result) {
      if (intake.message === command.message) intake.message = '';
      intake.title = ''; intake.pending = null; intake.fileChanges = false; intake.paths = '';
      emit('created', result.session.id, previousSessionId);
    } else intake.error = 'Creation could not be confirmed. Unlock if needed, then retry this same request.';
  } catch (error) {
    if (epoch !== state.draftEpoch) return;
    // Invalid input is rejected before admission. Every ambiguous outcome keeps the exact operation.
    if ((error as Error & { status?: number }).status === 400) intake.pending = null;
    intake.error = (error as Error).message;
  } finally { preparation.value = null; sending.value = false; emit('busy', false); }
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && canCreate.value) { event.preventDefault(); void create(); }
}
defineExpose({ focusInstructions });
</script>
<template>
  <SharedFeatureComposer v-if="sharedBinding" ref="sharedComposer" @created="(id, previous) => emit('created', id, previous)" @busy="emit('busy', $event)" />
  <section v-else class="task-intake" aria-labelledby="task-intake-title">
    <h3 id="task-intake-title">Create a feature request</h3>
    <p class="intake-intro">Describe the outcome. The worker saves a Markdown feature request and tracks its progress and results.</p>
    <form :aria-busy="sending" @submit.prevent="create">
      <fieldset :disabled="sending || state.workspaceBusy || !!intake.pending" class="contents">
        <div class="intake-field intake-message">
          <label for="new-task-instructions">Request instructions</label>
          <UTextarea id="new-task-instructions" v-model="intake.message" :rows="6" :maxrows="12" autoresize :maxlength="8000" required placeholder="What would you like this worker to do?" class="w-full" aria-describedby="new-task-draft-note" @keydown="keydown" />
          <p id="new-task-draft-note" class="intake-help">{{ intake.message.length.toLocaleString() }} / 8,000 · Ctrl / ⌘ + Enter to create</p>
        </div>
        <details ref="options" class="intake-definition" :open="optionsOpen" @toggle="optionsOpen = ($event.target as HTMLDetailsElement).open">
          <summary><span>Task options</span><span class="options-selection">{{ connection?.label ?? 'Choose a connection' }} · {{ model }}</span></summary>
          <div class="intake-options-content">
            <div class="intake-field">
              <label for="new-task-connection">Connection</label>
              <USelect id="new-task-connection" v-model="intake.provider" :items="state.settings?.providers.map(item => ({ label: item.label + (item.configured ? '' : ' · needs setup'), value: item.id })) ?? []" class="w-full" />
            </div>
            <div class="intake-field">
              <span class="field-label" id="new-task-model-label">{{ agent?.model ? 'Model from agent definition' : 'Configured model' }}</span>
              <div class="intake-model" aria-labelledby="new-task-model-label">{{ model }}</div>
              <p class="intake-help">{{ agent?.model ? 'This task keeps a copy of the selected instructions and model.' : 'Uses this connection’s configuration when the task starts.' }}</p>
            </div>
            <p class="intake-tool-access">Tool access: {{ toolSummary }} · <RouterLink to="/settings#tool-access">Manage access</RouterLink><span v-if="state.toolAccess?.builtins.files">File reads use the task worktree. Edits stay within the approved paths below.</span></p>
            <div class="intake-field">
              <label for="new-task-name">Request name · optional</label>
              <UInput id="new-task-name" v-model="intake.title" :maxlength="120" placeholder="Named from your first message" class="w-full" />
            </div>
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
            <RouterLink class="intake-help" to="/settings#agent-definitions">Manage agent definitions</RouterLink>
          </div>
        </details>
        <details class="intake-definition repository-options" :open="filesOpen" @toggle="filesOpen = ($event.target as HTMLDetailsElement).open">
          <summary><span>Repository files · optional</span><span class="options-selection">{{ intake.fileChanges ? 'Approved file changes enabled' : 'No repository file changes' }}</span></summary>
          <RunTask v-model:enabled="intake.fileChanges" v-model:repository="intake.repository" v-model:paths="intake.paths" />
          <p v-if="fileIssue" class="intake-notice error-text" role="status">{{ fileIssue }}</p>
        </details>
        <p v-if="!connection?.configured" class="intake-notice" role="status">Choose a configured connection in Task options or <RouterLink to="/settings#provider-connections">set up a provider</RouterLink> before creating a request.</p>
        <div v-if="optionIssue" class="intake-notice" role="status"><p>{{ optionIssue }}</p><button type="button" class="options-review" @click="reviewOptions">Review task options</button></div>
      </fieldset>
        <p v-if="sending && preparation && state.unlocked" class="intake-notice" role="status">{{ preparationNote }} Your original instructions stay here until the request is saved.</p>
        <p v-if="intake.pending && !sending" class="intake-notice" role="status">The submitted request is kept until its creation is confirmed. Retry uses its original instructions and request ID.</p>
        <div class="intake-submit">
          <p>{{ admissionNote }}</p>
          <UButton type="submit" :loading="sending" :disabled="!canCreate">{{ sending ? preparation ? 'Preparing request' : 'Creating request' : intake.pending ? 'Retry same request' : 'Create request' }}</UButton>
        </div>
        <p v-if="capacity.startBlocked" class="intake-help intake-start-condition">{{ capacity.description }} <RouterLink :to="state.sessions?.capacity?.starts.consumption?.blocked ? '/settings#consumption-limits' : '/settings#queue'">Review start conditions</RouterLink></p>
        <p v-if="intake.error" class="error-text" role="alert">{{ intake.error }}</p>
    </form>
    <p class="intake-privacy">Unsent instructions stay in this tab until you reload or lock it.</p>
  </section>
</template>
<style scoped>
.task-intake { min-width: 0; }
h3 { margin: 0; color: var(--ui-text-highlighted); font-size: 1.25rem; line-height: 1.4; font-weight: 650; }
.intake-intro { margin: var(--space-2) 0 var(--space-6); color: var(--ui-text-muted); font-size: .875rem; line-height: 1.6; }
.intake-field { display: grid; gap: var(--space-2); margin: 0 0 var(--space-6); min-width: 0; }
.intake-field label, .field-label { font-size: .875rem; font-weight: 600; color: var(--ui-text-highlighted); }
.intake-model { padding: var(--space-3); border: 1px solid var(--ui-border); border-radius: 8px; background: #132129; overflow-wrap: anywhere; font-size: .875rem; }
.intake-help { margin: 0; color: var(--ui-text-muted); font-size: .75rem; line-height: 1.6; }
.intake-tool-access { margin: 0 0 var(--space-6); font-size: .8125rem; color: var(--ui-text-muted); line-height: 1.6; }
.intake-tool-access span { display: block; margin-top: var(--space-1); }
.intake-definition { margin: 0 0 var(--space-6); border-block: 1px solid var(--ui-border); font-size: .875rem; }
.intake-definition > summary { min-height: 60px; padding-block: var(--space-3); cursor: pointer; color: var(--ui-text-highlighted); }
.options-selection { display: block; margin-top: var(--space-1); margin-left: var(--space-4); color: var(--ui-text-muted); font-size: .75rem; overflow-wrap: anywhere; }
.intake-options-content { padding-top: var(--space-3); padding-bottom: var(--space-4); }
.intake-instructions { margin-bottom: var(--space-4); }
.intake-instructions summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; }
.intake-instructions pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; font-size: .8125rem; }
.intake-message { margin-bottom: var(--space-4); }
.intake-field :deep(textarea) { min-height: 156px; line-height: 1.6; background: #111e26; font-size: 1rem; }
.intake-field :deep(button[role="combobox"]), .intake-field :deep(input) { min-height: 44px; background: #132129; }
.intake-notice { margin: 0 0 var(--space-4); color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.6; }
.options-review { min-height: 44px; color: var(--ui-primary); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.intake-submit { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.intake-submit p { margin: 0; color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.6; max-width: 24ch; }
.intake-submit button { min-height: 44px; padding-inline: var(--space-6); justify-content: center; white-space: nowrap; font-weight: 650; }
.intake-start-condition { margin-top: var(--space-4); }
.intake-privacy { margin: var(--space-4) 0 0; font-size: .75rem; color: var(--ui-text-muted); line-height: 1.6; }
.compatibility-note { margin-bottom: var(--space-4); }
.compatibility-note .check-label { min-height: 44px; }
a { color: var(--ui-primary); text-underline-offset: 3px; }
@media (max-width: 420px) { .intake-submit { align-items: stretch; flex-direction: column-reverse; } .intake-submit p { max-width: none; } }
</style>
