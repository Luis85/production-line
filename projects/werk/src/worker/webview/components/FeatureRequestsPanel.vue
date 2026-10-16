<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import type { FeatureRequests, FeatureRecord } from '../../application/feature-requests';
import { state, request, workspaceAction } from '../store';
const props = defineProps<{ compact?: boolean }>();
const route = useRoute(), router = useRouter();
type FeatureList = Awaited<ReturnType<FeatureRequests['list']>>;
const folder = ref<FeatureList | { enabled: false } | null>(null), loading = ref(false), error = ref(''), search = ref('');
const detail = ref<{ name: string; markdown: string; revision: string; record: FeatureRecord | null } | null>(null);
const active = ref(true);
let revision = 0, detailRevision = 0, trigger: HTMLElement | null = null;
const files = computed(() => folder.value && 'files' in folder.value ? folder.value.files.filter(file => [file.name, file.title, file.status].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())) : []);
const statusLabel = (value?: string) => value === 'waiting_input' ? 'Waiting for your answer' : value === 'escalated' ? 'Decision needed' : value === 'draft' ? 'Draft · not queued' : value === 'waiting' ? 'Waiting for admission' : value === 'ready' ? 'Ready for intake' : value ?? 'Status unavailable';
async function load() {
  if (!active.value || !state.unlocked || loading.value) return;
  const current = ++revision; loading.value = true; error.value = '';
  try { const result = await request('/api/features'); if (current === revision && state.unlocked) folder.value = result; }
  catch (failure) { if (current === revision && state.unlocked) error.value = (failure as Error).message; }
  finally { if (current === revision) loading.value = false; }
}
async function inspect(name: string, event: MouseEvent) {
  const current = ++detailRevision; trigger = event.currentTarget as HTMLElement; error.value = '';
  try { const result = await request('/api/features', 'POST', { action: 'get', name }); if (current !== detailRevision || !state.unlocked) return; detail.value = result; await nextTick(); document.getElementById('feature-detail-title')?.focus(); }
  catch (failure) { if (current === detailRevision && state.unlocked) error.value = (failure as Error).message; }
}
async function refreshSelected() {
  const name = detail.value?.name, current = detailRevision; if (!name || !active.value || !state.unlocked) return;
  try { const result = await request('/api/features', 'POST', { action: 'get', name }); if (current === detailRevision && detail.value?.name === name && active.value && state.unlocked) detail.value = result; }
  catch (failure) { if (current === detailRevision && active.value && state.unlocked) error.value = (failure as Error).message; }
}
async function closeDetail() { detailRevision++; detail.value = null; await nextTick(); trigger?.isConnected && trigger.focus(); }
async function openConversation() { const sessionId = detail.value?.record?.sessionId; if (!sessionId) return; if (await workspaceAction('/api/sessions', { action: 'select', id: sessionId })) await router.push({ path: '/taskboard', query: { session: sessionId } }); else error.value = state.actionError || 'The task conversation could not be opened.'; }
async function entry() { await load(); if (!props.compact && route.query.view === 'features') { await nextTick(); document.getElementById('project-requests-title')?.focus(); } }
onMounted(() => { void entry(); }); onActivated(() => { active.value = true; void entry(); });
onDeactivated(() => { active.value = false; revision++; detailRevision++; loading.value = false; });
watch(() => state.refreshRevision, () => { if (active.value && state.unlocked) { if (!loading.value) void load(); void refreshSelected(); } });
watch(() => route.query.view, () => { if (route.path === '/history') void entry(); });
watch(() => state.unlocked, unlocked => { if (unlocked) void entry(); else { revision++; detailRevision++; folder.value = null; detail.value = null; loading.value = false; error.value = ''; } });
</script>
<template>
<section class="monitor-section feature-requests" aria-labelledby="project-requests-title">
  <div class="section-heading"><div><h2 id="project-requests-title" tabindex="-1">Project requests</h2><p class="page-note">Markdown files in this project’s feature folder.</p></div><UButton v-if="compact" to="/history?view=features" color="neutral" variant="outline">Browse requests</UButton><UButton v-else color="neutral" variant="outline" :loading="loading" @click="load">Refresh requests</UButton></div>
  <p v-if="error" role="alert" class="error-text">{{ error }} Previously loaded requests may be stale. Refresh to retry.</p><p v-if="loading && !folder" role="status">Reading the feature folder…</p>
  <template v-if="folder?.enabled"><p class="break-anywhere"><strong>Feature folder</strong><br>{{ folder.directory }}</p><p class="page-note">{{ folder.files.length }} request files · {{ folder.records.length }} accepted requests. Drafts do not run. Set a reviewed request to <code>status: ready</code> to admit it to this worker’s shared queue.</p><p v-if="folder.error" role="alert" class="error-text">{{ folder.error }}</p><ul v-if="folder.errors.length" class="feature-errors"><li v-for="issue in folder.errors" :key="issue.file">{{ issue.file }} · {{ issue.message }}</li></ul>
    <template v-if="!compact"><label for="feature-search">Find a project request</label><UInput id="feature-search" v-model="search" placeholder="Filename, title or state" class="w-full" /><p v-if="!files.length" class="board-empty">{{ folder.files.length ? 'No project requests match your search.' : 'Copy the feature-request template into this folder to start a draft.' }}</p><ul class="run-list"><li v-for="file in files" :key="file.name"><div><strong>{{ file.title || file.name }}</strong><span class="muted">{{ file.name }} · {{ file.mode || 'Mode unavailable' }} · {{ file.provider || 'Provider unavailable' }}</span><span>{{ statusLabel(file.status) }}{{ file.archived ? ' · archived' : '' }}</span><p v-if="file.error" class="error-text">{{ file.error }}</p></div><UButton color="neutral" variant="outline" :aria-label="'Inspect request ' + file.name" @click="inspect(file.name, $event)">Inspect request</UButton></li></ul>
      <section v-if="detail" class="evidence-panel" @keydown.esc.prevent="closeDetail"><div class="section-heading"><h3 id="feature-detail-title" tabindex="-1">{{ detail.name }}</h3><UButton color="neutral" variant="ghost" aria-label="Close project request" @click="closeDetail">Close</UButton></div><p>{{ statusLabel(detail.record?.status ?? files.find(file => file.name === detail?.name)?.status) }}</p><p v-if="detail.record?.error" role="alert" class="error-text">{{ detail.record.error }}</p><div v-if="detail.record" class="actions"><UButton color="neutral" variant="outline" @click="openConversation">Open task conversation</UButton><UButton :to="'/history?view=runs&runSession=' + encodeURIComponent(detail.record.sessionId)" color="neutral" variant="outline">Inspect execution attempts</UButton></div><p class="page-note">Accepted input is frozen. Edit drafts in the project folder; create a new draft for different work. A completed request does not prove that tests ran or a patch was applied.</p><details open><summary>Current request Markdown</summary><pre tabindex="0" role="region" aria-label="Current request Markdown">{{ detail.markdown }}</pre></details></section>
    </template>
  </template><p v-else-if="folder" class="page-note">No feature folder is configured. Initialize this worker in a project to use Markdown requests. Chat and file tasks remain available.</p>
</section>
</template>
