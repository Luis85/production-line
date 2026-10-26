<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowMetricsReport } from '../../application/workflow-metrics-contracts';
import { workflowMeasures, workflowEbmIndicators } from '../workflow-dashboard';
const props = defineProps<{ report: WorkflowMetricsReport }>();
const measures = computed(() => workflowMeasures(props.report));
</script>
<template>
  <details id="workflow-measures" class="workflow-evidence"><summary>Delivery measures and coverage</summary><section aria-labelledby="workflow-measures-title">
<h2 id="workflow-measures-title">Delivery measures</h2>
<p>Completion-window evidence, with its measured samples. Unknown observations remain unmeasured rather than becoming zero.</p>
<dl class="measure-list">
<div v-for="metric in measures" :key="metric.id" :data-workflow-metric="metric.id">
<dt>{{ metric.label }}</dt>
<dd>
<strong>{{ metric.value }}</strong>
<span>{{ metric.coverage }}</span>
<p>{{ metric.definition }}</p>
</dd>
</div>
</dl>
</section></details>
  <details id="workflow-ebm" class="workflow-evidence"><summary>Customer value and evidence-based management</summary><section aria-labelledby="workflow-ebm-title">
<h2 id="workflow-ebm-title">Evidence-based management</h2>
<p>Four Key Value Areas. Operational delivery observations are proxies; shipping an increment does not establish customer or business value.</p>
<dl class="ebm-areas">
<div v-for="area in report.ebm" :key="area.id" :data-ebm-area="area.id">
<dt>{{ area.label }}<span>{{ area.status === 'unmeasured' ? 'Unmeasured' : 'Operational proxies' }}</span>
</dt>
<dd>
<dl v-if="workflowEbmIndicators(report, area.id).length" class="ebm-indicators"><div v-for="indicator in workflowEbmIndicators(report, area.id)" :key="indicator.label"><dt>{{ indicator.label }}</dt><dd><strong>{{ indicator.value }}</strong><span>{{ indicator.coverage }}</span></dd></div></dl>
<ul v-if="area.evidence.length" class="observed">
<li v-for="item in area.evidence" :key="item">{{ item }}</li>
</ul>
<p v-if="!area.evidence.length">No measured outcome evidence is connected.</p>
<ul v-if="area.unavailable.length" class="unmeasured">
<li v-for="item in area.unavailable" :key="item">{{ item }}</li>
</ul>
</dd>
</div>
</dl>
</section></details>
  <details class="measurement-notes">
<summary>Measurement coverage and definitions</summary>
<dl>
<div>
<dt>Retained canonical requests</dt>
<dd>{{ report.coverage.canonicalRequests }}</dd>
</div>
<div>
<dt>Complete event histories</dt>
<dd>{{ report.coverage.completeHistories }}</dd>
</div>
<div>
<dt>Intake-only records</dt>
<dd>{{ report.coverage.intakeOnly }}</dd>
</div>
<div>
<dt>Unknown submission times</dt>
<dd>{{ report.coverage.unknownSubmissionTimes }}</dd>
</div>
<div>
<dt>Closed without confirmed integration</dt>
<dd>{{ report.coverage.closedWithoutIntegration }}</dd>
</div>
<div>
<dt>Unknown completion times</dt>
<dd>{{ report.coverage.unknownCompletionTimes }}</dd>
</div>
</dl>
<p>Flow is an observation snapshot across submission dates. Throughput, timing and event observations use the completion window shown above, including its start and excluding its end. Submission-cohort quality evidence uses a different population.</p>
<ul>
<li v-for="note in report.notes" :key="note">{{ note }}</li>
</ul>
<RouterLink to="/workflow/evidence">Inspect submission-cohort quality evidence</RouterLink>
</details>
</template>
<style scoped>
.workflow-evidence > summary { cursor:pointer;min-height:44px;padding-block:var(--space-3);font-size:.875rem;font-weight:600;line-height:1.6; }
.workflow-evidence  {
   padding-block:var(--space-6);
  border-bottom:1px solid var(--ui-border);
  scroll-margin-top:var(--space-6);

}
h2  {
   font-size:1.125rem;
  font-weight:650;
  margin:0;

}
p,li  {
   font-size:.8125rem;
  line-height:1.65;
  color:var(--ui-text-muted);
  overflow-wrap:anywhere;

}
section > p  {
   max-width:75ch;

}
.measure-list,.ebm-areas  {
   margin-top:var(--space-6);

}
.measure-list > div,.ebm-areas > div  {
   display:grid;
  grid-template-columns:minmax(170px,1fr) minmax(0,3fr);
  gap:var(--space-6);
  padding-block:var(--space-4);
  border-top:1px solid var(--ui-border);

}
.measure-list dt,.ebm-areas dt  {
   font-size:.875rem;
  font-weight:600;
  line-height:1.65;

}
dd  {
   margin:0;
  min-width:0;

}
dd strong  {
   display:block;
  font-size:1rem;
  font-weight:650;
  font-variant-numeric:tabular-nums;

}
dd > span,.ebm-areas dt span  {
   display:block;
  font-size:.75rem;
  color:var(--ui-text-muted);
  margin-top:var(--space-2);
  font-weight:400;

}
dd p  {
   margin-block:var(--space-2);
  max-width:75ch;

}
ul  {
   padding-left:var(--space-4);
  margin:0;

}
li  {
   margin-block:var(--space-2);

}
.ebm-indicators { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-4);margin-bottom:var(--space-4); }.ebm-indicators dt { font-size:.75rem;font-weight:400;color:var(--ui-text-muted); }.ebm-indicators dd { margin-top:var(--space-2); }.ebm-indicators span { display:block;color:var(--ui-text-muted);font-size:.6875rem;margin-top:var(--space-2); }
.observed li  {
   color:var(--ui-text);

}
.unmeasured  {
   margin-top:var(--space-3);

}
.measurement-notes  {
   padding-block:var(--space-4);

}
.measurement-notes summary  {
   min-height:44px;
  padding-block:var(--space-3);
  cursor:pointer;
  font-size:.875rem;

}
.measurement-notes dl  {
   display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:var(--space-4);

}
.measurement-notes dt  {
   color:var(--ui-text-muted);
  font-size:.75rem;

}
.measurement-notes dd  {
   font-size:.875rem;
  margin-top:var(--space-2);
  font-variant-numeric:tabular-nums;

}
a  {
   display:inline-flex;
  align-items:center;
  min-height:44px;
  color:var(--ui-primary);
  font-size:.8125rem;
  text-underline-offset:3px;

}
@media(max-width:600px)  {
   .measure-list > div,.ebm-areas > div  {
   grid-template-columns:1fr;
  gap:var(--space-2);

}
.measurement-notes dl  {
   grid-template-columns:repeat(2,minmax(0,1fr));

}

}

@media(max-width:700px) { .ebm-indicators { grid-template-columns:1fr; } }
</style>
