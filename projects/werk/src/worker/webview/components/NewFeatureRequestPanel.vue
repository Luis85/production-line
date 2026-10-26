<script setup lang="ts">
import { computed } from 'vue';
import SharedFeatureComposer from './SharedFeatureComposer.vue';
import { request, state } from '../store';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import type { ManagedProjectsView } from '../../application/managed-projects';
defineProps<{ initialProjectId?: string }>();
defineEmits<{ created: [sessionId: string, previousSessionId: string]; busy: [boolean] }>();
const snapshot = useWorkerSnapshot(() => request<ManagedProjectsView>('/api/managed-projects'));
const clones = computed(() => snapshot.data.value?.projects.filter(project => project.mode === 'clone') ?? []);
const ready = computed(() => clones.value.filter(project => project.status === 'ready' && project.intake === 'shared' && project.intakeEnabled && project.policyApproved === true && !project.intakeBlockedReason));
const providerReady = computed(() => state.settings?.providers.some(provider => provider.configured) === true);
</script>
<template>
  <section class="new-feature-request" aria-label="New Feature Request">
    <p v-if="snapshot.loading.value && !snapshot.data.value" role="status">Checking project setup…</p>
    <p v-if="snapshot.error.value" role="alert">{{ snapshot.error.value }} <button type="button" @click="snapshot.refresh">Retry project check</button></p>
    <template v-if="snapshot.data.value">
      <div v-if="!ready.length || !providerReady" class="request-setup">
        <h2>Get ready to create a Feature Request</h2><p>A project checkout, approved workflow and configured provider keep your request connected to its real Git history.</p>
        <ol><li><RouterLink to="/projects">{{ clones.length ? 'Finish project setup' : 'Add a project' }}</RouterLink><span>Clone into Werk Home, review workflow files, approve the exact policy, then recheck setup.</span></li><li><RouterLink to="/settings#provider-connections">{{ providerReady ? 'Provider configured' : 'Set up a provider' }}</RouterLink><span>Confirm the CLI account on this worker.</span></li></ol>
        <p v-for="project in clones.filter(item => !ready.includes(item))" :key="project.id"><strong>{{ project.name }}</strong> · {{ project.intakeBlockedReason || project.detail }}</p>
      </div>
      <SharedFeatureComposer v-if="ready.length && providerReady" :initial-project-id="initialProjectId || ready[0]?.id" :registered-projects="ready.map(project => ({ id: project.id, label: project.name, enabled: true }))" @created="(id, previous) => $emit('created', id, previous)" @busy="$emit('busy', $event)" />
    </template>
  </section>
</template>
<style scoped>
.new-feature-request { min-width:0;max-width:900px;margin-inline:auto; }.request-setup { padding:var(--space-6);border:1px solid var(--ui-border);border-radius:10px; }h2 { font-size:1.125rem; }p,li { font-size:.875rem;line-height:1.7;overflow-wrap:anywhere; }ol { padding-left:var(--space-6); }li span { display:block;color:var(--ui-text-muted); }a,button { display:inline-flex;align-items:center;min-height:44px;color:var(--ui-primary); }
</style>
