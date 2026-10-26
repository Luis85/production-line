<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import WorkflowFlowPanel from '../components/WorkflowFlowPanel.vue';
import WorkflowVelocity from '../components/WorkflowVelocity.vue';
import WorkflowEvidencePanel from '../components/WorkflowEvidencePanel.vue';
import { readWorkflowMetrics } from '../workflow-metrics-client';
import { workflowQuery, workflowWindows, workflowUtcDate, workflowDuration, type WorkflowWindow } from '../workflow-dashboard';
import { state, date } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
const window = ref<WorkflowWindow>('28d'), projectId = ref(''), projects = ref<string[]>([]);
const { data, error, loading, refreshing, readAt, now, refresh } = useWorkerSnapshot(() => readWorkflowMetrics(workflowQuery(window.value, projectId.value, Date.now())), [window, projectId]);
watch(data, value => { if (value) projects.value = [...new Set([...projects.value, ...value.projects])].sort(); });
watch(() => state.unlocked, unlocked => { if (!unlocked) projects.value = []; });
const projectChoices = computed(() => [...new Set([...projects.value, ...(state.settings?.repositories.items.map(item => item.id) ?? []), ...(state.environment?.sharedIntake?.projects.map(item => item.id) ?? [])])].sort());
const stale = computed(() => state.paused || !!error.value || !readAt.value || now.value - Date.parse(readAt.value) > 15000);
const oldest = computed(() => data.value?.flow.stages.filter(stage => stage.wip && stage.oldestAgeMs !== null).sort((a,b) => b.oldestAgeMs! - a.oldestAgeMs!)[0]);
function revealEvidence(event: MouseEvent) {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!anchor) return;
  let target = document.getElementById(anchor.hash.slice(1));
  while (target) { if (target instanceof HTMLDetailsElement) target.open = true; target = target.parentElement; }
}
</script>
<template>
  <section class="workflow-page" aria-labelledby="workflow-page-title" :aria-busy="loading" data-page-goal="Understand delivery health" @click="revealEvidence">
    <header class="page-heading workflow-heading"><div><h1 id="workflow-page-title" tabindex="-1">Workflow health</h1><p>Find where delivery needs attention.</p></div><UButton type="button" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh workflow</UButton></header>
    <p v-if="!state.unlocked" role="status">Unlock this worker to inspect private workflow evidence.</p>
    <template v-else>
      <div class="workflow-toolbar"><div class="workflow-filters"><div><label for="workflow-project">Project</label><select id="workflow-project" v-model="projectId"><option value="">All retained projects</option><option v-for="id in projectChoices" :key="id" :value="id">{{ id }}</option></select></div><div><label for="workflow-window">Completed within</label><select id="workflow-window" v-model="window"><option v-for="item in workflowWindows" :key="item.value" :value="item.value">{{ item.label }}</option></select></div></div><nav v-if="data" aria-label="Workflow sections"><a href="#workflow-flow">Stages</a><a href="#workflow-velocity">Delivery pace</a><a href="#workflow-measures">Measures</a><a href="#workflow-ebm">Value evidence</a></nav></div>
      <p v-if="error" class="workflow-error" role="alert">Workflow evidence could not be refreshed. {{ error }} {{ data ? 'The last successful matching snapshot is retained below.' : 'Refresh to try again.' }}</p>
      <div v-if="loading && !data" class="workflow-loading" role="status" aria-label="Loading workflow evidence"><span>Reading retained workflow observations…</span><div aria-hidden="true" class="loading-rail" /></div>
      <template v-if="data">
        <p class="workflow-updated">{{ stale ? 'Last successful snapshot' : 'Updated' }} {{ date(readAt) }}<template v-if="state.paused"> · browser updates paused</template>.</p>
        <p v-if="!data.coverage.canonicalRequests && !data.coverage.intakeOnly" class="workflow-empty">No retained Feature Requests match this project. <RouterLink to="/projects">Add a project</RouterLink> or <RouterLink to="/requests/new">create a Feature Request</RouterLink> to begin collecting evidence.</p>
        <dl class="workflow-summary" aria-label="Delivery health summary"><div><dt>Work in progress</dt><dd>{{ data.flow.wip }} requests<span v-if="data.flow.unknownState"> · {{ data.flow.unknownState }} states unknown</span></dd></div><div><dt>Needs attention</dt><dd>{{ data.flow.blocked }} blocked<span v-if="data.flow.blockedUnknown"> · {{ data.flow.blockedUnknown }} unknown</span></dd></div><div><dt>Oldest observed wait</dt><dd>{{ oldest ? workflowDuration(oldest.oldestAgeMs) + ' · ' + oldest.label : 'Unmeasured' }}</dd></div><div><dt>Confirmed deliveries</dt><dd>{{ data.throughput.completed }} in this completion window</dd></div></dl>
        <WorkflowFlowPanel :flow="data.flow" />
        <WorkflowVelocity :throughput="data.throughput" />
        <WorkflowEvidencePanel :report="data" />
        <details class="workflow-scope"><summary>Observation window</summary><p>Confirmed completions: {{ data.window.since ? workflowUtcDate(data.window.since) : 'Retained bounded history' }} to {{ workflowUtcDate(data.window.until) }} · UTC · end exclusive.</p><p>Stage pressure includes all submission dates for the selected project. Delivery measures use this completion window.</p></details>
        <p class="workflow-quality"><RouterLink to="/workflow/evidence">Inspect delivery quality evidence</RouterLink><span>Readiness, repair and review observations for a submission cohort.</span></p>
      </template>
    </template>
  </section>
