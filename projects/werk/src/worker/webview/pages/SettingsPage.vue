<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onActivated, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UButton from '@nuxt/ui/components/Button.vue';
import USelect from '@nuxt/ui/components/Select.vue';
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
import { settingsSections, settingsSectionId } from '../settings-navigation';
const route = useRoute(), router = useRouter();
// Stable wrapper identities let KeepAlive preserve each editor and stop inactive polling.
const panels = {
  'provider-connections': defineComponent({ setup: () => () => h(SettingsPanel, { providerOnly: true }) }),
  queue: defineComponent({ setup: () => () => h('div', { class: 'settings-queue-panels' }, [h(QueueSettingsPanel), h(DurationSettingsPanel)]) }),
  'consumption-limits': defineComponent({ setup: () => () => h(ConsumptionPanel, { editorOpen: true }) }),
  'tool-access': ToolAccessPanel,
  repositories: RepositoryPanel,
  'shared-intake': SharedIntakePanel,
  'delivery-policy': DeliveryPolicyPanel,
  'execution-profiles': ExecutionProfilesPanel,
  'agent-definitions': DefinitionPanel,
  integrations: ProjectIntegrationsPanel,
  orchestrator: defineComponent({ setup: () => () => h('div', [h(SettingsPanel, { connectionOnly: true }), h(RequestPolicyPanel)]) }),
};
const selectedId = ref(settingsSectionId(route.hash));
watch(() => route.fullPath, () => { if (route.path === '/settings') selectedId.value = settingsSectionId(route.hash); });
const selected = computed(() => settingsSections.find(section => section.id === selectedId.value)!);
const options = settingsSections.map(section => ({ value: section.id, label: section.label }));
function choose(value: string) { void router.push({ path: '/settings', hash: '#' + value }); }
async function focusSection() {
  if (route.path !== '/settings' || !route.hash) return;
  const hash = route.hash;
  await nextTick();
  if (route.path !== '/settings' || route.hash !== hash) return;
  const heading = document.querySelector<HTMLElement>('.settings-content h2');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  document.querySelector('.settings-content')?.scrollIntoView({ block: 'start' });
}
watch(() => route.hash, () => { void focusSection(); });
onActivated(() => { void focusSection(); });
</script>
<template>
  <section class="settings-page">
    <div class="page-heading">
      <div><h1 tabindex="-1">Worker settings</h1><p>Configure how this worker runs, which tools it can use, and where work comes from.</p></div>
      <UButton to="/workboard" color="neutral" variant="outline" icon="i-lucide-arrow-left">Back to work</UButton>
    </div>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Worker settings sections">
        <RouterLink v-for="section in settingsSections" :key="section.id" :to="{ path: '/settings', hash: '#' + section.id }" :aria-current="section.id === selectedId ? 'location' : undefined">
          <UIcon :name="section.icon" /><span>{{ section.label }}<small>{{ section.hint }}</small></span>
        </RouterLink>
      </nav>
      <div class="settings-mobile-nav">
        <label for="worker-settings-section">Settings section</label>
        <USelect id="worker-settings-section" :model-value="selectedId" :items="options" class="w-full" @update:model-value="choose" />
      </div>
      <div class="settings-content" :aria-label="selected.label">
        <KeepAlive><component :is="panels[selectedId]" :key="selectedId" /></KeepAlive>
        <p class="settings-draft-note">Changes apply when you save a section. Unsaved edits stay in this tab while you navigate.</p>
      </div>
    </div>
  </section>
</template>
<style scoped>
.settings-page { max-width: 1480px; margin-inline: auto; }
.settings-page > .page-heading :deep(a) { min-height: 44px; }
.settings-content :deep(.settings-queue-panels) { display: grid; gap: var(--space-8); }
.settings-layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: var(--space-8); align-items: start; }
.settings-nav { display: grid; gap: var(--space-1); position: sticky; top: var(--space-4); }
.settings-nav a { display: flex; align-items: flex-start; gap: var(--space-3); padding: 12px 16px; min-height: 44px; border-radius: 8px; color: var(--ui-text-muted); text-decoration: none; font-size: .875rem; line-height: 1.4; }
.settings-nav a > :deep(.iconify) { flex: 0 0 20px; width: 20px; height: 20px; margin-top: 1px; }
.settings-nav a small { display: block; font-size: .75rem; font-weight: 400; margin-top: 4px; }
.settings-nav a:hover { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.settings-nav a[aria-current] { background: #243b37; color: #b3f1cf; font-weight: 600; }
.settings-content { min-width: 0; scroll-margin-top: var(--space-4); }
.settings-content :deep(.monitor-section:first-child) { margin-top: 0; }
.settings-content :deep(h2) { overflow-wrap: anywhere; }
.settings-draft-note { border-top: 1px solid var(--ui-border); padding-top: var(--space-4); margin-top: var(--space-6); color: var(--ui-text-muted); font-size: .75rem; }
.settings-mobile-nav { display: none; }
@media (max-width: 1000px) { .settings-layout { grid-template-columns: 210px minmax(0, 1fr); gap: var(--space-6); } .settings-nav a { padding-inline: 12px; } }
@media (max-width: 760px) { .settings-layout { grid-template-columns: 1fr; gap: var(--space-6); } .settings-nav { display: none; } .settings-mobile-nav { display: grid; gap: var(--space-2); } .settings-mobile-nav label { font-size: .8125rem; font-weight: 600; } }
</style>
