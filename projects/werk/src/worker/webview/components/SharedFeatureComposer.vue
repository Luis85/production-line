<script lang="ts">
import { reactive, watch as watchPrivateDraft } from 'vue';
import { state as workerState } from '../store';
import type { ProviderId } from '../../application/provider-contract';
import type { ModelEffort } from '../../application/model-effort';
import { emptyFeatureAuthoringEditor } from '../feature-authoring-editor';
const editorState = reactive(emptyFeatureAuthoringEditor());
const emptySeed = () => ({ title: '', message: '', provider: undefined as ProviderId | undefined, model: '', effort: '' as ModelEffort | '', paths: '', selectionEdited: false, executionProfile: '' });
const seed = reactive(emptySeed());
watchPrivateDraft(() => workerState.draftEpoch, () => {
  Object.assign(editorState, emptyFeatureAuthoringEditor());
  Object.assign(seed, emptySeed());
}, { flush: 'sync' });
</script>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import ProjectExecutionSelection from './ProjectExecutionSelection.vue';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import ModelSelectionFields from './ModelSelectionFields.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import MessageContent from './MessageContent.vue';
import FeatureRequestDetails from './FeatureRequestDetails.vue';
import { state, request, refresh } from '../store';
import { createFeatureAuthoringEditor } from '../feature-authoring-editor';
import { sharedReadyReviewView } from '../shared-ready-review-view';
import { splitFeatureRequestMarkdown } from '../feature-request-note';
import type { FeatureAuthoringResult } from '../../application/feature-authoring-contracts';
const emit = defineEmits<{ created: [sessionId: string, previousSessionId: string]; busy: [boolean] }>();
const projectId = ref(''), projectProfiles = ref(false);
const projectSnapshot = useWorkerSnapshot(() => request<NonNullable<NonNullable<typeof state.environment>['sharedIntake']>>('/api/shared-intake' + (projectId.value ? '?projectId=' + encodeURIComponent(projectId.value) : '')), [projectId]);
const projectChoices = computed(() => projectSnapshot.data.value?.projects ?? state.environment?.sharedIntake?.projects ?? []);
const view = computed(() => projectSnapshot.data.value ?? (!projectId.value ? state.environment?.sharedIntake : undefined));
const binding = () => view.value?.config.repositoryId ? { repositoryId: view.value.config.repositoryId, remote: view.value.config.remote, branch: view.value.config.branch, workflowPath: view.value.config.workflowPath } : null;
const editor = createFeatureAuthoringEditor({ state: editorState, binding, active: () => state.unlocked,
  epoch: () => state.draftEpoch, uuid: () => crypto.randomUUID(), command: command => request<FeatureAuthoringResult>('/api/features', 'POST', { ...command, projectId: command.expectedBinding?.repositoryId ?? projectId.value }) });
