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

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useTaskboard() {
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
        removing.value = false; removeWorktree.value = true; worktreeNotice.value = "";
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
  async function action(body: { id: string; action: string; priority?: number; removeWorktree?: boolean }) {
    if (busy.value || !state.unlocked) return;
    const epoch = state.draftEpoch, revision = detailRevision;
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

  return {
    action,
    actionError,
    allTasks,
    archived,
    beginRemoval,
    busy,
    clearFilters,
    closeDetail,
    columns,
    date,
    detail,
    detailError,
    detailLoading,
    dismissPreparation,
    download,
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
