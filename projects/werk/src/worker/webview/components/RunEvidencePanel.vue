<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import type { WorkerRun, RunAnalysis, RunPage, RunQuery } from '../../application/run-evidence';
import { state, request, bytes, date, duration } from '../store';
const props = defineProps<{ compact?: boolean }>();
const route = useRoute();
const page = ref<RunPage | null>(null), analysis = ref<RunAnalysis | null>(null), selected = ref<WorkerRun | null>(null);
const loading = ref(false), pendingRead = ref<'refresh' | 'filters' | 'more' | null>(null), error = ref(''), detailError = ref(''), exporting = ref(false), exported = ref(0), exportError = ref('');
const kind = ref('all'), outcomeFilter = ref('all'), provider = ref(''), since = ref(''), until = ref('');
const active = ref(true);
let revision = 0, detailRevision = 0, exportRevision = 0, trigger: HTMLElement | null = null;
const query = ref<RunQuery>({});
const kindOptions = [{ label: 'All task types', value: 'all' }, { label: 'Chat', value: 'chat' }, { label: 'File tasks', value: 'local' }, { label: 'Assignment follow-ups', value: 'orchestrator' }];
const outcomeOptions = [{ label: 'All outcomes', value: 'all' }, ...['queued', 'running', 'waiting_input', 'escalated', 'completed', 'review', 'failed', 'cancelled', 'interrupted'].map(value => ({ label: value === 'review' ? 'Patch ready for review' : value[0].toUpperCase() + value.slice(1), value }))];
const measured = (value: number | null | undefined) => value == null ? 'Unavailable' : value.toLocaleString();
const cost = (value: number | null | undefined) => value == null ? 'Unavailable' : '$' + value.toFixed(4) + ' USD';
const cpu = (value: number | null | undefined) => value == null ? 'Unavailable' : (value / 1_000_000).toFixed(3) + ' s';
const costHeading = (basis?: string) => basis === 'reported_estimate' ? 'Provider-reported estimate' : basis === 'reported_billed' ? 'Provider-reported billed cost' : basis === 'unavailable' ? 'Cost unavailable' : 'Reported cost · basis unknown';
const tokens = computed(() => analysis.value?.consumption);
function filters(): RunQuery {
  return { ...(kind.value !== 'all' ? { kind: kind.value as RunQuery['kind'] } : {}), ...(outcomeFilter.value !== 'all' ? { outcome: outcomeFilter.value as RunQuery['outcome'] } : {}), ...(provider.value.trim() ? { provider: provider.value.trim() } : {}), ...(since.value ? { since: new Date(since.value).toISOString() } : {}), ...(until.value ? { until: new Date(until.value).toISOString() } : {}), ...(typeof route.query.runSession === 'string' ? { sessionId: route.query.runSession } : {}) };
}
async function load(more = false, reuseFilters = false, background = false) {
  if (!active.value || !state.unlocked || pendingRead.value || background && loading.value) return;
  const current = ++revision; loading.value = true; pendingRead.value = background ? null : more ? 'more' : reuseFilters ? 'refresh' : 'filters';
  if (!background) error.value = '';
  try {
    if (!more && !reuseFilters) query.value = filters();
    const submittedQuery = { ...query.value };
    const body = { ...submittedQuery, limit: 25, ...(more && page.value?.nextCursor ? { cursor: page.value.nextCursor } : {}) };
    const result: RunPage = await request('/api/runs', 'POST', { action: 'list', ...body });
    if (current !== revision || !state.unlocked) return;
    const summary: RunAnalysis = more && analysis.value ? analysis.value : await request('/api/runs', 'POST', { action: 'analyze', ...submittedQuery, asOf: result.asOf });
    if (current !== revision || !state.unlocked) return;
    page.value = { ...result, rows: more ? [...(page.value?.rows ?? []), ...result.rows] : result.rows }; analysis.value = summary; error.value = '';
  } catch (failure) { if (current === revision && state.unlocked) error.value = (failure as Error).message; }
  finally { if (current === revision) { loading.value = false; pendingRead.value = null; } }
}
async function inspect(run: WorkerRun, event: MouseEvent) {
  trigger = event.currentTarget as HTMLElement; const current = ++detailRevision; detailError.value = '';
  try { const result: WorkerRun = await request('/api/runs', 'POST', { action: 'get', id: run.id }); if (current !== detailRevision || !state.unlocked) return; selected.value = result; await nextTick(); document.getElementById('run-detail-title')?.focus(); }
  catch (failure) { if (current === detailRevision && state.unlocked) detailError.value = (failure as Error).message; }
}
async function refreshSelected() {
  const id = selected.value?.id, current = detailRevision; if (!id || !active.value || !state.unlocked) return;
  try { const result: WorkerRun = await request('/api/runs', 'POST', { action: 'get', id }); if (current === detailRevision && selected.value?.id === id && active.value && state.unlocked) selected.value = result; }
  catch (failure) { if (current === detailRevision && active.value && state.unlocked) detailError.value = (failure as Error).message; }
}
async function closeDetail() { detailRevision++; selected.value = null; await nextTick(); trigger?.isConnected && trigger.focus(); }
function download(value: unknown, name: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function exportRuns() {
  if (exporting.value || !page.value) return;
  const current = ++exportRevision, frozenFilters = { ...query.value }, frozen = { ...frozenFilters, asOf: page.value.asOf };
  const summary = analysis.value ? JSON.parse(JSON.stringify(analysis.value)) : null;
  const rows: WorkerRun[] = [];
  exporting.value = true; exported.value = 0; exportError.value = '';
  try {
    let cursor: string | undefined;
    do { const batch: RunPage = await request('/api/runs', 'POST', { action: 'export', ...frozenFilters, limit: 100, ...(cursor ? { cursor } : { asOf: frozen.asOf }) }); if (current !== exportRevision || !state.unlocked) return; rows.push(...batch.rows); exported.value = rows.length; cursor = batch.nextCursor ?? undefined; } while (cursor);
    download({ schemaVersion: 1, scope: 'worker_session_executions', filters: frozen, analysis: summary, rows }, 'werk-run-evidence.json');
  } catch (failure) { if (current === exportRevision && state.unlocked) exportError.value = (failure as Error).message; }
  finally { if (current === exportRevision) exporting.value = false; }
}
async function entry() { if (!state.unlocked) return; await load(false, false, true);
  if (!props.compact && typeof route.query.runId === 'string') { const current = ++detailRevision; try { const result: WorkerRun = await request('/api/runs', 'POST', { action: 'get', id: route.query.runId }); if (current === detailRevision && state.unlocked) { selected.value = result; await nextTick(); document.getElementById('run-detail-title')?.focus(); } } catch (failure) { if (current === detailRevision) detailError.value = (failure as Error).message; } } if (!props.compact && (route.query.view === 'runs' || route.query.runSession)) { await nextTick(); document.getElementById('run-evidence-title')?.focus(); } }
onMounted(() => { void entry(); });
onActivated(() => { active.value = true; void entry(); });
onDeactivated(() => { active.value = false; revision++; detailRevision++; exportRevision++; loading.value = false; pendingRead.value = null; exporting.value = false; });
watch(() => state.refreshRevision, () => { if (active.value && state.unlocked) { if (!loading.value && (page.value?.rows.length ?? 0) <= 25) void load(false, true, true); void refreshSelected(); } });
watch(() => [route.query.view, route.query.runSession, route.query.runId], () => { if (route.path === '/history') { revision++; detailRevision++; selected.value = null; loading.value = false; pendingRead.value = null; void entry(); } });
watch(() => state.unlocked, unlocked => { if (unlocked) void entry(); else { revision++; detailRevision++; exportRevision++; page.value = null; analysis.value = null; selected.value = null; loading.value = false; pendingRead.value = null; exporting.value = false; error.value = ''; detailError.value = ''; exportError.value = ''; } });
</script>
<template>
<section class="monitor-section run-evidence" aria-labelledby="run-evidence-title">
  <div class="section-heading"><div><h2 id="run-evidence-title" tabindex="-1">{{ compact ? 'Retained local attempts' : 'Execution evidence' }}</h2><p class="page-note">Local chat, file tasks and assignment follow-ups. Original remote lease executions remain in Task history. One record per attempt; retries retain earlier runs.</p></div><UButton v-if="compact" to="/history?view=runs" color="neutral" variant="outline">Explore execution evidence</UButton><UButton v-else color="neutral" variant="outline" :loading="pendingRead === 'refresh'" :disabled="!!pendingRead" @click="load(false, true)">Refresh runs</UButton></div>
  <p v-if="error" role="alert" class="error-text">{{ error }} Previously loaded evidence may be stale. Refresh to retry.</p>
  <p v-if="loading && !analysis" role="status" class="page-note">Loading retained execution evidence…</p>
  <template v-if="analysis"><div class="run-analysis-grid"><div><span>Retained attempts</span><strong>{{ analysis.total }}</strong><small>{{ analysis.completedPairs }} complete before / after pairs</small></div><div><span>Mean execution time</span><strong>{{ analysis.duration.meanMs == null ? 'Unavailable' : duration(analysis.duration.meanMs) }}</strong><small>{{ analysis.duration.measuredRuns }} measured attempts</small></div><div><span>Reported cost · may include estimates</span><strong>{{ cost(tokens?.providerReportedCostUsd) }}</strong><small>{{ tokens?.coverage.providerReportedCostUsd ?? 0 }} / {{ analysis.total }} attempts report cost</small></div><div><span>Input / output tokens</span><strong>{{ measured(tokens?.inputTokens) }} / {{ measured(tokens?.outputTokens) }}</strong><small>{{ tokens?.coverage.inputTokens ?? 0 }} input · {{ tokens?.coverage.outputTokens ?? 0 }} output reports</small></div></div>
    <p class="page-note">Totals include reported measurements only. Missing usage is unavailable, never zero. Worker-process resources exclude the model subprocess. Reported costs are not verified invoices or subscription balances.</p>
  </template>
  <template v-if="!compact"><form class="history-filters run-filters" @submit.prevent="load()"><div><label for="run-kind">Task type</label><USelect id="run-kind" v-model="kind" :items="kindOptions" class="w-full" /></div><div><label for="run-outcome">Outcome</label><USelect id="run-outcome" v-model="outcomeFilter" :items="outcomeOptions" class="w-full" /></div><div><label for="run-provider">Provider ID · optional</label><UInput id="run-provider" v-model="provider" placeholder="e.g. codex-cli" class="w-full" /></div><div><label for="run-since">From · local time</label><UInput id="run-since" v-model="since" type="datetime-local" class="w-full" /></div><div><label for="run-until">Until · local time</label><UInput id="run-until" v-model="until" type="datetime-local" class="w-full" /></div><UButton type="submit" :loading="pendingRead === 'filters'" :disabled="!!pendingRead">Apply filters</UButton></form>
    <p v-if="route.query.runSession" class="page-note">Showing this task’s attempts. <RouterLink to="/history?view=runs">Show every task</RouterLink></p>
    <div class="section-heading"><p class="page-note" role="status">{{ page?.rows.length ?? 0 }} loaded of {{ page?.total ?? 0 }} matching attempts · oldest first</p><UButton color="neutral" variant="outline" :disabled="!page?.total || exporting" @click="exportRuns">Export matching runs</UButton></div>
    <p class="page-note">Exports keep the same admitted-attempt set across pages. Queued or running attempts may advance while you export.</p><p v-if="exporting" role="status">Preparing export · {{ exported }} / {{ page?.total }} attempts <UButton color="neutral" variant="ghost" @click="exportRevision++; exporting = false">Cancel export</UButton></p><p v-if="exportError" role="alert" class="error-text">{{ exportError }}</p>
    <p v-if="page && !page.rows.length" class="board-empty">No retained runs match these filters. New execution attempts appear here when work is queued.</p>
    <ul class="run-list"><li v-for="run in page?.rows" :key="run.id"><div><strong>{{ run.title }}</strong><span class="muted">Attempt {{ run.attempt }} · {{ run.provider }} · {{ date(run.before?.capturedAt ?? run.acceptedAt) }}</span><span>{{ run.outcome }} · {{ run.durationMs == null ? 'Duration unavailable' : duration(run.durationMs) }} · {{ run.before && run.after ? 'Complete pair' : 'Partial evidence' }}</span></div><UButton color="neutral" variant="outline" :aria-label="'Inspect run ' + run.title + ', attempt ' + run.attempt" @click="inspect(run, $event)">Inspect run</UButton></li></ul>
    <p v-if="(page?.rows.length ?? 0) > 25" class="page-note">Loaded historical pages stay in place during live updates. Refresh runs to reload the first page and latest totals.</p><UButton v-if="page?.nextCursor" color="neutral" variant="outline" :loading="pendingRead === 'more'" :disabled="!!pendingRead" @click="load(true)">Load more attempts</UButton>
    <p v-if="detailError" role="alert" class="error-text">{{ detailError }} Select the attempt again to retry.</p>
    <section v-if="selected" class="evidence-panel" @keydown.esc.prevent="closeDetail"><div class="section-heading"><h3 id="run-detail-title" tabindex="-1">{{ selected.title }} · attempt {{ selected.attempt }}</h3><UButton color="neutral" variant="ghost" aria-label="Close run evidence" @click="closeDetail">Close</UButton></div><p>{{ selected.outcome }} · {{ selected.provider }} · {{ selected.model || 'Provider default model' }}</p><p v-if="!selected.before" class="page-note">No execution-start snapshot exists. This attempt may not have acquired an execution slot.</p><p v-if="selected.after?.measurement === 'recovery'" class="page-note">The after snapshot was captured during recovery, rather than at the execution boundary.</p><p v-if="!selected.after" role="status">This attempt has no after snapshot yet. It may still be queued, running or awaiting recovery.</p><dl class="facts"><div><dt>Execution time / queue time</dt><dd>{{ selected.durationMs == null ? 'Unavailable' : duration(selected.durationMs) }} / {{ selected.queueDurationMs == null ? 'Unavailable' : duration(selected.queueDurationMs) }}</dd></div><div><dt>Worker RSS · before / after</dt><dd>{{ selected.before ? bytes(selected.before.resources.rssBytes) : 'Unavailable' }} / {{ selected.after ? bytes(selected.after.resources.rssBytes) : 'Unavailable' }}</dd></div><div><dt>Worker CPU · user / system delta</dt><dd>{{ cpu(selected.resourceDelta.cpuUserMicros) }} / {{ cpu(selected.resourceDelta.cpuSystemMicros) }}</dd></div><div><dt>Input / output tokens</dt><dd>{{ measured(selected.usage.inputTokens) }} / {{ measured(selected.usage.outputTokens) }}</dd></div><div><dt>Cache read / write tokens</dt><dd>{{ measured(selected.usage.cacheReadTokens) }} / {{ measured(selected.usage.cacheWriteTokens) }}</dd></div><div><dt>{{ costHeading(selected.usage.costBasis) }}</dt><dd>{{ cost(selected.usage.providerReportedCostUsd) }}</dd></div></dl><p class="page-note">{{ selected.usage.reason || 'Usage was reported by the provider.' }} CPU is the worker-process change between snapshots; RSS values are observations, not a measured peak.</p><UButton color="neutral" variant="outline" @click="download(selected, 'werk-run-' + selected.id + '.json')">Export this attempt</UButton><details><summary>Before / after record</summary><pre>{{ JSON.stringify(selected, null, 2) }}</pre></details></section>
    <details v-if="analysis" class="monitor-section"><summary>Resource totals &amp; measurement coverage</summary><dl class="facts"><div><dt>Worker CPU · user / system</dt><dd>{{ cpu(analysis.resources.cpuUserMicros) }} / {{ cpu(analysis.resources.cpuSystemMicros) }}</dd></div><div><dt>Highest observed worker RSS</dt><dd>{{ analysis.resources.peakObservedRssBytes == null ? 'Unavailable' : bytes(analysis.resources.peakObservedRssBytes) }}</dd></div><div><dt>Resource measurement coverage</dt><dd>{{ analysis.resources.measuredRuns }} / {{ analysis.total }} attempts</dd></div></dl><p v-for="note in analysis.notes" :key="note" class="page-note">{{ note }}</p></details>
  </template>
</section>
</template>
