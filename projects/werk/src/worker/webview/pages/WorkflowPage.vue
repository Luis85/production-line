<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import WorkflowFlowPanel from '../components/WorkflowFlowPanel.vue';
import WorkflowVelocity from '../components/WorkflowVelocity.vue';
import WorkflowEvidencePanel from '../components/WorkflowEvidencePanel.vue';
import { readWorkflowMetrics } from '../workflow-metrics-client';
import { workflowQuery, workflowWindows, workflowUtcDate, type WorkflowWindow } from '../workflow-dashboard';
import { state, date } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
const window = ref<WorkflowWindow>('28d'), projectId = ref(''), projects = ref<string[]>([]);
const { data, error, loading, refreshing, readAt, now, refresh } = useWorkerSnapshot(() => readWorkflowMetrics(workflowQuery(window.value, projectId.value, Date.now())), [window, projectId]);
watch(data, value => { if (value) projects.value = [...new Set([...projects.value, ...value.projects])].sort(); });
watch(() => state.unlocked, unlocked => { if (!unlocked) projects.value = []; });
const projectChoices = computed(() => [...new Set([...projects.value, ...(state.settings?.repositories.items.map(item => item.id) ?? []), ...(state.environment?.sharedIntake?.projects.map(item => item.id) ?? [])])].sort());
const stale = computed(() => state.paused || !!error.value || !readAt.value || now.value - Date.parse(readAt.value) > 15000);
</script>
<template>
  <section class="workflow-page" aria-labelledby="workflow-page-title" :aria-busy="loading">
    <header class="page-heading workflow-heading">
<div>
<h1 id="workflow-page-title" tabindex="-1">Workflow</h1>
<p>Follow work from intake to integration, and inspect the evidence behind delivery.</p>
</div>
<UButton type="button" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh workflow</UButton>
</header>
    <p v-if="!state.unlocked" role="status">Unlock this worker to inspect private workflow evidence.</p>
    <template v-else>
      <div class="workflow-toolbar">
<div class="workflow-filters">
<div>
<label for="workflow-project">Project</label>
<select id="workflow-project" v-model="projectId">
<option value="">All retained projects</option>
<option v-for="id in projectChoices" :key="id" :value="id">{{ id }}</option>
</select>
</div>
<div>
<label for="workflow-window">Completed within</label>
<select id="workflow-window" v-model="window">
<option v-for="item in workflowWindows" :key="item.value" :value="item.value">{{ item.label }}</option>
</select>
</div>
</div>
<nav v-if="data" aria-label="Workflow sections">
<a href="#workflow-flow">Flow</a>
<a href="#workflow-velocity">Velocity</a>
<a href="#workflow-measures">Measures</a>
<a href="#workflow-ebm">EBM</a>
</nav>
</div>
      <p v-if="error" class="workflow-error" role="alert">Workflow evidence could not be refreshed. {{ error }} {{ data ? 'The last successful matching snapshot is retained below.' : 'Refresh to try again.' }}</p>
      <div v-if="loading && !data" class="workflow-loading" role="status" aria-label="Loading workflow evidence">
<span>Reading retained workflow observations…</span>
<div aria-hidden="true" class="loading-rail" />
</div>
      <template v-if="data">
<div class="workflow-scope">
<p>{{ stale ? 'Last successful snapshot' : 'Updated' }} {{ date(readAt) }}<template v-if="state.paused"> · browser updates paused</template>.</p>
<p>Confirmed completion window: {{ data.window.since ? workflowUtcDate(data.window.since) : 'Retained bounded history' }} to {{ workflowUtcDate(data.window.until) }} · UTC · end exclusive.</p>
</div>
        <p v-if="!data.coverage.canonicalRequests && !data.coverage.intakeOnly" class="workflow-empty">No retained Feature Requests match this project. Register a project or create a request from the taskboard to start collecting workflow evidence. <RouterLink to="/taskboard">Open taskboard</RouterLink>
</p>
        <WorkflowFlowPanel :flow="data.flow" />
        <WorkflowVelocity :throughput="data.throughput" />
        <WorkflowEvidencePanel :report="data" />
      </template>
    </template>
  </section>
</template>
<style scoped>
.workflow-page  {
   max-width:1600px;
  margin-inline:auto;
  min-width:0;

}
.workflow-heading  {
   display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:var(--space-4);
  flex-wrap:wrap;
  margin-bottom:var(--space-6);

}
.workflow-heading h1  {
   font-size:2rem;
  font-weight:650;
  line-height:1.25;
  letter-spacing:-.03em;

}
.workflow-heading p  {
   color:var(--ui-text-muted);
  font-size:.875rem;
  line-height:1.65;
  max-width:75ch;

}
.workflow-toolbar  {
   display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:var(--space-4);
  flex-wrap:wrap;
  padding-block:var(--space-4);
  border-block:1px solid var(--ui-border);

}
.workflow-filters  {
   display:flex;
  gap:var(--space-4);
  flex-wrap:wrap;

}
.workflow-filters > div  {
   min-width:190px;

}
label  {
   display:block;
  font-size:.8125rem;
  margin-bottom:var(--space-2);

}
select  {
   width:100%;
  min-height:44px;
  padding-inline:var(--space-3);
  background:var(--ui-bg);
  color:var(--ui-text);
  border:1px solid var(--ui-border);
  border-radius:6px;
  font-size:.8125rem;

}
nav  {
   display:flex;
  gap:var(--space-4);
  flex-wrap:wrap;

}
a  {
   display:inline-flex;
  align-items:center;
  min-height:44px;
  color:var(--ui-primary);
  font-size:.8125rem;
  text-underline-offset:3px;

}
nav a  {
   color:var(--ui-text-muted);

}
nav a:hover  {
   color:var(--ui-primary);

}
.workflow-scope p  {
   margin-block:var(--space-2);
  font-size:.75rem;
  line-height:1.65;
  color:var(--ui-text-muted);
  font-variant-numeric:tabular-nums;

}
.workflow-error  {
   color:var(--ui-error);
  font-size:.875rem;
  line-height:1.65;
  overflow-wrap:anywhere;

}
.workflow-loading  {
   padding-block:var(--space-6);
  font-size:.8125rem;
  color:var(--ui-text-muted);

}
.loading-rail  {
   height:140px;
  background:var(--ui-bg-elevated);
  margin-top:var(--space-4);
  border-radius:6px;

}
.workflow-empty  {
   padding-block:var(--space-4);
  font-size:.875rem;
  line-height:1.65;
  color:var(--ui-text-muted);
  max-width:75ch;

}
:deep(button)  {
   min-height:44px;

}
@media(max-width:600px)  {
   .workflow-heading h1  {
   font-size:1.75rem;

}
.workflow-filters  {
   width:100%;

}
.workflow-filters > div  {
   min-width:0;
  flex:1 1 140px;

}
.workflow-toolbar nav  {
   width:100%;
  justify-content:space-between;
  gap:var(--space-2);

}

}

</style>
