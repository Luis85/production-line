<script setup lang="ts">
import type { ProviderId } from '../../infrastructure/providers';
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import { state, workspaceAction, taskStatus } from '../store';
defineProps<{ disabled?: boolean }>();
const title = ref(''), provider = ref<ProviderId>('codex-cli'), rename = ref(''), busy = ref(false), removing = ref(false), error = ref('');
const current = computed(() => state.sessions?.records.find(item => item.id === state.sessions?.selected));
watch(() => [current.value?.id, current.value?.title].join('|'), () => { rename.value = current.value?.title ?? ''; removing.value = false; }, { immediate: true });
watch(() => state.unlocked, value => { if (!value) { title.value = ''; rename.value = ''; } });
async function action(body: unknown) { busy.value = true; error.value = ''; try { const result = await workspaceAction('/api/sessions', body); if (result) { title.value = ''; removing.value = false; } else error.value = state.actionError || 'Session change failed. Your input is retained; retry when the worker is available.'; } finally { busy.value = false; } }
</script>
<template>
<section v-if="state.unlocked" class="session-panel" aria-label="Tasks and sessions">
  <div class="session-picker"><label for="active-session">Current task</label><USelect id="active-session" :model-value="state.sessions?.selected" :items="state.sessions?.records.map(item => ({ value: item.id, label: item.title + ' · ' + taskStatus(item.status) + (item.archived ? ' · archived' : '') })) ?? []" class="w-full" :disabled="busy || disabled || state.workspaceBusy" @update:model-value="id => action({ action: 'select', id })" /><span class="muted">{{ state.settings?.providers.find(item => item.id === current?.provider)?.label ?? current?.provider }}</span></div>
  <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  <details><summary>Task settings</summary><div class="settings-grid"><form class="settings-form" @submit.prevent="action({ action: 'create', title: title.trim() || 'New task', provider })"><h3>New task options</h3><label for="session-title">Task name · optional</label><UInput id="session-title" v-model="title" maxlength="120" placeholder="Named from your first message" class="w-full" /><label for="session-provider">Provider connection</label><USelect id="session-provider" v-model="provider" :items="state.settings?.providers.map(item => ({ label: item.label + (item.configured ? '' : ' · needs setup'), value: item.id })) ?? []" class="w-full" /><UButton type="submit" :loading="busy" :disabled="disabled || state.workspaceBusy">Create new task</UButton></form><form class="settings-form" @submit.prevent="action({ action: 'rename', id: current?.id, title: rename })"><h3>Current task</h3><label for="rename-session">Name</label><UInput id="rename-session" v-model="rename" maxlength="120" required class="w-full" /><div class="actions"><UButton type="submit" color="neutral" variant="outline" :loading="busy" :disabled="disabled || state.workspaceBusy">Rename</UButton><UButton color="neutral" variant="outline" :disabled="busy || disabled || state.workspaceBusy || current?.busy" @click="action({ action: 'archive', id: current?.id })">Archive</UButton><UButton color="error" variant="ghost" :disabled="busy || disabled || state.workspaceBusy || current?.busy" @click="removing = !removing">Delete</UButton></div><div v-if="removing" class="confirm-row"><p>Delete this task session and its saved messages?</p><UButton color="error" :loading="busy" :disabled="disabled || state.workspaceBusy" @click="action({ action: 'delete', id: current?.id })">Confirm deletion</UButton></div></form></div><p class="page-note">Each task owns one provider session and transcript, saved across worker restarts. Selecting an archived task restores it. New task creates a separate session; follow-ups stay in the selected task.</p></details>
</section>
</template>
