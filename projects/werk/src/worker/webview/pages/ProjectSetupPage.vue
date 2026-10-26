<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import ManagedProjectsPanel from '../components/ManagedProjectsPanel.vue';
import DeliveryPolicyPanel from '../components/DeliveryPolicyPanel.vue';
import DeliveryPolicyDraftEditor from '../components/DeliveryPolicyDraftEditor.vue';
import SharedIntakePanel from '../components/SharedIntakePanel.vue';
import type { ManagedProjectsView } from '../../application/managed-projects';
const route = useRoute(), projects = ref<ManagedProjectsView | null>(null), operationBusy = ref(false), recoveryProject = ref<string>();
const projectId = computed(() => typeof route.query.project === 'string' ? route.query.project : '');
const automaticStep = ref<{ projectId: string; step: 'workflow' | 'policy' | 'enable' }>();
watch(projectId, () => { automaticStep.value = undefined; projects.value = null; }, { flush: 'sync' });
const project = computed(() => projects.value?.projects.find(item => item.id === projectId.value));
const ready = computed(() => project.value?.status === 'ready' && project.value.workflow.configured && project.value.setup?.status !== 'unknown' && project.value.policyApproved === true && project.value.intakeEnabled && !project.value.intakeBlockedReason);
function acceptProjects(value: ManagedProjectsView | null) {
  projects.value = value;
  if (!value || automaticStep.value?.projectId === projectId.value) return;
  const item = value.projects.find(candidate => candidate.id === projectId.value);
  if (!item) return;
  const step = item.status !== 'ready' || item.setup?.status === 'unknown' || !item.workflow.configured ? 'workflow' : item.policyApproved !== true ? 'policy' : 'enable';
  automaticStep.value = { projectId: projectId.value, step };
}
const step = computed(() => recoveryProject.value === projectId.value || project.value?.setup?.status === 'unknown' ? 'workflow' : ['workflow', 'policy', 'enable', 'edit', 'intake'].includes(String(route.query.step)) ? route.query.step as 'workflow' | 'policy' | 'enable' | 'edit' | 'intake' : automaticStep.value?.step ?? 'workflow');
const steps = [{ id:'workflow', label:'Workflow files' }, { id:'policy', label:'Policy approval' }, { id:'enable', label:'Enable requests' }] as const;
const showReady = computed(() => ready.value && step.value === 'enable' && !route.query.step);
const title = computed(() => !project.value ? projectId.value ? 'Loading project setup…' : 'Choose a project' : showReady.value ? 'Ready for requests' : step.value === 'intake' ? 'Configure request polling' : step.value === 'edit' ? 'Edit project delivery policy' : step.value === 'policy' ? 'Approve project policy' : step.value === 'enable' ? 'Enable project requests' : 'Prepare project workflow');
function stepLink(value: string) { return { path:'/project', query:{ project:projectId.value, step:value } }; }
</script>
<template>
  <section class="project-setup-page" aria-labelledby="project-setup-heading">
    <nav class="project-breadcrumb" aria-label="Breadcrumb"><RouterLink to="/projects">Projects</RouterLink><span aria-hidden="true">/</span><span>{{ project?.name || projectId || 'Choose a project' }}</span></nav>
    <header class="page-heading"><div><h1 id="project-setup-heading" tabindex="-1">{{ title }}</h1><p>{{ project?.name || projectId }} · {{ showReady ? 'Approved intake is enabled for this worker-owned checkout.' : 'Get this project ready for Feature Requests.' }}</p></div></header>
    <nav v-if="projectId" class="project-stages" aria-label="Project setup stages"><RouterLink v-for="item in steps" :key="item.id" :to="stepLink(item.id)" :aria-disabled="operationBusy || undefined" :aria-current="step === item.id && !showReady ? 'step' : undefined" @click="event => operationBusy && event.preventDefault()">{{ item.label }}</RouterLink></nav>
    <ManagedProjectsPanel mode="detail" :project-id="projectId" :setup-step="step === 'edit' || step === 'intake' ? 'policy' : step" @view="acceptProjects" @busy="operationBusy = $event" @recovery="recoveryProject = $event" />
    <template v-if="project && !showReady">
      <KeepAlive>
        <DeliveryPolicyPanel v-if="step === 'policy' && project.status === 'ready' && project.workflow.configured && !operationBusy" :key="'approval-' + projectId" registered-only :locked-project-id="projectId" approval-only />
        <DeliveryPolicyDraftEditor v-else-if="step === 'edit' && project.status === 'ready' && !operationBusy" :key="'draft-' + projectId" :project-id="projectId" expanded />
        <SharedIntakePanel v-else-if="step === 'intake' && project.status === 'ready' && !operationBusy" :key="'intake-' + projectId" :project-id="projectId" configuration-only />
      </KeepAlive>
      <template v-if="step === 'policy'"><p v-if="project.status !== 'ready' || !project.workflow.configured" role="status">Finish preparing this project’s clone and workflow before reviewing its policy.</p><p class="next-action">After approving this exact policy, recheck the project to enable request intake.</p><div class="project-next"><UButton v-if="project.policyApproved === true" :to="stepLink('enable')" :disabled="operationBusy">Continue to project recheck</UButton><RouterLink class="project-secondary-link" :to="stepLink('edit')" :aria-disabled="operationBusy || undefined" @click="event => operationBusy && event.preventDefault()">Edit project delivery policy</RouterLink></div></template>
      <template v-else-if="step === 'workflow'"><p class="next-action">Review the project’s committed policy after its workflow files are published.</p><UButton v-if="project.status === 'ready' && project.workflow.configured" :to="stepLink('policy')" :disabled="operationBusy" color="neutral" variant="outline">Continue to policy approval</UButton></template>
      <p v-else-if="step === 'edit'" class="page-note">Saving does not commit or approve the policy. Review and commit the draft in this worker-owned checkout, then <RouterLink class="project-secondary-link" :to="stepLink('policy')">review the exact committed policy</RouterLink> before granting its authority.</p>
      <p v-else-if="step === 'intake'" class="page-note">Changes apply to this project’s request source. Existing requests keep their accepted source and policy.</p>
      <div v-else-if="ready" class="project-ready" role="status"><p>Project recheck passed. Approved request intake is enabled.</p><UButton :to="{ path:'/requests/new', query:{ project:projectId } }" icon="i-lucide-plus">New Feature Request</UButton></div>
      <p v-else class="page-note">Rechecking verifies the saved clone, workflow and current approval. A saved approval alone does not enable intake.</p>
    </template>
    <div v-else-if="showReady" class="project-ready"><UButton :to="{ path:'/requests/new', query:{ project:projectId } }" icon="i-lucide-plus">New Feature Request</UButton><RouterLink class="project-secondary-link" :to="{ path:'/request', query:{ project:projectId } }">Inspect incoming requests</RouterLink><RouterLink class="project-secondary-link" :to="stepLink('intake')">Configure request polling</RouterLink></div>
    <p v-else-if="!projectId" class="page-note">Choose a project from <RouterLink class="project-secondary-link" to="/projects">Projects</RouterLink> to prepare its workflow.</p>
  </section>
