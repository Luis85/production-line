<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import Taskboard from '../components/Taskboard.vue';
const route = useRoute();
const fileId = computed(() => typeof route.query.fileId === 'string' ? route.query.fileId : '');
</script>
<template><section class="task-maintenance-page" data-page-goal="Manage one saved file task"><header class="page-heading"><div><RouterLink to="/history">Back to request history</RouterLink><h1 tabindex="-1">Manage saved task</h1><p>Change its queue priority, retry saved input, or manage retained task files.</p></div></header><Taskboard v-if="fileId" :focused-task-id="fileId" /><p v-else role="alert">Choose a saved file task from request history before opening its controls.</p></section></template>
<style scoped>.task-maintenance-page { max-width:1000px;margin-inline:auto;min-width:0; }.page-heading a { display:inline-flex;align-items:center;min-height:44px;color:var(--ui-primary);font-size:.8125rem; }.page-heading p { max-width:65ch; }.task-maintenance-page :deep(button),.task-maintenance-page :deep(a[class]) { min-height:44px; }</style>
