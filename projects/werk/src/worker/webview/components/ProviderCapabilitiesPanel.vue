<script setup lang="ts">
import { computed } from 'vue';
import type { ProviderCapabilities } from '../../application/provider-capabilities';
const props = defineProps<{ capabilities?: ProviderCapabilities; runtimeVersion?: string | null }>();
const rows = computed(() => {
  const value = props.capabilities;
  if (!value) return [];
  return [
    ['Continuation', value.continuation === 'provider_session' ? 'Native provider session' : 'Retained worker context in a new invocation'],
    ['Tool permissions', value.permissions === 'worker_grants' ? 'Explicit worker tool grants' : 'Provider-native permissions and hooks'],
    ['Configuration', value.configuration === 'isolated_with_managed_policy' ? 'Managed worker policy' : 'Provider-native configuration'],
    ['Loaded extensions', value.loadedExtensions === 'worker_bridge_only' ? 'Worker tool bridge only' : 'Provider configuration; extensions are not enumerated'],
    ['Interruption', value.interruption === 'await_local_process_tree' ? 'Waits for the local process tree to stop' : 'Aborts the local HTTP request'],
    ['Remote cancellation', 'Not confirmed by this adapter'],
    ['Usage evidence', value.usage === 'reported_when_available' ? 'Reported when available; missing values remain unknown' : 'Unavailable from this adapter'],
  ];
});
</script>
<template>
  <details class="provider-capabilities">
    <summary>Connection capabilities and limits</summary>
    <template v-if="capabilities">
      <p>Adapter contract {{ capabilities.adapterVersion }} · {{ capabilities.interface === 'cli' ? 'Command-line integration' : 'HTTP integration' }}<template v-if="runtimeVersion"> · CLI version {{ runtimeVersion }}</template></p>
      <dl><div v-for="[label, value] in rows" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></div></dl>
      <p>These describe the configured adapter. A sign-in check does not prove model access, remaining account allowance or successful project execution.</p>
    </template>
    <p v-else>Capability details are unavailable in this saved connection. Check the connection to inspect its supported behavior.</p>
  </details>
</template>
<style scoped>
.provider-capabilities { border-top: 1px solid var(--ui-border); padding-top: var(--space-3); min-width: 0; }.provider-capabilities summary { cursor: pointer; min-height: 44px; padding-block: var(--space-3); font-size: .875rem; }.provider-capabilities p { font-size: .8125rem; color: var(--ui-text-muted); line-height: 1.65; }.provider-capabilities dl { display: grid; gap: var(--space-3); font-size: .875rem; }.provider-capabilities dl > div { display: grid; grid-template-columns: 160px minmax(0,1fr); gap: var(--space-3); }.provider-capabilities dt { color: var(--ui-text-muted); }.provider-capabilities dd { margin: 0; overflow-wrap: anywhere; }@media (max-width: 560px) { .provider-capabilities dl > div { grid-template-columns: 1fr; gap: var(--space-1); } }
</style>
