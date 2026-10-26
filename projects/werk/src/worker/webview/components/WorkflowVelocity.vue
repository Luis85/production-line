<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowMetricsReport } from '../../application/workflow-metrics-contracts';
import { visibleWorkflowWeeks, workflowWeekLabel, workflowNumber } from '../workflow-dashboard';
const props = defineProps<{ throughput: WorkflowMetricsReport['throughput'] }>();
const weeks = computed(() => visibleWorkflowWeeks(props.throughput.weeks));
const maximum = computed(() => Math.max(1, ...weeks.value.map(week => week.completed)));
const chartLabel = computed(() => weeks.value.map(week => `Week of ${workflowWeekLabel(week.weekStart)}: ${week.completed} delivered increments${week.partial ? ', partial week' : ''}`).join('; '));
</script>
<template>
  <section id="workflow-velocity" class="workflow-velocity" aria-labelledby="workflow-velocity-title">
    <header>
<div>
<h2 id="workflow-velocity-title">Weekly delivery velocity</h2>
<p>Recorded confirmed increments delivered per UTC week. A model turn, review acceptance or story point is not an increment.</p>
</div>
<p class="velocity-mean">
<strong>{{ workflowNumber(throughput.meanPerCompleteWeek) }}</strong>
<span>recorded increments / whole UTC week</span>
<small>{{ throughput.completeWeeks }} whole UTC weeks in window</small>
</p>
</header>
    <p v-if="!throughput.weeks.length" class="velocity-empty">No completion-week evidence in this window. Broaden the period or inspect the request histories.</p>
    <template v-else>
      <p v-if="throughput.weeks.length > weeks.length" class="velocity-note">Chart shows the latest {{ weeks.length }} of {{ throughput.weeks.length }} UTC weeks. The table below includes every returned week.</p>
      <div class="velocity-scroll" tabindex="0" role="region" aria-label="Weekly delivery chart; scroll horizontally when needed">
<div class="velocity-chart" role="img" :aria-label="chartLabel" :style="{ gridTemplateColumns: 'repeat(' + weeks.length + ', minmax(48px,1fr))' }">
<div v-for="week in weeks" :key="week.weekStart" class="velocity-week" :class="{ partial: week.partial }">
<span class="bar-count" aria-hidden="true">{{ week.completed }}</span>
<div class="bar-track" aria-hidden="true">
<div class="bar" :style="{ height: week.completed / maximum * 100 + '%' }" />
</div>
<span class="week-label" aria-hidden="true">{{ workflowWeekLabel(week.weekStart) }}</span>
<span class="week-state" aria-hidden="true">{{ week.partial ? 'Partial' : 'Complete' }}</span>
</div>
</div>
</div>
      <p class="velocity-note">Weeks begin Monday at 00:00 UTC. Retained confirmations may omit deliveries whose history is unavailable. Partial edge weeks contribute to delivered totals and are excluded from the complete-week mean.</p>
      <details>
<summary>Weekly values and exact UTC bounds</summary>
<div class="velocity-table" tabindex="0" role="region" aria-label="Weekly UTC values; scroll horizontally when needed">
<table>
<caption>Confirmed completed increments · UTC weeks</caption>
<thead>
<tr>
<th scope="col">Week start</th>
<th scope="col">Week end · exclusive</th>
<th scope="col">Increments</th>
<th scope="col">Coverage</th>
</tr>
</thead>
<tbody>
<tr v-for="week in throughput.weeks" :key="week.weekStart">
<th scope="row">{{ week.weekStart }}</th>
<td>{{ week.weekEnd }}</td>
<td>{{ week.completed }}</td>
<td>{{ week.partial ? 'Partial week' : 'Complete week' }}</td>
</tr>
</tbody>
</table>
</div>
</details>
    </template>
  </section>
</template>
<style scoped>
.workflow-velocity  {
   min-width:0;
  padding-block:var(--space-6);
  border-bottom:1px solid var(--ui-border);
  scroll-margin-top:var(--space-6);

}
header  {
   display:flex;
  justify-content:space-between;
  align-items:flex-start;
  gap:var(--space-4);
  flex-wrap:wrap;

}
h2  {
   font-size:1.125rem;
  font-weight:650;
  margin:0;

}
p  {
   font-size:.8125rem;
  line-height:1.65;
  color:var(--ui-text-muted);
  max-width:75ch;

}
header p  {
   margin-top:var(--space-2);

}
.velocity-mean  {
   display:grid;
  gap:var(--space-1);
  margin:0;
  text-align:right;
  font-variant-numeric:tabular-nums;

}
.velocity-mean strong  {
   font-size:1.25rem;
  color:var(--ui-text);
  font-weight:650;

}
.velocity-mean small  {
   font-size:.75rem;

}
.velocity-scroll  {
   overflow-x:auto;
  max-width:100%;
  margin-top:var(--space-6);
  padding:var(--space-2);
  border-radius:6px;

}
.velocity-scroll:focus-visible,.velocity-table:focus-visible  {
   outline:2px solid var(--ui-primary);
  outline-offset:2px;

}
.velocity-chart  {
   display:grid;
  gap:var(--space-4);
  min-width:min-content;
  align-items:end;

}
.velocity-week  {
   display:grid;
  grid-template-rows:24px 160px 24px 22px;
  text-align:center;
  align-items:end;
  gap:var(--space-2);
  font-variant-numeric:tabular-nums;

}
.bar-count  {
   font-size:.875rem;
  font-weight:600;

}
.bar-track  {
   display:flex;
  align-items:flex-end;
  height:160px;
  border-bottom:1px solid var(--ui-border);

}
.bar  {
   width:100%;
  max-width:80px;
  margin:auto auto 0;
  background:var(--ui-primary);
  border-radius:4px 4px 0 0;

}
.partial .bar  {
   opacity:.5;

}
.week-label  {
   font-size:.75rem;
  white-space:nowrap;

}
.week-state  {
   font-size:.6875rem;
  color:var(--ui-text-muted);

}
.velocity-note,.velocity-empty  {
   font-size:.75rem;

}
summary  {
   min-height:44px;
  padding-block:var(--space-3);
  cursor:pointer;
  font-size:.8125rem;

}
.velocity-table  {
   overflow-x:auto;

}
table  {
   width:100%;
  border-collapse:collapse;
  font-size:.75rem;
  font-variant-numeric:tabular-nums;

}
caption  {
   text-align:left;
  color:var(--ui-text-muted);
  padding-block:var(--space-3);

}
th,td  {
   padding:var(--space-3);
  text-align:left;
  border-bottom:1px solid var(--ui-border);
  white-space:nowrap;

}
th  {
   font-weight:600;

}
@media(max-width:600px)  {
   .velocity-mean  {
   text-align:left;

}
.velocity-chart  {
   gap:var(--space-3);

}

}

</style>
