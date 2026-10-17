<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import MessageContent from './MessageContent.vue';
import type { SharedFeatureView } from '../../application/shared-intake-contract';
import { createSharedIntakeEditor } from '../shared-intake-editor';
import { date, request, state } from '../store';
const editor = createSharedIntakeEditor({ unlocked: () => state.unlocked, epoch: () => state.draftEpoch, repositories: () => state.settings?.repositories.items ?? [], read: () => request('/api/shared-intake'), write: command => request('/api/shared-intake', 'POST', command), note: id => request('/api/shared-intake', 'POST', { action: 'note', id }) });
const { view, draft, dirty, stale, busy, validation, canSave, canSync, canClear, clearBlockedReason } = editor;
const search = ref(''), filter = ref('all'), selectedId = ref('');
let active = true, trigger: HTMLElement | null = null;
const repositories = computed(() => (state.settings?.repositories.items ?? []).map(item => ({ label: item.id + ' · ' + item.path, value: item.id })));
const seconds = computed({ get: () => draft.config.pollMs / 1000, set: (value: number | string) => { draft.config.pollMs = Number(value) * 1000; } });
const selected = computed(() => view.value?.requests.find(item => item.id === selectedId.value));
const needsAttention = (item: SharedFeatureView) => item.ready?.passed === false || item.done?.passed === false || item.publication === 'error' || !!item.error;
const requests = computed(() => (view.value?.requests ?? []).filter(item => (filter.value === 'all' || filter.value === 'local' && item.isLocal || filter.value === 'attention' && needsAttention(item)) && [item.title, item.name, item.id, item.owner, item.status].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())));
const phase = (value: string) => ({ draft: 'Draft', ready: 'Ready for intake', readiness: 'Checking readiness', queued: 'Queued', running: 'Running', waiting_input: 'Waiting for an answer', needs_rework: 'Needs rework', review: 'Human review required', ready_for_review: 'Human review required', done: 'Done checks passed', completed: 'Execution completed', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', claimed: 'Claimed', unclaimed: 'Unclaimed', escalated: 'Decision needed' }[value] ?? value.replaceAll('_', ' '));
const owner = (item: SharedFeatureView) => item.isLocal ? 'This worker · ' + (item.owner || view.value?.workerId || 'owner recorded locally') : item.owner ? 'Worker · ' + item.owner : 'Unclaimed';
const publication = (item: SharedFeatureView) => item.publication === 'synced' ? 'Published to Git' : item.publication === 'error' ? 'Git publication failed' : 'Publication pending';
const gate = (value: SharedFeatureView['ready']) => value === null ? 'Not checked' : value.passed ? 'Passed' : 'Needs attention';
async function inspect(id: string, event: MouseEvent) { trigger = event.currentTarget as HTMLElement; selectedId.value = id; editor.closeNote(); await nextTick(); document.getElementById('shared-request-detail-title')?.focus(); }
async function closeDetail() { selectedId.value = ''; editor.closeNote(); await nextTick(); if (trigger?.isConnected) trigger.focus(); }
async function refresh() { if (active && state.unlocked) await editor.load({ background: true }); }
onMounted(() => { void refresh(); });
onActivated(() => { active = true; void refresh(); });
onDeactivated(() => { active = false; });
onBeforeUnmount(editor.dispose);
watch(() => state.refreshRevision, () => { void refresh(); });
watch(() => state.unlocked, unlocked => { if (unlocked) void refresh(); else selectedId.value = ''; });
watch(() => state.draftEpoch, () => { search.value = ''; filter.value = 'all'; selectedId.value = ''; });
watch(() => selected.value?.reviewNote, (next, previous) => { if (next !== previous) editor.closeNote(); });
</script>
<template>
  <section class="shared-intake-panel" aria-labelledby="shared-intake-title" :aria-busy="draft.loading && !view">
    <div class="section-heading"><div><h2 id="shared-intake-title">Connect shared requests</h2><p class="page-note">Read requests from a shared Git repository. Owning workers automatically publish lifecycle and review notes; a person reviews feature branches before merge.</p></div><UButton color="neutral" variant="outline" :loading="draft.loading" :disabled="busy || !state.unlocked" @click="editor.load()">Refresh shared intake</UButton></div>
    <p v-if="draft.loading && !view" role="status">Reading the saved shared intake connection…</p>
    <p v-if="draft.error" role="alert" class="error-text">{{ draft.error }}</p>
    <p v-if="draft.notice" role="status" class="page-note">{{ draft.notice }}</p>
    <template v-if="view">
      <div class="shared-intake-status"><UBadge :color="view.state === 'error' ? 'error' : view.state === 'syncing' ? 'primary' : 'neutral'" variant="subtle">{{ view.state === 'disabled' ? view.config.repositoryId ? 'New intake paused' : 'Not connected' : view.state === 'syncing' ? 'Synchronizing' : view.state === 'error' ? 'Check failed' : 'Watching shared requests' }}</UBadge><span>Last synchronized {{ date(view.lastSyncedAt) }}</span></div>
      <p v-if="view.error" role="alert" class="error-text">{{ view.error }} Previously observed requests may be stale. Sync again to retry.</p>
      <details class="shared-intake-connection" :open="!view.config.enabled">
        <summary>Shared repository connection{{ dirty ? ' · unsaved changes' : '' }}</summary>
        <p class="page-note">Prepare the shared workflow kit in your repository with <code>node bin/apps/worker/cli.mjs feature setup</code>, then commit and push it before connecting this worker.</p>
        <form @submit.prevent="editor.save" class="shared-intake-form">
          <fieldset :disabled="draft.saving || draft.syncing || !!draft.uncertain || !state.unlocked">
            <label class="shared-intake-check"><input v-model="draft.config.enabled" type="checkbox" />Accept new shared requests</label>
            <p class="page-note">Accepting new requests grants this worker permission to claim work and publish its lifecycle, review notes and feature branch. Turning intake off stops new claims; owned work and its pending Git updates continue.</p>
            <p v-if="!repositories.length" class="page-note">Assign a Git repository in the section above before enabling shared intake.</p>
            <label for="shared-intake-repository">Assigned repository</label><USelect id="shared-intake-repository" v-model="draft.config.repositoryId" :items="repositories" placeholder="Choose a repository" class="w-full" :disabled="!repositories.length" />
            <div class="shared-intake-fields"><div><label for="shared-intake-remote">Remote name</label><UInput id="shared-intake-remote" v-model="draft.config.remote" maxlength="100" class="w-full" :required="draft.config.enabled" /></div><div><label for="shared-intake-branch">Shared branch</label><UInput id="shared-intake-branch" v-model="draft.config.branch" maxlength="200" class="w-full" :required="draft.config.enabled" /></div></div>
            <label for="shared-intake-workflow">Workflow file · relative to repository</label><UInput id="shared-intake-workflow" v-model="draft.config.workflowPath" maxlength="4096" class="w-full" :required="draft.config.enabled" />
            <label for="shared-intake-interval">Check shared requests every · seconds</label><UInput id="shared-intake-interval" v-model="seconds" type="number" min="1" max="300" step="1" class="w-full" :required="draft.config.enabled" />
            <p class="page-note">This saves the worker’s connection. Edit shared folders and ready/done JSON checks in the checked-in workflow files, then commit and push those changes.</p>
            <p v-if="validation && dirty" class="error-text" role="status">{{ validation }}</p>
            <div class="actions"><UButton type="submit" :loading="draft.saving" :disabled="!canSave">Save shared intake connection</UButton><UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="editor.reloadSaved">Reload saved connection</UButton></div>
          </fieldset>
          <div v-if="view.config.repositoryId" class="shared-clear-connection">
            <p class="page-note">Clearing this connection resumes the local feature-request intake when new starts resume. Existing local ready files may enter the queue. The repository assignment and published Git history are kept.</p>
            <UButton type="button" color="neutral" variant="outline" :disabled="!canClear" @click="editor.clearConnection">Clear shared connection</UButton>
            <p v-if="clearBlockedReason && draft.config.repositoryId" role="status" class="page-note">{{ clearBlockedReason }}</p>
          </div>
          <p v-if="!view.canEdit" role="status" class="page-note">{{ view.blockedReason || 'Pause new starts and finish or stop queued and running work before changing shared intake.' }}</p>
          <p v-if="stale" role="status" class="page-note">Saved settings changed while you were editing. Your draft is retained. Refresh, then reload the saved connection before saving again.</p>
          <p v-if="draft.uncertain" role="status" class="page-note">The save response was not confirmed. Refresh shared intake to compare the saved connection with your draft before continuing.</p>
        </form>
      </details>
      <template v-if="view.config.enabled || view.requests.length">
        <div class="shared-intake-sync"><p class="page-note break-anywhere">{{ view.config.repositoryId }} · {{ view.config.remote }} / {{ view.config.branch }}<br>Source commit {{ view.sourceCommit || 'not observed yet' }}</p><UButton color="neutral" variant="outline" :loading="draft.syncing" :disabled="!canSync" @click="editor.sync">Sync shared requests</UButton></div>
        <p class="page-note">Sync uses the saved connection and can publish lifecycle and review updates. Feature branches still require human review before merge.</p>
        <details v-if="view.workflow" class="shared-workflow-paths"><summary>Shared workflow files &amp; checks</summary><dl><div><dt>Requests folder</dt><dd>{{ view.workflow.requestsDirectory }}</dd></div><div><dt>Review notes folder</dt><dd>{{ view.workflow.reviewDirectory }}</dd></div><div><dt>Draft template</dt><dd>{{ view.workflow.template }}</dd></div><div><dt>Obsidian Base</dt><dd>{{ view.workflow.base }}</dd></div><div><dt>Ready checks</dt><dd>{{ view.workflow.readyCheck }}<small>Digest {{ view.workflow.readyDigest }}</small></dd></div><div><dt>Done checks</dt><dd>{{ view.workflow.doneCheck }}<small>Digest {{ view.workflow.doneDigest }}</small></dd></div></dl></details>
        <div class="shared-request-filters"><div><label for="shared-request-search">Find a shared request</label><UInput id="shared-request-search" v-model="search" placeholder="Title, file, worker or state" class="w-full" /></div><div><label for="shared-request-filter">Show requests</label><USelect id="shared-request-filter" v-model="filter" :items="[{ label: 'All requests', value: 'all' }, { label: 'Needs attention', value: 'attention' }, { label: 'Owned by this worker', value: 'local' }]" class="w-full" /></div></div>
        <p v-if="!requests.length" class="page-note">{{ view.requests.length ? 'No shared requests match these filters.' : view.lastSyncedAt ? 'No shared requests were found. Add a Markdown request using the checked-in template, then commit and push it.' : 'No shared requests have been observed yet. Sync the saved connection to read the workflow.' }}</p>
        <ul v-else class="shared-request-list"><li v-for="item in requests" :key="item.id"><div><strong>{{ item.title || item.name }}</strong><span>{{ item.name }}</span><span>{{ owner(item) }}</span><span>{{ phase(item.status) }} · {{ publication(item) }}</span><span class="page-note">Ready: {{ gate(item.ready) }} · Done: {{ gate(item.done) }}</span></div><UButton color="neutral" variant="outline" :aria-label="'Inspect shared request ' + (item.title || item.name)" @click="inspect(item.id, $event)">Inspect request</UButton></li></ul>
        <section v-if="selected" class="shared-request-detail" aria-labelledby="shared-request-detail-title" @keydown.esc.prevent="closeDetail">
          <div class="section-heading"><h3 id="shared-request-detail-title" tabindex="-1">{{ selected.title || selected.name }}</h3><UButton color="neutral" variant="ghost" @click="closeDetail">Close request</UButton></div>
          <p>{{ owner(selected) }} · {{ phase(selected.status) }}</p><p class="page-note">Updated {{ date(selected.updatedAt) }} · {{ publication(selected) }}</p>
          <p v-if="!selected.isLocal && selected.owner" class="page-note">Another worker owns this request. Its shared progress and review notes are read-only here.</p>
          <p v-if="selected.publication !== 'synced'" class="page-note">{{ selected.isLocal ? 'Local progress is retained. Shared updates are not yet confirmed in Git.' : 'The latest shared updates have not been confirmed as published.' }}</p>
          <p v-if="selected.error" role="alert" class="error-text">{{ selected.error }}</p>
          <div class="shared-gate-results"><section v-for="stage in ['ready', 'done'] as const" :key="stage"><h4>{{ stage === 'ready' ? 'Ready checks' : 'Done checks' }} · {{ gate(selected[stage]) }}</h4><ul v-if="selected[stage]?.issues.length"><li v-for="(issue, index) in selected[stage]!.issues" :key="index">{{ issue }}</li></ul><p v-else class="page-note">{{ selected[stage] === null ? 'No check result has been published.' : selected[stage]?.passed ? 'The recorded checks passed.' : 'Inspect the review note for the recorded findings.' }}</p></section></div>
          <dl class="shared-request-facts"><div><dt>Request</dt><dd>{{ selected.id }}</dd></div><div><dt>Source commit</dt><dd>{{ selected.sourceCommit }}</dd></div><div v-if="selected.featureBranch"><dt>Feature branch</dt><dd>{{ selected.featureBranch }}</dd></div><div v-if="selected.reviewNote"><dt>Review note</dt><dd>{{ selected.reviewNote }}</dd></div><div v-if="selected.taskId"><dt>Local task</dt><dd>{{ selected.taskId }}</dd></div></dl>
          <div class="actions"><UButton v-if="selected.isLocal && selected.taskId" to="/taskboard" color="neutral" variant="outline">Open taskboard</UButton><UButton v-if="selected.reviewNote" color="neutral" variant="outline" :loading="draft.noteLoading" @click="editor.openNote(selected.id)">Read review note</UButton></div>
          <p class="page-note">Execution completion, passing checks and Git publication are separate from human review and merge.</p>
          <p v-if="draft.noteError" role="alert" class="error-text">{{ draft.noteError }} Select Read review note to retry.</p>
          <div v-if="draft.note && draft.noteId === selected.id" class="shared-review-note"><h4>Review note</h4><p class="page-note break-anywhere">{{ draft.note.path }}</p><MessageContent :text="draft.note.markdown" /></div>
        </section>
      </template>
    </template>
  </section>
</template>
<style scoped>
.shared-intake-panel { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; padding-top: 24px; }
.shared-intake-panel h2 { margin: 0 0 8px; font-size: 1.125rem; }.shared-intake-panel h3 { margin: 0; font-size: 1rem; }.shared-intake-panel h4 { margin: 0 0 10px; font-size: .875rem; font-weight: 650; }
.shared-intake-panel p { margin: 0; max-width: 75ch; }.shared-intake-panel .section-heading { align-items: flex-start; }
.shared-intake-panel summary { min-height: 44px; padding-block: 12px; cursor: pointer; font-weight: 600; }
.shared-intake-panel label { display: block; font-weight: 600; font-size: .875rem; margin-bottom: 8px; }
.shared-intake-panel .shared-intake-check { display: flex; align-items: center; gap: 12px; min-height: 44px; margin: 0; line-height: 1.5; }
.shared-intake-check input { width: 20px; height: 20px; flex: 0 0 20px; accent-color: #8be0b8; }
.shared-intake-status { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: .8125rem; color: var(--ui-text-muted); }
.shared-clear-connection { display: grid; justify-items: start; gap: 12px; border-top: 1px solid var(--ui-border); padding-top: 16px; }.shared-intake-connection { min-width: 0; }.shared-intake-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 20px; min-width: 0; }.shared-intake-form fieldset { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; border: 0; padding: 0; margin: 0; min-width: 0; }.shared-intake-form :deep(#shared-intake-repository) { min-width: 0; }
.shared-intake-fields, .shared-request-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }.shared-request-filters { margin-top: 12px; }.shared-intake-fields > div, .shared-request-filters > div { min-width: 0; }
.shared-intake-sync { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; border-top: 1px solid var(--ui-border); padding-top: 20px; }
.shared-workflow-paths dl, .shared-request-facts { margin: 10px 0; display: grid; gap: 14px; }.shared-workflow-paths dl > div, .shared-request-facts > div { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 16px; }
.shared-intake-panel dt { font-weight: 600; font-size: .8125rem; }.shared-intake-panel dd { margin: 0; font-size: .8125rem; overflow-wrap: anywhere; }.shared-intake-panel dd small { display: block; margin-top: 5px; color: var(--ui-text-muted); }
.shared-request-list { list-style: none; padding: 0; margin: 0; }.shared-request-list > li { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 20px 0; border-top: 1px solid var(--ui-border); }.shared-request-list > li > div { display: grid; gap: 6px; min-width: 0; }.shared-request-list span { font-size: .8125rem; }.shared-request-list strong, .shared-request-list span { overflow-wrap: anywhere; }.shared-request-list button { flex-shrink: 0; }
.shared-request-detail { display: grid; gap: 16px; border-top: 1px solid var(--ui-border-accented); padding-top: 24px; min-width: 0; }.shared-request-detail h3 { overflow-wrap: anywhere; }
.shared-gate-results { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding-block: 8px; }.shared-gate-results section { min-width: 0; }.shared-gate-results ul { list-style: disc; margin: 0; padding-left: 20px; font-size: .8125rem; }.shared-gate-results li { margin-bottom: 8px; overflow-wrap: anywhere; }
.shared-review-note { border-top: 1px solid var(--ui-border); padding-top: 20px; min-width: 0; }.shared-review-note > p { margin-bottom: 16px; }
.shared-intake-panel .error-text { overflow-wrap: anywhere; }.shared-intake-panel code { overflow-wrap: anywhere; }
@media (max-width: 600px) { .shared-intake-fields, .shared-request-filters, .shared-gate-results { grid-template-columns: 1fr; }.shared-request-list > li { align-items: flex-start; flex-direction: column; gap: 12px; }.shared-workflow-paths dl > div, .shared-request-facts > div { grid-template-columns: 1fr; gap: 5px; }.shared-intake-panel .section-heading { flex-wrap: wrap; } }
</style>
