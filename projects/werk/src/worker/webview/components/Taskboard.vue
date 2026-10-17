<script setup lang="ts">
import {
  computed,
  ref,
  watch,
  nextTick,
  onActivated,
  onDeactivated,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import RequestGatePanel from "./RequestGatePanel.vue";
import CandidateEvidence from "./CandidateEvidence.vue";
import TaskKanban from "../../../shared/webview/components/TaskKanban.vue";
import { state, workspaceAction, request, date } from "../store";
import type { LocalTaskDetailView } from "../../application/workspace-view";
const route = useRoute(),
  router = useRouter();
const busy = ref(false),
  archived = ref(false),
  detail = ref<LocalTaskDetailView | null>(null),
  removing = ref(false),
  active = ref(false);
const search = ref(""),
  status = ref("all"),
  selectedId = ref(""),
  detailLoading = ref(false),
  detailError = ref(""),
  actionError = ref("");
let inspectTrigger: HTMLElement | null = null,
  detailRevision = 0;
const statusOptions = [
  { label: "All file tasks", value: "all" },
  { label: "Needs rework", value: "needs_rework" },
  { label: "Waiting for answer", value: "waiting_input" },
  { label: "Decision needed", value: "escalated" },
  { label: "Needs review", value: "review" },
  { label: "Failed", value: "failed" },
  { label: "Queued", value: "queued" },
  { label: "Running", value: "running" },
  { label: "Cancelled", value: "cancelled" },
];
watch(
  () => route.query.fileState,
  (value) => {
    status.value = statusOptions.some((item) => item.value === value)
      ? String(value)
      : "all";
    search.value = "";
    archived.value = false;
  },
  { immediate: true },
);
async function closeDetail() {
  detailRevision++;
  selectedId.value = "";
  detail.value = null;
  detailLoading.value = false;
  detailError.value = "";
  actionError.value = "";
  removing.value = false;
  await nextTick();
  (inspectTrigger?.isConnected
    ? inspectTrigger
    : document.getElementById("taskboard-title")
  )?.focus({ preventScroll: true });
}
async function focusFileTasks() {
  if (!active.value || !state.unlocked || route.path !== "/history" || route.query.fileId || !["review", "failed"].includes(String(route.query.fileState))) return;
  await nextTick();
  if (!active.value || route.path !== "/history" || route.query.fileId) return;
  const heading = document.getElementById("taskboard-title");
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView({ block: "start" });
}
async function openLinkedFileTask() {
  if (!active.value || !state.unlocked || route.path !== "/history") return;
  const id = typeof route.query.fileId === "string" ? route.query.fileId : "";
  if (!id) { await focusFileTasks(); return; }
  if (selectedId.value === id && detailLoading.value) {
    await nextTick();
    if (active.value && route.path === "/history" && route.query.fileId === id)
      document.getElementById("local-task-detail")?.focus();
    return;
  }
  await inspect(id);
  if (active.value && route.path === "/history" && selectedId.value === id) {
    inspectTrigger = document.getElementById("taskboard-title");
    await nextTick();
    if (active.value && route.path === "/history" && route.query.fileId === id)
      document.getElementById("local-task-detail")?.focus();
  }
}
onActivated(() => {
  active.value = true;
  void openLinkedFileTask();
});
watch(
  () => [route.path, route.query.fileId, route.query.fileState, state.unlocked],
  () => { void openLinkedFileTask(); },
);
const columns = [
  {
    id: "attention",
    label: "Needs your input",
    statuses: ["waiting_input", "escalated", "needs_rework"],
  },
  { id: "queued", label: "Queued", statuses: ["queued"] },
  { id: "running", label: "Running", statuses: ["running"] },
  {
    id: "finished",
    label: "Review & finished",
    statuses: [
      "review",
      "completed",
      "done",
      "failed",
      "cancelled",
      "interrupted",
    ],
  },
];
const allTasks = computed(() => state.board?.tasks ?? []);
const visible = computed(() =>
  allTasks.value.filter(
    (task) =>
      (archived.value || !task.archived) &&
      (status.value === "all" || task.status === status.value) &&
      [task.title, task.id, task.provider]
        .join(" ")
        .toLowerCase()
        .includes(search.value.trim().toLowerCase()),
  ),
);
const kanbanTasks = computed(() =>
  visible.value.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    sourceLabel: "This worker",
    priority: task.priority === 2 ? "High" : "Normal",
    contextLabel: task.provider + " · " + task.files.length + " approved files",
    gate: task.requestPhase ? { phase: task.requestPhase } : undefined,
  })),
);
function clearFilters() {
  search.value = "";
  status.value = "all";
  archived.value = true;
}
async function readDetail(id: string, focus = false) {
  const revision = ++detailRevision;
  detailLoading.value = true;
  detailError.value = "";
  try {
    const result = await request("/api/taskboard/detail", "POST", { id });
    if (
      revision !== detailRevision ||
      !state.unlocked ||
      selectedId.value !== id
    )
      return;
    detail.value = result;
    if (focus) {
      await nextTick();
      if (revision === detailRevision)
        document.getElementById("local-task-detail")?.focus();
    }
  } catch (error) {
    if (
      revision === detailRevision &&
      state.unlocked &&
      selectedId.value === id
    )
      detailError.value =
        error instanceof Error
          ? error.message
          : "Task evidence could not be loaded. Retry to inspect this task.";
  } finally {
    if (revision === detailRevision) detailLoading.value = false;
  }
}
watch(
  () =>
    [
      selectedId.value,
      state.board?.tasks.find((task) => task.id === selectedId.value)?.status,
    ] as const,
  ([id, value], [previousId, previous]) => {
    if (id === previousId && value && previous && value !== previous)
      void readDetail(id);
  },
);
watch(
  () => state.unlocked,
  (value) => {
    if (!value) {
      detailRevision++;
      selectedId.value = "";
      detail.value = null;
      detailLoading.value = false;
      detailError.value = "";
      actionError.value = "";
    }
  },
  { flush: "sync" },
);
onDeactivated(() => {
  active.value = false;
  detailRevision++;
  if (detailLoading.value && selectedId.value)
    detailError.value =
      "Evidence loading was paused when you left History. Retry to load this task.";
  detailLoading.value = false;
});
const preparations = computed(() => state.board?.preparations ?? []);
// Delete removes a clean Git worktree by default; the worker keeps a changed one and says why.
const removeWorktree = ref(true);
const worktreeNotice = ref("");
async function dismissPreparation(id: string) {
  if (busy.value) return;
  busy.value = true;
  try { await workspaceAction("/api/taskboard/action", { id, action: "delete" }); }
  finally { busy.value = false; }
}
async function action(body: { id: string; action: string; priority?: number; removeWorktree?: boolean }) {
  if (busy.value) return;
  const failedAdmission = state.board?.tasks.find(item => item.id === body.id)?.admissionFailure || (detail.value?.id === body.id && detail.value.admissionFailure);
  if (body.action === "retry" && failedAdmission) return;
  busy.value = true;
  actionError.value = "";
  try {
    const result = await workspaceAction("/api/taskboard/action", body);
    if (!state.unlocked || selectedId.value !== body.id) return;
    if (!result) {
      actionError.value =
        state.actionError || "The task could not be updated. Try again.";
      return;
    }
    removing.value = false;
    worktreeNotice.value = result.worktree?.outcome === "kept" ? `The task was deleted; its Git worktree was kept. ${result.worktree.reason}` : "";
    if (body.action === "delete") await closeDetail();
    else await readDetail(body.id);
  } finally {
    busy.value = false;
  }
}
async function inspect(id: string, event?: MouseEvent) {
  inspectTrigger = (event?.currentTarget ??
    document.activeElement) as HTMLElement;
  selectedId.value = id;
  detail.value = null;
  removing.value = false;
  actionError.value = "";
  await readDetail(id, true);
}
async function openConversation() {
  if (busy.value || !detail.value) return;
  const sessionId = detail.value.sessionId;
  busy.value = true;
  actionError.value = "";
  try {
    if (
      await workspaceAction("/api/sessions", {
        action: "select",
        id: sessionId,
      })
    )
      await router.push({ path: "/taskboard", query: { session: sessionId } });
    else
      actionError.value =
        state.actionError || "The conversation could not be opened. Try again.";
  } finally {
    busy.value = false;
  }
}
function download() {
  if (!detail.value?.patch) return;
  const url = URL.createObjectURL(
    new Blob([detail.value.patch], { type: "text/plain" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "werk-" + detail.value.id + ".patch";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <section
    v-if="state.unlocked"
    class="taskboard"
    aria-labelledby="taskboard-title"
  >
    <div class="section-heading">
      <div>
        <h2 id="taskboard-title" tabindex="-1">File tasks</h2>
        <p class="page-note">
          Requests with permission to change approved repository files. Each request keeps a Markdown
          record of its progress and results.
        </p>
      </div>
      <UButton
        color="neutral"
        variant="outline"
        :icon="
          state.settings?.board.paused ? 'i-lucide-play' : 'i-lucide-pause'
        "
        :disabled="busy"
        @click="
          workspaceAction('/api/settings', {
            board: { paused: !state.settings?.board.paused },
          })
        "
      >
        {{ state.settings?.board.paused ? "Resume queue" : "Pause queue" }}
      </UButton>
    </div>
    <p v-if="state.board?.persistenceError" role="alert" class="error-text">
      A task result could not be saved. Check free disk space and
      state-directory permissions before restarting.
    </p>
    <p v-if="worktreeNotice" role="status" class="notice">{{ worktreeNotice }}</p>
    <ul v-if="preparations.length" class="file-task-preparations" aria-label="File tasks being prepared">
      <li v-for="item in preparations" :key="item.id">
        <strong>{{ item.title }}</strong>
        <span v-if="item.state === 'preparing'" role="status" class="muted">
          {{ item.phase === "waiting" ? "Waiting for an earlier task to be admitted…" : item.phase === "worktree" ? "Preparing its Git worktree…" : "Saving approved file snapshots…" }}
        </span>
        <template v-else>
          <span role="alert" class="error-text">Not created: {{ item.error }}</span>
          <UButton color="neutral" variant="ghost" size="xs" :disabled="busy" @click="dismissPreparation(item.id)">Dismiss</UButton>
        </template>
      </li>
    </ul>
    <div v-if="state.settings?.board.paused" class="notice">
      Queue paused. The running task can finish; queued chat, file tasks and
      orchestrator assignments wait.
    </div>
    <div v-if="allTasks.length" class="history-filters file-task-filters">
      <div>
        <label for="file-task-search">Find a file task</label>
        <UInput
          id="file-task-search"
          v-model="search"
          icon="i-lucide-search"
          placeholder="Title, task ID or provider"
          class="w-full"
        />
      </div>
      <div>
        <label for="file-task-status">State</label>
        <USelect
          id="file-task-status"
          v-model="status"
          :items="statusOptions"
          class="w-full"
        />
      </div>
    </div>
    <p v-if="allTasks.length" class="page-note" role="status">
      {{ visible.length }} matching
      {{ visible.length === 1 ? "file task" : "file tasks" }}
    </p>
    <div v-if="!allTasks.length" class="compact-empty">
      <p>
        No file changes requested yet. Choose New request on the taskboard, then open Repository files
        to allow changes and receive a patch for review.
      </p>
      <UButton to="/taskboard" color="neutral" variant="outline">Open taskboard</UButton>
    </div>
    <div v-else-if="!visible.length" class="compact-empty">
      <p>No file tasks match these filters.</p>
      <UButton color="neutral" variant="outline" @click="clearFilters"
        >Show all file tasks</UButton
      >
    </div>
    <TaskKanban
      v-else
      :tasks="kanbanTasks"
      :columns="columns"
      scope-label="Worker file tasks"
      @open="(task) => inspect(task.id)"
    />
    <label v-if="allTasks.length" class="check-label">
      <input v-model="archived" type="checkbox" />
      Show archived tasks
    </label>
    <section
      v-if="selectedId"
      id="local-task-evidence"
      @keydown.esc.prevent="closeDetail"
      class="evidence-panel"
      :aria-busy="detailLoading"
    >
      <div class="section-heading">
        <h3 id="local-task-detail" tabindex="-1">
          {{ detail?.title ?? "File task evidence" }}
        </h3>
        <UButton
          color="neutral"
          variant="ghost"
          aria-label="Close local task"
          icon="i-lucide-x"
          @click="closeDetail"
        />
      </div>
      <p v-if="detailLoading" role="status">Loading task evidence…</p>
      <div v-if="detailError" class="notice">
        <p role="alert" class="error-text">{{ detailError }}</p>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="detailLoading"
          @click="readDetail(selectedId, true)"
        >
          Retry loading evidence
        </UButton>
      </div>
      <p v-if="actionError" role="alert" class="error-text">
        {{ actionError }}
      </p>
      <template v-if="detail">
        <p>
          {{ detail.status }} · {{ date(detail.createdAt) }} ·
          {{ detail.provider }}
        </p>
        <p>{{ detail.instruction }}</p>
        <RequestGatePanel
          v-if="detail.requestId && !detail.admissionFailure"
          :request-id="detail.requestId"
          :session-id="detail.sessionId"
        />
        <p v-if="detail.error" class="error-text">{{ detail.error }}</p>
        <div v-if="detail.admissionFailure" class="notice" role="status">
          <p>This request stopped before approved file snapshots were saved. Inspect the preserved worktree, then use New request on the taskboard to continue.</p>
          <p v-if="detail.worktree" class="break-anywhere">Preserved worktree: <code>{{ detail.worktree }}</code></p>
        </div>
        <p v-if="detail.summary">{{ detail.summary }}</p>
        <CandidateEvidence v-if="!detail.admissionFailure" :key="detail.id" :task="detail" />
        <p class="break-anywhere">{{ detail.repository }}</p>
        <ul>
          <li v-for="file in detail.files" :key="file.path" class="break-anywhere">{{ file.path }}</li>
        </ul>
        <div class="actions">
          <UButton
            color="neutral"
            variant="outline"
            :disabled="busy || state.workspaceBusy"
            @click="openConversation"
          >
            Open conversation
          </UButton>
          <UButton
            v-if="['queued', 'running'].includes(detail.status)"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'cancel' })"
          >
            {{
              detail.status === "queued" ? "Cancel queued task" : "Stop task"
            }}
          </UButton>
          <UButton
            v-if="detail.status === 'queued'"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="
              action({
                id: detail.id,
                action: 'priority',
                priority: detail.priority === 2 ? 1 : 2,
              })
            "
          >
            {{ detail.priority === 2 ? "Normal priority" : "Raise priority" }}
          </UButton>
          <UButton
            v-if="!detail.admissionFailure && ['failed', 'cancelled'].includes(detail.status)"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'retry' })"
          >
            Retry saved input
          </UButton>
          <UButton
            v-if="detail.patch"
            icon="i-lucide-download"
            @click="download"
          >
            Download patch
          </UButton>
          <template v-if="!['queued', 'running'].includes(detail.status)">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="busy"
              @click="
                action({
                  id: detail.id,
                  action: detail.archived ? 'restore' : 'archive',
                })
              "
            >
              {{ detail.archived ? "Restore" : "Archive" }}
            </UButton>
            <UButton color="error" variant="ghost" @click="removing = !removing"
              >Delete</UButton
            >
          </template>
        </div>
        <div v-if="removing" class="confirm-row">
          <p>Delete the saved task and its board evidence?</p>
          <label v-if="detail.worktree" class="check-label">
            <input v-model="removeWorktree" type="checkbox" />
            Also remove its Git worktree when it has no uncommitted or untracked changes
          </label>
          <UButton
            color="error"
            :disabled="busy"
            @click="action({ id: detail.id, action: 'delete', ...(removeWorktree ? {} : { removeWorktree: false }) })"
          >
            Confirm deletion
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="busy"
            @click="removing = false"
          >
            Keep task
          </UButton>
        </div>
        <p v-if="detail.patch" class="page-note">
          Inspect this patch before applying it. <template v-if="!detail.implementation">This proposal has not been automatically applied or verified.</template> In your
          repository, use
          <code>git apply --check path/to/download.patch</code>
          before applying with
          <code>git apply</code>. Inputs were captured when this task was
          queued.
        </p>
        <details v-if="detail.patch">
          <summary>Inspect patch</summary>
          <pre>{{ detail.patch }}</pre>
        </details>
      </template>
    </section>
    <p class="page-note">Queue capacity and task duration are managed in <RouterLink to="/settings#queue">Settings</RouterLink>.</p>
    <section v-if="state.status?.queuedTasks?.length" class="monitor-section">
      <h3>Waiting from the orchestrator</h3>
      <ul class="profile-list">
        <li v-for="task in state.status.queuedTasks" :key="task.id">
          <div>
            <strong>{{ task.id }}</strong>
            <span>{{ task.profile }} · lease maintained</span>
          </div>
        </li>
      </ul>
    </section>
    <p v-if="state.actionError" role="alert" class="error-text">
      {{ state.actionError }}
    </p>
  </section>
</template>