const locked = computed(() => editorState.busy || !!editorState.pending || state.workspaceBusy || !state.unlocked);
const current = computed(() => editor.current());
const editable = computed(() => editor.editable());
const changed = computed(() => editorState.markdown !== editorState.checkedMarkdown);
const unsaved = computed(() => !!editorState.result && (!editorState.result.revision || editorState.markdown !== editorState.savedMarkdown));
const ready = computed(() => editable.value && !locked.value && !changed.value && editorState.result?.readiness.valid);
const reviewRequired = computed(() => editorState.result?.readiness.reviewRequired === true);
const selectedReview = computed(() => selected.value?.readyReview && !selected.value.taskId ? sharedReadyReviewView(selected.value) : null);
const preview = computed(() => splitFeatureRequestMarkdown(editorState.markdown).body);
const requests = computed(() => view.value?.requests ?? []);
const selected = computed(() => requests.value.find(item => item.id === editorState.result?.featureId));
function sessionId(taskId: string | null) { return taskId ? state.board?.tasks.find(task => task.id === taskId)?.sessionId : undefined; }
function openConversation(taskId: string | null) { const id = sessionId(taskId); if (id) emit('created', id, state.sessions?.selected ?? ''); }
watch(() => editorState.busy, value => emit('busy', value));
const defaultProvider = computed(() => state.settings?.defaultProvider ?? state.settings?.providers.find(item => item.configured)?.id ?? state.settings?.providers[0]?.id);
watch([() => state.settings?.providers, defaultProvider], () => {
  const untouched = !seed.selectionEdited && !seed.title && !seed.message && !seed.model && !seed.effort && !seed.paths && !editorState.result && !editorState.pending;
  if (!seed.provider || untouched) seed.provider = defaultProvider.value;
}, { immediate: true });
async function focusInstructions() { await nextTick(); document.getElementById(editorState.result ? 'feature-detail-goal' : 'new-task-instructions')?.focus(); }
async function prepare() {
  if (locked.value || !seed.message.trim() || !binding() || !projectProfiles.value && !seed.provider) return;
  await editor.prepare({ title: seed.title.trim() || seed.message.trim().slice(0, 80), message: seed.message, ...(projectProfiles.value ? seed.executionProfile ? { executionProfile: seed.executionProfile } : {} : { provider: seed.provider }),
    ...(!projectProfiles.value && seed.model.trim() ? { model: seed.model.trim() } : {}), ...(!projectProfiles.value && seed.effort ? { effort: seed.effort } : {}),
    paths: seed.paths.split('\n').map(path => path.trim()).filter(Boolean) });
  await focusInstructions();
}
async function publish(status: 'draft' | 'ready') { if (await editor.publish(status)) await refresh(); }
async function retry() { if ((await editor.retry())?.publication) await refresh(); }
async function reopen(name: string) { if (await editor.reopen(name)) await focusInstructions(); }
function newRequest() {
  if (locked.value) return;
  editor.reset(); Object.assign(seed, emptySeed(), { provider: defaultProvider.value }); void focusInstructions();
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !editorState.result) { event.preventDefault(); void prepare(); }
}
defineExpose({ focusInstructions });
</script>
<template>
  <section class="shared-feature-composer" aria-labelledby="shared-feature-title" :aria-busy="editorState.busy">
    <h3 id="shared-feature-title">Create a feature request</h3>
    <p class="composer-intro">Describe the outcome here. Your request uses the same project template, Markdown queue and checks as your team.</p>
    <label for="shared-project-choice">Project</label><select id="shared-project-choice" v-model="projectId" :disabled="locked || !!editorState.result || !!seed.message.trim()"><option value="">Worker installation project</option><option v-for="project in projectChoices" :key="project.id" :value="project.id">{{ project.label }}{{ project.enabled ? '' : ' · intake paused' }}</option></select><p v-if="projectSnapshot.error.value" role="alert" class="error-text">{{ projectSnapshot.error.value }}</p><p v-if="view && !view.config.repositoryId" class="notice">Shared Git intake is not configured for this project. Add requests to its local feature folder, or configure shared intake.</p>
    <p class="destination">{{ view?.config.repositoryId }} · {{ view?.config.remote }} / {{ view?.config.branch }}</p>
    <p v-if="view && !view.config.enabled" class="notice">Shared intake is paused. You can publish requests; execution waits until intake resumes.</p>
    <form v-if="!editorState.result" :aria-busy="editorState.busy" @submit.prevent="prepare">
      <fieldset :disabled="locked">
        <label for="new-task-instructions">Request instructions</label>
        <UTextarea id="new-task-instructions" v-model="seed.message" :rows="6" :maxrows="12" autoresize :maxlength="8000" required placeholder="What would you like this worker to do?" class="w-full" aria-describedby="shared-instructions-help" @keydown="keydown" />
        <p id="shared-instructions-help" class="help">Start with your goal. Preparing a draft does not run the model or start implementation.</p>
        <details class="request-options">
          <summary>Request options</summary>
          <label for="shared-request-title">Request name · optional</label>
          <UInput id="shared-request-title" v-model="seed.title" :maxlength="120" placeholder="Named from your instructions" class="w-full" />
          <ProjectExecutionSelection id="shared-request" v-model="seed.executionProfile" :project-id="view?.config.repositoryId || projectId || undefined" mode="patch" :disabled="locked" @configured="projectProfiles = $event" />
          <ModelSelectionFields v-if="!projectProfiles" id="shared-request" @update:provider="seed.selectionEdited = true" @update:model="seed.selectionEdited = true" @update:effort="seed.selectionEdited = true" v-model:provider="seed.provider" v-model:model="seed.model" v-model:effort="seed.effort" :providers="state.settings?.providers ?? []" :disabled="locked" />
          <label for="shared-request-paths">Approved repository paths · one per line</label>
          <UTextarea id="shared-request-paths" v-model="seed.paths" :rows="3" placeholder="src/orders/export.ts" class="w-full" />
          <p class="help">Only approve files this feature may change. You can complete these details in the draft.</p>
        </details>
      </fieldset>
      <UButton type="submit" :loading="editorState.busy" :disabled="locked || !seed.message.trim() || !binding() || !projectProfiles && !seed.provider">Prepare request</UButton>
    </form>
    <template v-else>
      <div class="request-identity"><strong>{{ editorState.result.name }}</strong><span>{{ editorState.result.revision ? 'Published ' + editorState.result.status : 'Unpublished draft' }}</span></div>
      <p v-if="!current" class="error-text" role="alert">The shared connection changed. This draft still belongs to {{ editorState.result.binding.repositoryId }} / {{ editorState.result.binding.branch }}. Restore that connection to continue.</p>
      <p v-if="editorState.notice" class="notice" role="status">{{ editorState.notice }}</p>
      <template v-if="editable">
        <FeatureRequestDetails v-model="editorState.markdown" :disabled="locked" :project-id="editorState.result.binding.repositoryId" />
        <section class="readiness" aria-labelledby="shared-readiness-title" aria-live="polite">
          <h4 id="shared-readiness-title">{{ changed ? 'Details changed · check again' : editorState.result.readiness.valid ? reviewRequired ? 'Ready for request review' : 'Ready checks passed' : reviewRequired ? 'Details needed before review' : 'Details needed before work can start' }}</h4>
          <ul v-if="!changed && editorState.result.readiness.errors.length"><li v-for="(issue, index) in editorState.result.readiness.errors" :key="index">{{ issue.message }}</li></ul>
          <UButton color="neutral" variant="outline" :disabled="locked" @click="editor.check">{{ reviewRequired ? 'Check request details' : 'Check readiness' }}</UButton>
        </section>
        <p v-if="reviewRequired" class="help">This check validates the request structure. After publication, a model reviewer examines the Feature Request and may ask for answers in its Markdown note. Implementation waits for that review and the Definition of Ready checks.</p>
        <div class="publish-actions">
          <UButton color="neutral" variant="outline" :disabled="locked" @click="publish('draft')">Save draft to Git</UButton>
          <UButton :disabled="!ready" @click="publish('ready')">Mark ready and publish</UButton>
        </div>
        <p class="help">Publishing commits and pushes this note to {{ editorState.result.binding.branch }}. {{ reviewRequired ? 'A ready request enters the Ready Check review before implementation.' : 'Only a ready request can be claimed for implementation.' }}</p>
      </template>
      <template v-else-if="current">
        <p class="notice">{{ selectedReview ? selectedReview.description : selected?.owner ? selected.isLocal ? 'This worker owns the request. Continue in its conversation or answer its Task note.' : 'Another worker owns this request. Follow its progress in the shared Markdown notes.' : 'Your request is in the shared queue. It starts after validation, ownership and capacity checks.' }}</p>
        <UButton v-if="selected && sessionId(selected.taskId)" :disabled="locked" @click="openConversation(selected.taskId)">Open conversation</UButton>
        <RouterLink v-else to="/settings#shared-intake">Inspect shared progress</RouterLink>
      </template>
      <details class="request-preview"><summary>Preview Feature Request</summary><MessageContent :text="preview" /></details>
      <UButton v-if="!editorState.pending" color="neutral" variant="ghost" :disabled="locked" @click="newRequest">{{ unsaved ? 'Discard unpublished edits' : 'Start another request' }}</UButton>
    </template>
    <p v-if="editorState.busy" class="notice" role="status">{{ editorState.pending?.action === 'publish' ? 'Publishing this request to Git…' : 'Preparing and checking request details…' }}</p>
    <p v-if="editorState.error" class="error-text" role="alert">{{ editorState.error }}</p>
    <div v-if="editorState.pending && !editorState.busy" class="uncertain-publication">
      <p class="notice">The result is unconfirmed. Your exact request is retained; retry before editing or starting another request.</p>
      <UButton :disabled="state.workspaceBusy || !state.unlocked" @click="retry">Retry same request</UButton>
    </div>
    <details class="saved-requests">
      <summary>Shared requests · {{ requests.length }}</summary>
      <p v-if="unsaved" class="help">Save or discard your current edits before opening another draft.</p>
      <p v-if="!requests.length" class="help">Published requests appear here after synchronization.</p>
      <ul v-else><li v-for="item in requests" :key="item.id"><div><strong>{{ item.title || item.name }}</strong><span>{{ item.status.replaceAll('_', ' ') }} · {{ item.name }}</span></div>
        <UButton v-if="!item.owner && item.status === 'draft'" color="neutral" variant="outline" :disabled="locked || unsaved" @click="reopen(item.name)">Open draft</UButton>
        <UButton v-else-if="item.isLocal && sessionId(item.taskId)" color="neutral" variant="outline" :disabled="locked" @click="openConversation(item.taskId)">Open conversation</UButton>
        <RouterLink v-else to="/settings#shared-intake">Inspect progress</RouterLink>
      </li></ul>
    </details>
    <p class="privacy">Unpublished edits stay in this tab until you reload or lock it. Saved drafts remain in Git.</p>
  </section>
