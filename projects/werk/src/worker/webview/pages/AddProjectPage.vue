<script setup lang="ts">
import ManagedProjectsPanel from '../components/ManagedProjectsPanel.vue';
</script>
<template>
  <section class="add-project-page" aria-labelledby="add-project-title">
    <RouterLink class="back-link" to="/projects">Back to projects</RouterLink>
    <header class="page-heading"><div><h1 id="add-project-title" tabindex="-1">Add a project</h1><p>Clone a Git repository into Werk Home.</p></div></header>
    <p class="page-note">The worker uses its own checkout and Git account. Your development checkout stays separate. Keep credentials out of the repository URL.</p>
    <ManagedProjectsPanel mode="register" />
  </section>
</template>
<style scoped>
.add-project-page { max-width:800px;margin-inline:auto;min-width:0; }.back-link { display:inline-flex;align-items:center;min-height:44px;color:var(--ui-primary);margin-bottom:var(--space-4);font-size:.875rem; }.page-heading { margin-bottom:var(--space-4); }.page-note { max-width:70ch;font-size:.875rem;line-height:1.65;margin-bottom:var(--space-6);color:var(--ui-text-muted); }
</style>
