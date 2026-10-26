<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import TaskInteraction from '../components/TaskInteraction.vue';
import SharedIntakePanel from '../components/SharedIntakePanel.vue';
import { state, workspaceAction } from '../store';
const route = useRoute(), loading = ref(false), error = ref(''), selectedIdentity = ref('');
const interaction = ref<InstanceType<typeof TaskInteraction> | null>(null);
let active = true, generation = 0, openingIdentity = "";
const sessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : '');
const projectId = computed(() => typeof route.query.project === 'string' ? route.query.project : '');
const requestName = computed(() => typeof route.query.request === 'string' ? route.query.request : undefined);
const identityError = computed(() => sessionId.value && (projectId.value || requestName.value) ? 'This link mixes conversation and project request identities. Return to Workboard and open the exact request.' : requestName.value && !projectId.value ? 'This request link has no project. Choose a retained request from Workboard.' : '');
const fileTask = computed(() => state.board?.tasks.find(task => task.sessionId === sessionId.value));
const current = computed(() => state.sessions?.records.find(session => session.id === sessionId.value));
const matching = computed(() => !!sessionId.value && selectedIdentity.value === sessionId.value && state.sessions?.selected === sessionId.value && !!current.value);
async function open() {
  const id = sessionId.value;
  if (active && state.unlocked && route.path === '/request' && !identityError.value && matching.value) { error.value = ''; return; }
  if (state.unlocked && active && route.path === '/request' && loading.value && openingIdentity === id) return;
  const revision = ++generation; openingIdentity = id; selectedIdentity.value = ''; error.value = ''; loading.value = false;
  if (!active || !state.unlocked || route.path !== '/request' || !id) return;
  if (identityError.value) { error.value = identityError.value; return; }
  loading.value = true;
  try {
    if (!state.sessions) return;
    if (!state.sessions.records.some(session => session.id === id)) throw Error('This request is not available. Return to Workboard and open a retained request.');
    if (state.sessions?.selected !== id && !await workspaceAction('/api/sessions', { action: 'select', id })) throw Error(state.actionError || 'The request could not be opened. Try again.');
    if (revision !== generation || !active || !state.unlocked || sessionId.value !== id) return;
    if (state.sessions?.selected !== id) throw Error('The selected request changed. Open this request again before continuing.');
    selectedIdentity.value = id; await nextTick(); await interaction.value?.focusConversation();
  } catch (failure) { if (revision === generation && state.unlocked) error.value = (failure as Error).message; }
  finally { if (revision === generation) loading.value = false; }
}
watch(() => [route.fullPath, state.unlocked], () => { void open(); }, { immediate:true });
watch(() => !!state.sessions, available => { if (available && !selectedIdentity.value) void open(); });
watch(() => state.sessions?.selected, selected => { if (selectedIdentity.value && selected !== selectedIdentity.value) { selectedIdentity.value = ''; error.value = 'Another request was selected. Reopen this request before sending a response.'; } });
onActivated(() => { active = true; void open(); });
onDeactivated(() => { active = false; generation++; loading.value = false; });
</script>
<template>
  <section class="request-page" aria-labelledby="request-page-title">
    <header class="page-heading"><div><h1 id="request-page-title" tabindex="-1">{{ sessionId ? current?.title || 'Request conversation' : requestName ? 'Incoming Feature Request' : 'Choose an incoming request' }}</h1><p>{{ sessionId ? 'Follow this request and respond to its current checkpoint.' : requestName ? 'Resolve the next checkpoint for this committed request.' : 'Select a committed Feature Request from this project.' }}</p></div><UButton to="/workboard" color="neutral" variant="ghost">Back to Workboard</UButton></header>
    <p v-if="!state.unlocked" role="status">Unlock this worker to open the request.</p>
    <p v-else-if="identityError" class="error-text" role="alert">{{ identityError }}</p>
    <template v-else-if="sessionId"><p v-if="loading" role="status">Opening this request…</p><p v-if="error" class="error-text" role="alert">{{ error }} <button type="button" @click="open">Reopen request</button></p><p v-if="!loading && !error && !matching" role="status">The request is not available in the current snapshot. <button type="button" @click="open">Reopen request</button></p><TaskInteraction v-if="matching" id="request-controls" ref="interaction" :key="sessionId" existing-only @board="$router.push('/workboard')" /><RouterLink v-if="matching && fileTask" :to="{ path: '/request/maintenance', query: { fileId: fileTask.id } }" class="saved-task-link">Manage this saved task</RouterLink></template>
    <SharedIntakePanel v-else-if="projectId" :key="projectId + ':' + (requestName || '')" :project-id="projectId" :request-name="requestName" observation-only focused />
    <p v-else class="page-note">Choose a request from <RouterLink to="/workboard">Workboard</RouterLink> to see its conversation and next action.</p>
  </section>
</template>
<style scoped>
.request-page { max-width:1100px;margin-inline:auto;min-width:0; }.page-heading { display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-6); }.page-heading h1 { overflow-wrap:anywhere;font-size:2rem;line-height:1.25;letter-spacing:-.025em; }.page-heading p { color:var(--ui-text-muted);font-size:.875rem;line-height:1.65; }button,a { min-height:44px;display:inline-flex;align-items:center;color:var(--ui-primary); }
</style>
