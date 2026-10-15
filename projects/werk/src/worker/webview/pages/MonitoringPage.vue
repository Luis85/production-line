<script setup lang="ts">
import ProjectIntegrationsPanel from '../components/ProjectIntegrationsPanel.vue';
import ResourceMonitorPanel from '../components/ResourceMonitorPanel.vue';
import RunEvidencePanel from '../components/RunEvidencePanel.vue';
import FeatureRequestsPanel from '../components/FeatureRequestsPanel.vue';
import { computed, nextTick, onActivated, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import RequestPolicyPanel from '../components/RequestPolicyPanel.vue';
import SettingsPanel from '../components/SettingsPanel.vue';
import DefinitionPanel from '../components/DefinitionPanel.vue';
import { state, bytes, date, workspaceAction } from '../store';

const router = useRouter(), route = useRoute();
const providerDetails = ref<HTMLDetailsElement | null>(null), definitionDetails = ref<HTMLDetailsElement | null>(null);
async function openLinkedSettings() {
  if (route.path !== '/dashboard') return;
  const path = route.fullPath;
  await nextTick();
  if (route.fullPath !== path) return;
  const target = route.hash === '#provider-connections' ? providerDetails.value : route.hash === '#agent-definitions' ? definitionDetails.value : null;
  if (!target) return;
  target.open = true;
  target.querySelector('summary')?.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start' });
}
watch(() => route.fullPath, () => { void openLinkedSettings(); });
onActivated(() => { void openLinkedSettings(); });
const queueBusy = ref(false), opening = ref(false), actionError = ref('');
const env = computed(() => state.environment), worker = computed(() => state.status);
const runningSession = computed(() => state.sessions?.records.find(item => item.id === state.sessions?.execution.currentSessionId));
const reviews = computed(() => state.board?.tasks.filter(task => task.status === 'review' && !task.archived).length ?? 0);
const inputNeeded = computed(() => state.sessions?.records.filter(task => ['waiting_input', 'escalated'].includes(task.status) && !task.archived).length ?? 0);
const failures = computed(() => state.sessions?.records.filter(task => task.status === 'failed' && !task.archived).length ?? 0);
const executionTitle = computed(() => {
  if (!state.sessions) return 'Loading worker activity…';
  if (runningSession.value) return runningSession.value.title;
  if (state.sessions.execution.currentSessionId) return 'Task running';
  if (state.settings?.board.paused) return 'Queue paused';
  return 'Ready for your next task';
});
const executionNote = computed(() => state.settings?.board.paused
  ? 'New work can join the queue. Waiting tasks will start when you resume; an active task can finish.'
  : 'Chat, file tasks and assignments share one execution slot. Waiting work starts automatically.');
const memoryPercent = computed(() => env.value?.memory.hostTotalBytes ? Math.round((1 - env.value.memory.hostFreeBytes / env.value.memory.hostTotalBytes) * 100) : 0);
const diskPercent = computed(() => env.value?.disk?.totalBytes ? Math.round((1 - env.value.disk.freeBytes / env.value.disk.totalBytes) * 100) : 0);

async function toggleQueue() {
  if (queueBusy.value || !state.settings) return;
  queueBusy.value = true; actionError.value = '';
  try {
    if (!await workspaceAction('/api/settings', { board: { paused: !state.settings.board.paused } })) {
      actionError.value = state.actionError || 'The queue could not be updated. Refresh and try again.';
    }
  } finally { queueBusy.value = false; }
}
async function openRunning() {
  const id = runningSession.value?.id;
  if (!id || opening.value) return;
  opening.value = true; actionError.value = '';
  try {
    if (await workspaceAction('/api/sessions', { action: 'select', id })) await router.push({ path: '/taskboard', query: { session: id } });
    else actionError.value = state.actionError || 'The task could not be opened. Refresh and try again.';
  } finally { opening.value = false; }
}
</script>

<template>
  <section class="dashboard-page">
    <div class="page-heading">
      <div><h1 tabindex="-1">Worker dashboard</h1><p>Current work, items to review and the health of this worker.</p></div>
      <UButton to="/taskboard" color="neutral" variant="outline" icon="i-lucide-layout-dashboard">Open taskboard</UButton>
    </div>
    <UAlert v-for="alert in state.monitoring?.alerts" :key="alert.code" :title="alert.message"
      :description="alert.remediation" color="warning" variant="soft" icon="i-lucide-triangle-alert" class="notice" />

    <section class="monitor-section activity-overview" aria-labelledby="activity-title">
      <div class="section-heading">
        <h2 id="activity-title">Work in progress</h2>
        <UButton color="neutral" variant="outline" :loading="queueBusy" :disabled="!state.settings"
          :icon="state.settings?.board.paused ? 'i-lucide-play' : 'i-lucide-pause'" @click="toggleQueue">
          {{ state.settings?.board.paused ? 'Resume queue' : 'Pause queue' }}
        </UButton>
      </div>
      <div class="execution-summary" :class="{ occupied: !!state.sessions?.execution.currentSessionId }">
        <UIcon :name="state.sessions?.execution.currentSessionId ? 'i-lucide-loader-circle' : state.settings?.board.paused ? 'i-lucide-pause' : 'i-lucide-circle-check'" />
        <div class="execution-copy">
          <UBadge v-if="state.sessions?.execution.currentSessionId" color="primary" variant="subtle">Running</UBadge>
          <h3>{{ executionTitle }}</h3>
          <p>{{ runningSession ? runningSession.provider + ' · one task at a time' : executionNote }}</p>
        </div>
        <UButton v-if="runningSession" color="neutral" variant="outline" :loading="opening" :disabled="state.workspaceBusy" @click="openRunning">Open running task</UButton>
      </div>
      <p v-if="runningSession && state.settings?.board.paused" class="page-note">The queue is paused. This task can finish; waiting tasks will not start.</p>
      <p v-if="actionError" role="alert" class="error-text">{{ actionError }}</p>
      <p v-if="inputNeeded" class="needs-input-notice" role="status"><RouterLink to="/history?taskState=attention">{{ inputNeeded }} {{ inputNeeded === 1 ? 'task needs' : 'tasks need' }} your answer or decision →</RouterLink></p>
      <ul class="activity-links" aria-label="Work queues">
        <li><RouterLink to="/history"><strong>{{ state.sessions?.execution.queued ?? '—' }}</strong><span>Waiting tasks</span><UIcon name="i-lucide-arrow-up-right" /></RouterLink></li>
        <li><RouterLink to="/history?fileState=review"><strong>{{ state.board ? reviews : '—' }}</strong><span>Review patches</span><UIcon name="i-lucide-arrow-up-right" /></RouterLink></li>
        <li><RouterLink to="/history?taskState=failed"><strong>{{ state.sessions ? failures : '—' }}</strong><span>Failed tasks</span><UIcon name="i-lucide-arrow-up-right" /></RouterLink></li>
      </ul>
      <p class="page-note">{{ state.sessions?.records.filter(session => !session.archived).length ?? '—' }} saved tasks · {{ worker?.queuedTasks?.length ?? 0 }} remote assignments waiting</p>
    </section>

    <div class="monitor-columns">
      <section class="monitor-section">
        <h2>Worker health</h2>
        <dl class="facts">
          <div><dt>Connection</dt><dd>{{ worker?.state === 'standalone' ? 'Standalone' : worker?.state ?? 'Loading…' }}</dd></div>
          <div><dt>Orchestrator execution</dt><dd>{{ worker?.mode === 'mock' ? 'Simulation' : worker?.mode === 'cli' ? 'Live Codex' : 'Unavailable' }}</dd></div>
          <div><dt>Heartbeat errors · this process</dt><dd>{{ worker?.heartbeatErrors ?? '—' }}</dd></div>
          <div><dt>Latest reported error</dt><dd>{{ worker?.lastError ?? 'None recorded' }}</dd></div>
        </dl>
      </section>
      <section class="monitor-section">
        <h2>Environment resources</h2>
        <template v-if="env">
          <div class="resource-summary">
            <div><div class="measure-label"><strong>Host memory</strong><span>{{ memoryPercent }}%</span></div><meter :value="memoryPercent" min="0" max="100" aria-label="Host memory in use" /><p>{{ bytes(env.memory.hostFreeBytes) }} free of {{ bytes(env.memory.hostTotalBytes) }}</p></div>
            <div><div class="measure-label"><strong>State-volume space</strong><span>{{ env.disk ? diskPercent + '%' : 'Unavailable' }}</span></div><meter v-if="env.disk" :value="diskPercent" min="0" max="100" aria-label="State volume used" /><p>{{ env.disk ? bytes(env.disk.freeBytes) + ' available of ' + bytes(env.disk.totalBytes) : 'No measurement from this operating system.' }}</p></div>
          </div>
        </template>
        <p v-else class="page-note">Environment data is unavailable. Refresh to try again.</p>
      </section>
    </div>

    <ResourceMonitorPanel v-if="state.unlocked" />
    <ProjectIntegrationsPanel v-if="state.unlocked" />
    <RunEvidencePanel v-if="state.unlocked" compact />
    <FeatureRequestsPanel v-if="state.unlocked" compact />
    <details id="provider-connections" ref="providerDetails" class="monitor-section dashboard-disclosure">
      <summary>Provider connections &amp; orchestrator enrollment</summary>
      <SettingsPanel />
      <RequestPolicyPanel />
    </details>
    <details id="agent-definitions" ref="definitionDetails" class="monitor-section dashboard-disclosure">
      <summary>Agent definitions</summary>
      <DefinitionPanel />
    </details>
    <details class="monitor-section dashboard-disclosure">
      <summary>Connections &amp; delivery</summary>
      <div class="worker-map" role="group" aria-label="Worker environment and current connections">
        <div class="map-node"><UIcon name="i-lucide-network" /><strong>Orchestrator</strong><span>{{ worker?.lastContact ? 'Last contact ' + date(worker.lastContact) : worker?.state === 'standalone' ? 'Optional · not connected' : 'No contact recorded' }}</span></div>
        <div class="map-link" aria-hidden="true"></div>
        <div class="map-node current"><UIcon name="i-lucide-cpu" /><strong>{{ worker?.project ?? 'This worker' }}</strong><UBadge :color="['idle', 'executing', 'standalone'].includes(worker?.state ?? '') ? 'primary' : 'warning'" variant="subtle">{{ worker?.state ?? 'Connecting' }}</UBadge></div>
        <div class="map-link" aria-hidden="true"></div>
        <div class="map-node"><UIcon name="i-lucide-hard-drive" /><strong>Local journal</strong><span>{{ worker?.outbox ? worker.outbox.pending + ' snapshots awaiting delivery' : 'Delivery state unavailable' }}</span></div>
      </div>
      <dl class="facts">
        <div><dt>Worker ID</dt><dd>{{ worker?.workerId ?? 'Not registered' }}</dd></div>
        <div><dt>Completed simulations · this process</dt><dd>{{ worker?.completedSimulations ?? '—' }}</dd></div>
        <div><dt>Change sets for review · this process</dt><dd>{{ worker?.completedReviews ?? '—' }}</dd></div>
      </dl>
    </details>
    <details class="monitor-section dashboard-disclosure">
      <summary>Runtime, storage &amp; execution profiles</summary>
      <template v-if="env">
        <p class="page-note">Host and process measurements exclude the model subprocess. {{ env.chat.configured ? 'Selected task provider: ' + env.chat.provider + '.' : 'The selected task provider is not configured.' }}</p>
        <dl class="facts">
          <div><dt>Host</dt><dd>{{ env.hostname }}</dd></div>
          <div><dt>Operating system</dt><dd>{{ env.platform }} {{ env.osRelease }} · {{ env.architecture }}</dd></div>
          <div><dt>Node.js / process ID</dt><dd>{{ env.nodeVersion }} / {{ env.pid }}</dd></div>
          <div><dt>Uptime</dt><dd>{{ Math.floor(env.uptimeSeconds / 60) }} min {{ Math.floor(env.uptimeSeconds % 60) }} s</dd></div>
          <div><dt>Worker-process RSS</dt><dd>{{ bytes(env.memory.processRssBytes) }}</dd></div>
          <div><dt>Worker heap used / allocated</dt><dd>{{ bytes(env.memory.heapUsedBytes) }} / {{ bytes(env.memory.heapTotalBytes) }}</dd></div>
          <div><dt>Host load · 1 / 5 / 15 min</dt><dd>{{ env.hostLoad ? env.hostLoad.map(value => value.toFixed(2)).join(' / ') : 'Unavailable on this platform' }}</dd></div>
          <div><dt>Available logical CPUs</dt><dd>{{ env.logicalCpus }}</dd></div>
          <div><dt>Orchestrator</dt><dd>{{ env.orchestratorUrl ?? 'Standalone' }}</dd></div>
          <div><dt>State directory</dt><dd>{{ env.stateDirectory }}</dd></div>
          <div><dt>Project directory</dt><dd>{{ env.projectDirectory ?? 'Not configured' }}</dd></div>
          <div><dt>Poll interval / task timeout</dt><dd>{{ env.pollMs }} ms / {{ env.taskTimeoutMs / 1000 }} s</dd></div>
          <div><dt>Retained acknowledged pairs</dt><dd>{{ env.retainedPairs }}</dd></div>
        </dl>
      </template>
      <ul class="profile-list"><li v-for="profile in worker?.profiles" :key="profile.id"><UIcon name="i-lucide-box" /><div><strong>{{ profile.id }}</strong><span>{{ profile.provider }} · {{ profile.mode === 'mock' ? 'Simulated' : 'Live CLI' }}</span></div></li></ul>
      <p class="page-note">Configured profiles do not verify login, quota or remaining subscription. Execution evidence shows usage and reported cost when a provider supplies them; subscription balances and remaining quota are unavailable.</p>
    </details>
    <details class="monitor-section dashboard-disclosure">
      <summary>Diagnostics &amp; evidence identifiers</summary>
      <dl class="facts">
        <div><dt>Configuration hash</dt><dd>{{ worker?.configurationHash ?? 'Unavailable' }}</dd></div>
        <div><dt>Latest snapshot</dt><dd>{{ worker?.lastSnapshot ?? 'None recorded in this process' }}</dd></div>
        <div><dt>Status recorded</dt><dd>{{ date(worker?.updatedAt) }}</dd></div>
      </dl>
      <UButton to="/status" target="_blank" color="neutral" variant="outline" icon="i-lucide-braces">Status JSON</UButton>
    </details>
  </section>
</template>
