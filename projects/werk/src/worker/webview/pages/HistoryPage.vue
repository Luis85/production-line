<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import TaskConversationHistory from '../components/TaskConversationHistory.vue';
import FileTaskHistory from '../components/FileTaskHistory.vue';
import RunEvidencePanel from '../components/RunEvidencePanel.vue';
import FeatureRequestsPanel from '../components/FeatureRequestsPanel.vue';
import AssignedAttemptHistory from '../components/AssignedAttemptHistory.vue';
import { state } from '../store';
const route=useRoute();
const view=computed(() => route.query.runSession || route.query.view==='runs' ? 'runs' : route.query.view==='features' ? 'features' : route.query.view==='assigned' ? 'assigned' : route.query.fileId || route.query.fileState || route.query.view==='files' ? 'files' : 'requests');
const pages={ requests:{title:'Request history',goal:'Find a retained request',component:TaskConversationHistory}, files:{title:'File-task history',goal:'Find retained file-task evidence',component:FileTaskHistory}, runs:{title:'Execution evidence',goal:'Inspect a recorded execution attempt',component:RunEvidencePanel}, features:{title:'Project request history',goal:'Inspect retained project request evidence',component:FeatureRequestsPanel}, assigned:{title:'Assigned attempt history',goal:'Inspect an assigned attempt',component:AssignedAttemptHistory} };
const selected=computed(()=>pages[view.value]);
</script>
<template><section class="history-page" :data-page-goal="selected.goal"><header class="page-heading"><div><h1 tabindex="-1">{{ selected.title }}</h1><p>{{ selected.goal }}. Browsing history does not change running work.</p></div></header><nav class="history-views" aria-label="History views"><RouterLink to="/history" :aria-current="['requests','files'].includes(view) ? 'page' : undefined">Requests</RouterLink><RouterLink to="/history?view=runs" :aria-current="view==='runs' ? 'page' : undefined">Execution attempts</RouterLink><RouterLink to="/history?view=features" :aria-current="view==='features' ? 'page' : undefined">Project requests</RouterLink><RouterLink to="/history?view=assigned" :aria-current="view==='assigned' ? 'page' : undefined">Assigned attempts</RouterLink></nav><p v-if="!state.unlocked" role="status">Unlock this worker to inspect retained evidence.</p><KeepAlive><component v-if="state.unlocked" :is="selected.component" :key="view" /></KeepAlive></section></template>
<style scoped>.history-page { max-width:1400px;margin-inline:auto;min-width:0; }.history-views { display:flex;gap:var(--space-4);flex-wrap:wrap;padding-block:var(--space-3);margin-bottom:var(--space-6);border-bottom:1px solid var(--ui-border); }.history-views a { display:inline-flex;align-items:center;min-height:44px;font-size:.875rem;color:var(--ui-text-muted);text-decoration:none; }.history-views a[aria-current] { color:var(--ui-primary);font-weight:600; }.history-views a:hover { color:var(--ui-text); }.page-heading p { max-width:65ch; }</style>
