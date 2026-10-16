<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import WorkerShell from "./components/WorkerShell.vue";
import AccessPanel from "../../shared/webview/components/AccessPanel.vue";
import ConnectionStatus from "../../shared/webview/components/ConnectionStatus.vue";
import OnboardingTour from "../../shared/webview/components/OnboardingTour.vue";
import { useBoundedPolling } from "../../shared/webview/composables/useBoundedPolling";
import type { TourStep } from "../../shared/webview/types";
import { useRoute, useRouter } from "vue-router";
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import UIcon from "@nuxt/ui/components/Icon.vue";
import { state, refresh, refreshFromUser, unlock, lock, date, checkAccess } from "./store";
const router = useRouter(),
  tourOpen = ref(false);
const tourSteps: TourStep[] = [
  {
    title: "Start with your taskboard",
    text: "Describe what you need in New request. Every request has a Markdown progress record, and follow-ups stay with the same request.",
    target: ".page-heading",
    activate: () => router.push("/taskboard"),
  },
  {
    title: "Keep each task together",
    text: "Select a task to reopen its transcript. New request creates a separate session. This worker executes one task at a time; additional work waits in its queue.",
    target: ".taskboard-groups",
  },
  {
    title: "Include repository changes",
    text: "Use the same instructions for all work. When repository changes are needed, allow file changes and choose the repository and approved paths. Review the resulting patch before applying it.",
    target: ".task-interaction",
  },
  {
    title: "Follow your work",
    text: "History keeps completed work and execution attempts. Open a request to inspect its progress record, results and any patch awaiting review.",
    target: ".taskboard",
    activate: () => router.push("/history"),
  },
  {
    title: "Understand usage and health",
    text: "Metrics brings together this worker’s consumption, retained run measurements and host health. Missing measurements stay unavailable.",
    target: ".page-heading",
    activate: () => router.push("/dashboard"),
  },
  {
    title: "Configure your worker",
    text: "Settings groups providers and accounts, queue limits, consumption, tools and project connections. Choose a section; unsaved edits stay in this tab while you navigate.",
    target: ".settings-content",
    activate: () => router.push("/settings"),
  },
];
const route = useRoute(),
  credential = ref(""),
  connecting = ref(false),
  accessError = ref(""),
  showToken = ref(false);
const links = [
  { path: "/taskboard", label: "Taskboard", icon: "i-lucide-columns-2" },
  { path: "/dashboard", label: "Metrics", icon: "i-lucide-activity" },
  { path: "/history", label: "History", icon: "i-lucide-history" },
  { path: "/settings", label: "Settings", icon: "i-lucide-settings-2" },
];
const connected = computed(
  () =>
    !!state.status &&
    ["idle", "executing", "standalone"].includes(state.status.state),
);

