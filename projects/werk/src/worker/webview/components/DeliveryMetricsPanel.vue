<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { DeliveryMetricsReport } from '../../application/delivery-metrics-contracts';
import { request, state, date } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { executionWindows, type ExecutionWindow, reportedCount, reportedCost } from '../metrics-execution';
import { deliveryMetricCards, deliveryMetricDuration, deliveryMetricInterval, deliverySubmissionCoverage } from '../metrics-delivery';
const window = ref<ExecutionWindow>('7d'), projectId = ref(''), profileId = ref('');
const { data, error, loading, refreshing, readAt, now, refresh } = useWorkerSnapshot(() => request<DeliveryMetricsReport>('/api/requests', 'POST', { action: 'metrics', ...deliveryMetricInterval(window.value, Date.now()), ...(projectId.value ? { projectId: projectId.value } : {}), ...(profileId.value ? { profileId: profileId.value } : {}) }), [window, projectId, profileId]);
const projects = ref<string[]>([]), profiles = ref<string[]>([]);
watch(data, value => { if (value) { projects.value = value.projects; profiles.value = value.profiles; } });
watch(() => state.unlocked, value => { if (!value) { projects.value = []; profiles.value = []; } });
const cards = computed(() => data.value ? deliveryMetricCards(data.value) : []);
const stale = computed(() => state.paused || !!error.value || !!readAt.value && now.value - Date.parse(readAt.value) > 15000);
const longestBlocker = computed(() => Math.max(1, ...data.value?.blockers.map(item => item.totalMs) ?? []));
</script>
<template>
  <section class="delivery-metrics" aria-labelledby="delivery-metrics-title">
    <header><div><h2 id="delivery-metrics-title">Feature Request outcomes</h2><p>Delivery lifecycle measurements for this worker’s retained requests. Model attempts are shown separately below.</p></div><UButton color="neutral" variant="outline" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh outcomes</UButton></header>
    <div class="metric-filters">
      <div><label for="delivery-metrics-window">Submitted within</label><select id="delivery-metrics-window" v-model="window"><option v-for="item in executionWindows" :key="item.value" :value="item.value">{{ item.label }}</option></select></div>
      <div><label for="delivery-metrics-project">Project</label><select id="delivery-metrics-project" v-model="projectId"><option value="">All retained projects</option><option v-for="id in projects" :key="id" :value="id">{{ id }}</option></select></div>
      <div><label for="delivery-metrics-profile">Quality profile</label><select id="delivery-metrics-profile" v-model="profileId"><option value="">All quality profiles</option><option v-for="id in profiles" :key="id" :value="id">{{ id }}</option></select></div>
    </div>
    <p v-if="error" class="error-text" role="alert">Delivery metrics could not be refreshed. {{ error }} {{ data ? 'The last successful snapshot is shown.' : 'Refresh to try again.' }}</p>
    <p v-else-if="loading && !data" role="status">Reading canonical request outcomes…</p>
    <template v-if="data">
      <p class="cohort">{{ data.cohort.requests }} {{ data.cohort.requests === 1 ? 'request' : 'requests' }} in this cohort · {{ data.cohort.completeHistories }} complete retained histories. {{ stale ? 'Last successful update' : 'Updated' }} {{ date(readAt) }}.</p>
      <p v-if="data.cohort.unknownSubmissionTimes" class="cohort">{{ deliverySubmissionCoverage(data.cohort) }}</p>
      <p v-if="!data.cohort.requests" class="empty">No retained requests match this cohort. Try a wider window or another project.</p>
      <dl class="metric-cards"><div v-for="card in cards" :key="card.id" :data-delivery-metric="card.id"><dt>{{ card.title }}</dt><dd>{{ card.value }}</dd><p class="coverage">{{ card.coverage }}</p><p>{{ card.description }}</p></div></dl>
      <div class="metric-details">
        <section aria-labelledby="delivery-blockers-title"><h3 id="delivery-blockers-title">What work waits for</h3>
          <ul v-if="data.blockers.length" class="blocker-list"><li v-for="row in data.blockers" :key="row.category"><div><strong>{{ row.category }}</strong><span>{{ deliveryMetricDuration(row.totalMs) }} · {{ row.waits }} waits · {{ row.active }} active</span></div><div class="blocker-track" aria-hidden="true"><i :style="{ width: Math.max(1, row.totalMs / longestBlocker * 100) + '%' }" /></div></li></ul>
          <p v-else>No measured blocker intervals in this cohort. Older histories may lack blocker instrumentation.</p>
        </section>
        <section aria-labelledby="delivery-clarification-title"><h3 id="delivery-clarification-title">Clarification by profile and cause</h3>
          <ul v-if="data.clarification.groups.length"><li v-for="row in data.clarification.groups" :key="row.profileId + ':' + row.cause">{{ row.profileId }} · {{ row.cause }}: {{ row.completedCycles }} completed cycles · {{ row.cycles }} asked rounds · {{ row.pendingCycles }} pending · {{ row.unknownCycles }} completion unknown</li></ul><p v-else>No explicit question rounds are recorded in the measured histories.</p>
        </section>
      </div>
      <details><summary>Measurement coverage and interpretation</summary>
        <ul><li v-for="note in data.notes" :key="note">{{ note }}</li></ul>
        <p>Feedback p50: {{ deliveryMetricDuration(data.firstFeedback.p50Ms) }}. Provider-time coverage: {{ data.firstFeedback.providerPortion.samples }} measured / {{ data.firstFeedback.providerPortion.unknown }} unknown. Review-time sources: {{ data.review.effortSources.join(', ') || 'None recorded' }}.</p>
        <p>Accepted-request reported input: {{ reportedCount(data.consumption.inputTokens) }} tokens; output: {{ reportedCount(data.consumption.outputTokens) }} tokens; cost: {{ reportedCost(data.consumption.costUsd) }}. Cost is complete for {{ data.consumption.costMeasuredRequests }} of {{ data.consumption.acceptedRequests }} accepted requests.</p>
        <p>Usage sources: {{ data.consumption.sources.join(', ') || 'Unavailable' }}. Cost basis: {{ data.consumption.costBases.join(', ') || 'Unavailable' }}. Partial totals exclude unreported values and delegated calls whose overlap is unknown. Cost is not a verified invoice or subscription balance.</p>
        <p v-if="data.integrity.categories.length">Incident categories: {{ data.integrity.categories.map(row => row.category + ': ' + row.count).join('; ') }}.</p>
      </details>
    </template>
  </section>
