<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import '../../shared/ui/tour.js';
import '../../shared/ui/tour.css';
import { useRoute, useRouter } from 'vue-router';
import UApp from '@nuxt/ui/components/App.vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UBadge from '@nuxt/ui/components/Badge.vue';
import UAlert from '@nuxt/ui/components/Alert.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import { state, refresh, unlock, lock, date, checkAccess } from './store';
const router = useRouter();
function tour(event: MouseEvent) {
  const launch = (globalThis as unknown as { WerkTour: (title: string, steps: unknown[], trigger: EventTarget | null) => void }).WerkTour;
  launch('Worker tour', [
    { title: 'Start a task in Chat', text: 'Choose New task and send its instructions. The first message queues a task; each follow-up stays in the same session.', target: '.page-heading', activate: () => router.push('/chat') },
    { title: 'Keep each task together', text: 'Select a task to reopen its transcript. New task creates a separate session. This worker executes one task at a time; additional work waits in its queue.', target: '.session-panel' },
    { title: 'Produce a patch with Run task', text: 'Run task creates a separate file-task session using dedicated instructions and approved files. Review its patch before applying it to your checkout.', target: '.run-task' },
    { title: 'Follow your work', text: 'History contains chat tasks, file-task results and orchestrator attempts. Open a chat task to continue it, or inspect a file task to review its patch.', target: '.taskboard', activate: () => router.push('/history') },
    { title: 'Inspect and configure', text: 'The dashboard shows queues, sessions and host health. Configure model connections here, or enroll with an orchestrator later. This worker also runs on its own.', target: '.page-heading', activate: () => router.push('/dashboard') },
  ], event.currentTarget);
}
const route = useRoute(), credential = ref(''), connecting = ref(false), accessError = ref(''), showToken = ref(false);
const links = [{ path: '/chat', label: 'Chat', icon: 'i-lucide-messages-square' }, { path: '/history', label: 'History', icon: 'i-lucide-history' }, { path: '/dashboard', label: 'Dashboard', icon: 'i-lucide-activity' }];
const connected = computed(() => !!state.status && ['idle', 'executing', 'standalone'].includes(state.status.state));
let timer: ReturnType<typeof setInterval>;
async function connect() { if (connecting.value) return; connecting.value = true; accessError.value = ''; try { await unlock(credential.value); credential.value = ''; } catch (error) { accessError.value = (error as Error).message; } finally { connecting.value = false; } }
function visibility() { if (!document.hidden && !state.paused) void refresh(); }
onMounted(() => { void checkAccess(); timer = setInterval(() => { if (!state.paused && !document.hidden) void refresh(); }, 3000); document.addEventListener('visibilitychange', visibility); });
onUnmounted(() => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); });
watch(() => route.path, async () => { await nextTick(); document.querySelector<HTMLElement>('h1')?.focus(); });
watch(() => [state.accessChecked, state.unlocked], async ([checked, unlocked]) => {
  if (!checked) return;
  await nextTick();
  if (unlocked) document.querySelector<HTMLElement>('h1')?.focus();
  else document.getElementById('worker-token')?.focus();
});
</script>
<template>
<UApp>
  <a class="skip-link" href="#main">Skip to content</a>
  <main v-if="!state.unlocked" id="main" class="unlock-page">
    <div class="unlock-brand wordmark">werk<span>.</span></div>
    <section class="unlock-card" aria-labelledby="access-title">
      <div class="unlock-symbol"><UIcon name="i-lucide-lock-keyhole" /></div>
      <h1 id="access-title">Your worker, ready when you are.</h1>
      <p class="unlock-lead">Unlock this workspace to give your worker a task, pick up a conversation, or inspect its progress.</p>
      <p v-if="!state.accessChecked" role="status">Checking saved access…</p>
      <form v-else @submit.prevent="connect">
        <label for="worker-token">Worker access token</label>
        <div class="access-input"><UInput id="worker-token" v-model="credential" :type="showToken ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="Paste the token from this worker" class="grow" :disabled="connecting" required aria-describedby="token-help" /><UButton color="neutral" variant="outline" :icon="showToken ? 'i-lucide-eye-off' : 'i-lucide-eye'" :aria-label="showToken ? 'Hide token' : 'Show token'" :aria-pressed="showToken" @click="showToken = !showToken" /></div>
        <p id="token-help" class="page-note">Use the <code>webview-token</code> file in this worker’s state directory. The start or status command shows its location as <code>credentialsFile</code>.</p>
        <p v-if="accessError" class="error-text" role="alert">{{ accessError }}</p><p v-if="state.accessMessage" class="page-note" role="status">{{ state.accessMessage }}</p>
        <UButton class="unlock-submit" type="submit" :loading="connecting" :disabled="!credential.trim()" trailing-icon="i-lucide-arrow-right">Unlock worker</UButton>
      </form>
      <details class="unlock-help"><summary>Where do I find my token?</summary><p>On the worker machine, open the private token file shown when you started the worker. Copy its contents here. If someone else runs this worker, ask them for workspace access.</p><p>This opens Werk only. You will connect your Claude, Codex or API account inside the workspace.</p></details>
      <p class="unlock-privacy"><UIcon name="i-lucide-shield-check" /> This browser stays unlocked for up to 12 hours, or until the worker restarts. Lock it any time.</p>
    </section><p class="unlock-caption">One worker. One task at a time. Your work stays together.</p>
  </main>
  <div v-else class="workspace-shell">
    <aside class="sidebar">
      <RouterLink class="wordmark" to="/chat" aria-label="Werk worker home">werk<span>.</span></RouterLink>
      <div class="worker-identity"><UIcon name="i-lucide-cpu" class="worker-icon" /><div><strong>{{ state.status?.project ?? 'Local worker' }}</strong><span>{{ state.status?.workerId ? 'Worker ' + state.status.workerId.slice(0, 8) : state.status?.machineId ? 'Machine ' + state.status.machineId.slice(0, 8) : 'Starting worker' }}</span></div></div>
      <nav aria-label="Worker pages"><RouterLink v-for="link in links" :key="link.path" :to="link.path" class="page-link" :aria-current="route.path === link.path ? 'page' : undefined"><UIcon :name="link.icon" /><span>{{ link.label }}</span></RouterLink></nav>
      <div class="sidebar-foot"><UBadge :color="state.status?.mode === 'cli' ? 'primary' : 'warning'" variant="subtle">{{ state.status?.mode === 'cli' ? 'Live task execution' : state.status ? 'Orchestrator: simulation' : 'Mode unavailable' }}</UBadge><p>One worker. Its model, work and environment.</p></div>
    </aside>
    <div class="workspace-content">
      <header class="utility-bar"><div class="connection"><span class="status-dot" :class="{ healthy: connected && !state.error }"></span><strong>{{ state.error ? 'Connection lost' : state.status?.state ?? 'Connecting' }}</strong><span class="muted">{{ state.paused ? 'Updates paused' : 'Updates every 3s' }}</span></div><div class="actions"><UButton color="neutral" variant="ghost" icon="i-lucide-compass" @click="tour">Tour</UButton><UButton color="neutral" variant="ghost" :icon="state.paused ? 'i-lucide-play' : 'i-lucide-pause'" :aria-label="state.paused ? 'Resume updates' : 'Pause updates'" @click="state.paused = !state.paused; if (!state.paused) refresh()" /><UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Refresh worker" :loading="state.loading" @click="refresh()" /><UButton v-if="state.unlocked" color="neutral" variant="outline" icon="i-lucide-lock-keyhole" title="Lock this browser and clear unsent drafts" @click="lock()">Lock</UButton></div></header>
      <main id="main">
        <UAlert v-if="state.error" color="error" variant="soft" title="Live data is unavailable" :description="`${state.error} Last successful refresh: ${date(state.lastRead)}. Values below may be stale.`" icon="i-lucide-wifi-off" class="notice" />
        <UAlert v-if="state.partialError" color="warning" variant="soft" title="Some updates are unavailable" :description="state.partialError" class="notice" />
        <RouterView v-slot="{ Component }"><KeepAlive><component :is="Component" /></KeepAlive></RouterView>
      </main>
      <footer class="workspace-footer">{{ state.lastRead ? 'Last refreshed ' + date(state.lastRead) : 'Waiting for worker data' }}<span>Werk · Worker workspace</span></footer>
    </div>
  </div>
</UApp>
</template>
