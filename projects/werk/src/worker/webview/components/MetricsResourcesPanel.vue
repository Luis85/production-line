<script setup lang="ts">
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import type { ResourceStatus } from '../../application/resources';
import ResourceMonitorPanel from './ResourceMonitorPanel.vue';
import { state, request, bytes, date } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { resourceMetrics, resourceSampleState, measurementStale, type ResourceMetric } from '../metrics-resources';

const { data: report, error, loading, refreshing, now, refresh } = useWorkerSnapshot<ResourceStatus>(() => request('/api/resources'));
const metrics = computed(() => resourceMetrics(report.value));
const sample = computed(() => resourceSampleState(report.value, now.value, state.paused, error.value));
const host = computed(() => state.environment);
const hostStale = computed(() => state.paused || !!state.environmentError || !state.environmentReadAt || measurementStale(host.value?.capturedAt, 10000, now.value));
const hostPercent = computed(() => {
  const memory = host.value?.memory;
  return memory && memory.hostTotalBytes > 0 ? (1 - memory.hostFreeBytes / memory.hostTotalBytes) * 100 : null;
});
const percentage = (value: number | null) => value === null ? 'Unavailable' : value.toFixed(1) + '%';
const meterValue = (value: number) => Math.max(0, Math.min(100, value));
const valueText = (metric: ResourceMetric) => metric.id === 'cpu' ? percentage(metric.value) : bytes(metric.value);
function comparison(metric: ResourceMetric) {
  if (metric.id === 'cpu') return metric.value === null ? 'CPU needs two samples from this worker process.' : 'Normalized across ' + metric.capacity + ' available CPU cores.';
  if (!metric.capacity) return 'Capacity unavailable; no percentage comparison.';
  return percentage(metric.percent) + (metric.id === 'disk' ? ' free of ' : ' of ') + bytes(metric.capacity) + (metric.id === 'memory' ? ' effective capacity.' : metric.id === 'heap' ? ' heap limit.' : ' volume capacity.');
}
function threshold(metric: ResourceMetric) {
  if (!report.value) return 'Warning policy unavailable.';
  if (metric.id === 'disk') return 'Warn below ' + report.value.policy.diskFreePercent + '% free or ' + bytes(report.value.policy.diskFreeBytes) + '.';
  if (metric.id === 'cpu') return 'Warn at ' + report.value.policy.cpuPercent + '% for ' + report.value.policy.cpuSustainMs / 1000 + ' seconds.';
  return 'Warn at ' + metric.thresholdPercent + '%.';
}
</script>

<template>
  <section id="resource-monitor" class="metrics-resources" aria-labelledby="metrics-resources-title">
    <header class="resources-heading">
      <div><p class="eyebrow">Machine resources</p><h2 id="metrics-resources-title">Worker &amp; host</h2></div>
      <UBadge :color="sample.stale ? 'neutral' : 'primary'" variant="subtle">{{ sample.label }}</UBadge>
    </header>
    <p class="resource-scope">CPU, resident memory and heap measure the worker’s Node.js process. Model subprocesses are excluded.</p>
    <p v-if="sample.message" class="resource-notice" role="status">{{ sample.message }}</p>
    <p v-else-if="loading && !report" class="resource-notice" role="status">Reading this worker’s resource measurements…</p>
    <p v-else-if="sample.unavailable" class="resource-notice">No resource sample is available yet.</p>
    <div class="resource-grid">
      <article v-for="metric in metrics" :key="metric.id" class="resource-metric" :data-resource="metric.id" :class="{ 'has-warning': metric.warning }">
        <div class="metric-heading"><h3 :id="'resource-' + metric.id + '-title'">{{ metric.label }}</h3><span v-if="metric.warning" class="metric-warning">{{ sample.stale ? 'Reported alert' : 'Alert active' }}</span></div>
        <p class="metric-value">{{ valueText(metric) }}</p>
        <div v-if="metric.percent !== null" class="meter-track">
          <meter :value="meterValue(metric.percent)" min="0" max="100" :aria-label="metric.label" :aria-valuetext="percentage(metric.percent)" :aria-describedby="'resource-' + metric.id + '-comparison resource-' + metric.id + '-threshold'" />
          <span v-if="metric.thresholdPercent !== null" class="threshold-marker" :style="{ left: meterValue(metric.thresholdPercent) + '%' }" aria-hidden="true" />
        </div>
        <div v-else class="meter-unavailable" aria-hidden="true" />
        <p :id="'resource-' + metric.id + '-comparison'" class="metric-context">{{ comparison(metric) }}</p>
        <p :id="'resource-' + metric.id + '-threshold'" class="metric-threshold">{{ threshold(metric) }}</p>
      </article>
    </div>
    <p class="volume-scope">State-volume space includes all files on the same volume. It is not the size of Werk’s files.</p>
    <div class="host-context">
      <div><h3>Host memory in use</h3><p>Whole machine, including other applications.</p></div>
      <div class="host-reading"><strong>{{ percentage(hostPercent) }}</strong><span>{{ host ? bytes(host.memory.hostFreeBytes) + ' free of ' + bytes(host.memory.hostTotalBytes) : 'Host measurements unavailable' }}</span></div>
      <p v-if="hostStale" class="host-stale">{{ state.environmentError ? 'Host measurements could not be refreshed. Last reported values are shown.' : host ? 'Host measurements are paused or stale.' : 'No host sample yet.' }}</p>
      <p v-if="host" class="host-timestamp">{{ hostStale ? 'Last host sample' : 'Host sample' }}: {{ date(host.capturedAt) }}</p>
    </div>
    <footer class="resources-footer">
      <p>{{ report?.snapshot ? 'Sample: ' + date(report.snapshot.capturedAt) : 'Waiting for a sample' }}<span v-if="report"> · every {{ report.sampleIntervalMs / 1000 }}s</span></p>
      <UButton v-if="sample.stale || sample.unavailable" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh resources</UButton>
    </footer>
    <details class="resource-details">
      <summary>Alerts &amp; task monitoring <span v-if="report?.alerts.length">· {{ report.alerts.length }} {{ sample.stale ? 'reported' : 'active' }}</span></summary>
      <ResourceMonitorPanel :resource-report="report" alerts-only />
    </details>
  </section>