</template>
<style scoped>
.delivery-metrics { border-top: 1px solid var(--ui-border); padding-block: var(--space-6); min-width: 0; }header { display: flex; justify-content: space-between; gap: var(--space-4); align-items: flex-start; flex-wrap: wrap; }h2 { font-size: 1.125rem; margin: 0; }h3 { font-size: .9375rem; }p,li { font-size: .8125rem; line-height: 1.65; color: var(--ui-text-muted); }header p { margin-bottom: 0; max-width: 75ch; }.metric-filters { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-block: var(--space-6); }.metric-filters > div { flex: 1; min-width: 180px; }label { display: block; font-size: .8125rem; margin-bottom: var(--space-2); }select { background: var(--ui-bg); color: var(--ui-text); border: 1px solid var(--ui-border); padding-inline: var(--space-3); min-height: 44px; border-radius: 6px; width: 100%; }.metric-cards { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: var(--space-6); margin: var(--space-6) 0; }.metric-cards > div { border-top: 2px solid var(--ui-border); padding-top: var(--space-4); min-width: 0; }.metric-cards dt { font-size: .875rem; font-weight: 600; }.metric-cards dd { font-size: 1.75rem; font-variant-numeric: tabular-nums; margin: var(--space-3) 0; overflow-wrap: anywhere; }.coverage { color: var(--ui-text); }.metric-details { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-8); }.blocker-list { list-style: none; margin: 0; padding: 0; }.blocker-list li { margin-block: var(--space-4); }.blocker-list li > div:first-child { display: flex; justify-content: space-between; gap: var(--space-3); }.blocker-list strong { text-transform: capitalize; font-weight: 550; }.blocker-track { height: 6px; margin-top: var(--space-2); background: var(--ui-bg-accented); border-radius: 3px; overflow: hidden; }.blocker-track i { display: block; height: 100%; background: var(--ui-warning); }summary { min-height: 44px; padding-block: var(--space-3); font-size: .875rem; cursor: pointer; }:deep(button) { min-height: 44px; }.empty { padding-block: var(--space-3); }@media(max-width:1000px) { .metric-cards { grid-template-columns: repeat(2,minmax(0,1fr)); } }@media(max-width:560px) { .metric-cards,.metric-details { grid-template-columns: 1fr; }.metric-cards { gap: var(--space-4); }.blocker-list li > div:first-child { flex-wrap: wrap; } }
</style>