</template>
<style scoped>
.workflow-page { max-width:1600px;margin-inline:auto;min-width:0; }.workflow-heading { display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-6); }.workflow-heading h1 { font-size:2rem;font-weight:650;line-height:1.25;letter-spacing:-.03em; }.workflow-heading p { color:var(--ui-text-muted);font-size:.875rem;line-height:1.65; }
.workflow-toolbar { display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-4);flex-wrap:wrap;padding-block:var(--space-4);border-block:1px solid var(--ui-border); }.workflow-filters { display:flex;gap:var(--space-4);flex-wrap:wrap; }.workflow-filters > div { min-width:190px; }label { display:block;font-size:.8125rem;margin-bottom:var(--space-2); }select { width:100%;min-height:44px;padding-inline:var(--space-3);background:var(--ui-bg);color:var(--ui-text);border:1px solid var(--ui-border);border-radius:6px;font-size:.8125rem; }nav { display:flex;gap:var(--space-4);flex-wrap:wrap; }a { display:inline-flex;align-items:center;min-height:44px;color:var(--ui-primary);font-size:.8125rem;text-underline-offset:3px; }nav a { color:var(--ui-text-muted); }nav a:hover { color:var(--ui-primary); }
.workflow-updated,.workflow-scope p { font-size:.75rem;line-height:1.65;color:var(--ui-text-muted);font-variant-numeric:tabular-nums; }.workflow-summary { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-6);margin-block:var(--space-6); }.workflow-summary div { min-width:0; }.workflow-summary dt { color:var(--ui-text-muted);font-size:.8125rem; }.workflow-summary dd { margin:var(--space-2) 0 0;font-size:1rem;font-weight:600;line-height:1.6;font-variant-numeric:tabular-nums;overflow-wrap:anywhere; }.workflow-summary dd span { display:block;font-size:.75rem;font-weight:400;color:var(--ui-text-muted); }.workflow-error { color:var(--ui-error);font-size:.875rem;line-height:1.65;overflow-wrap:anywhere; }.workflow-loading { padding-block:var(--space-6);font-size:.8125rem;color:var(--ui-text-muted); }.loading-rail { height:140px;background:var(--ui-bg-elevated);margin-top:var(--space-4);border-radius:6px; }.workflow-empty { padding-block:var(--space-4);font-size:.875rem;line-height:1.65;color:var(--ui-text-muted);max-width:75ch; }.workflow-scope summary { min-height:44px;cursor:pointer;padding-block:var(--space-3);font-size:.8125rem; }.workflow-quality { border-top:1px solid var(--ui-border);padding-top:var(--space-4); }.workflow-quality span { display:block;color:var(--ui-text-muted);font-size:.8125rem; }:deep(button) { min-height:44px; }
@media(max-width:760px) { .workflow-summary { grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4); }.workflow-heading h1 { font-size:1.75rem; }.workflow-filters { width:100%; }.workflow-filters > div { min-width:0;flex:1 1 140px; }.workflow-toolbar nav { width:100%;justify-content:space-between;gap:var(--space-2); } }
</style>
