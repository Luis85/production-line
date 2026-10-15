<script setup lang="ts">
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { TaskOverviewItem } from '../task-overview';
import { date } from '../store';
defineProps<{ item: TaskOverviewItem; selected?: boolean; disabled?: boolean; compact?: boolean }>();
defineEmits<{ open: [TaskOverviewItem] }>();
</script>
<template>
  <article class="overview-card" :class="[{ selected, compact }, 'task-group-' + item.group]" :aria-label="item.title">
    <div class="overview-card-meta"><span class="task-identity" :title="item.taskId">{{ item.taskId }}</span><span class="task-source">{{ item.sourceLabel }}</span><span v-if="selected" class="task-selected">Selected</span></div>
    <h3>{{ item.title }}</h3>
    <div class="overview-status"><UIcon :name="item.group === 'attention' ? 'i-lucide-circle-alert' : item.group === 'completed' ? 'i-lucide-circle-check' : item.group === 'queued' ? 'i-lucide-clock-3' : 'i-lucide-file-pen-line'" />{{ item.statusLabel }}</div>
    <p class="overview-card-summary">{{ item.summary }}</p>
    <div class="overview-card-footer">
      <span v-if="item.provider" class="task-provider">{{ item.provider }}</span>
      <time v-else-if="item.updatedAt" :datetime="item.updatedAt">{{ date(item.updatedAt) }}</time>
      <button type="button" :disabled="disabled" @click="$emit('open', item)">{{ item.primaryAction.label }}<UIcon name="i-lucide-arrow-up-right" /></button>
    </div>
    <RouterLink v-if="item.localTaskId && item.status === 'review'" class="patch-review-link" :to="{ path: '/history', query: { fileState: 'review', fileId: item.localTaskId } }">Review proposed patch<UIcon name="i-lucide-arrow-up-right" /></RouterLink>
  </article>
</template>
<style scoped>
.overview-card { min-width: 0; padding: 20px; border: 1px solid #30434d; border-radius: 8px; background: #192831; }
.overview-card.selected { border-color: #8be0b8; box-shadow: 0 0 0 1px #8be0b822; }
.overview-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: #b5c4cd; font-size: .6875rem; }
.task-identity { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-source { padding: 2px 7px; background: #253641; color: #d1dce2; border-radius: 4px; }
.task-selected { margin-left: auto; color: #8be0b8; }
h3 { margin: 13px 0 11px; font-size: 1.0625rem; line-height: 1.5; font-weight: 620; color: #edf4f7; overflow-wrap: anywhere; }
.overview-status { display: flex; align-items: center; gap: 7px; font-size: .75rem; color: #bacad3; }
.task-group-attention .overview-status { color: #edc47e; }
.task-group-completed .overview-status { color: #8be0b8; }
.overview-card-summary { margin: 12px 0 15px; font-size: .875rem; line-height: 1.65; color: #b5c4cd; overflow-wrap: anywhere; }
.overview-card-footer { display: flex; align-items: center; gap: 8px; justify-content: space-between; flex-wrap: wrap; }
.task-provider, time { font-size: .6875rem; color: #a4b7c2; }
button, .patch-review-link { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; border: 1px solid #40565e; border-radius: 6px; padding: 8px 12px; font-size: .75rem; font-weight: 550; color: #e1edf0; background: #23353e; cursor: pointer; text-decoration: none; }
button:hover, .patch-review-link:hover { background: #2d4349; border-color: #7ca79a; }
button:disabled { opacity: .5; cursor: default; }
.patch-review-link { margin-top: 12px; width: 100%; color: #b8eccf; }
.compact { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(180px, 1.5fr) minmax(110px, .7fr) minmax(160px, 1fr); gap: 16px; align-items: center; padding: 14px 18px; }
.compact h3 { margin: 0; font-size: .875rem; }
.compact .overview-card-summary { display: none; }
.compact .overview-card-footer { justify-content: flex-end; }
.compact .patch-review-link { grid-column: 2 / -1; width: fit-content; margin: 0; }
@media (max-width: 1300px) { .compact { grid-template-columns: minmax(140px, 1fr) minmax(180px, 1.3fr); } .compact .overview-card-footer { justify-content: flex-start; } }
@media (max-width: 560px) { .overview-card { padding: 16px; } .compact { display: block; } .compact h3 { margin-block: 12px; } .compact .overview-card-footer { margin-top: 12px; } }
</style>