</template>

<style scoped>
.metrics-resources { min-width: 0; border: 1px solid var(--ui-border); border-radius: 12px; padding: var(--space-6); background: var(--ui-bg-muted); }
.resources-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); }
h2, h3, p { margin: 0; }
h2 { color: var(--ui-text-highlighted); font-size: 1.125rem; }
.eyebrow { color: var(--ui-text-muted); font-size: .8125rem; margin-bottom: var(--space-1); }
.resource-scope, .volume-scope { color: var(--ui-text-muted); font-size: .875rem; line-height: 1.6; }
.resource-scope { margin-top: var(--space-3); }
.resource-notice { margin-top: var(--space-3); padding: var(--space-3); border: 1px solid var(--ui-border); border-radius: 12px; font-size: .8125rem; }
.resource-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); margin-top: var(--space-6); }
.resource-metric { min-width: 0; }
.metric-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-1); }
h3 { color: var(--ui-text-muted); font-size: .875rem; font-weight: 500; }
.metric-warning { color: var(--ui-warning, #edc47e); font-size: .8125rem; }
.metric-value { font-size: clamp(1.25rem, 2vw, 1.625rem); line-height: 1.4; font-weight: 650; color: var(--ui-text-highlighted); margin-top: var(--space-1); font-variant-numeric: tabular-nums; }
.meter-track { position: relative; margin-block: var(--space-2); height: 8px; }
meter { display: block; width: 100%; height: 8px; border: 0; border-radius: 4px; overflow: hidden; background: var(--ui-bg-accented); accent-color: var(--ui-primary); }
meter::-webkit-meter-bar { background: var(--ui-bg-accented); border: 0; border-radius: 4px; }
meter::-webkit-meter-optimum-value { background: var(--ui-primary); }
meter::-moz-meter-bar { background: var(--ui-primary); }
.has-warning meter::-webkit-meter-optimum-value { background: var(--ui-warning, #edc47e); }
.has-warning meter::-moz-meter-bar { background: var(--ui-warning, #edc47e); }
.threshold-marker { position: absolute; top: -2px; height: 12px; width: 2px; background: var(--ui-text-muted); transform: translateX(-1px); }
.meter-unavailable { height: 8px; border: 1px dashed var(--ui-border-accented); border-radius: 4px; margin-block: var(--space-2); }
.metric-context, .metric-threshold { font-size: .8125rem; color: var(--ui-text-muted); line-height: 1.6; overflow-wrap: anywhere; }
.metric-threshold { margin-top: 2px; }
.volume-scope { margin-top: var(--space-3); }
.host-context { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: var(--space-2); border-top: 1px solid var(--ui-border); margin-top: var(--space-4); padding-top: var(--space-3); }
.host-context p, .host-reading span { font-size: .8125rem; color: var(--ui-text-muted); }
.host-reading { display: grid; text-align: right; font-variant-numeric: tabular-nums; }
.host-reading strong { font-size: .875rem; font-weight: 600; }
.host-stale, .host-timestamp { grid-column: 1 / -1; }
.resources-footer { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-top: var(--space-3); }
.resources-footer p { font-size: .8125rem; color: var(--ui-text-muted); }
.resources-footer :deep(button) { min-height: 44px; }
.resource-details { border-top: 1px solid var(--ui-border); margin-top: var(--space-3); }
.resource-details summary { min-height: 44px; padding-block: var(--space-3); font-size: .8125rem; font-weight: 600; cursor: pointer; }
.resource-details summary span { font-weight: 400; }
.resource-details :deep(.monitor-section) { padding: 0; margin: 0; border: 0; }
.resource-details :deep(h2) { font-size: .875rem; }
.resource-details :deep(summary) { min-height: 44px; }
.resource-details :deep(button), .resource-details :deep(a) { min-height: 44px; }
@media (max-width: 460px) {
  .metrics-resources { padding: var(--space-4); }
  .resource-grid { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .resource-metric + .resource-metric { padding-top: var(--space-3); border-top: 1px solid var(--ui-border); }
  .host-context { grid-template-columns: minmax(0, 1fr); }
  .host-reading { text-align: left; }
}
</style>
