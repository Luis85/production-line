<script setup lang="ts">
import { computed, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { RunAnalysis } from '../../application/run-evidence';
import type { ExecutionSnapshot, ExecutionWindow } from '../metrics-execution';
import { executionInterval, executionOutcomes, executionWindows, measuredDuration, reportedCost, reportedCount } from '../metrics-execution';
import { request, state } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';

const window = ref<ExecutionWindow>('7d');
const { data, error, loading, refreshing, readAt, now, refresh } = useWorkerSnapshot<ExecutionSnapshot>(async () => {
  const selected = window.value, interval = executionInterval(selected, Date.now());
  const analysis = await request<RunAnalysis>('/api/runs', 'POST', { action: 'analyze', ...interval });
  return { analysis, window: selected, interval };
}, [() => window.value]);
const analysis = computed(() => data.value?.analysis);
const distribution = computed(() => analysis.value ? executionOutcomes(analysis.value) : []);
const usage = computed(() => analysis.value?.consumption);
const stale = computed(() => !!data.value && (state.paused || !!error.value || now.value - Date.parse(readAt.value) > 15_000));
const timestamp = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<template>
  <section class="execution-metrics monitor-section" aria-labelledby="execution-metrics-title">
    <header class="execution-heading">
      <div><h2 id="execution-metrics-title">Execution activity</h2><p>Attempts accepted in this window. Each retry counts separately.</p></div>
      <div class="execution-controls">
        <div><label for="execution-window">Accepted within</label><select id="execution-window" v-model="window"><option v-for="option in executionWindows" :key="option.value" :value="option.value">{{ option.label }}</option></select></div>
        <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh activity</UButton>
      </div>
    </header>

    <p v-if="error" role="alert" class="execution-error">Execution activity could not be refreshed. {{ error }} {{ data ? 'The last successful snapshot is shown.' : 'Use Refresh activity to retry.' }}</p>
    <p v-if="loading && !data" role="status" class="execution-empty">Loading execution activity…</p>
    <template v-if="analysis">
      <p v-if="!analysis.total" class="execution-empty">No retained attempts were accepted in this window.</p>
      <template v-else>
        <div class="execution-total"><strong>{{ analysis.total.toLocaleString() }}</strong><span>retained {{ analysis.total === 1 ? 'attempt' : 'attempts' }}</span></div>
        <figure class="execution-distribution">
          <figcaption>Outcome distribution</figcaption>
          <div class="execution-bar" aria-hidden="true"><span v-for="item in distribution.filter(item => item.count > 0)" :key="item.key" :class="'tone-' + item.tone" :style="{ width: item.percent + '%' }"></span></div>
          <dl class="execution-outcomes"><div v-for="item in distribution" :key="item.key"><dt><i :class="'tone-' + item.tone" aria-hidden="true"></i>{{ item.label }}</dt><dd>{{ item.count.toLocaleString() }}</dd></div></dl>
        </figure>
        <p class="execution-note">Completed attempts are execution outcomes, not a count of delivered Feature Requests.</p>
        <dl class="execution-measurements">
          <div><dt>Average execution time</dt><dd data-execution-metric="duration">{{ measuredDuration(analysis.duration.meanMs) }}</dd><span>{{ analysis.duration.measuredRuns }} of {{ analysis.total }} attempts measured</span></div>
          <div><dt>Input tokens</dt><dd data-execution-metric="input-tokens">{{ reportedCount(usage?.inputTokens) }}</dd><span>{{ usage?.coverage.inputTokens ?? 0 }} of {{ analysis.total }} attempts report input</span></div>
          <div><dt>Output tokens</dt><dd data-execution-metric="output-tokens">{{ reportedCount(usage?.outputTokens) }}</dd><span>{{ usage?.coverage.outputTokens ?? 0 }} of {{ analysis.total }} attempts report output</span></div>
          <div><dt>Reported cost · USD</dt><dd data-execution-metric="reported-cost">{{ reportedCost(usage?.providerReportedCostUsd) }}</dd><span>{{ usage?.coverage.providerReportedCostUsd ?? 0 }} of {{ analysis.total }} attempts report cost</span></div>
        </dl>
        <p class="execution-note">Reported cost may include estimates. Missing usage is not counted as zero.</p>
      </template>
      <details class="execution-details">
        <summary>About these measurements</summary>
        <p v-if="data">Accepted {{ data.interval.since ? 'from ' + timestamp(data.interval.since) : 'at any retained time' }} through {{ timestamp(data.interval.until) }}. This window uses acceptance time, not completion time.</p>
        <p>Local session attempts include execution, checks and rework. Original remote lease executions remain in Task history. History includes only attempts retained on this worker.</p>
        <p>Durations use measured execution time, excluding queue time. Token and cost totals include provider reports only. Cache counts are not added to input or output tokens. Reported cost is not a verified invoice or subscription balance.</p>
      </details>
    </template>
    <footer class="execution-footer">
      <UButton to="/history?view=runs" color="neutral" variant="link" trailing-icon="i-lucide-arrow-right">Explore all retained attempts</UButton>
      <span v-if="readAt" class="execution-freshness" :class="{ 'is-stale': stale }">{{ state.paused ? 'Updates paused · last successful update' : stale ? 'Last successful update' : 'Updated' }} <time :datetime="readAt">{{ timestamp(readAt) }}</time></span>
    </footer>
  </section>
</template>

<style scoped>
.execution-metrics { min-width: 0; padding-block: var(--space-6); border-top: 1px solid var(--ui-border); }
.execution-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--space-6); flex-wrap: wrap; }
.execution-heading h2, .execution-heading p { margin: 0; }
.execution-heading h2 { font-size: 1.125rem; }
.execution-heading p { margin-top: var(--space-2); color: var(--ui-text-muted); font-size: .875rem; }
.execution-controls { display: flex; align-items: flex-end; flex-wrap: wrap; gap: var(--space-3); }
.execution-controls label { font-size: .8125rem; margin-bottom: var(--space-1); }
.execution-controls select { min-height: 44px; width: 100%; padding: var(--space-2) var(--space-8) var(--space-2) var(--space-3); background: var(--ui-bg-elevated); color: var(--ui-text); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); font-size: .875rem; }
.execution-controls :deep(button) { min-height: 44px; }
.execution-total { display: flex; align-items: baseline; gap: var(--space-3); margin-top: var(--space-6); font-variant-numeric: tabular-nums; }
.execution-total strong { font-size: 2rem; line-height: 1.2; font-weight: 650; }
.execution-total span { font-size: .875rem; color: var(--ui-text-muted); }
.execution-distribution { margin: var(--space-6) 0 0; }
.execution-distribution figcaption { font-size: .875rem; font-weight: 600; }
.execution-bar { display: flex; height: 14px; margin: var(--space-3) 0 var(--space-4); border-radius: 4px; overflow: hidden; background: var(--ui-bg-accented); }
.execution-bar span { flex-shrink: 0; border-right: 2px solid var(--ui-bg); }
.execution-outcomes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3) var(--space-6); margin: 0; }
.execution-outcomes > div { display: flex; justify-content: space-between; gap: var(--space-2); min-width: 0; }
.execution-outcomes dt { display: flex; align-items: center; gap: var(--space-2); font-size: .8125rem; color: var(--ui-text-muted); }
.execution-outcomes dd { font-size: .875rem; margin: 0; }
.execution-outcomes i { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.tone-positive { background: var(--ui-primary); }
.tone-review { background: var(--ui-info); }
.tone-active { background: var(--ui-info); }
.tone-waiting { background: var(--ui-warning); }
.tone-negative { background: var(--ui-error); }
.tone-neutral { background: var(--ui-text-muted); }
.execution-note { margin-top: var(--space-4); color: var(--ui-text-muted); font-size: .8125rem; }
.execution-measurements { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-6); margin: var(--space-6) 0 0; padding-top: var(--space-6); border-top: 1px solid var(--ui-border); }
.execution-measurements > div { min-width: 0; }
.execution-measurements dt { font-size: .8125rem; color: var(--ui-text-muted); }
.execution-measurements dd { margin: var(--space-2) 0; font-size: 1.25rem; font-weight: 650; overflow-wrap: anywhere; line-height: 1.4; }
.execution-measurements span { color: var(--ui-text-muted); font-size: .8125rem; display: block; }
.execution-details { font-size: .8125rem; color: var(--ui-text-muted); margin-top: var(--space-4); }
.execution-details summary { display: flex; align-items: center; min-height: 44px; width: fit-content; gap: var(--space-2); cursor: pointer; }
.execution-details summary::before { content: '+'; }
.execution-details[open] summary::before { content: '−'; }
.execution-details p { margin-top: var(--space-3); }
.execution-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-4); }
.execution-footer :deep(a) { padding-left: 0; min-height: 44px; }
.execution-freshness { font-size: .8125rem; color: var(--ui-text-muted); }
.execution-freshness.is-stale { color: var(--ui-warning); }
.execution-empty { padding-block: var(--space-8); color: var(--ui-text-muted); font-size: .875rem; }
.execution-error { margin-top: var(--space-4); color: var(--ui-error); overflow-wrap: anywhere; font-size: .875rem; }
@media (max-width: 1000px) { .execution-measurements { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) {
  .execution-heading, .execution-controls { width: 100%; }
  .execution-controls > div { flex: 1; min-width: 160px; }
  .execution-outcomes { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3) var(--space-4); }
  .execution-measurements { gap: var(--space-6) var(--space-4); }
}
</style>
