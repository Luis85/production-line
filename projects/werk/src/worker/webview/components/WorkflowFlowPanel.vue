<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowMetricsReport } from '../../application/workflow-metrics-contracts';
import { workflowDuration } from '../workflow-dashboard';
const props = defineProps<{ flow: WorkflowMetricsReport['flow'] }>();
const stages = computed(() => props.flow.stages.filter(stage => stage.id !== 'unknown'));
const unknown = computed(() => props.flow.stages.find(stage => stage.id === 'unknown'));
</script>
<template>
  <section id="workflow-flow" class="workflow-flow" aria-labelledby="workflow-flow-title">
    <header>
<div>
<h2 id="workflow-flow-title">Observed workflow</h2>
<p>Current requests across all submission dates.</p>
</div>

</header>
    <p v-if="flow.unknownState" class="flow-gap" role="status">{{ flow.unknownState }} historical request states could not be reconstructed at this observation time.</p>
    <ol class="stage-rail" aria-label="Feature Request delivery stages">
      <li v-for="(stage, index) in stages" :key="stage.id" :data-workflow-column="stage.id" :class="{ 'has-blockers': stage.blocked > 0, 'optional-stage': stage.id === 'build' || stage.id === 'publish' }">
        <div class="stage-name">
<span class="stage-marker" aria-hidden="true">{{ index + 1 }}</span>
<h3>{{ stage.label }}</h3>
</div>
        <p class="stage-count">
<strong>{{ stage.wip }}</strong> {{ stage.wip === 1 ? 'request' : 'requests' }}</p>
        <p v-if="stage.id === 'build' || stage.id === 'publish'" class="stage-note">Optional release policy</p>
<p v-else-if="stage.id === 'review'" class="stage-note">Human acceptance</p>
<p v-else-if="stage.id === 'merge'" class="stage-note">Explicit integration approval</p>
        <p v-if="stage.blocked || stage.blockedUnknown" class="stage-blocked">{{ stage.blocked }} blocked<template v-if="stage.blockedUnknown"> · {{ stage.blockedUnknown }} unknown</template>
</p>
        <p v-if="stage.wip" class="stage-age">Oldest in stage {{ workflowDuration(stage.oldestAgeMs) }}</p>
<p v-if="stage.wip && stage.age.unknown" class="stage-samples">{{ stage.age.samples }} {{ stage.age.samples === 1 ? 'age measured' : 'ages measured' }} · {{ stage.age.unknown }} unknown</p>
      </li>
    </ol>
    <p v-if="unknown?.wip" class="flow-gap" role="status">{{ unknown.wip }} {{ unknown.wip === 1 ? 'request has' : 'requests have' }} an unmapped retained stage. Missing workflow evidence is not treated as completed work.</p>
    <details class="flow-definition"><summary>How stages and ages are counted</summary><p>Review acceptance and merge are separate decisions. Merge uses the assigned main checkout, or an explicitly approved GitHub release workflow. Build and Publish require an opted-in release policy. Age begins at recorded stage entry, or submission for Intake.</p><dl><div v-for="stage in stages" :key="stage.id"><dt>{{ stage.label }}</dt><dd>{{ stage.age.samples }} ages measured · {{ stage.age.unknown }} unknown</dd></div></dl></details>
  </section>
</template>
<style scoped>
.workflow-flow  {
   min-width:0;
  padding-block:var(--space-6);
  border-bottom:1px solid var(--ui-border);
  scroll-margin-top:var(--space-6);

}
header  {
   display:flex;
  align-items:flex-start;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:var(--space-4);

}
h2  {
   font-size:1.125rem;
  font-weight:650;
  margin:0;

}
header p  {
   max-width:75ch;
  font-size:.8125rem;
  line-height:1.65;
  color:var(--ui-text-muted);
  margin-top:var(--space-2);

}
.stage-rail  {
   display:grid;
  grid-template-columns:repeat(8,minmax(0,1fr));
  gap:var(--space-4);
  list-style:none;
  padding:0;
  margin-block:var(--space-6);

}
.stage-rail li  {
   min-width:0;
  border-top:1px solid var(--ui-border);
  padding-top:var(--space-4);

}
.stage-name  {
   min-height:44px;
  display:flex;
  gap:var(--space-2);
  align-items:flex-start;

}
.stage-marker  {
   width:24px;
  height:24px;
  flex:0 0 24px;
  border:1px solid var(--ui-primary);
  border-radius:50%;
  display:flex;
  align-items:center;
  justify-content:center;
  color:var(--ui-primary);
  font-size:.75rem;
  font-variant-numeric:tabular-nums;

}
.optional-stage .stage-marker  {
   border-style:dashed;
  border-color:var(--ui-text-muted);
  color:var(--ui-text-muted);

}
h3  {
   font-size:.8125rem;
  font-weight:600;
  line-height:1.5;
  margin:2px 0 0;
  overflow-wrap:anywhere;

}
.stage-count  {
   font-size:.8125rem;

}
.stage-count strong  {
   font-size:1.5rem;
  font-weight:600;
  font-variant-numeric:tabular-nums;

}
.stage-note,.stage-blocked,.stage-age,.stage-samples  {
   font-size:.75rem;
  line-height:1.65;
  color:var(--ui-text-muted);
  margin-block:var(--space-2);

}
.stage-note  {
   min-height:0;

}
.stage-count { margin-block:var(--space-3); }
.has-blockers .stage-blocked,.flow-gap  {
   color:var(--ui-warning);

}
.flow-definition,.flow-gap  {
   font-size:.8125rem;
  line-height:1.65;
  max-width:100ch;
  overflow-wrap:anywhere;

}

@media(max-width:1200px)  {
   .stage-rail  {
   grid-template-columns:repeat(4,minmax(0,1fr));
  row-gap:var(--space-6);

}

}
.flow-definition summary { min-height:44px;cursor:pointer;padding-block:var(--space-3); }.flow-definition dl { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3); }.flow-definition dd { margin:var(--space-1) 0 0;color:var(--ui-text-muted); }
@media(max-width:600px)  {
   .stage-rail  {
   grid-template-columns:repeat(2,minmax(0,1fr));

}
.stage-name  {
   min-height:44px;

}
.stage-count  {
   margin-top:var(--space-2);

}

}

</style>
