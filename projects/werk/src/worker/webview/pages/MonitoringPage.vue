<script setup lang="ts">
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import MetricsConsumptionPanel from '../components/MetricsConsumptionPanel.vue';
import MetricsResourcesPanel from '../components/MetricsResourcesPanel.vue';
import MetricsExecutionPanel from '../components/MetricsExecutionPanel.vue';
import DeliveryMetricsPanel from '../components/DeliveryMetricsPanel.vue';
import MetricsProcessesPanel from '../components/MetricsProcessesPanel.vue';
import { state, date, getCapacityFreshness } from '../store';
import { buildWorkerCapacityView } from '../worker-capacity';
import { useWorkerClock } from '../useWorkerSnapshot';

const now = useWorkerClock();
const env = computed(() => state.environment), worker = computed(() => state.status);
const capacity = computed(() => state.sessions?.capacity);
const activity = computed(() => {
  void now.value;
  return buildWorkerCapacityView(capacity.value, getCapacityFreshness());
});
const activeTask = computed(() => state.sessions?.records.find(session => session.id === capacity.value?.execution.sessionId)?.title);
const identity = computed(() => worker.value?.workerId || env.value?.hostname || 'This worker');
const remoteVisible = computed(() => (capacity.value?.remote.accepted ?? 0) > 0 || worker.value?.state !== 'standalone');
const statusStale = computed(() => state.paused || !!state.statusError || !state.statusReadAt || now.value - Date.parse(state.statusReadAt) > 15000);
const environmentStale = computed(() => state.paused || !!state.environmentError || !state.environmentReadAt || now.value - Date.parse(state.environmentReadAt) > 15000);
const uptime = computed(() => {
  if (!env.value) return 'Unavailable';
  const minutes = Math.floor(env.value.uptimeSeconds / 60);
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
    : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
});
</script>

<template>
  <section class="dashboard-page metrics-page">
    <header class="page-heading metrics-heading">
      <div><p class="metrics-worker">{{ identity }}<span v-if="env?.hostname && env.hostname !== identity"> · {{ env.hostname }}</span></p><h1 tabindex="-1">Metrics</h1><p>Capacity, resources and consumption for this worker.</p></div>
      <UButton to="/settings" color="neutral" variant="outline" icon="i-lucide-settings">Worker settings</UButton>
    </header>
    <UAlert v-for="alert in state.monitoring?.alerts" :key="alert.code" :title="alert.message"
      :description="alert.remediation" color="warning" variant="soft" icon="i-lucide-triangle-alert" class="notice" />

    <template v-if="state.unlocked">
      <section class="metrics-activity" :data-activity="activity.state" aria-labelledby="metrics-activity-title">
        <div class="activity-summary">
          <p class="activity-kicker">{{ activity.stale ? 'Last reported activity' : 'Current activity' }}</p>
          <h2 id="metrics-activity-title"><span class="activity-dot" aria-hidden="true" />{{ activity.title }}</h2>
          <p v-if="activeTask && capacity?.execution.inUse" class="active-task">{{ activeTask }}</p>
          <p class="activity-description">{{ activity.description }}</p>
        </div>
        <dl class="activity-counts">
          <div><dt>Execution slots</dt><dd>{{ capacity ? capacity.execution.inUse + ' / ' + capacity.execution.limit : 'Unavailable' }}<small>Shared execution capacity</small></dd></div>
          <div><dt>Local places</dt><dd>{{ capacity ? capacity.local.used + ' / ' + capacity.local.limit : 'Unavailable' }}<small>Includes queued, active &amp; preparing</small></dd></div>
          <div v-if="remoteVisible"><dt>Accepted assignments</dt><dd>{{ capacity?.remote.accepted == null ? 'Unavailable' : capacity.remote.accepted + ' / ' + (capacity.remote.extraQueuePlaces + 1) }}<small>Separate remote buffer</small></dd></div>
        </dl>
        <UButton to="/taskboard" color="neutral" variant="outline" icon="i-lucide-arrow-up-right">View taskboard</UButton>
      </section>

      <div class="metrics-overview">
        <MetricsConsumptionPanel />
        <MetricsResourcesPanel />
      </div>
      <MetricsProcessesPanel />
      <DeliveryMetricsPanel />
      <MetricsExecutionPanel />

      <details class="metrics-diagnostics">
        <summary>Runtime &amp; connection details</summary>
        <div class="diagnostic-columns">
          <section aria-labelledby="metrics-runtime-title">
            <h2 id="metrics-runtime-title">Runtime</h2>
            <p v-if="environmentStale" class="page-note">{{ state.environmentError || 'Runtime readings are paused or need refresh.' }} Last read {{ date(state.environmentReadAt) }}.</p>
            <dl v-if="env" class="facts">
              <div><dt>Host</dt><dd>{{ env.hostname }}</dd></div>
              <div><dt>Operating system</dt><dd>{{ env.platform }} {{ env.osRelease }} · {{ env.architecture }}</dd></div>
              <div><dt>Node.js / process ID</dt><dd>{{ env.nodeVersion }} / {{ env.pid }}</dd></div>
              <div><dt>Worker-process uptime</dt><dd>{{ uptime }}</dd></div>
              <div><dt>Host load · 1 / 5 / 15 min</dt><dd>{{ env.hostLoad ? env.hostLoad.map(value => value.toFixed(2)).join(' / ') : 'Unavailable on this platform' }}</dd></div>
              <div><dt>Available logical CPUs</dt><dd>{{ env.logicalCpus }}</dd></div>
              <div><dt>State directory</dt><dd>{{ env.stateDirectory }}</dd></div>
              <div><dt>Project directory</dt><dd>{{ env.projectDirectory ?? 'Not configured' }}</dd></div>
            </dl>
            <p v-else class="page-note">Runtime details are unavailable. Refresh to try again.</p>
          </section>
          <section aria-labelledby="metrics-connection-title">
            <h2 id="metrics-connection-title">Connection &amp; diagnostics</h2>
            <p v-if="statusStale" class="page-note">{{ state.statusError || 'Connection readings are paused or need refresh.' }} Last read {{ date(state.statusReadAt) }}.</p>
            <dl class="facts">
              <div><dt>Connection</dt><dd>{{ worker?.state === 'standalone' ? 'Standalone' : worker?.state ?? 'Unavailable' }}</dd></div>
              <div><dt>Orchestrator</dt><dd>{{ env ? env.orchestratorUrl ?? 'Not connected' : 'Unavailable' }}</dd></div>
              <div><dt>Orchestrator execution</dt><dd>{{ worker?.mode === 'mock' ? 'Simulation' : worker?.mode === 'cli' ? 'Live Codex' : 'Unavailable' }}</dd></div>
              <div><dt>Heartbeat errors · this process</dt><dd>{{ worker?.heartbeatErrors ?? 'Unavailable' }}</dd></div>
              <div><dt>Snapshots awaiting delivery</dt><dd>{{ worker?.outbox?.pending ?? 'Unavailable' }}</dd></div>
              <div><dt>Latest reported error</dt><dd>{{ worker ? worker.lastError ?? 'None recorded' : 'Unavailable' }}</dd></div>
              <div><dt>Completed simulations · this process</dt><dd>{{ worker?.completedSimulations ?? 'Unavailable' }}</dd></div>
              <div><dt>Change sets for review · this process</dt><dd>{{ worker?.completedReviews ?? 'Unavailable' }}</dd></div>
              <div><dt>Configuration hash</dt><dd>{{ worker?.configurationHash ?? 'Unavailable' }}</dd></div>
              <div><dt>Latest snapshot</dt><dd>{{ worker ? worker.lastSnapshot ?? 'None recorded in this process' : 'Unavailable' }}</dd></div>
            </dl>
            <p class="page-note">{{ worker?.state === 'standalone' ? 'Standalone is a healthy state. An orchestrator is optional.' : worker?.lastContact ? 'Last orchestrator contact: ' + date(worker.lastContact) + '.' : 'No orchestrator contact has been recorded.' }}</p>
            <UButton to="/status" target="_blank" color="neutral" variant="outline" icon="i-lucide-braces">Status JSON</UButton>
          </section>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.metrics-page { min-width: 0; }