</template>
<style scoped>
.project-setup-page { max-width:1100px;margin-inline:auto;min-width:0; }.project-breadcrumb { display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;margin-bottom:var(--space-4);color:var(--ui-text-muted);font-size:.875rem; }.project-breadcrumb a,.project-stages a { display:inline-flex;min-height:44px;align-items:center;color:var(--ui-primary); }.project-stages { display:flex;flex-wrap:wrap;gap:var(--space-4);border-bottom:1px solid var(--ui-border);margin-bottom:var(--space-6); }.project-stages a { color:var(--ui-text-muted);border-bottom:2px solid transparent;text-decoration:none; }.project-stages a[aria-current] { color:var(--ui-primary);border-color:var(--ui-primary); }.next-action,.page-note { max-width:70ch;color:var(--ui-text-muted);font-size:.875rem;line-height:1.65;margin-top:var(--space-6); }.project-next { display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:center; }.project-secondary-link { display:inline-flex;min-height:44px;align-items:center;color:var(--ui-primary); }.project-stages a[aria-disabled] { opacity:.55;cursor:wait; }.project-ready { display:flex;gap:var(--space-4);align-items:center;flex-wrap:wrap;margin-top:var(--space-6); }:deep(button),:deep(a[class]) { min-height:44px; }
</style>
