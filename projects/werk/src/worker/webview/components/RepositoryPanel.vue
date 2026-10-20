<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import { state, date, workspaceAction } from '../store';
import RepositoryDiscovery from './RepositoryDiscovery.vue';

interface RepositoryDraft { id: string; path: string; remote: string; branch: string; watch: boolean; featureDirectory: string; featurePollSeconds: number; }
const entries = ref<RepositoryDraft[]>([]), seconds = ref(30), worktreeDirectory = ref(''), baseline = ref('');
const busy = ref(false), syncing = ref(''), error = ref(''), notice = ref(''), stale = ref(false);
const serialized = () => JSON.stringify({ seconds: seconds.value, worktreeDirectory: worktreeDirectory.value, entries: entries.value });
const dirty = computed(() => baseline.value !== serialized());
const assigned = computed(() => state.settings?.repositories?.items ?? []);
const observed = computed(() => state.environment?.repositories?.items ?? []);
const queued = computed(() => !!state.sessions?.execution.currentSessionId || !!state.sessions?.execution.queued || !!state.status?.activeTasks.length || !!state.status?.queuedTasks?.length || !!state.board?.preparations?.some(item => item.state === 'preparing'));
const editingLocked = computed(() => busy.value || !state.unlocked);
function reload() {
  seconds.value = (state.settings?.repositories?.pollMs ?? 30000) / 1000;
  worktreeDirectory.value = state.settings?.repositories?.worktreeDirectory ?? '';
  entries.value = assigned.value.map(item => ({ ...item, branch: item.branch ?? '', featureDirectory: item.features?.directory ?? '', featurePollSeconds: (item.features?.pollMs ?? 1000) / 1000 }));
  baseline.value = serialized(); stale.value = false; error.value = ''; notice.value = '';
}
watch(() => JSON.stringify(state.settings?.repositories), (value, previous) => {
  if (!state.unlocked) { entries.value = []; worktreeDirectory.value = ''; baseline.value = serialized(); return; }
  if (value === previous) return;
  if (!baseline.value || !dirty.value) reload();
  else stale.value = true;
}, { immediate: true });
watch(() => state.unlocked, unlocked => { if (!unlocked) { entries.value = []; seconds.value = 30; worktreeDirectory.value = ''; baseline.value = serialized(); stale.value = false; error.value = ''; notice.value = ''; } });
async function add() {
  entries.value.push({ id: '', path: '', remote: 'origin', branch: '', watch: true, featureDirectory: '', featurePollSeconds: 1 });
  await nextTick(); document.getElementById(`repository-id-${entries.value.length - 1}`)?.focus();
}
async function save() {
  if (editingLocked.value || queued.value || stale.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  const epoch = state.draftEpoch;
  const repositories = { pollMs: Number(seconds.value) * 1000, ...(worktreeDirectory.value.trim() ? { worktreeDirectory: worktreeDirectory.value.trim() } : {}), items: entries.value.map(item => ({ id: item.id.trim(), path: item.path.trim(), remote: item.remote.trim(), watch: item.watch, ...(item.featureDirectory.trim() ? { features: { directory: item.featureDirectory.trim(), pollMs: Number(item.featurePollSeconds) * 1000 } } : {}), ...(item.branch.trim() ? { branch: item.branch.trim() } : {}) })) };
  try {
    const result = await workspaceAction('/api/settings', { repositories });
    if (!state.unlocked || state.draftEpoch !== epoch) return;
    if (result) { reload(); notice.value = 'Repository assignments saved. Watchers use these settings now.'; }
    else error.value = state.actionError || 'Assignments could not be saved. Your edits are retained.';
  } finally { busy.value = false; }
}
async function sync(id: string) {
  if (syncing.value || !state.unlocked) return;
  syncing.value = id; error.value = ''; notice.value = '';
  const epoch = state.draftEpoch;
  try {
    const result = await workspaceAction('/api/repositories', { action: 'sync', id });
    if (!state.unlocked || state.draftEpoch !== epoch) return;
    if (result) notice.value = 'Repository check completed. Review its status below.';
    else error.value = state.actionError || 'The repository could not be checked. Try again.';
  } finally { syncing.value = ''; }
}
const statusLabel = (value?: string) => ({ pending: 'Waiting for first check', syncing: 'Checking remote', ready: 'Up to date', behind: 'Remote advanced · checkout preserved', dirty: 'Local changes · pull skipped', ahead: 'Local commits · pull skipped', diverged: 'Branches diverged · pull skipped', error: 'Check failed' }[value ?? ''] ?? 'Status unavailable');
</script>

<template>
  <section class="monitor-section repository-panel" aria-labelledby="repositories-title">
    <h2 id="repositories-title">Git repositories</h2>
    <p class="page-note">Assign existing checkouts on the worker machine. Watched repositories are fetched and pulled when a fast-forward is safe. Shared intake preserves its developer checkout. File tasks run in isolated Git worktrees.</p>
    <RepositoryDiscovery reconsider />
    <ul v-if="assigned.length" class="repository-list">
      <li v-for="item in assigned" :key="item.id">
        <div class="section-heading"><h3 class="break-anywhere">{{ item.id }}</h3><UButton type="button" color="neutral" variant="outline" :loading="syncing === item.id" :disabled="!!syncing || busy || !state.unlocked" @click="sync(item.id)">{{ observed.find(row => row.id === item.id)?.checkoutPreserved ? 'Check remote' : 'Check & pull' }}</UButton></div>
        <p class="break-anywhere">{{ item.path }}</p>
        <p v-if="observed.find(row => row.id === item.id)?.checkoutPreserved" class="page-note">Shared intake checks fetch the remote and leave this checkout unchanged.</p>
        <p>{{ statusLabel(observed.find(row => row.id === item.id)?.state) }}</p>
        <p class="page-note">{{ item.watch ? 'Watching' : 'Automatic checks paused' }} · {{ item.remote }} / {{ item.branch || 'current branch' }} · Last checked {{ date(observed.find(row => row.id === item.id)?.lastCheckedAt) }}</p>
        <p v-if="item.features" class="page-note">Local Feature Requests: {{ item.features.directory }} · every {{ item.features.pollMs / 1000 }} seconds</p>
        <p v-if="observed.find(row => row.id === item.id)?.error" class="error-text break-anywhere">{{ observed.find(row => row.id === item.id)?.error }}</p>
      </li>
    </ul>
    <p v-else class="page-note">No repositories assigned. Add a checkout below to watch it and select it for file tasks.</p>
    <details class="repository-editor">
      <summary>Manage repository assignments</summary>
      <form class="settings-form" :aria-busy="busy" @submit.prevent="save">
        <fieldset :disabled="editingLocked" class="contents">
          <p class="page-note">A repository ID identifies this project in tasks. Use the configured remote name, such as origin; leave the branch blank to follow the checkout’s current branch.</p>
          <label for="repository-poll-seconds">Check watched repositories every · seconds</label>
          <UInput id="repository-poll-seconds" v-model="seconds" type="number" min="1" max="3600" step="1" required class="w-full" />
          <label for="repository-worktree-directory">Task worktree folder · optional</label>
          <UInput id="repository-worktree-directory" v-model="worktreeDirectory" maxlength="1024" placeholder="Inside each checkout: .werk/worktrees" class="w-full" />
          <p class="page-note">An absolute folder outside every checkout keeps project tools from scanning task copies. Use a short path on Windows. Existing task worktrees stay where they are.</p>
          <fieldset v-for="(item, index) in entries" :key="index" class="repository-fields">
            <legend>Repository {{ index + 1 }}</legend>
            <label :for="`repository-id-${index}`">Repository ID</label><UInput :id="`repository-id-${index}`" v-model="item.id" pattern="[A-Za-z0-9_\-]+" maxlength="100" required placeholder="web-app" class="w-full" />
            <label :for="`repository-path-${index}`">Absolute checkout directory</label><UInput :id="`repository-path-${index}`" v-model="item.path" maxlength="4096" required placeholder="/home/you/web-app" class="w-full" />
            <label :for="`repository-remote-${index}`">Remote name</label><UInput :id="`repository-remote-${index}`" v-model="item.remote" maxlength="100" required class="w-full" />
            <label :for="`repository-branch-${index}`">Branch · optional</label><UInput :id="`repository-branch-${index}`" v-model="item.branch" maxlength="200" placeholder="Current branch" class="w-full" />
            <label :for="`repository-features-${index}`">Local Feature Request folder · optional</label><UInput :id="`repository-features-${index}`" v-model="item.featureDirectory" maxlength="1024" placeholder="feature-requests" class="w-full" /><p class="page-note">Relative to this repository. Markdown requests use this project’s policy and isolated worktrees. Leave empty to disable this additional local intake.</p><label v-if="item.featureDirectory.trim()" :for="`repository-feature-poll-${index}`">Check Feature Requests every · seconds</label><UInput v-if="item.featureDirectory.trim()" :id="`repository-feature-poll-${index}`" v-model="item.featurePollSeconds" type="number" min="1" max="300" step="1" required />
            <label class="check-label"><input v-model="item.watch" type="checkbox" /> Watch and pull this repository</label>
            <UButton type="button" color="neutral" variant="outline" :aria-label="`Remove repository ${item.id || index + 1}`" @click="entries.splice(index, 1)">Remove assignment</UButton>
          </fieldset>
          <div class="actions"><UButton type="button" color="neutral" variant="outline" :disabled="entries.length >= 64" @click="add">Add repository</UButton><UButton type="submit" :loading="busy" :disabled="!dirty || stale || queued">Save assignments</UButton><UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="reload">Reload saved assignments</UButton></div>
        </fieldset>
        <p v-if="queued" class="page-note">Finish or stop queued and running tasks before saving repository assignments.</p>
        <p v-if="stale" role="status" class="page-note">Saved assignments changed while you were editing. Reload saved assignments before saving again.</p>
      </form>
    </details>
    <p v-if="error" role="alert" class="error-text">{{ error }}</p><p v-if="notice" role="status" class="page-note">{{ notice }}</p>
  </section>
</template>

<style scoped>
.repository-list { list-style: none; margin: var(--space-4) 0; padding: 0; }
.repository-list > li { padding: var(--space-4) 0; border-top: 1px solid var(--color-border, #3b4b56); }
.repository-list h3 { margin: 0; }
.repository-list p { margin: var(--space-2) 0; }
.repository-editor summary { cursor: pointer; padding: var(--space-3) 0; }
.repository-fields { display: grid; gap: var(--space-2); margin: var(--space-4) 0; padding: var(--space-4) 0; min-width: 0; border: 0; border-top: 1px solid var(--color-border, #3b4b56); }
.repository-fields legend { font-weight: 600; padding-right: var(--space-2); }
.repository-fields label:not(.check-label) { margin-top: var(--space-2); }
.repository-fields button { justify-self: start; }
</style>
