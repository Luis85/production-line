<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { DeliveryControl, DeliveryRun } from '../../application/delivery-contracts';
import { deliveryControlHelp, deliveryControlLabels, deliveryControlNotice } from '../delivery-view';
const props = defineProps<{ run: DeliveryRun; disabled: boolean; pending: (action: string) => boolean }>();
const emit = defineEmits<{ command: [action: DeliveryControl, note?: string] }>();
const inspected = ref(false), recoveryNote = ref('');
const recoveryNext = computed(() => props.run.control?.action === 'cancel'
  ? 'Your cancellation is pending. Recording this confirmation completes cancellation; work will not resume.'
  : deliveryControlHelp.confirm_stopped);
const controls = computed(() => props.run.allowedControls.filter(action => action !== 'confirm_stopped'));
watch(() => `${props.run.id}:${props.run.inputRevision}`, () => { inspected.value = false; recoveryNote.value = ''; });
function confirmStopped() {
  if (props.disabled || !inspected.value || !recoveryNote.value.trim()) return;
  emit('command', 'confirm_stopped', recoveryNote.value.trim());
}
</script>
<template>
  <section class="delivery-controls" aria-labelledby="delivery-controls-title">
    <h3 id="delivery-controls-title">Control this delivery run</h3>
    <p v-if="deliveryControlNotice(run)" role="status">{{ deliveryControlNotice(run) }}</p>
    <div v-if="controls.length" class="delivery-control-list">
      <div v-for="action in controls" :key="action">
        <UButton :color="action === 'cancel' || action === 'interrupt' ? 'error' : 'neutral'" variant="outline" :disabled="disabled" :loading="pending(action)" :aria-describedby="'delivery-help-' + action" @click="emit('command', action)">{{ deliveryControlLabels[action] }}</UButton>
        <p :id="'delivery-help-' + action">{{ deliveryControlHelp[action] }}</p>
      </div>
    </div>
    <form v-if="run.allowedControls.includes('confirm_stopped')" class="delivery-recovery" @submit.prevent="confirmStopped">
      <p id="delivery-recovery-help">The worker cannot establish what happened to the previous process. Inspect your machine, stop any remaining model or command processes for this run, and review its worktree before continuing. This records your confirmation; it does not prove the earlier operation completed.</p>
      <fieldset :disabled="pending('confirm_stopped')">
        <label class="delivery-recovery-ack"><input v-model="inspected" type="checkbox" aria-describedby="delivery-recovery-help" /> I inspected and stopped any remaining processes for this delivery run.</label>
        <label for="delivery-recovery-note">What you inspected and stopped</label>
        <textarea id="delivery-recovery-note" v-model="recoveryNote" maxlength="8000" rows="3" required aria-describedby="delivery-recovery-next" />
        <p id="delivery-recovery-next">{{ recoveryNext }}</p>
        <UButton type="submit" color="neutral" variant="outline" :disabled="disabled || !inspected || !recoveryNote.trim()" :loading="pending('confirm_stopped')">{{ deliveryControlLabels.confirm_stopped }}</UButton>
      </fieldset>
    </form>
    <p v-else-if="!controls.length">No control command is currently available. The delivery status explains what the worker is waiting for.</p>
  </section>
</template>
<style scoped>
.delivery-controls { margin-block: var(--space-6); padding-block: var(--space-4); border-block: 1px solid var(--ui-border); }.delivery-controls h3 { margin: 0 0 var(--space-3); font-size: 1rem; }.delivery-controls p { font-size: .875rem; color: var(--ui-text-muted); line-height: 1.65; max-width: 75ch; }
.delivery-control-list { display: grid; gap: var(--space-4); }.delivery-control-list > div { display: grid; grid-template-columns: 220px minmax(0,1fr); gap: var(--space-4); align-items: center; }.delivery-control-list p { margin: 0; }.delivery-control-list :deep(button) { min-height: 44px; justify-content: center; }
.delivery-recovery { margin-top: var(--space-4); max-width: 75ch; }.delivery-recovery fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }.delivery-recovery label { display: block; font-size: .875rem; line-height: 1.65; margin-block: var(--space-3) var(--space-2); }.delivery-recovery .delivery-recovery-ack { display: flex; align-items: flex-start; gap: var(--space-3); min-height: 44px; }.delivery-recovery input[type="checkbox"] { flex: 0 0 auto; margin-top: .3rem; accent-color: var(--ui-primary); }.delivery-recovery textarea { display: block; width: 100%; min-height: 88px; resize: vertical; padding: var(--space-3); border: 1px solid var(--ui-border); border-radius: 6px; color: var(--ui-text); background: var(--ui-bg); font: inherit; }.delivery-recovery :deep(button) { min-height: 44px; }
@media (max-width: 600px) { .delivery-control-list > div { grid-template-columns: 1fr; gap: var(--space-2); } }
</style>
