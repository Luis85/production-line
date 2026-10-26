<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onActivated, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UIcon from '@nuxt/ui/components/Icon.vue';
import QueueSettingsPanel from '../components/QueueSettingsPanel.vue';
import DurationSettingsPanel from '../components/DurationSettingsPanel.vue';
import ConsumptionPanel from '../components/ConsumptionPanel.vue';
import SettingsPanel from '../components/SettingsPanel.vue';
import ToolAccessPanel from '../components/ToolAccessPanel.vue';
import ExecutionProfilesPanel from '../components/ExecutionProfilesPanel.vue';
import DefinitionPanel from '../components/DefinitionPanel.vue';
import RepositoryPanel from '../components/RepositoryPanel.vue';
import SharedIntakePanel from '../components/SharedIntakePanel.vue';
import ProjectIntegrationsPanel from '../components/ProjectIntegrationsPanel.vue';
import RequestPolicyPanel from '../components/RequestPolicyPanel.vue';
import DeliveryPolicyPanel from '../components/DeliveryPolicyPanel.vue';
import { settingsGroups, settingsSectionId, visibleSettingsSections } from '../settings-navigation';
import { state } from '../store';
const route = useRoute(), router = useRouter();
// Stable component identities preserve each independent editor while navigating.
const panels = {
  'provider-connections': defineComponent({ setup: () => () => h(SettingsPanel, { providerOnly: true, hideDefaults: true }) }),
  'default-provider': defineComponent({ setup: () => () => h(SettingsPanel, { defaultOnly: true }) }),
  queue: QueueSettingsPanel,
  'duration-policy': DurationSettingsPanel,
  'consumption-limits': defineComponent({ setup: () => () => h(ConsumptionPanel, { editorOpen: true }) }),
  'tool-access': ToolAccessPanel,
  'retained-approvals': defineComponent({ setup: () => () => h(DeliveryPolicyPanel, { cleanupOnly: true }) }),
  repositories: RepositoryPanel,
  'shared-intake': SharedIntakePanel,
  'delivery-policy': DeliveryPolicyPanel,
  'execution-profiles': ExecutionProfilesPanel,
  'agent-definitions': DefinitionPanel,
  integrations: ProjectIntegrationsPanel,
  orchestrator: defineComponent({ setup: () => () => h(SettingsPanel, { connectionOnly: true }) }),
  'request-policy': RequestPolicyPanel,
};
const selectedId = ref(settingsSectionId(route.hash));
const sections = computed(() => visibleSettingsSections(state.environment?.homeLayout === 'central'));
const groups = computed(() => settingsGroups.map(group => ({ ...group, sections: sections.value.filter(section => section.group === group.id) })).filter(group => group.sections.length));
const selected = computed(() => sections.value.find(section => section.id === selectedId.value));
const panel = computed(() => selected.value ? panels[selected.value.id] : null);
watch(() => route.fullPath, () => { if (route.path === '/settings') selectedId.value = settingsSectionId(route.hash); });
watch(() => [state.environment?.homeLayout, selectedId.value, route.path], () => {
  if (route.path !== '/settings' || state.environment?.homeLayout !== 'central' || !selectedId.value || sections.value.some(section => section.id === selectedId.value)) return;
  const project = typeof route.query.project === 'string' ? route.query.project : '';
  void router.replace(project ? { path: '/project', query: { project, step: selectedId.value === 'delivery-policy' ? 'policy' : 'workflow' } } : { path: '/projects' });
}, { immediate: true });
async function focusGoal() {
  if (route.path !== '/settings') return;
  const hash = route.hash; await nextTick();
  if (route.path !== '/settings' || route.hash !== hash) return;
  document.getElementById('settings-goal')?.focus({ preventScroll: true });
  document.getElementById('settings-goal')?.scrollIntoView({ block: 'start' });
}
watch(() => route.hash, () => { void focusGoal(); });
onActivated(() => { void focusGoal(); });
</script>
<template>
  <section class="settings-page" :data-page-goal="selected?.goal || 'Choose one worker setting'">
    <header class="page-heading">
      <div><RouterLink v-if="selected" class="settings-back" to="/settings"><UIcon name="i-lucide-arrow-left" />All settings</RouterLink><h1 id="settings-goal" tabindex="-1">{{ selected?.goal || 'Worker settings' }}</h1><p>{{ selected?.hint || 'Choose the setting you want to change.' }}</p></div>
    </header>
    <div v-if="!selected" class="settings-directory">
      <section v-for="group in groups.filter(item => item.id !== 'coordination' && item.id !== 'projects')" :key="group.id" :aria-labelledby="'settings-group-' + group.id"><h2 :id="'settings-group-' + group.id">{{ group.label }}</h2><RouterLink v-for="section in group.sections" :key="section.id" :to="{ path: '/settings', hash: '#' + section.id }"><span><strong>{{ section.label }}</strong><small>{{ section.hint }}</small></span><UIcon name="i-lucide-arrow-right" /></RouterLink></section>
      <details v-for="group in groups.filter(item => item.id === 'coordination' || item.id === 'projects')" :key="group.id"><summary>{{ group.label }}</summary><RouterLink v-for="section in group.sections" :key="section.id" :to="{ path: '/settings', hash: '#' + section.id }"><span><strong>{{ section.label }}</strong><small>{{ section.hint }}</small></span><UIcon name="i-lucide-arrow-right" /></RouterLink></details>
      <p v-if="state.environment?.homeLayout === 'central'" class="settings-project-link">Repository setup and delivery authority belong to <RouterLink to="/projects">Projects</RouterLink>.</p>
    </div>
    <div class="settings-layout" :class="{ 'editor-hidden': !selected }">
      <nav v-if="selected" class="settings-nav" aria-label="Worker settings sections"><template v-for="group in groups" :key="group.id"><h2>{{ group.label }}</h2><RouterLink v-for="section in group.sections" :key="section.id" :to="{ path: '/settings', hash: '#' + section.id }" :aria-current="section.id === selectedId ? 'location' : undefined">{{ section.label }}</RouterLink></template></nav>
      <div class="settings-content" v-show="selected" :aria-label="selected?.label">
        <KeepAlive><component v-if="panel" :is="panel" :key="selectedId" /></KeepAlive>
        <p v-if="selected" class="settings-draft-note">Save applies this setting. Unsent edits stay in this tab while you navigate.</p>
      </div>
    </div>
  </section>
