<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { WorkerCapacityView } from '../worker-capacity';
defineProps<{ view: WorkerCapacityView; remaining?: number; showRemote?: boolean; consumptionBlocked?: boolean; refreshing?: boolean; refreshDisabled?: boolean; projects?: Array<{ projectId: string; limit: number; inUse: number }> }>();
defineEmits<{ refresh: [] }>();
</script>
<template>
  <section class="worker-capacity" :class="'capacity-' + view.state" aria-labelledby="worker-capacity-title">
    <header><h2 id="worker-capacity-title"><UIcon :name="view.stale || view.state === 'unknown' ? 'i-lucide-circle-help' : view.state === 'blocked' || view.state === 'paused' ? 'i-lucide-pause-circle' : 'i-lucide-activity'" />{{ view.title }}</h2><div class="capacity-actions"><RouterLink to="/settings#queue">Queue settings</RouterLink><UButton v-if="view.stale || view.state === 'unknown'" size="sm" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="refreshing" :disabled="refreshDisabled" @click="$emit('refresh')">Refresh activity</UButton></div></header>
    <p v-if="view.nativeWorkMessage" role="status" aria-live="polite" aria-atomic="true" class="capacity-description">{{ view.nativeWorkMessage }}</p>
    <dl class="capacity-facts">
      <div><dt>Execution</dt><dd>{{ view.executionLabel }}</dd></div>
      <div><dt>Local requests</dt><dd>{{ view.localLabel }}<span v-if="remaining !== undefined"> · {{ remaining }} {{ remaining === 1 ? 'place' : 'places' }} free</span></dd></div>
      <div v-if="showRemote"><dt>Assigned work</dt><dd>{{ view.remoteLabel }}</dd></div>
    </dl>
    <ul v-if="projects?.length" class="capacity-projects" aria-label="Occupied project capacity"><li v-for="project in projects" :key="project.projectId">{{ project.projectId }} · {{ project.inUse }} / {{ project.limit }} occupied</li></ul>
    <p v-if="view.unresolvedCount || view.startBlocked || view.stale || view.state === 'unknown' || view.admissionAvailable === false" class="capacity-description">{{ view.description }} <RouterLink v-if="consumptionBlocked" to="/settings#consumption-limits">Consumption limits</RouterLink></p>
  </section>
</template>
<style scoped>
.capacity-projects { display: flex; gap: var(--space-3) var(--space-6); flex-wrap: wrap; list-style: none; padding: 0; margin: var(--space-3) 0 0; color: var(--ui-text-muted); font-size: .8125rem; }
.worker-capacity { margin-bottom: var(--space-4); padding-block: var(--space-3); border-block: 1px solid var(--ui-border); min-width: 0; }
header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
h2 { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--ui-text-highlighted); font-size: .9375rem; line-height: 1.5; font-weight: 650; }
h2 :deep(.iconify) { flex-shrink: 0; color: var(--ui-primary); }
.capacity-blocked h2 :deep(.iconify), .capacity-paused h2 :deep(.iconify) { color: #edc47e; }
.capacity-unknown h2 :deep(.iconify) { color: var(--ui-text-muted); }
header :deep(button) { min-height: 44px; }
.capacity-facts { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-6); margin: var(--space-2) 0 0; }
.capacity-facts > div { min-width: 0; }
dt { color: var(--ui-text-muted); font-size: .75rem; }
dd { margin: var(--space-1) 0 0; color: var(--ui-text-highlighted); font-size: .875rem; line-height: 1.5; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
dd span { color: var(--ui-text-muted); font-size: .75rem; }
.capacity-description { margin: var(--space-2) 0 0; max-width: 78ch; color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.6; }
.capacity-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0 var(--space-3); }
.capacity-actions a, .capacity-description a { display: inline-flex; align-items: center; min-height: 44px; color: var(--ui-primary); font-size: .75rem; text-underline-offset: 3px; }
@media (max-width: 600px) { .capacity-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); } dd { font-size: .8125rem; } .capacity-facts > div:last-child:nth-child(3) { grid-column: 1 / -1; } }
</style>
