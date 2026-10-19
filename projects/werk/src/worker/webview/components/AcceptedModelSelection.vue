<script setup lang="ts">
import { providerLabels } from '../../application/provider-contract';
import type { ModelSelection } from '../../application/model-selection';
defineProps<{ selection?: ModelSelection | null }>();
</script>
<template>
  <div class="accepted-model-selection">
    <dl v-if="selection" aria-label="Accepted model selection">
      <div><dt>Provider</dt><dd>{{ providerLabels[selection.provider] }}</dd></div>
      <div><dt>Model</dt><dd>{{ selection.model || 'Provider default · specific model not recorded' }}</dd></div>
      <div><dt>Effort</dt><dd>{{ selection.effort === 'default' ? 'Provider default' : selection.effort }}</dd></div>
    </dl>
    <p>{{ selection ? 'Saved for this Feature Request. Later worker defaults do not change this selection.' : 'No accepted model selection is retained for this request.' }}</p>
  </div>
</template>
<style scoped>
.accepted-model-selection { margin-block: 16px; min-width: 0; }
dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(140px, 2fr) minmax(100px, 1fr); gap: 12px 20px; margin: 0; }
dl > div { min-width: 0; }
dt, p { color: var(--ui-text-muted); font-size: .75rem; line-height: 1.6; }
dd { margin: 4px 0 0; font-size: .875rem; overflow-wrap: anywhere; }
p { margin: 8px 0 0; }
@media (max-width: 560px) { dl { grid-template-columns: 1fr; gap: 12px; } }
</style>
