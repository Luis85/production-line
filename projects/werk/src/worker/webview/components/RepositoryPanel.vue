<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import { state, date, workspaceAction } from '../store';

interface RepositoryDraft { id: string; path: string; remote: string; branch: string; watch: boolean; }
const entries = ref<RepositoryDraft[]>([]), seconds = ref(30), baseline = ref('');
const busy = ref(false), syncing = ref(''), error = ref(''), notice = ref(''), stale = ref(false);
const serialized = () => JSON.stringify({ seconds: seconds.value, entries: entries.value });
const dirty = computed(() => baseline.value !== serialized());
const assigned = computed(() => state.settings?.repositories?.items ?? []);
const observed = computed(() => state.environment?.repositories?.items ?? []);
const queued = computed(() => !!state.sessions?.execution.currentSessionId || !!state.sessions?.execution.queued || !!state.status?.activeTasks.length || !!state.status?.queuedTasks?.length);
const editingLocked = computed(() => busy.value || !state.unlocked);
function reload() {
  seconds.value = (state.settings?.repositories?.pollMs ?? 30000) / 1000;
  entries.value = assigned.value.map(item => ({ ...item, branch: item.branch ?? '' }));
  baseline.value = serialized(); stale.value = false; error.value = ''; notice.value = '';
}
watch(() => JSON.stringify(state.settings?.repositories), (value, previous) => {
  if (!state.unlocked) { entries.value = []; baseline.value = serialized(); return; }
  if (value === previous) return;
  if (!baseline.value || !dirty.value) reload();
  else stale.value = true;
}, { immediate: true });
watch(() => state.unlocked, unlocked => { if (!unlocked) { entries.value = []; seconds.value = 30; baseline.value = serialized(); stale.value = false; error.value = ''; notice.value = ''; } });
async function add() {
  entries.value.push({ id: '', path: '', remote: 'origin', branch: '', watch: true });
  await nextTick(); document.getElementById(`repository-id-${entries.value.length - 1}`)?.focus();
}
async function save() {
  if (editingLocked.value || queued.value || stale.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  const epoch = state.draftEpoch;
  const repositories = { pollMs: Number(seconds.value) * 1000, items: entries.value.map(item => ({ id: item.id.trim(), path: item.path.trim(), remote: item.remote.trim(), watch: item.watch, ...(item.branch.trim() ? { branch: item.branch.trim() } : {}) })) };
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
const statusLabel = (value?: string) => ({ pending: 'Waiting for first check', syncing: 'Checking remote', ready: 'Up to date', dirty: 'Local changes · pull skipped', ahead: 'Local commits · pull skipped', diverged: 'Branches diverged · pull skipped', error: 'Check failed' }[value ?? ''] ?? 'Status unavailable');
</script>

<template>
  <section class="monitor-section repository-panel" aria-labelledby="repositories-title">
    <h2 id="repositories-title">Git repositories</h2>
    <p class="page-note">Assign existing checkouts on the worker machine. Watched repositories are fetched and pulled when a fast-forward is safe. File tasks run in isolated Git worktrees.</p>
    <ul v-if="assigned.length" class="repository-list">
      <li v-for="item in assigned" :key="item.id">
        <div class="section-heading"><h3 class="break-anywhere">{{ item.id }}</h3><UButton type="button" color="neutral" variant="outline" :loading="syncing === item.id" :disabled="!!syncing || busy || !state.unlocked" @click="sync(item.id)">Check &amp; pull</UButton></div>
        <p class="break-anywhere">{{ item.path }}</p>
        <p>{{ statusLabel(observed.find(row => row.id === item.id)?.state) }}</p>
        <p class="page-note">{{ item.watch ? 'Watching' : 'Automatic checks paused' }} · {{ item.remote }} / {{ item.branch || 'current branch' }} · Last checked {{ date(observed.find(row => row.id === item.id)?.lastCheckedAt) }}</p>
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
          <fieldset v-for="(item, index) in entries" :key="index" class="repository-fields">
            <legend>Repository {{ index + 1 }}</legend>
            <label :for="`repository-id-${index}`">Repository ID</label><UInput :id="`repository-id-${index}`" v-model="item.id" pattern="[A-Za-z0-9_\-]+" maxlength="100" required placeholder="web-app" class="w-full" />
            <label :for="`repository-path-${index}`">Absolute checkout directory</label><UInput :id="`repository-path-${index}`" v-model="item.path" maxlength="4096" required placeholder="/home/you/web-app" class="w-full" />
            <label :for="`repository-remote-${index}`">Remote name</label><UInput :id="`repository-remote-${index}`" v-model="item.remote" maxlength="100" required class="w-full" />
            <label :for="`repository-branch-${index}`">Branch · optional</label><UInput :id="`repository-branch-${index}`" v-model="item.branch" maxlength="200" placeholder="Current branch" class="w-full" />
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
