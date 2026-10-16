<script setup lang="ts">
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import ConsumptionPanel from '../components/ConsumptionPanel.vue';
import ResourceMonitorPanel from '../components/ResourceMonitorPanel.vue';
import RunEvidencePanel from '../components/RunEvidencePanel.vue';
import { state, bytes, date } from '../store';

const env = computed(() => state.environment), worker = computed(() => state.status);
const memoryPercent = computed(() => env.value?.memory.hostTotalBytes
  ? Math.max(0, Math.min(100, Math.round((1 - env.value.memory.hostFreeBytes / env.value.memory.hostTotalBytes) * 100))) : null);
const diskAvailablePercent = computed(() => env.value?.disk?.totalBytes
  ? Math.max(0, Math.min(100, Math.round(env.value.disk.freeBytes / env.value.disk.totalBytes * 100))) : null);
</script>

<template>
  <section class="dashboard-page metrics-page">
    <div class="page-heading">
      <div><h1 tabindex="-1">Metrics</h1><p>Consumption, retained execution evidence and this worker’s health.</p></div>
      <UButton to="/settings" color="neutral" variant="outline" icon="i-lucide-settings">Worker settings</UButton>
    </div>
    <UAlert v-for="alert in state.monitoring?.alerts" :key="alert.code" :title="alert.message"
      :description="alert.remediation" color="warning" variant="soft" icon="i-lucide-triangle-alert" class="notice" />

    <ConsumptionPanel v-if="state.unlocked" readonly />
    <RunEvidencePanel v-if="state.unlocked" compact />

    <div class="monitor-columns metrics-health">
      <section class="monitor-section" aria-labelledby="worker-health-title">
        <h2 id="worker-health-title">Worker health</h2>
        <dl class="facts">
          <div><dt>Connection</dt><dd>{{ worker?.state === 'standalone' ? 'Standalone' : worker?.state ?? 'Unavailable' }}</dd></div>
          <div><dt>Orchestrator execution</dt><dd>{{ worker?.mode === 'mock' ? 'Simulation' : worker?.mode === 'cli' ? 'Live Codex' : 'Unavailable' }}</dd></div>
          <div><dt>Heartbeat errors · this process</dt><dd>{{ worker?.heartbeatErrors ?? 'Unavailable' }}</dd></div>
          <div><dt>Snapshots awaiting delivery</dt><dd>{{ worker?.outbox?.pending ?? 'Unavailable' }}</dd></div>
          <div><dt>Latest reported error</dt><dd>{{ worker ? worker.lastError ?? 'None recorded' : 'Unavailable' }}</dd></div>
        </dl>
        <p class="page-note">{{ worker?.state === 'standalone' ? 'Standalone is a healthy state. An orchestrator is optional.' : worker?.lastContact ? 'Last orchestrator contact: ' + date(worker.lastContact) + '.' : 'No orchestrator contact has been recorded.' }}</p>
      </section>
      <section class="monitor-section" aria-labelledby="host-resources-title">
        <h2 id="host-resources-title">Host &amp; state volume</h2>
        <template v-if="env">
          <div class="resource-summary">
            <div>
              <div class="measure-label"><strong>Host memory in use</strong><span>{{ memoryPercent === null ? 'Unavailable' : memoryPercent + '%' }}</span></div>
              <meter v-if="memoryPercent !== null" :value="memoryPercent" min="0" max="100" aria-label="Host memory in use" />
              <p>{{ bytes(env.memory.hostFreeBytes) }} free of {{ bytes(env.memory.hostTotalBytes) }}.</p>
            </div>
            <div>
              <div class="measure-label"><strong>State-volume space available</strong><span>{{ diskAvailablePercent === null ? 'Unavailable' : diskAvailablePercent + '%' }}</span></div>
              <meter v-if="diskAvailablePercent !== null" :value="diskAvailablePercent" min="0" max="100" aria-label="State-volume space available" />
              <p>{{ env.disk ? bytes(env.disk.freeBytes) + ' available of ' + bytes(env.disk.totalBytes) + '.' : 'No measurement from this operating system.' }}</p>
            </div>
          </div>
          <p class="page-note resource-scope">Host memory includes all processes. Volume space includes other files on the same volume.</p>
          <p class="page-note">Recorded {{ date(env.capturedAt) }}.</p>
        </template>
        <p v-else class="page-note">Environment data is unavailable. Refresh to try again.</p>
      </section>
    </div>

    <ResourceMonitorPanel v-if="state.unlocked" />

    <details class="monitor-section dashboard-disclosure">
      <summary>Runtime &amp; storage details</summary>
      <template v-if="env">
        <p class="page-note">Worker-process measurements describe Node.js and exclude model subprocesses. Host load and host memory cover the whole machine.</p>
        <dl class="facts">
          <div><dt>Host</dt><dd>{{ env.hostname }}</dd></div>
          <div><dt>Operating system</dt><dd>{{ env.platform }} {{ env.osRelease }} · {{ env.architecture }}</dd></div>
          <div><dt>Node.js / process ID</dt><dd>{{ env.nodeVersion }} / {{ env.pid }}</dd></div>
          <div><dt>Worker-process uptime</dt><dd>{{ Math.floor(env.uptimeSeconds / 60) }} min {{ Math.floor(env.uptimeSeconds % 60) }} s</dd></div>
          <div><dt>Worker-process RSS</dt><dd>{{ bytes(env.memory.processRssBytes) }}</dd></div>
          <div><dt>Worker heap used / allocated</dt><dd>{{ bytes(env.memory.heapUsedBytes) }} / {{ bytes(env.memory.heapTotalBytes) }}</dd></div>
          <div><dt>Host load · 1 / 5 / 15 min</dt><dd>{{ env.hostLoad ? env.hostLoad.map(value => value.toFixed(2)).join(' / ') : 'Unavailable on this platform' }}</dd></div>
          <div><dt>Available logical CPUs</dt><dd>{{ env.logicalCpus }}</dd></div>
          <div><dt>Orchestrator</dt><dd>{{ env.orchestratorUrl ?? 'Standalone' }}</dd></div>
          <div><dt>State directory</dt><dd>{{ env.stateDirectory }}</dd></div>
          <div><dt>Project directory</dt><dd>{{ env.projectDirectory ?? 'Not configured' }}</dd></div>
          <div><dt>Orchestrator poll interval / task timeout</dt><dd>{{ env.pollMs }} ms / {{ env.taskTimeoutMs / 1000 }} s</dd></div>
          <div><dt>Retained acknowledged pairs</dt><dd>{{ env.retainedPairs }}</dd></div>
          <div><dt>Selected task connection</dt><dd>{{ env.chat.configured ? env.chat.provider : 'Not configured' }}</dd></div>
        </dl>
      </template>
      <p v-else class="page-note">Runtime details are unavailable. Refresh to try again.</p>
      <p class="page-note">Configured connections do not verify sign-in, quota or remaining subscription. Reported usage and cost appear in execution evidence when supplied by a provider.</p>
    </details>
    <details class="monitor-section dashboard-disclosure">
      <summary>Diagnostics &amp; evidence identifiers</summary>
      <dl class="facts">
        <div><dt>Worker ID</dt><dd>{{ worker?.workerId ?? (worker ? 'Not registered' : 'Unavailable') }}</dd></div>
        <div><dt>Completed simulations · this process</dt><dd>{{ worker?.completedSimulations ?? 'Unavailable' }}</dd></div>
        <div><dt>Change sets for review · this process</dt><dd>{{ worker?.completedReviews ?? 'Unavailable' }}</dd></div>
        <div><dt>Configuration hash</dt><dd>{{ worker?.configurationHash ?? 'Unavailable' }}</dd></div>
        <div><dt>Latest snapshot</dt><dd>{{ worker ? worker.lastSnapshot ?? 'None recorded in this process' : 'Unavailable' }}</dd></div>
        <div><dt>Status recorded</dt><dd>{{ date(worker?.updatedAt) }}</dd></div>
      </dl>
      <UButton to="/status" target="_blank" color="neutral" variant="outline" icon="i-lucide-braces">Status JSON</UButton>
    </details>
  </section>
</template>

<style scoped>
.metrics-page { min-width: 0; }
.metrics-page > .page-heading :deep(a), .metrics-page :deep(.run-evidence > .section-heading > a) { min-height: 44px; }
.metrics-page > .monitor-section { margin-bottom: var(--space-8); }
.metrics-health { gap: var(--space-8); padding-top: var(--space-4); border-top: 1px solid var(--ui-border); }
.metrics-health .page-note { margin-top: var(--space-4); }
.metrics-health h2 { margin-bottom: var(--space-4); }
.resource-scope { max-width: 65ch; }
.metrics-page > .dashboard-disclosure { margin-bottom: 0; }
@media (max-width: 760px) { .metrics-health { gap: 0; } }
</style>
