<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import ManagedProjectsPanel from '../components/ManagedProjectsPanel.vue';
</script>
<template>
  <section class="projects-page" aria-labelledby="projects-title">
    <header class="page-heading"><div><h1 id="projects-title" tabindex="-1">Projects</h1><p>Choose a project to check its setup.</p></div><UButton to="/projects/new" icon="i-lucide-plus">Add a project</UButton></header>
    <ManagedProjectsPanel mode="directory" />
  </section>
</template>
<style scoped>
.projects-page { max-width:1200px;margin-inline:auto;min-width:0; }.page-heading { display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-6); }.page-heading :deep(a) { min-height:44px; }
</style>
