<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { ResourceStatus, ResourceEventPage, ResourceEvent, ResourceAlertCode } from '../../application/resources';
import { state, request, bytes, date, workspaceAction } from '../store';
import { useRouter } from 'vue-router';
const props = defineProps<{ compact?: boolean }>();
const router = useRouter(), report = ref<ResourceStatus | null>(null), readError = ref(''), error = ref(''), loading = ref(false), events = ref<ResourceEvent[]>([]), history = ref<ResourceEventPage | null>(null), historyBusy = ref(false), historyOpen = ref(false), opening = ref(false);
let active = true, generation = 0, historyGeneration = 0;
const warningHours = ref(''), maximumHours = ref(''), policyBusy = ref(false), policyNotice = ref('');
const snapshot = computed(() => report.value?.snapshot);
const activeTitle = computed(() => state.sessions?.records.find(session => session.id === snapshot.value?.active?.sessionId)?.title ?? 'Active worker task');
const labels: Record<ResourceAlertCode, string> = { memory: 'Worker memory pressure', heap: 'Worker heap pressure', cpu: 'Sustained worker CPU usage', disk: 'Low state-volume space', long_running: 'Long-running task' };
const elapsed = (ms: number) => ms < 60000 ? Math.round(ms / 1000) + ' seconds' : ms < 3600000 ? Math.floor(ms / 60000) + ' minutes' : (ms / 3600000).toFixed(1) + ' hours';
async function savePolicy() {
 const warning = Number(warningHours.value), maximum = Number(maximumHours.value);
 if (!Number.isFinite(warning) || !Number.isFinite(maximum) || warning <= 0 || warning > 24 || maximum <= 0 || maximum > 24) { error.value = 'Enter warning and maximum durations greater than zero and up to 24 hours.'; return; }
 policyBusy.value = true; error.value = ''; policyNotice.value = '';
 try { if (await workspaceAction('/api/settings', { resources: { longRunningMs: Math.round(warning * 3600000) }, ...(state.settings?.executionSource === 'environment' ? {} : { execution: { maxRuntimeMs: Math.round(maximum * 3600000) } }) })) { policyNotice.value = 'Duration policy saved. New attempts use the maximum execution duration.'; void load(); } else error.value = state.actionError || 'Duration policy could not be saved.'; }
 finally { policyBusy.value = false; }
}
async function load() {
 if (!active || !state.unlocked || loading.value) return;
 const current = ++generation; loading.value = true;
 try { const result = await request('/api/resources'); if (current === generation && state.unlocked) { report.value = result; readError.value = ''; } }
 catch (failure) { if (current === generation && state.unlocked) readError.value = (failure as Error).message; }
 finally { if (current === generation) loading.value = false; }
}
async function loadEvents(more = false) {
 if (historyBusy.value || !state.unlocked) return;
 const current = ++historyGeneration; historyBusy.value = true;
 try { const result: ResourceEventPage = await request('/api/resources', 'POST', { action: 'events', after: more ? history.value?.nextAfter ?? 0 : 0, limit: 50 }); if (current === historyGeneration && state.unlocked) { history.value = { ...result, gap: result.gap || (more && !!history.value?.gap) }; events.value = more ? [...events.value, ...result.events] : result.events; } }
 catch (failure) { if (current === historyGeneration && state.unlocked) error.value = (failure as Error).message; }
 finally { if (current === historyGeneration) historyBusy.value = false; }
}
async function openTask(sessionId: string) { if (opening.value) return; opening.value = true; try { if (await workspaceAction('/api/sessions', { action: 'select', id: sessionId })) await router.push({ path: '/taskboard', query: { session: sessionId } }); else error.value = state.actionError || 'The task could not be opened.'; } finally { opening.value = false; } }
onMounted(() => { void load(); }); onActivated(() => { active = true; void load(); });
onDeactivated(() => { active = false; generation++; historyGeneration++; loading.value = false; historyBusy.value = false; });
watch(() => state.refreshRevision, () => { void load(); });
watch(() => state.settings, settings => { if (settings && !warningHours.value && !maximumHours.value) { warningHours.value = String(settings.resources.longRunningMs / 3600000); maximumHours.value = String(settings.execution.maxRuntimeMs / 3600000); } }, { immediate: true });
watch(historyOpen, opened => { if (opened) void loadEvents(); });
watch(() => state.unlocked, unlocked => { if (unlocked) void load(); else { generation++; historyGeneration++; report.value = null; history.value = null; events.value = []; loading.value = false; historyBusy.value = false; error.value = ''; readError.value = ''; policyNotice.value = ''; warningHours.value = ''; maximumHours.value = ''; } });
</script>
<template>
<section v-if="!compact || report?.alerts.length || snapshot?.active" id="resource-monitor" :class="compact ? 'resource-compact' : 'monitor-section'" aria-labelledby="resource-monitor-title">
 <div class="section-heading"><h2 id="resource-monitor-title">{{ compact ? 'Active task monitoring' : 'Worker resource monitoring' }}</h2><UButton v-if="compact" to="/dashboard#resource-monitor" color="neutral" variant="ghost">View resources</UButton></div>
 <p v-if="readError" role="alert" class="error-text">{{ readError }} Last loaded information may be stale.</p><p v-if="error" class="error-text" role="alert">{{ error }} Last measurements may be stale.</p><p v-if="report?.sampleError || report?.persistenceError" class="error-text" role="status">{{ report.sampleError ? 'Some resource measurements could not be refreshed.' : '' }} {{ report.persistenceError ? 'Alert history could not be saved.' : '' }}</p>
 <p v-if="snapshot?.active"><strong>{{ activeTitle }} · running for {{ elapsed(snapshot.active.elapsedMs) }}</strong> · started {{ date(snapshot.active.startedAt) }} <UButton v-if="compact" color="neutral" variant="ghost" :loading="opening" @click="openTask(snapshot.active.sessionId)">Open active task</UButton></p>
 <ul v-if="report?.alerts.length" class="resource-alerts"><li v-for="alert in report.alerts" :key="alert.id"><strong>{{ labels[alert.code] }}</strong><p>{{ alert.code === 'long_running' ? 'Elapsed-time warning; this does not prove the task is stuck.' : 'A configured resource threshold has been crossed.' }} Since {{ date(alert.openedAt) }}.</p><UButton v-if="alert.sessionId" color="neutral" variant="outline" :loading="opening" @click="openTask(alert.sessionId)">Open affected task</UButton></li></ul>
 <template v-if="!compact"><p class="page-note">Worker Node process only; provider subprocesses are not measured. Samples every {{ report ? report.sampleIntervalMs / 1000 : 10 }} seconds. Alerts do not stop or retry tasks.</p><dl v-if="snapshot" class="facts"><div><dt>Worker resident memory</dt><dd>{{ bytes(snapshot.rssBytes) }}{{ snapshot.effectiveMemoryLimitBytes ? ' / ' + bytes(snapshot.effectiveMemoryLimitBytes) + ' effective capacity' : ' · capacity unavailable' }}</dd></div><div><dt>Worker heap</dt><dd>{{ bytes(snapshot.heapUsedBytes) }} / {{ bytes(snapshot.heapLimitBytes) }}</dd></div><div><dt>CPU · available-parallelism normalized</dt><dd>{{ snapshot.cpuPercent === null ? 'Unavailable' : snapshot.cpuPercent.toFixed(1) + '%' }} · {{ snapshot.cpuCapacityCores }} cores</dd></div><div><dt>Available memory</dt><dd>{{ snapshot.availableMemoryBytes === null ? 'Unavailable' : bytes(snapshot.availableMemoryBytes) }}</dd></div><div><dt>State-volume available space</dt><dd>{{ snapshot.diskAvailableBytes === null ? 'Unavailable' : bytes(snapshot.diskAvailableBytes) }}</dd></div><div><dt>Sample recorded</dt><dd>{{ date(snapshot.capturedAt) }}</dd></div></dl><p v-else class="page-note">{{ loading ? 'Reading resource measurements…' : 'No resource sample is available yet.' }}</p><p v-if="report && !report.alerts.length" class="page-note">No active resource alerts. Long-running warning after {{ elapsed(report.policy.longRunningMs) }}; elapsed time does not measure model progress.</p><p v-if="snapshot?.unavailable.length" class="page-note">Unavailable measurements: {{ snapshot.unavailable.join(', ') }}.</p>
 <details class="duration-policy"><summary>Task duration policy</summary><p class="page-note">The warning reports elapsed time without interrupting work. The maximum duration ends a new execution attempt; you can inspect its saved context before explicitly continuing.</p><form @submit.prevent="savePolicy"><fieldset :disabled="policyBusy"><label for="resource-warning-hours">Warn after · hours</label><input id="resource-warning-hours" v-model="warningHours" type="number" min="0.001" max="24" step="any" required><label for="resource-maximum-hours">Maximum attempt duration · hours</label><input id="resource-maximum-hours" v-model="maximumHours" :disabled="state.settings?.executionSource === 'environment'" type="number" min="0.001" max="24" step="any" required><p v-if="state.settings?.executionSource === 'environment'" class="page-note">Maximum duration is set by WERK_WORKER_MAX_RUNTIME_MS. Change that environment setting and restart the worker to update it; the warning remains editable.</p><UButton type="submit" :loading="policyBusy">Save duration policy</UButton></fieldset></form><p v-if="policyNotice" role="status">{{ policyNotice }}</p></details>
 <details @toggle="historyOpen = ($event.target as HTMLDetailsElement).open"><summary>Durable alert history</summary><p class="page-note">Opened and resolved alerts are retained locally, up to 1,000 events. A worker restart resolves old process alerts; it does not mean a task succeeded.</p><p v-if="history?.gap" class="error-text">Earlier events were removed by the retention limit.</p><p v-if="!events.length">{{ historyBusy ? 'Reading alert history…' : 'No retained alert events.' }}</p><ul class="checkpoint-history"><li v-for="event in events" :key="event.id"><strong>{{ labels[event.code] }} · {{ event.type }}</strong><span>{{ date(event.at) }} · {{ event.reason.replaceAll('_', ' ') }}</span></li></ul><UButton color="neutral" variant="outline" :loading="historyBusy" @click="loadEvents(false)">Refresh history</UButton><UButton v-if="history?.hasMore" color="neutral" variant="outline" :loading="historyBusy" @click="loadEvents(true)">Load more events</UButton></details></template>
</section>
</template>