</template>
<style scoped>
.shared-feature-composer { min-width: 0; }
h3 { margin: 0; font-size: 1.25rem; line-height: 1.4; }
h4 { margin: 0 0 12px; font-size: .875rem; }
p { line-height: 1.6; }
.composer-intro { margin: 8px 0 12px; color: var(--ui-text-muted); font-size: .875rem; }
.destination { margin: 0 0 24px; font-size: .75rem; color: var(--ui-text-muted); overflow-wrap: anywhere; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
select { min-height:44px;max-width:100%;width:100%;background:var(--ui-bg);color:var(--ui-text);border:1px solid var(--ui-border);padding-inline:12px;border-radius:6px; }
label { display: block; margin: 20px 0 8px; font-weight: 600; font-size: .875rem; }
fieldset > label:first-child { margin-top: 0; }
:deep(textarea) { background: #111e26; line-height: 1.6; }
:deep(button), :deep(input) { min-height: 44px; }
:deep(textarea:focus-visible), :deep(input:focus-visible) { outline-offset: 3px; }
.help, .privacy { font-size: .75rem; color: var(--ui-text-muted); margin: 8px 0 16px; }
.notice { font-size: .8125rem; margin: 12px 0 20px; color: var(--ui-text-muted); }
.error-text { overflow-wrap: anywhere; margin: 16px 0; }
.request-options, .request-preview, .saved-requests { border-top: 1px solid var(--ui-border); margin-top: 20px; padding-block: 4px 12px; }
summary { cursor: pointer; min-height: 44px; padding-block: 12px; font-size: .875rem; font-weight: 600; }
.request-identity { display: grid; gap: 5px; margin: 20px 0; overflow-wrap: anywhere; }
.request-identity span { font-size: .75rem; color: var(--ui-text-muted); }
.markdown-editor :deep(textarea) { font-family: var(--font-mono, monospace); font-size: .8125rem; }
.readiness { margin-block: 20px; padding-block: 16px; border-block: 1px solid var(--ui-border); }
.readiness ul { padding-left: 20px; font-size: .8125rem; line-height: 1.6; margin-bottom: 16px; }
.publish-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.publish-actions :deep(button) { white-space: normal; justify-content: center; }
.request-preview :deep(pre), .request-preview :deep(table) { max-width: 100%; overflow-x: auto; }
.saved-requests ul { list-style: none; padding: 0; margin: 0; max-height: 360px; overflow-y: auto; }
.saved-requests li { display: grid; gap: 10px; justify-items: start; padding-block: 16px; border-top: 1px solid var(--ui-border); }
.saved-requests li > div { display: grid; gap: 5px; min-width: 0; font-size: .875rem; overflow-wrap: anywhere; }
.saved-requests li span { font-size: .75rem; color: var(--ui-text-muted); }
a { color: var(--ui-primary); text-underline-offset: 3px; }
.privacy { margin-top: 24px; }
@media (max-width: 420px) { .publish-actions { flex-direction: column; } }
</style>
