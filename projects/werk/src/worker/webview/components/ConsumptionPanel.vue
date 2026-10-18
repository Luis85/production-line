<script lang="ts">
import { createConsumptionEditor } from '../consumption-editor';
import { state as workerState, consumptionAction, refresh } from '../store';
const consumptionEditor = createConsumptionEditor({
  policy: () => workerState.settings?.consumption ?? null,
  unlocked: () => workerState.unlocked,
  epoch: () => workerState.draftEpoch,
  write: consumptionAction,
  refresh,
});
</script>
<script setup lang="ts">
import { computed } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import SettingsSaveFeedback from '../../../shared/webview/components/SettingsSaveFeedback.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { state } from '../store';
import { consumptionStateLabel, consumptionBlockedMessage } from '../consumption-view';
const props = withDefaults(defineProps<{ readonly?: boolean; editorOpen?: boolean }>(), { readonly: false, editorOpen: false });
const { draft, dirty, stale, locked, validation, canSave, workerAllowance } = consumptionEditor;
const report = computed(() => state.consumption);
const count = (value: number) => value.toLocaleString();
const utcDate = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const stateLabel = computed(() => consumptionStateLabel(report.value));
const blockedMessage = computed(() => consumptionBlockedMessage(report.value));
const hasMeasurements = computed(() => !!report.value?.accountingAvailable);
</script>

<template>
  <section id="consumption-limits" class="monitor-section consumption-panel" :class="{ 'consumption-summary': props.readonly }" aria-labelledby="consumption-title">
    <div class="section-heading">
      <h2 id="consumption-title" tabindex="-1">{{ props.readonly ? 'Consumption this period' : 'Consumption limits' }}</h2>
      <div class="consumption-heading-actions"><UBadge :color="report?.blocked ? 'warning' : 'neutral'" variant="subtle">{{ stateLabel }}</UBadge><UButton v-if="props.readonly" to="/settings#consumption-limits" color="neutral" variant="outline" icon="i-lucide-settings-2">Manage limits</UButton></div>
    </div>
    <p v-if="props.readonly" class="page-note">Reported input and output tokens for this UTC period. Usage in your everyday tools is not measured here.</p>
    <p v-else class="page-note">Set this worker’s share of a daily or monthly token allowance. Usage in your everyday tools is not measured here.</p>
    <p v-if="state.consumptionError" role="alert" class="error-text">{{ state.consumptionError }} Last loaded values may be stale.</p>
    <p v-if="blockedMessage" class="consumption-warning" role="status">{{ blockedMessage }}</p>
    <template v-if="report">
      <p v-if="report.policy.enabled" class="consumption-share"><strong>{{ count(report.policy.workerPercent) }}% for this worker</strong> · {{ count(report.workerAllowance) }} of {{ count(report.policy.allowance) }} configured tokens per {{ report.policy.period === 'daily' ? 'day' : 'month' }}</p>
      <p v-else class="page-note">Limits are off. Recorded usage is kept.</p>
      <dl class="facts consumption-facts">
        <div><dt>Reported usage</dt><dd>{{ hasMeasurements ? count(report.measuredTokens) + ' tokens' : 'Unavailable' }}</dd></div>
        <div><dt>Reserved for model calls</dt><dd>{{ hasMeasurements ? count(report.reservedTokens) + ' tokens' : 'Unavailable' }}</dd></div>
        <div><dt>{{ report.policy.enabled ? 'Remaining worker allowance' : 'Remaining if limits are enabled' }}</dt><dd>{{ hasMeasurements && !report.uncertainInvocations ? count(report.remainingTokens) + ' tokens' : 'Unverified' }}</dd></div>
        <div><dt>Period resets</dt><dd>{{ utcDate(report.periodEnd) }}</dd></div>
      </dl>
      <p v-if="report.uncertainInvocations" class="page-note">{{ report.uncertainInvocations }} {{ report.uncertainInvocations === 1 ? 'call has' : 'calls have' }} incomplete usage. Reservations for these calls are retained; they are not measured token totals.</p>
      <p v-if="report.activeInvocations" class="page-note">{{ report.activeInvocations }} {{ report.activeInvocations === 1 ? 'model call is' : 'model calls are' }} active. A call can exceed its reservation and the remaining allowance before final usage arrives.</p>
      <details class="consumption-accounting"><summary>How usage is counted</summary><p class="page-note">Input and output tokens count toward the allowance. A reservation checks capacity before a model call; it is not a hard token cap on the active call. Changes to these limits do not erase recorded usage.</p><p v-if="report.trackingStartedAt" class="page-note">Tracking since {{ utcDate(report.trackingStartedAt) }}. Earlier usage is not included.</p></details>
    </template>
    <p v-else class="page-note">Consumption data is not available yet. Refresh to load this worker’s allowance and usage.</p>

    <details v-if="!props.readonly" class="consumption-editor" :open="props.editorOpen">
      <summary>Configure consumption limits</summary>
      <form v-if="draft.baseline" :aria-busy="draft.busy" @submit.prevent="consumptionEditor.save">
        <fieldset :disabled="locked" class="consumption-fields">
          <legend class="sr-only">Worker consumption allowance</legend>
          <label class="check-label consumption-toggle"><input v-model="draft.enabled" type="checkbox"> Limit this worker’s consumption</label>
          <div class="consumption-form-grid">
            <div class="consumption-field"><label for="consumption-period">Allowance period</label><USelect id="consumption-period" v-model="draft.period" :items="[{ label: 'Daily · resets at midnight UTC', value: 'daily' }, { label: 'Monthly · resets on the first at midnight UTC', value: 'monthly' }]" class="w-full" /></div>
            <div class="consumption-field"><label for="consumption-allowance">Total allowance · tokens</label><UInput id="consumption-allowance" v-model.number="draft.allowance" type="number" min="1" step="1" required class="w-full" aria-describedby="consumption-share-help" /></div>
            <div class="consumption-field"><label for="consumption-share">Worker share · percent</label><UInput id="consumption-share" v-model.number="draft.workerPercent" type="number" min="1" max="100" step="1" required class="w-full" aria-describedby="consumption-share-help" /></div>
          </div>
          <p id="consumption-share-help" class="page-note">{{ workerAllowance === null ? 'Enter an allowance and worker share to see the allocation.' : 'Worker allocation: ' + count(workerAllowance) + ' tokens. The other ' + count(100 - Number(draft.workerPercent)) + '% is left outside this worker’s configured share.' }} This is your configured budget, not a provider subscription balance.</p>
          <details class="consumption-advanced">
            <summary>Model call reservation</summary>
            <div class="consumption-field"><label for="consumption-reservation">Reserve before each model call · tokens</label><UInput id="consumption-reservation" v-model.number="draft.perRunReservation" type="number" min="1" step="1" required class="w-full" aria-describedby="consumption-reservation-help" /></div>
            <p id="consumption-reservation-help" class="page-note">A call starts only when this many tokens remain. Its reported usage replaces the reservation when complete. Larger reservations leave more headroom; a call can still use more tokens.</p>
          </details>
          <div class="consumption-actions">
            <UButton type="submit" :loading="draft.busy" :disabled="!canSave">Save consumption limits</UButton>
            <UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="consumptionEditor.reload">Discard edits and reload</UButton>
          </div>
        </fieldset>
        <p v-if="validation && dirty" class="error-text" role="status">{{ validation }}</p>
        <p v-if="stale" class="consumption-warning" role="status">Saved limits changed while you were editing. Your draft is kept. Discard edits and reload the current limits before saving.</p>
      </form>
      <p v-else class="page-note">Saved consumption settings are not available. Refresh to try again.</p>
      <SettingsSaveFeedback :state="draft" :unlocked="state.unlocked" :show-refresh="false" uncertain-message="The save acknowledgement is uncertain. Your submitted limits are kept. Check the saved limits or retry the same save." @retry="consumptionEditor.retry" @reload="consumptionEditor.reload" />
    </details>
    <p v-if="!props.readonly && draft.notice" role="status">{{ draft.notice }}</p>
    <UButton v-if="!report || state.consumptionError || !props.readonly && (!draft.baseline || draft.uncertain)" type="button" color="neutral" variant="outline" :loading="draft.checking" :disabled="draft.busy || !state.unlocked" @click="consumptionEditor.check">Refresh consumption</UButton>
  </section>
