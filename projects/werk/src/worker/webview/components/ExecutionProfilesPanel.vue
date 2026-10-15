<script lang="ts">
import { createExecutionProfileEditor } from '../execution-profile-editor';
import { state as workerState, executionProfilesAction, refresh } from '../store';
const profileEditor = createExecutionProfileEditor({
  view: () => workerState.executionProfiles,
  unlocked: () => workerState.unlocked,
  epoch: () => workerState.draftEpoch,
  write: executionProfilesAction,
  refresh,
});
</script>
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import { state, workspaceAction } from '../store';
const { draft, dirty, stale, locked, validation, canSave } = profileEditor;
const view = computed(() => state.executionProfiles);
const providerName = (provider: string) => provider === 'claude' ? 'Claude' : 'Codex';
const providers = computed(() => view.value?.allowedProviders.map(provider => ({ value: provider, label: providerName(provider) })) ?? []);
const pausing = ref(false);
async function add() {
  profileEditor.add();
  await nextTick(); document.getElementById(`execution-profile-id-${draft.profiles.length - 1}`)?.focus();
}
async function remove(index: number) {
  profileEditor.remove(index);
  await nextTick(); document.getElementById(`execution-profile-id-${Math.min(index, draft.profiles.length - 1)}`)?.focus();
}
async function pause() {
  if (pausing.value || !state.unlocked) return;
  pausing.value = true; draft.error = ''; const epoch = state.draftEpoch;
  try {
    if (!await workspaceAction('/api/settings', { board: { paused: true } }) && state.unlocked && epoch === state.draftEpoch) draft.error = state.actionError || 'New starts could not be paused. Try again.';
  } finally { pausing.value = false; }
}
</script>

