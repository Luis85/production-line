<script setup lang="ts">
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { state, date } from '../store';
import { useWorkerClock } from '../useWorkerSnapshot';
import { consumptionAllocation, consumptionBlockedMessage, consumptionStateLabel } from '../consumption-view';

const now = useWorkerClock();
const report = computed(() => state.consumption);
const allocation = computed(() => consumptionAllocation(report.value));
const message = computed(() => consumptionBlockedMessage(report.value));
const stale = computed(() => state.paused || !!state.consumptionError || !state.consumptionReadAt
  || now.value - Date.parse(state.consumptionReadAt) > 15000);
const count = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString();
const utc = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const headline = computed(() => !report.value ? 'Unavailable' : report.value.policy.enabled
  ? allocation.value.remaining === null ? 'Unverified' : count(allocation.value.remaining)
  : count(allocation.value.measured));
const chartLabel = computed(() => `${count(allocation.value.measured)} tokens reported, ${count(allocation.value.reserved)} reserved, ${count(allocation.value.remaining)} remaining from this worker’s configured allowance.`);
</script>

<template>
  <section id="consumption-limits" class="metrics-allowance" aria-labelledby="metrics-allowance-title">
    <div class="allowance-heading">
      <div><p class="eyebrow">Current UTC {{ report?.policy.period === 'monthly' ? 'month' : 'day' }}</p><h2 id="metrics-allowance-title">Token allowance</h2></div>
      <UBadge :color="report?.blocked ? 'warning' : 'neutral'" variant="subtle">{{ stale && report ? 'Last reported' : consumptionStateLabel(report) }}</UBadge>
    </div>
    <p v-if="state.consumptionError" role="alert" class="error-text">{{ state.consumptionError }} Values below are last reported.</p>
    <p v-else-if="stale && report" class="allowance-note">{{ state.paused ? 'Updates paused.' : 'This reading needs refresh.' }} Read {{ date(state.consumptionReadAt) }}.</p>
    <p v-if="message" class="allowance-warning" role="status">{{ message }}</p>
    <div class="allowance-headline">
      <strong>{{ headline }}</strong>
      <span>{{ !report ? 'consumption unavailable' : report.policy.enabled ? 'tokens remaining for this worker' : 'reported tokens · limits off' }}</span>
    </div>
    <template v-if="report">
      <p v-if="report.policy.enabled" class="allowance-note">{{ count(report.workerAllowance) }} tokens allocated · {{ report.policy.workerPercent }}% of your configured allowance</p>
      <p v-else class="allowance-note">Usage is recorded without a configured consumption stop.</p>
      <div v-if="allocation.segments" class="allocation-bar" role="img" :aria-label="chartLabel">
        <span class="allocation-used" :style="{ width: allocation.segments.measured + '%' }" aria-hidden="true" />
        <span class="allocation-reserved" :style="{ width: allocation.segments.reserved + '%' }" aria-hidden="true" />
        <span class="allocation-remaining" :style="{ width: allocation.segments.remaining + '%' }" aria-hidden="true" />
      </div>
      <dl class="allocation-values">
        <div><dt><span class="legend-dot used" aria-hidden="true" />Reported</dt><dd data-consumption-metric="reported">{{ count(allocation.measured) }}<small v-if="allocation.measured !== null"> tokens</small></dd></div>
        <div><dt><span class="legend-dot reserved" aria-hidden="true" />Reserved</dt><dd data-consumption-metric="reserved">{{ count(allocation.reserved) }}<small v-if="allocation.reserved !== null"> tokens</small></dd></div>
        <div v-if="report.policy.enabled"><dt><span class="legend-dot remaining" aria-hidden="true" />Remaining</dt><dd data-consumption-metric="remaining">{{ allocation.remaining === null ? 'Unverified' : count(allocation.remaining) }}<small v-if="allocation.remaining !== null"> tokens</small></dd></div>
      </dl>
      <p v-if="allocation.aboveAllowance" class="allowance-warning">Reported usage and reservations are {{ count(allocation.aboveAllowance) }} tokens above the allocation.</p>
      <p v-if="report.uncertainInvocations" class="allowance-note">{{ report.uncertainInvocations }} {{ report.uncertainInvocations === 1 ? 'call has' : 'calls have' }} incomplete usage. Retained reservations are not measured usage.</p>
      <p v-if="report.activeInvocations" class="allowance-note">{{ report.activeInvocations }} {{ report.activeInvocations === 1 ? 'model call is' : 'model calls are' }} active. Final usage can exceed its reservation.</p>
      <p class="allowance-reset">Resets <time :datetime="report.periodEnd">{{ utc(report.periodEnd) }}</time></p>
      <details class="allowance-method">
        <summary>What counts toward this allowance?</summary>
        <p>Reported input and output tokens count toward this worker’s share. Reservations leave room before a call starts; they are not a hard cap on an active call.</p>
        <p>This is a configured worker budget, not your provider subscription balance. Everyday usage outside this worker is not measured.</p>
        <p v-if="report.trackingStartedAt">Tracking since {{ utc(report.trackingStartedAt) }}. Earlier usage is not included.</p>
      </details>
    </template>
    <p v-else class="allowance-note">The worker has not returned consumption data. Refresh to try again.</p>
    <UButton to="/settings#consumption-limits" color="neutral" variant="outline" icon="i-lucide-sliders-horizontal" class="allowance-action">Manage consumption limits</UButton>
  </section>
</template>

<style scoped>
.metrics-allowance { padding: var(--space-6); border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-bg-elevated); min-width: 0; }
.allowance-heading { display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: var(--space-3); }
.eyebrow { margin: 0 0 var(--space-1); font-size: .8125rem; color: var(--ui-text-muted); }
.allowance-heading h2 { margin: 0; font-size: 1.125rem; }
.allowance-headline { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-6); }
.allowance-headline strong { font-size: clamp(1.8rem, 3vw, 2.6rem); line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -.035em; overflow-wrap: anywhere; }
.allowance-headline span, .allowance-note, .allowance-reset, .allowance-method { font-size: .875rem; color: var(--ui-text-muted); }
.allowance-note { margin-block: var(--space-3); }
.allocation-bar { display: flex; height: 16px; border-radius: 4px; overflow: hidden; margin-top: var(--space-6); background: var(--ui-bg); }
.allocation-used, .used { background: var(--ui-primary); }
.allocation-reserved, .reserved { background: var(--ui-warning); }
.allocation-remaining, .remaining { background: var(--ui-border-accented); }
.allocation-values { display: grid; gap: var(--space-3); margin-block: var(--space-4); }
.allocation-values > div { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.allocation-values dt { display: flex; align-items: center; gap: var(--space-2); color: var(--ui-text-muted); font-size: .875rem; }
.allocation-values dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }
.allocation-values small { color: var(--ui-text-muted); font-weight: 400; }
.legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.allowance-reset { padding-top: var(--space-3); border-top: 1px solid var(--ui-border); }
.allowance-reset time { display: block; color: var(--ui-text); }
.allowance-warning { padding: var(--space-3); background: var(--ui-bg); border-left: 3px solid var(--ui-warning); margin-top: var(--space-4); font-size: .875rem; }
.allowance-method summary { cursor: pointer; min-height: 44px; align-content: center; color: var(--ui-text); }
.allowance-method p { margin: var(--space-2) 0 var(--space-3); }
.allowance-action { min-height: 44px; margin-top: var(--space-3); }
@media (max-width: 760px) { .metrics-allowance { padding: var(--space-4); } }
</style>
