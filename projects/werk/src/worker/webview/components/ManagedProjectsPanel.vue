<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import type { ManagedSetupPlan, ManagedSetupResult } from '../../application/managed-project-setup';
import { request, refresh as refreshWorkspace, state } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { emptyManagedProjectDraft, managedProjectCommand, managedProjectStatus, type ManagedProjectCommand, type ManagedProjectsView } from '../managed-project-view';
const { data, error, loading, refreshing, refresh } = useWorkerSnapshot(() => request<ManagedProjectsView>('/api/managed-projects'));
const draft = reactive(emptyManagedProjectDraft()), busy = ref(false), actionError = ref(''), notice = ref('');
const pending = ref<ManagedProjectCommand | null>(null);
const setupPlan = ref<ManagedSetupPlan | null>(null), setupResult = ref<ManagedSetupResult | null>(null), setupPending = ref<{ id: string; operationId: string; expectedPlan?: string } | null>(null), setupBusy = ref(false), setupError = ref(''), setupApproved = ref(false);
const setupResumable = computed(() => !!setupResult.value?.resumePlan && !!setupPending.value?.expectedPlan);
const locked = computed(() => busy.value || !!pending.value || setupBusy.value || !!setupPending.value || !state.unlocked);
watch(() => data.value?.projects, projects => {
  if (setupPending.value || setupBusy.value) return;
  const held = projects?.find(project => project.setup && project.setup.status === 'unknown');
  if (held?.setup) { setupResult.value = held.setup; setupPending.value = { id: held.id, operationId: held.setup.operationId, ...(held.setup.resumePlan ? { expectedPlan: held.setup.resumePlan.planDigest } : {}) }; setupPlan.value = held.setup.resumePlan ?? null; setupApproved.value = false; }
});
const valid = computed(() => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(draft.id.trim()) && !!(draft.mode === 'register' ? draft.repository.trim() : draft.path.trim()));
watch(() => state.draftEpoch, () => { Object.assign(draft, emptyManagedProjectDraft()); pending.value = null; actionError.value = ''; notice.value = ''; busy.value = false; setupPlan.value = null; setupResult.value = null; setupPending.value = null; setupBusy.value = false; setupError.value = ''; setupApproved.value = false; });
async function send(command: ManagedProjectCommand) {
  if (busy.value || setupBusy.value || setupPending.value || !state.unlocked) return;
  const epoch = state.draftEpoch;
  pending.value = JSON.parse(JSON.stringify(command)) as ManagedProjectCommand; busy.value = true; actionError.value = ''; notice.value = '';
  try {
    await request<ManagedProjectsView>('/api/managed-projects', 'POST', pending.value, 120000);
    if (epoch !== state.draftEpoch || !state.unlocked) return;
    pending.value = null; notice.value = 'Project operation recorded. Review the saved project status below.';
    if (command.action === 'register' || command.action === 'adopt') Object.assign(draft, emptyManagedProjectDraft());
    await Promise.all([refresh(), refreshWorkspace()]);
  } catch (failure) {
    if (epoch !== state.draftEpoch || !state.unlocked) return;
    const status = (failure as { status?: number }).status;
    if (status && status >= 400 && status < 500 && status !== 401) pending.value = null;
    actionError.value = failure instanceof Error ? failure.message : 'The project operation could not be confirmed. Retry the saved operation.';
  } finally { if (epoch === state.draftEpoch) busy.value = false; }
}
async function previewSetup(id: string) {
  if (locked.value) return;
  const epoch = state.draftEpoch; setupBusy.value = true; setupError.value = ''; setupResult.value = null; setupPlan.value = null; setupApproved.value = false;
  try { const value = await request<ManagedSetupPlan>('/api/managed-projects', 'POST', { action: 'setup_plan', id }); if (epoch === state.draftEpoch && state.unlocked) setupPlan.value = value; }
  catch (failure) { if (epoch === state.draftEpoch) setupError.value = (failure as Error).message; }
  finally { if (epoch === state.draftEpoch) setupBusy.value = false; }
}
async function applySetup(reconcile = false) {
  if (setupBusy.value || busy.value || pending.value || !state.unlocked) return;
  if (reconcile ? !setupPending.value : !setupPlan.value || !setupApproved.value || setupPending.value && !setupResumable.value || !setupPlan.value.files.some(file => file.status === 'create')) return;
  const command = setupPending.value ?? { id: setupPlan.value!.projectId, operationId: crypto.randomUUID(), expectedPlan: setupPlan.value!.planDigest };
  setupPending.value = command; setupBusy.value = true; setupError.value = ''; const epoch = state.draftEpoch;
  try {
    const value = await request<ManagedSetupResult>('/api/managed-projects', 'POST', reconcile ? { action: 'setup_reconcile', id: command.id, operationId: command.operationId } : { action: 'setup_apply', ...command }, 120000);
    if (epoch !== state.draftEpoch || !state.unlocked) return;
    setupResult.value = value; setupApproved.value = false;
    if (value.resumePlan) { setupPlan.value = value.resumePlan; setupPending.value = { id: value.projectId, operationId: value.operationId, expectedPlan: value.resumePlan.planDigest }; }
    if (value.status === 'published') { setupPending.value = null; setupPlan.value = null; setupApproved.value = false; await Promise.all([refresh(), refreshWorkspace()]); }
  } catch (failure) { if (epoch !== state.draftEpoch || !state.unlocked) return; if ((failure as { status?: number }).status && (failure as { status: number }).status < 500) setupPending.value = null; setupError.value = (failure as Error).message; }
  finally { if (epoch === state.draftEpoch) setupBusy.value = false; }
}
function submit() { if (valid.value && !locked.value) void send(managedProjectCommand(draft, crypto.randomUUID())); }
function recover(id: string, action: 'retry' | 'reconcile') { if (!locked.value) void send({ action, id, operationId: crypto.randomUUID() }); }
</script>
<template>
  <section class="managed-projects" aria-labelledby="managed-projects-title">
    <header><h3 id="managed-projects-title">Managed projects</h3><UButton type="button" color="neutral" variant="ghost" :loading="refreshing" :disabled="!state.unlocked || busy" @click="refresh">Refresh projects</UButton></header>
    <p>Register a Git repository for this worker to clone, or connect an existing checkout. Each project retains its own requests, policy and isolated worktrees.</p>
    <p v-if="loading && !data" role="status">Loading project registrations…</p>
    <p v-if="error" class="error-text" role="alert">{{ error }} Refresh to retry.</p>
    <p v-if="busy" role="status" class="caption">{{ pending?.action === 'register' ? 'Cloning and registering the project…' : pending?.action === 'adopt' ? 'Connecting the existing checkout…' : 'Checking the saved project setup…' }} Wait for the worker’s recorded result.</p>
    <p v-if="data" class="caption break-anywhere">Worker project home: {{ data.home }}</p>
    <details v-if="data?.diagnostics.length"><summary>Project prerequisites</summary><ul class="diagnostics"><li v-for="item in data.diagnostics" :key="item.id"><strong>{{ item.id === 'claude' ? 'Claude Code CLI' : item.id === 'github' ? 'GitHub CLI' : 'Git' }} · {{ item.applicable === false ? 'Optional · not enabled' : item.available ? 'Available' : item.required === false ? 'Optional · unavailable' : 'Unavailable' }}</strong><span>{{ item.detail }}</span></li></ul></details>
    <ol v-if="data?.projects.length" class="managed-project-list" aria-label="Registered projects"><li v-for="project in data.projects" :key="project.id">
      <h4>{{ project.name || project.id }} <span>{{ managedProjectStatus[project.status] }}</span></h4><p>{{ project.detail }}</p>
      <dl><div><dt>Project ID</dt><dd>{{ project.id }}</dd></div><div><dt>Shared branch</dt><dd>{{ project.branch }}</dd></div><div><dt>Checkout</dt><dd>{{ project.path }}</dd></div><div><dt>Request folder</dt><dd>{{ project.featuresDirectory }} · {{ project.intake === 'local' ? 'local saves' : 'shared Git' }}</dd></div></dl>
      <p v-if="project.status === 'ready'" class="caption">{{ project.intakeEnabled && project.policyApproved === true && !project.intakeBlockedReason ? 'Request intake enabled.' : 'Request intake is held.' }} {{ project.workflow.configured ? 'Project template and workflow found.' : 'Configure the project template and delivery policy before submitting implementation work.' }}</p>
      <p v-if="project.intakeBlockedReason" class="caption" role="status">{{ project.intakeBlockedReason }}</p>
      <p v-if="project.status === 'ready' && (!project.intakeEnabled || project.policyApproved !== true || !!project.intakeBlockedReason)" class="caption">Review <RouterLink to="/settings#delivery-policy">Project delivery policy</RouterLink>, then recheck this project’s setup to enable approved intake.</p>
      <UButton v-if="project.mode === 'clone' && project.status === 'ready' && (!project.workflow.configured || project.policyApproved !== true)" type="button" color="neutral" variant="outline" :disabled="locked" @click="previewSetup(project.id)">Preview project workflow setup</UButton>
      <div v-if="project.status !== 'ready' || !project.intakeEnabled || project.policyApproved !== true || !!project.intakeBlockedReason" class="actions"><UButton type="button" color="neutral" variant="outline" :disabled="locked" @click="recover(project.id, 'reconcile')">{{ project.status === 'ready' ? 'Recheck project setup' : 'Check saved operation' }}</UButton><UButton v-if="project.status === 'needs_attention' && project.mode === 'clone' && !project.attached" type="button" color="neutral" variant="outline" :disabled="locked" @click="recover(project.id, 'retry')">Retry project preparation</UButton></div>
    </li></ol>
    <p v-else-if="data" class="caption">No managed projects yet. Register a repository below to make it available for request intake.</p>
    <section v-if="setupPlan || setupResult || setupError || setupBusy || setupPending" class="setup-preview" aria-labelledby="project-setup-title" :aria-busy="setupBusy"><h4 id="project-setup-title">Project workflow setup</h4><p v-if="setupBusy" role="status">{{ setupPending ? 'Recording the project setup publication…' : 'Reading the exact proposed workflow files…' }}</p><p v-if="setupError" role="alert" class="error-text">{{ setupError }}<template v-if="setupPending"> Reconcile the saved operation before taking another setup action.</template></p>
      <template v-if="setupPlan"><p>Project {{ setupPlan.projectId }} · branch {{ setupPlan.branch }} · provider {{ setupPlan.provider }}. Only missing files are created; existing files are preserved. Setup does not add GitHub integration.</p><p class="caption">Reviewed baseline: <code>{{ setupPlan.baseCommit }}</code></p><ul><li v-for="file in setupPlan.files" :key="file.path"><details><summary>{{ file.status === 'create' ? 'Create' : 'Preserve existing' }} · {{ file.path }}</summary><pre>{{ file.content }}</pre></details></li></ul><template v-if="setupPlan.files.some(file => file.status === 'create')"><label class="check-label"><input v-model="setupApproved" type="checkbox" :disabled="setupBusy || !!setupPending && !setupResumable" /> I approve committing and pushing these missing workflow files to {{ setupPlan.branch }}.</label><UButton type="button" :disabled="!setupApproved || busy || setupBusy || !!pending || !state.unlocked || !!setupPending && !setupResumable" @click="applySetup()">{{ setupResumable ? 'Resume project setup publication' : 'Commit and push project setup' }}</UButton></template><p v-else>No setup files are missing. Review the existing policy and approve its exact committed version.</p><UButton v-if="!setupPending" type="button" color="neutral" variant="ghost" :disabled="setupBusy" @click="setupPlan = null; setupApproved = false">Close setup preview</UButton></template>
      <p v-if="setupResult" role="status">{{ setupResult.detail }}<template v-if="setupResult.commit"> Commit <code>{{ setupResult.commit }}</code>.</template></p><p v-if="setupResult?.status === 'published'">Next, <RouterLink to="/settings#delivery-policy">review and approve the exact project delivery policy</RouterLink>, then recheck project setup. Publication does not grant execution authority.</p><UButton v-if="setupPending && !setupBusy && !setupResumable" type="button" color="neutral" variant="outline" :disabled="!state.unlocked" @click="applySetup(true)">Reconcile project setup publication</UButton>
    </section>
    <details class="registration"><summary>Register a project</summary><form :aria-busy="busy" @submit.prevent="submit"><fieldset :disabled="locked">
      <label for="managed-project-mode">Project source</label><select id="managed-project-mode" v-model="draft.mode"><option value="register">Clone a Git repository</option><option value="adopt">Use an existing checkout</option></select>
      <label for="managed-project-intake">Request intake</label><select id="managed-project-intake" v-model="draft.intake"><option value="shared">Shared Git · commit and push requests</option><option value="local">Local files · observe saved requests</option></select><p class="caption">Shared Git keeps team requests and progress on the project’s shared branch. Local intake uses saves on this worker machine.</p>
      <div class="fields"><div><label for="managed-project-id">Project ID</label><UInput id="managed-project-id" v-model="draft.id" maxlength="40" pattern="[a-z0-9][a-z0-9_\-]*" placeholder="customer-portal" required class="w-full" /></div><div><label for="managed-project-name">Project name · optional</label><UInput id="managed-project-name" v-model="draft.name" maxlength="120" class="w-full" /></div></div>
      <template v-if="draft.mode === 'register'"><label for="managed-project-repository">Git repository URL</label><UInput id="managed-project-repository" v-model="draft.repository" maxlength="4096" placeholder="https://github.com/team/customer-portal.git" required class="w-full" /><p class="caption">Uses the worker account’s Git authentication. Keep credentials out of the URL.</p></template>
      <template v-else><label for="managed-project-path">Absolute checkout directory</label><UInput id="managed-project-path" v-model="draft.path" maxlength="4096" placeholder="C:\Projects\customer-portal" required class="w-full" /><p class="caption">Explicitly connects this checkout. Existing files and requests remain owned by the project.</p></template>
      <div class="fields"><div><label for="managed-project-branch">Shared branch</label><UInput id="managed-project-branch" v-model="draft.branch" maxlength="200" required class="w-full" /></div><div><label for="managed-project-features">Feature Request folder</label><UInput id="managed-project-features" v-model="draft.featuresDirectory" maxlength="1024" required class="w-full" /></div></div>
      <UButton type="submit" :loading="busy" :disabled="!valid">{{ draft.mode === 'register' ? 'Clone and register project' : 'Connect existing project' }}</UButton>
    </fieldset></form></details>
    <p v-if="actionError" class="error-text" role="alert">{{ actionError }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="pending && !busy" class="uncertain" role="status"><p>The acknowledgement is uncertain. Retry the saved operation to recover the same registration.</p><UButton type="button" color="neutral" variant="outline" :loading="busy" :disabled="busy || !state.unlocked" @click="send(pending)">Retry saved operation</UButton></div>
  </section>
</template>
<style scoped>
.setup-preview { border:1px solid var(--ui-border);border-radius:8px;padding:var(--space-4);margin-block:var(--space-4);min-width:0; }.setup-preview ul { list-style:none;padding:0; }.setup-preview pre { white-space:pre-wrap;overflow-wrap:anywhere;font-size:.75rem;line-height:1.6; }.check-label { display:flex;align-items:flex-start;gap:var(--space-3);min-height:44px;line-height:1.65; }.check-label input { flex:0 0 18px;width:18px;height:18px;margin-top:.25rem;accent-color:var(--ui-primary); }
.managed-projects { margin-block: var(--space-6); border-top: 1px solid var(--ui-border); padding-top: var(--space-6); min-width: 0; }
header,.actions { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--space-3); }h3 { margin:0;font-size:1.125rem; }h4 { font-size:1rem;margin:0;overflow-wrap:anywhere; }h4 span { display:block;color:var(--ui-text-muted);font-size:.8125rem;font-weight:400;margin-top:var(--space-2); }
a { color:var(--ui-primary);text-underline-offset:3px; }
p { font-size:.875rem;line-height:1.65;overflow-wrap:anywhere; }.caption,dt { color:var(--ui-text-muted);font-size:.8125rem; }summary { cursor:pointer;min-height:44px;padding-block:var(--space-3);font-size:.875rem; }
.managed-project-list,.diagnostics { list-style:none;padding:0;margin:0; }.managed-project-list li { padding-block:var(--space-6);border-top:1px solid var(--ui-border); }.diagnostics li { display:grid;gap:var(--space-2);padding-block:var(--space-3);font-size:.8125rem; }
dl,.fields { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4); }dd { margin:var(--space-1) 0 0;font-size:.875rem;overflow-wrap:anywhere; }
fieldset { border:0;padding:0;min-width:0; }label { display:block;font-size:.875rem;font-weight:600;margin-block:var(--space-4) var(--space-2); }select { background:var(--ui-bg);color:var(--ui-text);border:1px solid var(--ui-border);border-radius:6px;padding:10px;min-height:44px;max-width:100%;width:100%; }form :deep(button) { margin-top:var(--space-6); }:deep(button),:deep(input) { min-height:44px; }.uncertain { padding-block:var(--space-4); }
@media(max-width:560px) { dl,.fields { grid-template-columns:1fr; } }
</style>
