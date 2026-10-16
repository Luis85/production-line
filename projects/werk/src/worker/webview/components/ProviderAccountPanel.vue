<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import type { ProviderId } from '../../infrastructure/providers';
import { createProviderAccountView } from '../provider-account-view';
import { date, request, state } from '../store';
const props = defineProps<{ providerId: ProviderId; connectionKey: string; enabled: boolean }>();
const account = createProviderAccountView({ id: () => props.providerId, identity: () => props.connectionKey, enabled: () => props.enabled, unlocked: () => state.unlocked, epoch: () => state.draftEpoch, read: id => request('/api/providers/account', 'POST', { id }) });
const observation = account.state;
const status = computed(() => observation.value?.signedIn === true ? 'Signed in' : observation.value?.signedIn === false ? 'Signed out' : 'Account status unavailable');
const fields = computed(() => observation.value?.signedIn === true ? [
  ['Account', observation.value.account], ['Email', observation.value.email], ['Organization', observation.value.organization], ['Subscription', observation.value.subscription], ['Authentication method', observation.value.authMethod],
].filter((item): item is [string, string] => typeof item[1] === 'string' && !!item[1]) : []);
function refreshIfNeeded() { if (!observation.value && !observation.loading && props.enabled && state.unlocked) void account.refresh(); }
onMounted(refreshIfNeeded); onActivated(refreshIfNeeded);
watch(() => [props.providerId, props.connectionKey, props.enabled, state.unlocked], refreshIfNeeded);
onBeforeUnmount(account.dispose);
</script>
<template>
  <section class="provider-account-panel" aria-label="Provider account on this worker">
    <div class="provider-account-heading"><h4>Account on the worker machine</h4><UButton type="button" color="neutral" variant="outline" size="sm" :loading="observation.loading" :disabled="!enabled || observation.loading || !state.unlocked" @click="account.refresh">Refresh account status</UButton></div>
    <p v-if="!enabled" class="page-note">Save the provider connection before checking its account.</p>
    <p v-else-if="observation.loading && !observation.value" role="status" class="page-note">Reading the saved provider’s account status…</p>
    <p v-if="observation.error" role="alert" class="error-text">{{ observation.error }} Refresh account status to retry.</p>
    <template v-if="observation.value">
      <p role="status"><strong>{{ status }}</strong><span class="page-note"> · Checked {{ date(observation.value.checkedAt) }}</span></p>
      <dl v-if="fields.length"><div v-for="[label, value] in fields" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></div></dl>
      <p class="page-note">{{ observation.value.message }}</p>
      <p v-if="observation.value.signedIn === true && !observation.value.subscription" class="page-note">Subscription details are unavailable from this CLI.</p>
    </template>
    <p class="page-note">Uses the worker process owner’s saved login. This read-only check sends no model task and does not sign in, sign out or change accounts.</p>
  </section>
</template>
<style scoped>
.provider-account-panel { display: grid; gap: 12px; min-width: 0; margin-top: 8px; padding-top: 20px; border-top: 1px solid var(--ui-border); }
.provider-account-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }.provider-account-heading h4 { margin: 0; font-size: .875rem; font-weight: 650; }
.provider-account-heading button { min-height: 44px; }.provider-account-panel p { margin: 0; }.provider-account-panel dl { display: grid; gap: 10px; margin: 0; }.provider-account-panel dl > div { display: grid; grid-template-columns: 145px minmax(0, 1fr); gap: 12px; font-size: .8125rem; }.provider-account-panel dt { color: var(--ui-text-muted); }.provider-account-panel dd { margin: 0; overflow-wrap: anywhere; }.provider-account-panel .error-text { overflow-wrap: anywhere; }
@media (max-width: 600px) { .provider-account-panel dl > div { grid-template-columns: 1fr; gap: 3px; } }
</style>