</template>

<style scoped>
.consumption-panel { min-width: 0; scroll-margin-top: var(--space-6); }
.consumption-panel .section-heading { flex-wrap: wrap; }
.consumption-panel h2 { margin: 0; }
.consumption-heading-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }
.consumption-heading-actions :deep(a) { min-height: 44px; }
.consumption-panel p { max-width: 75ch; }
.consumption-facts dd, .consumption-share { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.consumption-facts dd { text-align: right; }
.consumption-warning { margin: var(--space-4) 0; padding: var(--space-4); border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-bg-elevated); overflow-wrap: anywhere; }
.consumption-editor { margin-top: var(--space-3); }
.consumption-editor summary, .consumption-advanced summary, .consumption-accounting summary { cursor: pointer; min-height: 44px; display: list-item; padding-block: var(--space-3); font-weight: 600; }
.consumption-fields { min-width: 0; border: 0; padding: 0; margin: 0; }
.consumption-toggle { min-height: 44px; margin-bottom: var(--space-4); }
.consumption-form-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-4); }
.consumption-field { min-width: 0; display: grid; gap: var(--space-2); }
.consumption-field label { font-weight: 600; }
.consumption-field :deep(input), .consumption-field :deep(button), .consumption-actions :deep(button) { min-height: 44px; }
.consumption-advanced .consumption-field { max-width: 360px; }
.consumption-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-4); }
.consumption-summary .consumption-facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-6); margin-top: var(--space-4); }
.consumption-summary .consumption-facts > div { display: flex; flex-direction: column; gap: var(--space-2); padding: 0 0 var(--space-4); }
.consumption-summary .consumption-facts dd { text-align: left; margin: 0; font-size: 1.25rem; font-weight: 600; }
.consumption-summary .consumption-facts > div:last-child dd { font-size: 1rem; font-weight: 400; }
.consumption-summary .section-heading { gap: var(--space-3); }
@media (max-width: 1000px) { .consumption-summary .consumption-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); } }
@media (max-width: 760px) { .consumption-form-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 480px) { .consumption-facts > div { display: block; } .consumption-facts dd { text-align: left; margin-top: var(--space-1); } .consumption-actions { flex-direction: column; align-items: stretch; } .consumption-actions :deep(button) { justify-content: center; } }
</style>
