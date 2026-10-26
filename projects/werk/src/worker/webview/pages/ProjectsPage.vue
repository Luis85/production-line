<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import SharedIntakePanel from '../components/SharedIntakePanel.vue';
import ManagedProjectsPanel from '../components/ManagedProjectsPanel.vue';
import DeliveryPolicyPanel from '../components/DeliveryPolicyPanel.vue';
const route = useRoute();
const requestName = computed(() => typeof route.query.request === 'string' ? route.query.request : undefined);
const projectId = computed(() => typeof route.query.project === 'string' ? route.query.project : '');
</script>
<template>
  <section class="projects-page">
    <header class="page-heading"><div><h1 tabindex="-1">Projects</h1><p>One worker. Your projects, together in Werk Home.</p></div><RouterLink to="/workboard">Back to Workboard</RouterLink></header>
    <ol class="project-steps" aria-label="Project setup"><li><strong>1 · Add a project</strong><span>Clone your repository into the Home projects folder.</span></li><li><strong>2 · Review its workflow</strong><span>Preview missing setup files before committing and pushing.</span></li><li><strong>3 · Approve and recheck</strong><span>Grant the exact policy, then enable request intake.</span></li></ol>
    <p class="project-provider">Implementation also needs a <RouterLink to="/settings#provider-connections">configured provider and CLI account</RouterLink>. GitHub integration is optional; plain Git uses a Markdown pull request.</p>
    <ManagedProjectsPanel />
    <section v-if="projectId" id="shared-progress"><SharedIntakePanel :key="projectId" :project-id="projectId" :request-name="requestName" observation-only /></section>
    <section id="delivery-policy" class="project-policy"><DeliveryPolicyPanel registered-only :initial-project-id="projectId || undefined" /></section>
  </section>
</template>
<style scoped>
.projects-page { max-width:1200px;margin-inline:auto;min-width:0; }.page-heading { display:flex;justify-content:space-between;gap:var(--space-4);flex-wrap:wrap; }a { display:inline-flex;align-items:center;min-height:44px;color:var(--ui-primary);font-size:.875rem; }.project-steps { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-4);padding:0;list-style:none; }.project-steps li { padding:var(--space-4);border:1px solid var(--ui-border);border-radius:8px; }.project-steps strong,.project-steps span { display:block;font-size:.875rem;line-height:1.6; }.project-steps span,.project-provider { color:var(--ui-text-muted);font-size:.8125rem;line-height:1.7; }.project-policy { border-top:1px solid var(--ui-border);padding-top:var(--space-8);margin-top:var(--space-8); }@media(max-width:700px) { .project-steps { grid-template-columns:1fr; } }
</style>
