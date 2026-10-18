<script setup lang="ts">
import { computed, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import type { WorkerProcessesView } from '../../application/process-observation';
import type { ServiceLog } from '../../application/process-supervision';
import { state, request, bytes, date } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { activeProcess, processDuration, processOwner, processReadState, processStateLabel, serviceLifetime, serviceReadiness } from '../metrics-processes';
import { useServiceControls } from './useServiceControls';

const snapshot = useWorkerSnapshot<WorkerProcessesView>(() => request('/api/processes'));
const { data: report, now, refresh, refreshing, error: readError } = snapshot;
const reading = computed(() => processReadState(report.value?.capturedAt, now.value, state.paused, readError.value));
const showEnded = ref(false);
const services = computed(() => report.value?.services.services.filter(row => showEnded.value || activeProcess(row.state)) ?? []);
const executions = computed(() => (report.value?.executions.processes.filter(row => showEnded.value || row.state === 'running') ?? []).map(row => ({ ...row, owner: processOwner(row, state.sessions?.records ?? [], state.board?.tasks ?? []) })));
const { pending, confirmation, busy, error, notice, blocked, confirm, execute, retry } = useServiceControls(refresh);
const logId = ref('');
interface LogView { id: string; revision: number; entries: ServiceLog[]; nextAfter: number; gap: boolean; }
const logs = useWorkerSnapshot<LogView | null>(() => logId.value ? request('/api/processes', 'POST', { action: 'logs', id: logId.value, after: 0, limit: 128 }) : Promise.resolve(null), [logId]);
const logView = logs.data;
const logError = logs.error;
const logsLoading = logs.loading;
const logTime = logs.readAt;
const owner = (sessionId: string | null) => state.sessions?.records.find(row => row.id === sessionId)?.title || 'Open Feature Request';
const requestLink = (sessionId: string) => ({ path: '/taskboard', query: { session: sessionId } });
const time = (micros: number | null | undefined) => processDuration(micros == null ? null : micros / 1000);
const summary = computed(() => report.value ? [
  { name: 'Development services', scope: 'Granted service process groups', ...report.value.services.summary },
  { name: 'Model, tool & other processes', scope: 'Observed finite process groups', ...report.value.executions.summary },
] : []);
const shownActive = computed(() => (report.value?.services.capacity.active ?? 0) + (report.value?.executions.summary.active ?? 0));
</script>

<template>
  <section id="worker-processes" class="metrics-processes" aria-labelledby="metrics-processes-title">
    <header class="process-heading">
      <div><p class="eyebrow">Processes started by this worker</p><h2 id="metrics-processes-title">Services &amp; execution processes</h2></div>
      <UBadge :color="reading.stale ? 'neutral' : 'primary'" variant="subtle">{{ reading.label }}</UBadge>
    </header>
    <p class="process-scope">Development services can stay available for review after a model turn. Each has an approved lifetime and belongs to a Feature Request.</p>
    <p v-if="reading.message" class="process-notice" role="status">{{ reading.message }}</p>
    <p v-if="!report && !readError" class="process-notice" role="status">Reading this worker’s processes…</p>
    <p v-if="report?.services.persistenceError" class="process-notice" role="alert">The service journal is unavailable. Service starts are blocked; inspect the worker’s storage.</p>
    <div v-if="report" class="process-kpis">
      <dl v-for="group in summary" :key="group.name" class="process-metric-group">
        <div class="metric-group-title"><dt>{{ group.name }}</dt><dd>{{ group.scope }}</dd></div>
        <div><dt>Active groups</dt><dd>{{ group.activeGroups }}</dd></div>
        <div><dt>Observed resident memory</dt><dd>{{ bytes(group.rssBytes) }}</dd></div>
        <div><dt>CPU time · active groups</dt><dd>{{ time(group.cpuTotalMicros) }}</dd></div>
        <div class="measurement-coverage"><dt>Resource coverage</dt><dd>{{ group.measuredGroups }} of {{ group.activeGroups }} active groups<span> · {{ group.coverage }}</span></dd></div>
      </dl>
    </div>
    <p v-if="report" class="process-scope">CPU time is cumulative for the currently measured groups, not a percentage or a usage bill. Memory is summed resident memory and can count shared pages more than once. These readings exclude the worker process shown above.</p>
    <div class="process-toolbar">
      <label><input v-model="showEnded" type="checkbox"> Include ended processes</label>
      <div class="process-actions"><UButton to="/settings#tool-access" color="neutral" variant="ghost" icon="i-lucide-settings-2">Configure services</UButton><UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" :disabled="!state.unlocked || !!busy" @click="refresh">Refresh processes</UButton></div>
    </div>
    <template v-if="report">
      <h3>Development services <span>· {{ report.services.capacity.active }} / {{ report.services.capacity.maximum }} active slots</span></h3>
      <p class="process-scope">{{ report.services.summary.restarts }} restarts and {{ report.services.summary.failed }} failed or interrupted services in retained history. Running means the process is alive; readiness output is not a health check.</p>
      <p v-if="!services.length" class="empty-processes">{{ report.services.services.length ? 'No active development services. Include ended processes to inspect retained history.' : 'No development services have been started. Grant a service preset in Tool access, then let a Feature Request use it when needed.' }}</p>
      <div v-for="service in services" :key="service.id" class="service-card" :data-service-id="service.id">
        <div class="service-title"><h4>{{ service.name }}</h4><UBadge :color="service.state === 'failed' || service.state === 'interrupted' ? 'warning' : 'neutral'" variant="subtle">{{ processStateLabel(service.state) }}</UBadge></div>
        <UButton :to="requestLink(service.sessionId)" color="neutral" variant="link" icon="i-lucide-arrow-up-right" class="service-owner">{{ owner(service.sessionId) }}</UButton>
        <dl class="service-facts"><div><dt>Lifetime</dt><dd>{{ serviceLifetime(service, now) }}</dd></div><div><dt>Readiness</dt><dd>{{ serviceReadiness(service) }}</dd></div><div><dt>Restarts used</dt><dd>{{ service.restartCount }} / {{ service.restartLimit }}</dd></div><div><dt>Started</dt><dd>{{ date(service.startedAt) }}</dd></div></dl>
        <p v-if="service.error" class="process-notice">{{ service.error }}</p>
        <p v-if="service.lastExit" class="process-scope">Latest exit: {{ service.lastExit.reason.replaceAll('_', ' ') }}<span v-if="service.lastExit.code !== null"> · code {{ service.lastExit.code }}</span> · {{ date(service.endedAt) }}</p>
        <div class="process-actions">
          <UButton color="neutral" variant="outline" icon="i-lucide-scroll-text" :disabled="!state.unlocked" @click="logId = logId === service.id ? '' : service.id">{{ logId === service.id ? 'Hide logs' : 'Inspect logs' }}</UButton>
          <UButton v-if="service.controls.stop" color="neutral" variant="outline" icon="i-lucide-square" :disabled="reading.stale || blocked" :loading="busy === service.id + ':stop'" @click="confirm('stop', service)">Stop service</UButton>
          <UButton color="neutral" variant="outline" icon="i-lucide-rotate-cw" :disabled="reading.stale || blocked || !service.controls.restart" :loading="busy === service.id + ':restart'" @click="confirm('restart', service)">Restart service</UButton>
        </div>
        <p v-if="!service.controls.restart && service.controls.restartUnavailableReason" class="process-scope">{{ service.controls.restartUnavailableReason }}</p>
        <section v-if="logId === service.id" class="service-logs" :aria-labelledby="'logs-' + service.id">
          <h5 :id="'logs-' + service.id">Retained service output</h5><p class="process-scope">A bounded snapshot of stdout and stderr. {{ logTime ? 'Read ' + date(logTime) + '.' : '' }}</p>
          <p v-if="logError" role="status">{{ logError }}</p><p v-else-if="logsLoading && !logView" role="status">Reading output…</p>
          <p v-if="logView?.gap" class="process-notice">Earlier output has expired from the retained log.</p>
          <pre v-if="logView?.entries.length" tabindex="0" aria-label="Service output"><template v-for="entry in logView.entries" :key="entry.sequence">{{ '[' + entry.stream + '] ' + entry.text + '\n' }}</template></pre>
          <p v-else-if="logView">No output is retained for this service.</p>
          <UButton color="neutral" variant="ghost" :loading="logs.refreshing.value" @click="logs.refresh">Refresh logs</UButton>
        </section>
        <section v-if="confirmation?.service.id === service.id" class="service-confirmation" aria-label="Confirm service operation">
          <p>{{ confirmation.action === 'stop' ? 'Stop this service and its owned child processes? The Feature Request stays available.' : 'Restart this service using its current grant? This consumes a restart attempt and keeps the original lifetime.' }}</p>
          <p v-if="confirmation.service.revision !== service.revision">The service changed since you selected this action. Cancel and inspect its current state.</p>
          <div class="process-actions"><UButton color="primary" :disabled="reading.stale || blocked || confirmation.service.revision !== service.revision" @click="execute">{{ confirmation.action === 'stop' ? 'Confirm stop' : 'Confirm restart' }}</UButton><UButton color="neutral" variant="ghost" :disabled="!!busy" @click="confirmation = null">Cancel</UButton></div>
        </section>
      </div>
      <p v-if="error" class="process-notice" role="alert">{{ error }}</p>
      <p v-if="notice" class="process-notice" role="status">{{ notice }}</p>
      <div v-if="pending" class="process-notice"><p>{{ busy ? 'Waiting for the service operation to be acknowledged.' : 'The previous operation is unconfirmed. Retry the same operation to check its outcome without issuing a second restart.' }}</p><UButton v-if="!busy" color="neutral" variant="outline" @click="retry">Retry unconfirmed operation</UButton></div>
      <h3>Model, tool &amp; other processes</h3>
      <p class="process-scope">Observed local task and model processes are retained for the current worker runtime, up to {{ report.executions.retention.limit }} completed entries plus active work. This view does not scan the machine or include provider probes and separate orchestrator execution adapters. To stop attributed work, open its Feature Request.</p>
      <ul v-if="executions.length" class="execution-processes"><li v-for="process in executions" :key="process.id"><div><strong>{{ process.label }}</strong><span>{{ process.kind }} · {{ processStateLabel(process.state) }}<template v-if="process.exitCode !== null"> · exit {{ process.exitCode }}</template></span></div><div><span>{{ date(process.startedAt) }}</span><UButton v-if="process.owner" :to="requestLink(process.owner.id)" color="neutral" variant="link" icon="i-lucide-arrow-up-right">{{ process.owner.title }}</UButton><span v-else>{{ process.featureRequestKey ? 'Request link unavailable' : 'Worker maintenance' }}</span></div></li></ul>
      <p v-else class="empty-processes">{{ showEnded ? 'No finite processes are retained in this worker runtime.' : 'No observed finite processes are currently running.' }}</p>
      <footer class="process-scope">{{ shownActive }} active groups · status read {{ date(report.capturedAt) }}. Resource sampling: services {{ report.services.sampleIntervalMs / 1000 }}s; finite processes {{ report.executions.sampleIntervalMs / 1000 }}s.</footer>
    </template>
  </section>
</template>

<style scoped>
.metrics-processes { min-width: 0; border: 1px solid var(--ui-border); border-radius: 12px; padding: var(--space-6); margin-bottom: var(--space-8); }
h2, h3, h4, h5, p, dl { margin: 0; }
h2 { font-size: 1.125rem; color: var(--ui-text-highlighted); }
h3 { font-size: 1rem; margin-top: var(--space-6); margin-bottom: var(--space-2); }
h3 span { color: var(--ui-text-muted); font-size: .875rem; font-weight: 400; }
h4, h5 { font-size: .9375rem; }
.eyebrow, .process-scope { color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.6; }
.process-scope { margin-top: var(--space-2); }
.process-heading, .process-toolbar, .process-actions, .service-title { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: var(--space-3); }
.process-actions, .service-title { justify-content: flex-start; }
.process-toolbar { margin-block: var(--space-4); padding-block: var(--space-2); border-block: 1px solid var(--ui-border); }
.process-toolbar label { display: flex; align-items: center; gap: var(--space-2); min-height: 44px; font-size: .875rem; }
.process-toolbar input { width: 18px; height: 18px; accent-color: var(--ui-primary); }
.process-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-block: var(--space-4); }
.process-metric-group { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); padding: var(--space-4); border-radius: 8px; background: var(--ui-bg-muted); }
.process-metric-group dt, .service-facts dt { font-size: .8125rem; color: var(--ui-text-muted); }
.process-metric-group dd { margin: var(--space-1) 0 0; font-size: 1.125rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.metric-group-title, .measurement-coverage { grid-column: 1 / -1; }
.metric-group-title dt { font-weight: 600; color: var(--ui-text-highlighted); font-size: .9375rem; }
.metric-group-title dd, .measurement-coverage dd { font-size: .8125rem; font-weight: 400; color: var(--ui-text-muted); }
.measurement-coverage dt { display: inline; }.measurement-coverage dd { display: inline; margin-left: var(--space-2); }
.service-card { border: 1px solid var(--ui-border); padding: var(--space-4); border-radius: 8px; margin-block: var(--space-3); min-width: 0; }
.service-owner { max-width: 100%; white-space: normal; text-align: left; overflow-wrap: anywhere; padding-left: 0; }
.service-facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); margin-block: var(--space-3); }
.service-facts dd { margin: var(--space-1) 0 0; font-size: .875rem; overflow-wrap: anywhere; }
.process-notice, .service-confirmation { padding: var(--space-3); border-left: 3px solid var(--ui-border-accented); background: var(--ui-bg-muted); font-size: .875rem; margin-block: var(--space-3); overflow-wrap: anywhere; }
.service-confirmation .process-actions { margin-top: var(--space-3); }
.service-logs { border-top: 1px solid var(--ui-border); margin-top: var(--space-3); padding-top: var(--space-3); }
.service-logs pre { margin-block: var(--space-3); padding: var(--space-3); font-size: .8125rem; max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--ui-bg-muted); border-radius: 8px; }
.execution-processes { margin: var(--space-3) 0; padding: 0; list-style: none; }
.execution-processes li { display: flex; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; padding-block: var(--space-3); border-bottom: 1px solid var(--ui-border); }
.execution-processes li > div { display: grid; min-width: 0; gap: var(--space-1); }
.execution-processes strong { font-size: .875rem; }.execution-processes span, .empty-processes { font-size: .8125rem; color: var(--ui-text-muted); }
.empty-processes { padding-block: var(--space-3); line-height: 1.6; }.execution-processes a { padding-inline: 0; }
.metrics-processes :deep(button), .metrics-processes :deep(a) { min-height: 44px; }
.metrics-processes :deep(button:focus-visible), .metrics-processes :deep(a:focus-visible), .metrics-processes pre:focus-visible, .metrics-processes input:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 3px; }
footer { padding-top: var(--space-3); }
@media (max-width: 1050px) { .process-kpis { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .metrics-processes { padding: var(--space-4); }.service-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }.process-metric-group { grid-template-columns: repeat(2, minmax(0, 1fr)); }.process-metric-group > div { grid-column: auto; }.process-metric-group .metric-group-title, .process-metric-group .measurement-coverage, .process-metric-group > div:nth-child(2) { grid-column: 1 / -1; }.service-title { align-items: flex-start; }.process-actions { gap: var(--space-2); } }
</style>
