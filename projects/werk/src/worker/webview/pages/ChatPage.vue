<script setup lang="ts">
import SessionPanel from '../components/SessionPanel.vue';
import RunTask from '../components/RunTask.vue';
import NewTask from '../components/NewTask.vue';
import SettingsPanel from '../components/SettingsPanel.vue';
import DefinitionPanel from '../components/DefinitionPanel.vue';
import MessageContent from '../components/MessageContent.vue';
import { computed, nextTick, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import { state, chatAction, date, taskStatus } from '../store';
const sending = ref(false), creating = ref(false), setup = ref(false), definitions = ref(false);
watch(() => state.sessions?.selected, () => { creating.value = false; });
const current = computed(() => state.sessions?.records.find(item => item.id === state.sessions?.selected));
const snapshot = computed(() => current.value?.definition);
const available = computed(() => state.unlocked && state.chat?.available && !state.workspaceBusy && !current.value?.busy);
const firstMessage = computed(() => !state.chat?.messages.length);
const phase = computed(() => state.chat?.phase ?? 'idle');
async function createTask() { if (sending.value || state.workspaceBusy) return; creating.value = true; await nextTick(); document.getElementById('session-provider')?.focus(); }
async function created() { creating.value = false; await nextTick(); document.getElementById('chat-message')?.focus(); }
async function showSetup() { setup.value = true; await nextTick(); document.getElementById('provider-connection')?.focus(); }
async function showDefinitions() { definitions.value = true; await nextTick(); document.getElementById('definition-file')?.focus(); }
async function act(action: 'send' | 'cancel') { if (sending.value || state.workspaceBusy) return; sending.value = true; try { await chatAction(action); if (action === 'send') { await nextTick(); document.querySelector('.message:last-of-type')?.scrollIntoView({ block: 'nearest' }); } } finally { sending.value = false; } }
function keydown(event: KeyboardEvent) { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && state.draft.trim() && available.value && !state.chat?.busy) { event.preventDefault(); void act('send'); } }
</script>
<template>
<section class="chat-page">
  <div class="page-heading"><div><h1 tabindex="-1">Chat</h1><p>Give your worker a task. Keep the conversation with the work.</p></div><div class="actions"><UButton color="neutral" variant="ghost" icon="i-lucide-plug" :aria-expanded="setup" @click="setup ? setup = false : showSetup()">Connections</UButton><UButton color="neutral" variant="ghost" icon="i-lucide-file-code" :aria-expanded="definitions" @click="definitions ? definitions = false : showDefinitions()">Agent definitions</UButton></div></div>
  <section v-if="setup" class="chat-setup"><div class="section-heading"><h2>Connect this worker to a model</h2><UButton color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close provider connections" @click="setup = false" /></div><SettingsPanel provider-only /></section>
  <section v-if="definitions" class="chat-setup"><div class="actions"><UButton color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close agent definitions" @click="definitions = false" /></div><DefinitionPanel /></section>
  <div class="chat-workspace"><SessionPanel :disabled="sending" @new-task="createTask" /><div class="chat-main"><NewTask v-if="creating" @created="created" @close="creating = false" @setup="showSetup" @definitions="showDefinitions" />
  <template v-else><div class="task-title"><h2>{{ current?.title ?? 'New task' }}</h2><span class="muted">{{ state.settings?.providers.find(item => item.id === current?.provider)?.label ?? current?.provider }}</span></div>
  <div class="conversation-meta"><UBadge :color="current?.status === 'running' ? 'primary' : 'neutral'" variant="subtle">{{ current ? taskStatus(current.status) : 'Unlock to start' }}</UBadge><span>One task at a time · additional work waits in this worker’s queue</span></div>
  <div v-if="state.unlocked && state.chat && !state.chat.available" class="connect-prompt"><UIcon name="i-lucide-plug" /><div><strong>Connect a model to send your first task</strong><p>Use a local Codex or Claude sign-in, or add an API key.</p></div><UButton color="neutral" variant="outline" @click="showSetup">Connect provider</UButton></div>
  <details v-if="snapshot" class="task-definition"><summary>Agent: {{ snapshot.name }} / {{ snapshot.agent }} <span v-if="snapshot.adapted">· instructions only</span></summary><p class="page-note">This task keeps the instructions and model selected at creation. Changes to the imported definition do not change this session.</p><p>{{ snapshot.model || 'Configured provider model' }}</p><pre>{{ snapshot.instruction }}</pre></details>
  <UAlert v-if="state.settings?.board.paused" title="Worker queue is paused" description="You can queue work now. Open History and resume intake when you want this worker to start waiting tasks." color="warning" variant="soft" class="notice" />
  <UAlert v-if="state.chat?.persistenceError" title="Reply could not be saved" description="The reply below is only in memory. Check free disk space and state-directory permissions before restarting." color="error" variant="soft" class="notice" />
  <UAlert v-if="state.paused && state.chat?.busy" title="Task updates are paused" description="Resume updates in the header to see progress, or use Refresh worker." color="warning" variant="soft" class="notice" />
  <div class="conversation" aria-label="Task conversation">
    <div v-if="!state.chat?.messages.length" class="chat-empty"><UIcon name="i-lucide-messages-square" /><h2>What should this worker do?</h2><p>Your first message queues this task. Its instructions, replies and follow-ups stay together in one saved session.</p><div class="suggestions"><UButton color="neutral" variant="outline" :disabled="!available" @click="state.draft = 'Turn this feature idea into clear acceptance criteria: '">Define acceptance criteria</UButton><UButton color="neutral" variant="outline" :disabled="!available" @click="state.draft = 'Create an implementation plan for: '">Plan an implementation</UButton></div></div>
    <article v-for="message in state.chat?.messages" :key="message.id" class="message" :class="message.role"><div class="message-label"><UIcon :name="message.role === 'user' ? 'i-lucide-user-round' : 'i-lucide-sparkles'" /><strong>{{ message.role === 'user' ? 'You' : 'Worker model' }}</strong><time :datetime="message.at">{{ date(message.at) }}</time><UBadge v-if="['error', 'cancelled'].includes(message.state)" :color="message.state === 'error' ? 'error' : 'neutral'" variant="subtle">{{ message.state === 'error' ? 'Failed' : 'Cancelled' }}</UBadge></div><p v-if="message.state === 'pending'" class="pending-message">{{ phase === 'queued' ? state.settings?.board.paused ? 'Queued · this worker’s queue is paused. Resume intake in History to start waiting tasks.' : 'Queued · waiting for this worker’s next execution slot' : 'Working on this task…' }}</p><MessageContent v-else :text="message.text" :class="{ 'error-text': message.state === 'error' }" /></article>
  </div>
  <p class="sr-only" role="status">{{ phase === 'queued' ? 'Task queued. Waiting for this worker.' : phase === 'running' ? 'This worker is running the task.' : state.chat?.messages.length ? 'Task conversation updated.' : '' }}</p>
  <p v-if="current?.busy && !state.chat?.busy" class="page-note" role="status">{{ current.status === 'queued' ? 'This task is queued.' : 'This task is running.' }} Send a follow-up when it finishes, or create a New task.</p>
  <form class="composer" @submit.prevent="act('send')"><label for="chat-message">{{ firstMessage ? 'Task instructions' : 'Follow-up for this task' }}</label><UTextarea id="chat-message" v-model="state.draft" :rows="3" :maxrows="8" autoresize :maxlength="8000" :disabled="sending || state.workspaceBusy" :placeholder="firstMessage ? 'Describe the outcome you need…' : 'Continue this task with the same context…'" class="w-full" @keydown="keydown" /><div class="composer-footer"><span>{{ state.draft.length.toLocaleString() }} / 8,000 · Ctrl / ⌘ + Enter to send</span><UButton v-if="state.chat?.busy" type="button" color="neutral" variant="outline" icon="i-lucide-square" :loading="sending" :disabled="state.workspaceBusy" @click="act('cancel')">{{ phase === 'queued' ? 'Cancel queued task' : 'Stop task' }}</UButton><UButton v-else type="submit" icon="i-lucide-arrow-up" :loading="sending" :disabled="!available || !state.draft.trim()">{{ firstMessage ? 'Queue task' : 'Send follow-up' }}</UButton></div><p v-if="state.actionError" role="alert" class="error-text">{{ state.actionError }}</p></form>
  <RunTask />
  </template></div></div>
  <p class="page-note chat-privacy">Tasks are saved on this worker and shared by its operators. New task starts a separate session; follow-ups retain the current transcript. To produce a patch, use Run task with explicitly approved files.</p>
</section>
</template>
