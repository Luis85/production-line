<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';

interface SaveState {
  busy: boolean;
  checking: boolean;
  error: string;
  uncertain: unknown;
}
withDefaults(defineProps<{
  state: SaveState;
  unlocked: boolean;
  unavailable?: boolean;
  notice?: string;
  showRefresh?: boolean;
  refreshLabel?: string;
  uncertainMessage?: string;
}>(), {
  unavailable: false,
  notice: '',
  showRefresh: true,
  refreshLabel: 'Refresh saved settings',
  uncertainMessage: 'The save acknowledgement is uncertain. Your submitted settings are kept.',
});
defineEmits<{ retry: []; reload: []; refresh: [] }>();
</script>
<template>
  <p v-if="state.error" role="alert" class="error-text">{{ state.error }}</p>
  <p v-if="notice" role="status" class="settings-save-notice">{{ notice }}</p>
  <div v-if="state.uncertain" role="status" class="settings-save-recovery">
    <p>{{ uncertainMessage }}</p>
    <div class="settings-save-actions">
      <UButton type="button" color="neutral" variant="outline" :loading="state.busy" :disabled="state.busy || state.checking || !unlocked" @click="$emit('retry')">Retry same save</UButton>
      <UButton type="button" color="neutral" variant="ghost" :disabled="state.busy || state.checking || !unlocked" @click="$emit('reload')">Discard edits and reload</UButton>
    </div>
  </div>
  <UButton v-if="showRefresh && (unavailable || state.uncertain)" type="button" color="neutral" variant="outline" :loading="state.checking" :disabled="state.busy || state.checking || !unlocked" @click="$emit('refresh')">{{ refreshLabel }}</UButton>
</template>
<style scoped>
.settings-save-notice { margin: var(--space-3) 0 var(--space-4); max-width: 75ch; line-height: 1.6; overflow-wrap: anywhere; }
.error-text { color: #ffa6a6; margin-top: 12px; }
.settings-save-recovery { min-width: 0; margin: var(--space-4) 0; padding: var(--space-4); background: var(--ui-bg-elevated); border: 1px solid var(--ui-border); border-radius: 12px; overflow-wrap: anywhere; }
.settings-save-recovery p { margin: 0; max-width: 75ch; }
.settings-save-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-4); }
.settings-save-actions :deep(button) { min-height: 44px; }
@media (max-width: 480px) { .settings-save-actions { flex-direction: column; align-items: stretch; } .settings-save-actions :deep(button) { justify-content: center; } }
</style>