</template>
<style scoped>
.settings-page { max-width: 1280px; margin-inline: auto; min-width: 0; }
.page-heading { margin-bottom: var(--space-8); }.page-heading p { max-width: 65ch; }
a { text-decoration: none; }.settings-back { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 44px; color: var(--ui-primary); font-size: .8125rem; margin-bottom: var(--space-3); }
.settings-directory { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-8) var(--space-8); }.settings-directory h2 { font-size: 1rem; margin-bottom: var(--space-3); }
.settings-directory a { display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);min-height:64px;padding-block:var(--space-3);border-bottom:1px solid var(--ui-border);color:var(--ui-text); }.settings-directory a:hover { color:var(--ui-primary); }.settings-directory strong,.settings-directory small { display:block; }.settings-directory strong { font-size:.9375rem;font-weight:600; }.settings-directory small { font-size:.8125rem;color:var(--ui-text-muted);margin-top:var(--space-1);line-height:1.6; }.settings-directory details { min-width:0; }.settings-directory summary { cursor:pointer;min-height:44px;font-weight:600;font-size:1rem; }.settings-project-link { grid-column:1 / -1;color:var(--ui-text-muted);font-size:.875rem; }.settings-project-link a { display:inline-flex;min-height:44px;color:var(--ui-primary);border:0; }
.settings-layout { display:grid;grid-template-columns:220px minmax(0,1fr);gap:var(--space-8);align-items:start; }.editor-hidden { display:block; }.settings-nav { position:sticky;top:var(--space-4); }.settings-nav h2 { font-size:.75rem;color:var(--ui-text-muted);font-weight:600;margin:var(--space-6) 0 var(--space-2); }.settings-nav h2:first-child { margin-top:0; }.settings-nav a { display:flex;align-items:center;min-height:44px;padding:var(--space-2) var(--space-3);border-radius:6px;color:var(--ui-text-muted);font-size:.8125rem; }.settings-nav a:hover { color:var(--ui-text-highlighted);background:var(--ui-bg-elevated); }.settings-nav a[aria-current] { color:var(--ui-primary);background:var(--ui-bg-muted);font-weight:600; }.settings-content { min-width:0; }.settings-content :deep(.monitor-section:first-child) { margin-top:0; }.settings-draft-note { border-top:1px solid var(--ui-border);padding-top:var(--space-4);margin-top:var(--space-6);font-size:.75rem;color:var(--ui-text-muted); }
@media(max-width:760px) { .settings-directory { grid-template-columns:1fr;gap:var(--space-6); }.settings-layout { grid-template-columns:1fr; }.settings-nav { display:none; }.page-heading { margin-bottom:var(--space-6); } }
</style>
