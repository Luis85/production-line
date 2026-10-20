<script setup lang="ts">
import { computed, ref } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { DeliveryPolicySnapshot } from '../../application/delivery-policy';
import { useWorkerSnapshot } from '../useWorkerSnapshot';
import { request, state } from '../store';
const { data, error, loading, refreshing, refresh } = useWorkerSnapshot(() => request<DeliveryPolicySnapshot>('/api/requests', 'POST', { action: 'delivery_policy' }));
const selected = ref('');
const profile = computed(() => data.value?.configuration.profiles.find(item => item.id === selected.value) ?? data.value?.profile);
</script>
<template>
  <section class="delivery-policy" aria-labelledby="delivery-policy-title">
    <header><h2 id="delivery-policy-title">Project delivery policy</h2><UButton variant="outline" color="neutral" :loading="refreshing" :disabled="!state.unlocked" @click="refresh">Refresh committed policy</UButton></header>
    <p>The worker reads <code>.werk/delivery-policy.json</code> from the committed project baseline. Each accepted request keeps its own policy snapshot.</p>
    <p v-if="error" role="alert" class="error-text">{{ error }} Commit the project policy and refresh to inspect its effective settings.</p>
    <p v-else-if="loading && !data" role="status">Reading the committed project policy…</p>
    <template v-if="data && profile">
      <dl><div><dt>Default quality profile</dt><dd>{{ data.configuration.defaultProfile }}</dd></div><div><dt>Review notes directory</dt><dd>{{ data.configuration.reviewDirectory }}</dd></div><div><dt>Committed baseline</dt><dd><code>{{ data.baseline }}</code></dd></div><div><dt>Policy version</dt><dd>{{ data.configuration.version }}</dd></div></dl>
      <label for="delivery-profile-preview">Preview a quality profile</label><select id="delivery-profile-preview" :value="profile.id" @change="selected = ($event.target as HTMLSelectElement).value"><option v-for="item in data.configuration.profiles" :key="item.id" :value="item.id">{{ item.id }}</option></select>
      <dl><div><dt>Minimum acceptance criteria</dt><dd>{{ profile.minimumCriteria }}</dd></div><div><dt>Minimum instruction length</dt><dd>{{ profile.minimumMessageLength }} characters</dd></div><div><dt>Maximum repair attempts</dt><dd>{{ profile.maxRepairAttempts }}</dd></div></dl>
      <h3>Protected verification inputs</h3><ul><li v-for="path in profile.verificationInputs" :key="path"><code>{{ path }}</code></li></ul>
      <p>Review and commit policy changes in the project. Previewing a profile here does not change the default or alter accepted work. A Feature Request can select a configured <code>quality_profile</code>.</p>
      <details><summary>Configuration identity</summary><code>{{ data.configurationDigest }}</code></details>
    </template>
  </section>
</template>
<style scoped>
.delivery-policy { min-width: 0; }header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }h2 { font-size: 1.25rem; margin: 0; }h3 { font-size: 1rem; margin-top: var(--space-6); }p { max-width: 75ch; font-size: .875rem; line-height: 1.65; }code, dd { overflow-wrap: anywhere; }code { font-size: .8125rem; }dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-4); margin-block: var(--space-6); }dt { color: var(--ui-text-muted); font-size: .8125rem; }dd { font-size: .875rem; margin: var(--space-1) 0 0; }label { display: block; font-size: .875rem; margin-bottom: var(--space-2); }select { min-height: 44px; border: 1px solid var(--ui-border); background: var(--ui-bg); color: var(--ui-text); padding-inline: var(--space-3); border-radius: 6px; width: min(100%,24rem); }ul { padding-left: var(--space-6); }li { margin-block: var(--space-2); }summary { min-height: 44px; padding-block: var(--space-3); cursor: pointer; font-size: .875rem; }@media (max-width: 560px) { dl { grid-template-columns: 1fr; } }
</style>