.metrics-heading { align-items: center; gap: var(--space-4); margin-bottom: var(--space-6); }
.metrics-heading .metrics-worker { color: var(--ui-text-muted); font-size: .875rem; margin-bottom: var(--space-1); overflow-wrap: anywhere; }
.metrics-heading h1 { margin-bottom: var(--space-1); }
.metrics-page :deep(button), .metrics-page :deep(a[class]) { min-height: 44px; }
.metrics-activity { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-6); padding: var(--space-6); margin-bottom: var(--space-6); background: var(--ui-bg-muted); border-left: 3px solid var(--ui-border-accented); }
.metrics-activity[data-activity=running], .metrics-activity[data-activity=available] { border-left-color: var(--ui-primary); }
.metrics-activity[data-activity=blocked], .metrics-activity[data-activity=paused] { border-left-color: var(--ui-warning); }
.activity-summary { flex: 1 1 310px; min-width: 0; }
.activity-kicker { color: var(--ui-text-muted); font-size: .8125rem; margin: 0 0 var(--space-1); }
.activity-summary h2 { margin: 0; font-size: 1.125rem; display: flex; align-items: center; gap: var(--space-2); }
.activity-dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--ui-text-muted); }
[data-activity=running] .activity-dot, [data-activity=available] .activity-dot { background: var(--ui-primary); }
[data-activity=blocked] .activity-dot, [data-activity=paused] .activity-dot { background: var(--ui-warning); }
.active-task { font-weight: 600; margin: var(--space-2) 0; overflow-wrap: anywhere; }
.activity-description { margin: var(--space-1) 0 0; color: var(--ui-text-muted); font-size: .875rem; max-width: 65ch; }
.activity-counts { display: flex; gap: var(--space-6); margin: 0; flex-wrap: wrap; }
.activity-counts > div { min-width: 100px; max-width: 190px; }
.activity-counts dt, .activity-counts small { color: var(--ui-text-muted); font-size: .8125rem; }
.activity-counts dd { font-size: 1.5rem; font-weight: 650; font-variant-numeric: tabular-nums; margin: var(--space-1) 0; }
.activity-counts small { display: block; }
.metrics-overview { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 5fr); gap: var(--space-6); align-items: start; margin-bottom: var(--space-8); }
.metrics-diagnostics { border-top: 1px solid var(--ui-border); margin-top: var(--space-8); }
.metrics-diagnostics > summary { cursor: pointer; min-height: 44px; padding-block: var(--space-4); font-weight: 600; }
.diagnostic-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-8); margin-block: var(--space-4); }
.diagnostic-columns h2 { font-size: 1.125rem; margin-bottom: var(--space-4); }
.diagnostic-columns .page-note { margin-block: var(--space-4); }
.diagnostic-columns dd { overflow-wrap: anywhere; }
@media (max-width: 1000px) { .metrics-overview { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .metrics-activity { padding: var(--space-4); gap: var(--space-4); }
  .activity-summary { flex-basis: 100%; }
  .activity-counts { flex: 1 1 100%; gap: var(--space-4); }
  .activity-counts > div { flex: 1; }
  .metrics-overview, .diagnostic-columns { gap: var(--space-4); }
  .diagnostic-columns { grid-template-columns: minmax(0, 1fr); }
}
</style>
