import {
  computed,
  ref,
  watch,
  nextTick,
  onActivated,
  onDeactivated,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { state, workspaceAction, request, date } from "../store";
import type { LocalTaskDetailView } from "../../application/workspace-view";
import { taskPriorityLabel } from '../task-priority';

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useTaskboard(options: { focusedTaskId?: () => string } = {}) {
  const route = useRoute(),
    router = useRouter();
  const busy = ref(false),
    archived = ref(false),
    detail = ref<LocalTaskDetailView | null>(null),
    removing = ref(false),
    active = ref(false);
  // Explicit cleanup must succeed before deleting a task; keeping its worktree is a separate choice.
  const removeWorktree = ref(true), worktreeNotice = ref("");
  const search = ref(""),
    status = ref("all"),
    selectedId = ref(""),
    detailLoading = ref(false),
    detailError = ref(""),
    actionError = ref("");
  let inspectTrigger: HTMLElement | null = null,
    detailRevision = 0, readingId = "";
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
    detailRevision++; readingId = "";
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
    if (!active.value || !state.unlocked || !options.focusedTaskId?.() && route.path !== "/history") return;
    const id = options.focusedTaskId?.() || (typeof route.query.fileId === "string" ? route.query.fileId : "");
    if (!id) { await focusFileTasks(); return; }
    if (selectedId.value === id && detailLoading.value) {
      await nextTick();
      if (active.value && (options.focusedTaskId?.() === id || route.path === "/history" && route.query.fileId === id))
        document.getElementById("local-task-detail")?.focus();
      return;
    }
    await inspect(id);
    if (active.value && (!!options.focusedTaskId?.() || route.path === "/history") && selectedId.value === id) {
      inspectTrigger = document.getElementById("taskboard-title");
      await nextTick();
      if (active.value && (options.focusedTaskId?.() === id || route.path === "/history" && route.query.fileId === id))
        document.getElementById("local-task-detail")?.focus();
    }
  }
  onActivated(() => {
    active.value = true;
    void openLinkedFileTask();
  });
  watch(
    () => [route.path, route.query.fileId, route.query.fileState, options.focusedTaskId?.(), state.unlocked],
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
      priority: taskPriorityLabel(task.priority),
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
    if (!state.unlocked || readingId === id) return;
    const revision = ++detailRevision; readingId = id;
    detailLoading.value = focus || detail.value?.id !== id;
    try {
      const result = await request("/api/taskboard/detail", "POST", { id });
      if (
        revision !== detailRevision ||
        !state.unlocked ||
        selectedId.value !== id
      )
        return;
      detail.value = result; detailError.value = "";
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
      if (revision === detailRevision) { detailLoading.value = false; readingId = ""; }
    }
  }
  // Same-status polls may carry new receipts, findings or publication evidence.
  watch(() => state.refreshRevision, () => {
    if (active.value && selectedId.value && !busy.value) void readDetail(selectedId.value);
  });
  watch(
    () => state.unlocked,
    (value) => {
      if (!value) {
        detailRevision++; readingId = "";
        selectedId.value = "";
        detail.value = null;
        detailLoading.value = false;
        detailError.value = "";
        actionError.value = "";
        removing.value = false; removeWorktree.value = true; worktreeNotice.value = "";
      }
    },
    { flush: "sync" },
  );
  onDeactivated(() => {
    active.value = false;
    detailRevision++; readingId = "";
    if (detailLoading.value && selectedId.value)
      detailError.value =
        "Evidence loading was paused when you left this view. Retry to load this task.";
    detailLoading.value = false;
  });
  const preparations = computed(() => state.board?.preparations ?? []);
  function beginRemoval() { removeWorktree.value = true; removing.value = true; actionError.value = ""; }
  async function dismissPreparation(id: string) {
    if (busy.value || !state.unlocked) return;
    const epoch = state.draftEpoch;
    busy.value = true; actionError.value = "";
    try {
      const result = await workspaceAction("/api/taskboard/action", { id, action: "delete" });
      if (epoch === state.draftEpoch && state.unlocked && !result) actionError.value = state.actionError || "The failed preparation could not be dismissed. Try again.";
    }
    finally { busy.value = false; }
  }
  const canRetry = computed(() => !!detail.value && !detailError.value && !detail.value.admissionFailure && detail.value.feature?.source !== 'shared_git' && ['failed', 'cancelled'].includes(detail.value.status));
  const canManage = computed(() => !!detail.value && !detailError.value && !['queued', 'running', 'waiting_input', 'escalated'].includes(detail.value.status) && !state.sessions?.records.find(item => item.id === detail.value?.sessionId)?.busy);
  async function action(body: { id: string; action: string; priority?: number; removeWorktree?: boolean }) {
    if (busy.value || !state.unlocked || detailError.value) return;
    if (body.action === "retry" && !canRetry.value || ["archive", "restore", "delete"].includes(body.action) && !canManage.value) return;
    const epoch = state.draftEpoch, revision = ++detailRevision; readingId = ""; detailLoading.value = false;
    const failedAdmission = state.board?.tasks.find(item => item.id === body.id)?.admissionFailure || (detail.value?.id === body.id && detail.value.admissionFailure);
    if (body.action === "retry" && failedAdmission) return;
    busy.value = true;
    actionError.value = "";
    try {
      const result = await workspaceAction("/api/taskboard/action", body);
      if (!state.unlocked || epoch !== state.draftEpoch || revision !== detailRevision || selectedId.value !== body.id) return;
      if (!result) {
        actionError.value =
          state.actionError || "The task could not be updated. Try again.";
        return;
      }
      removing.value = false;
      worktreeNotice.value = result.worktree?.outcome === "kept" ? `The task was deleted; its Git worktree was kept. ${result.worktree.reason}` : body.action === "delete" ? "Saved task deleted." : "";
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
    removeWorktree.value = true; worktreeNotice.value = "";
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
        await router.push({ path: "/request", query: { session: sessionId } });
      else
        actionError.value =
          state.actionError || "The conversation could not be opened. Try again.";
    } finally {
      busy.value = false;
    }
  }

  return {
    action,
    actionError,
    allTasks,
    archived,
    beginRemoval,
    busy,
    clearFilters,
    canRetry,
    canManage,
    closeDetail,
    columns,
    date,
    detail,
    detailError,
    detailLoading,
    dismissPreparation,
    inspect,
    kanbanTasks,
    openConversation,
    preparations,
    readDetail,
    removeWorktree,
    removing,
    search,
    selectedId,
    state,
    status,
    statusOptions,
    visible,
    workspaceAction,
    worktreeNotice,
  };
}
