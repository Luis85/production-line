<script setup lang="ts">
import { computed } from 'vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { WorkerRequest } from '../../application/request-gates';
import { workflowStateLabels, workflowTimeline } from '../workflow-timeline';
const props = defineProps<{ subject: WorkerRequest }>();
const stages = computed(() => workflowTimeline(props.subject));
</script>
<template>
  <ol class="workflow-timeline" aria-label="Feature Request end-to-end workflow">
    <li v-for="(stage, index) in stages" :key="stage.id" :class="'workflow-' + stage.state" :aria-current="stage.state === 'active' ? 'step' : undefined"><span class="marker" aria-hidden="true"><UIcon v-if="stage.state === 'complete'" name="i-lucide-check" /><template v-else>{{ index + 1 }}</template></span><div><strong>{{ stage.label }}</strong><span class="workflow-state">{{ workflowStateLabels[stage.state] }}</span><p>{{ stage.detail }}</p></div></li>
  </ol>
</template>
<style scoped>
.workflow-timeline { list-style:none;padding:0;margin-block:var(--space-6);display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-6) var(--space-4); }
li { display:flex;align-items:flex-start;gap:var(--space-3);min-width:0; }.marker { display:flex;flex:0 0 26px;width:26px;height:26px;align-items:center;justify-content:center;border:1px solid var(--ui-border);border-radius:50%;font-size:.75rem;font-variant-numeric:tabular-nums;color:var(--ui-text-muted); }strong { display:block;font-size:.875rem;line-height:1.6; }.workflow-state { display:block;color:var(--ui-text-muted);font-size:.75rem;margin-block:var(--space-1); }p { margin:var(--space-2) 0 0;font-size:.75rem;color:var(--ui-text-muted);line-height:1.6;overflow-wrap:anywhere; }.workflow-complete .marker { color:var(--ui-success);border-color:var(--ui-success); }.workflow-active .marker { color:var(--ui-primary);border-color:var(--ui-primary); }.workflow-active strong { color:var(--ui-primary); }.workflow-blocked .workflow-state,.workflow-unknown .workflow-state { color:var(--ui-warning); }
@media(max-width:1000px) { .workflow-timeline { grid-template-columns:repeat(2,minmax(0,1fr)); } }@media(max-width:560px) { .workflow-timeline { grid-template-columns:1fr; } }
</style>