<template>
  <section class="execution-profiles" aria-labelledby="execution-profiles-title">
    <div class="section-heading">
      <h2 id="execution-profiles-title">Execution profiles</h2>
      <UBadge v-if="view" color="neutral" variant="subtle">{{ view.mode === 'mock' ? 'Simulated execution' : 'Live CLI execution' }}</UBadge>
    </div>
    <p class="page-note">Name the provider profiles this worker offers for assignments. All profiles share one execution slot.</p>
    <template v-if="view">
      <div v-if="view.pending" class="profile-update" role="status">
        <strong>Waiting for the orchestrator</strong>
        <p>Profile changes are saved. The worker retries the update automatically. Requested profiles take effect after acceptance.</p>
        <p>Requested: <span v-for="(profile, index) in view.pending.profiles" :key="profile.id" class="break-anywhere">{{ index ? '; ' : '' }}{{ profile.id }} · {{ providerName(profile.provider) }}</span>.</p>
        <p v-if="dirty">Your unsaved edits are kept while this update is pending.</p>
        <p>Currently active: <span v-for="(profile, index) in view.profiles" :key="profile.id" class="break-anywhere">{{ index ? '; ' : '' }}{{ profile.id }} · {{ providerName(profile.provider) }}</span>.</p>
      </div>
      <form v-if="!view.pending" :aria-busy="draft.busy" @submit.prevent="profileEditor.save">
        <fieldset :disabled="locked" class="profile-fields">
          <legend class="sr-only">Edit execution profiles</legend>
          <p id="execution-profile-id-help" class="page-note">Profile IDs identify assignments. Use letters, numbers, underscores or hyphens; changing an ID also changes its routing name.</p>
          <div v-for="(profile, index) in draft.profiles" :key="index" class="profile-row">
            <div class="profile-field"><label :for="`execution-profile-id-${index}`">Profile ID{{ draft.profiles.length > 1 ? ' · ' + (index + 1) : '' }}</label><UInput :id="`execution-profile-id-${index}`" v-model="profile.id" required pattern="[A-Za-z0-9_\-]+" maxlength="100" aria-describedby="execution-profile-id-help" class="w-full" /></div>
            <div class="profile-field"><label :for="`execution-profile-provider-${index}`">Provider{{ draft.profiles.length > 1 ? ' · ' + (index + 1) : '' }}</label><USelect :id="`execution-profile-provider-${index}`" v-model="profile.provider" :items="providers" :disabled="providers.length === 1" class="w-full" /></div>
            <UButton v-if="view.maxProfiles > 1" type="button" color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="draft.profiles.length === 1" :aria-label="`Remove execution profile ${profile.id || index + 1}`" @click="remove(index)">Remove</UButton>
          </div>
          <div class="profile-actions">
            <UButton v-if="view.maxProfiles > 1" type="button" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="draft.profiles.length >= view.maxProfiles" @click="add">Add profile</UButton>
            <UButton type="submit" :loading="draft.busy" :disabled="!canSave">Save profiles</UButton>
            <UButton v-if="dirty || stale" type="button" color="neutral" variant="ghost" @click="profileEditor.reload">Discard edits and reload</UButton>
          </div>
        </fieldset>
        <p v-if="validation && dirty" role="status" class="error-text">{{ validation }}</p>
        <p v-if="stale" role="status" class="profile-update">Saved profiles changed while you were editing. Your draft is kept. Discard edits and reload the current profiles before saving again.</p>
      </form>
      <div v-if="!view.pending && !view.canEdit" class="profile-guidance">
        <p>{{ view.saveBlockedReason || 'Pause new starts and finish or stop queued and running work before saving profiles.' }}</p>
        <UButton v-if="state.settings && !state.settings.board.paused" type="button" color="neutral" variant="outline" icon="i-lucide-pause" :loading="pausing" :disabled="draft.busy || !state.unlocked" @click="pause">Pause new starts</UButton>
        <p v-if="state.settings?.board.paused" class="page-note">Queued work stays paused. Open Taskboard to finish or stop it, then return to save.</p>
      </div>
      <p v-else-if="!view.pending && state.settings?.board.paused" class="page-note">New starts are paused. Save your profiles, then resume from Work in progress when you are ready.</p>
      <p class="page-note">{{ view.mode === 'mock' ? 'This worker simulates assigned work. Editing profiles does not enable live execution.' : 'This worker supports one Codex CLI execution profile.' }} Provider sign-in and model settings are managed separately in <RouterLink to="/dashboard#provider-connections">Provider connections</RouterLink>.</p>
    </template>
    <p v-else class="page-note">Execution profiles are not available yet. Refresh to load this worker’s saved profiles.</p>
    <p v-if="draft.error" role="alert" class="error-text">{{ draft.error }}</p>
    <p v-if="draft.notice" role="status" class="page-note">{{ draft.notice }}</p>
    <div v-if="draft.uncertain" class="profile-update" role="status">
      <p>The save acknowledgement is uncertain. Your submitted profiles are kept. Check their status or retry the same save.</p>
      <UButton type="button" color="neutral" variant="outline" :loading="draft.busy" :disabled="draft.checking || !state.unlocked" @click="profileEditor.retry">Retry same save</UButton>
    </div>
    <UButton v-if="!view || view.pending || draft.uncertain" type="button" color="neutral" variant="outline" :loading="draft.checking" :disabled="draft.busy || !state.unlocked" @click="profileEditor.check">Check saved profiles</UButton>
  </section>
</template>

<style scoped>
.execution-profiles { min-width: 0; }
.execution-profiles h2 { margin: 0; }
.execution-profiles .section-heading { flex-wrap: wrap; }
.profile-fields { min-width: 0; margin: 0; padding: 0; border: 0; }
.profile-row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(150px, 1fr) auto; align-items: end; gap: var(--space-4); padding: var(--space-4) 0; border-bottom: 1px solid var(--ui-border); }
.profile-field { display: grid; gap: var(--space-2); min-width: 0; }
.profile-field label { font-weight: 600; }
.profile-row :deep(input), .profile-row :deep(button), .profile-actions :deep(button) { min-height: 44px; }
.profile-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-6); }
.profile-update { margin: var(--space-4) 0; padding: var(--space-4); background: var(--ui-bg-elevated); border: 1px solid var(--ui-border); border-radius: 12px; overflow-wrap: anywhere; }
.profile-update p { margin: var(--space-2) 0; }
.profile-guidance { margin: var(--space-6) 0 var(--space-4); }
.profile-guidance p { margin: var(--space-2) 0; }
@media (max-width: 620px) { .profile-row { grid-template-columns: minmax(0, 1fr); gap: var(--space-3); } .profile-row > button { justify-self: start; } .profile-actions { align-items: stretch; flex-direction: column; } .profile-actions :deep(button) { justify-content: center; } }
</style>