async function connect() {
  if (connecting.value) return;
  connecting.value = true;
  accessError.value = "";
  try {
    await unlock(credential.value);
    credential.value = "";
  } catch (error) {
    accessError.value = (error as Error).message;
  } finally {
    connecting.value = false;
  }
}
useBoundedPolling(
  refresh,
  computed(() => state.paused),
  3000,
);
onMounted(() => {
  void checkAccess();
});
watch(
  () => route.path,
  async () => {
    await nextTick();
    document.querySelector<HTMLElement>("h1")?.focus();
  },
);
watch(
  () => [state.accessChecked, state.unlocked],
  async ([checked, unlocked]) => {
    if (!unlocked) tourOpen.value = false;
    if (!checked) return;
    await nextTick();
    if (unlocked) document.querySelector<HTMLElement>("h1")?.focus();
    else document.getElementById("worker-token")?.focus();
  },
);
</script>
<template>
  <UApp>
    <AccessPanel
      v-if="!state.unlocked"
      title="Your worker, ready when you are."
      lead="Unlock this workspace to give your worker a task, pick up a conversation, or inspect its progress."
      caption="One worker. One task at a time. Your work stays together."
    >
      <p v-if="!state.accessChecked" role="status">Checking saved access…</p>
      <form v-else @submit.prevent="connect">
        <label for="worker-token">Worker access token</label>
        <div class="access-input">
          <UInput
            id="worker-token"
            v-model="credential"
            :type="showToken ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            placeholder="Paste the token from this worker"
            class="grow"
            :disabled="connecting"
            required
            aria-describedby="token-help"
          /><UButton
            color="neutral"
            variant="outline"
            :icon="showToken ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            :aria-label="showToken ? 'Hide token' : 'Show token'"
            :aria-pressed="showToken"
            @click="showToken = !showToken"
          />
        </div>
        <p id="token-help" class="page-note">
          For a project worker, use <code>WERK_WORKER_TOKEN</code> from the
          project’s <code>.env</code> file. Existing standalone or managed
          setups can use the private <code>webview-token</code> file in the
          worker’s state directory; the start or status command shows its
          location as <code>credentialsFile</code>.
        </p>
        <p v-if="accessError" class="error-text" role="alert">
          {{ accessError }}
        </p>
        <p v-if="state.accessMessage" class="page-note" role="status">
          {{ state.accessMessage }}
        </p>
        <UButton
          class="unlock-submit"
          type="submit"
          :loading="connecting"
          :disabled="!credential.trim()"
          trailing-icon="i-lucide-arrow-right"
          >Unlock worker</UButton
        >
      </form>
      <template #help
        ><p>
          On the worker machine, open the private token file shown when you
          started the worker. Copy its contents here. If someone else runs this
          worker, ask them for workspace access.
        </p>
        <p>
          This opens Werk only. You will connect your Claude, Codex or API
          account inside the workspace.
        </p></template
      >
      <template #privacy
        >This browser stays unlocked for up to 12 hours, or until the worker
        restarts. Lock it any time.</template
      >
    </AccessPanel>
    <WorkerShell
      v-else
      :links="links"
      home-path="/taskboard"
      home-label="Werk worker home"
      nav-label="Worker pages"
    >
      <template #identity
        ><div class="worker-identity">
          <UIcon name="i-lucide-cpu" class="worker-icon" />
          <div>
            <strong>{{ state.status?.project ?? "Local worker" }}</strong
            ><span>{{
              state.status?.workerId
                ? "Worker " + state.status.workerId.slice(0, 8)
                : state.status?.machineId
                  ? "Machine " + state.status.machineId.slice(0, 8)
                  : "Starting worker"
            }}</span>
          </div>
        </div></template
      >
      <template #mode
        ><UBadge
          :color="state.status?.mode === 'cli' ? 'primary' : 'warning'"
          variant="subtle"
          >{{
            state.status?.mode === "cli"
              ? "Assignments: live Codex"
              : state.status
                ? "Assignments: simulation"
                : "Mode unavailable"
          }}</UBadge
        >
      </template
      >
      <template #status
        ><ConnectionStatus
          :healthy="connected && !state.error"
          :label="
            state.error
              ? 'Connection lost'
              : (state.status?.state ?? 'Connecting')
          "
          :detail="state.paused ? 'Updates paused' : 'Updates every 3s'"
      /></template>
      <template #actions
        ><UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-compass"
          aria-label="Tour"
          @click="tourOpen = true"
          ><span class="worker-tour-label">Tour</span></UButton
        ><UButton
          color="neutral"
          variant="ghost"
          :icon="state.paused ? 'i-lucide-play' : 'i-lucide-pause'"
          :aria-label="state.paused ? 'Resume updates' : 'Pause updates'"
          @click="
            state.paused = !state.paused;
            if (!state.paused) refresh();
          "
        /><UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          aria-label="Refresh worker"
          :loading="state.refreshingManually"
          @click="refreshFromUser()"
        /><UButton
          v-if="state.unlocked"
          color="neutral"
          variant="outline"
          icon="i-lucide-lock-keyhole"
          title="Lock this browser and clear unsent drafts"
          @click="lock()"
          >Lock</UButton
        ></template
      >
      <template #notices>
        <UAlert
          v-if="state.error"
          color="error"
          variant="soft"
          title="Live data is unavailable"
          :description="`${state.error} Last successful refresh: ${date(state.lastRead)}. Values below may be stale.`"
          icon="i-lucide-wifi-off"
          class="notice"
        />
        <UAlert
          v-if="state.partialError"
          color="warning"
          variant="soft"
          title="Some updates are unavailable"
          :description="state.partialError"
          class="notice"
        />
      </template>
      <RouterView v-slot="{ Component }"
        ><KeepAlive><component :is="Component" /></KeepAlive
      ></RouterView>
      <template #footer
        >{{
          state.lastRead
            ? "Last refreshed " + date(state.lastRead)
            : "Waiting for worker data"
        }}<span>Werk · Worker workspace</span></template
      >
    </WorkerShell>
    <OnboardingTour
      v-model:open="tourOpen"
      title="Worker tour"
      :steps="tourSteps"
    />
  </UApp>
</template>
