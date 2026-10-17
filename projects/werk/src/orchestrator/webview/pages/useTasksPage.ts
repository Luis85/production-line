import { computed, nextTick, ref, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import type { KanbanTask } from "../../../shared/webview/task-kanban";
import type { RequestGateEvidence } from "../../../shared/request-gate";
import {
  statuses,
  contextState,
  date,
  type OrchestratorStore,
  type RecordData,
} from "../store";

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useTasksPage(props: { store: OrchestratorStore }) {
  const s = props.store.state,
    router = useRouter(),
    route = useRoute();
  const tasks = computed(() =>
    s.tasks.filter(
      (t) =>
        (!s.taskStatus || t.status === s.taskStatus) &&
        (!s.taskSearch.trim() ||
          [t.title, t.id, t.project, t.requirementRef ?? ""].some((v) =>
            String(v)
              .toLocaleLowerCase()
              .includes(s.taskSearch.trim().toLocaleLowerCase()),
          )),
    ),
  );
  const layout = ref<"board" | "table">("board");
  const statusFilter = computed({
    get: () => s.taskStatus || "werk:any",
    set: (value) => {
      s.taskStatus = value === "werk:any" ? "" : value;
    },
  });
  const statusOptions = computed(() => [
    { value: "werk:any", label: "Alle Status" },
    ...[
      ...new Set([
        ...Object.keys(statuses),
        ...s.tasks.map((task) => String(task.status)),
      ]),
    ].map((value) => ({ value, label: statuses[value] ?? value })),
  ]);
  const columns = computed(() =>
    Object.entries(statuses)
      .filter(
        ([value]) =>
          s.showEmptyStatuses ||
          tasks.value.some((task) => task.status === value),
      )
      .map(([id, label]) => ({ id, label, statuses: [id] })),
  );
  const kanbanTasks = computed<KanbanTask[]>(() =>
    tasks.value.map((task) => ({
      id: String(task.id),
      title: String(task.title),
      status: String(task.status),
      sourceLabel: "Diese Produktionslinie",
      project: task.project,
      priority: task.priority === 2 ? "Hoch" : "Normal",
      workerLabel: task.workerId ?? undefined,
      contextLabel:
        (task.executionMode === "cli" ? "Codex CLI" : "Simulation") +
        " · Versuch " +
        task.attempt,
      gate: task.requestGate
        ? {
            phase: task.requestGate.stage + "_" + task.requestGate.status,
            label:
              "Gate " +
              task.requestGate.stage +
              " · " +
              (task.requestGate.status === "passed" ? "bestanden" : "blockiert"),
          }
        : undefined,
    })),
  );
  const selectedGate = computed<RequestGateEvidence | undefined>(
    () => s.selectedTask?.requestGate,
  );
  const kanbanCopy = {
    emptyColumn: "Keine geladenen Aufträge in diesem Status.",
    refreshing: "Geladene Aufträge werden aktualisiert…",
    unknownGate: "Request-Gates nicht ausgewertet",
    priority: "Priorität",
    other: "Weitere Status",
    scrollHint: "Scrolle seitlich oder wähle eine Statusspalte.",
    jump: "Statusspalte öffnen",
    loadedTasks: "geladene Aufträge",
  };
  let taskTrigger: HTMLElement | null = null;
  const pendingRestore = ref<string | null>(null);
  function restoreTaskFocus() {
    const id = pendingRestore.value;
    if (!id || route.path !== "/tasks" || route.query.task) return;
    pendingRestore.value = null;
    const target = taskTrigger?.isConnected
      ? taskTrigger
      : [...document.querySelectorAll<HTMLElement>("[data-task-id]")].find(
          (element) => element.dataset.taskId === id,
        );
    if (target && !(target as HTMLButtonElement).disabled)
      target.focus({ preventScroll: true });
    else
      document
        .querySelector<HTMLElement>(".page-heading h1")
        ?.focus({ preventScroll: true });
  }
  watch(
    () => s.busy,
    async (busy) => {
      if (!busy && pendingRestore.value) {
        await nextTick();
        restoreTaskFocus();
      }
    },
  );
  const guidance = computed(
    () =>
      ({
        queued:
          "Auftrag gespeichert. Er wartet auf einen erreichbaren Worker mit passendem Projekt und Profil.",
        running:
          s.selectedTask?.executionMode === "cli"
            ? "Codex bearbeitet den Auftrag. Laufende Ausführung ist keine erfolgreiche Umsetzung."
            : "Die Simulation läuft. Ihr Ergebnis bestätigt den technischen Testlauf, keine Umsetzung.",
        review:
          "Änderungssatz zum Review bereit. Prüfe Basis-Commit, SHA-256 und Patch-Pfad in den Ereignissen. Nichts wurde automatisch veröffentlicht oder gemergt.",
        simulated:
          "Testlauf simuliert. Prüfe Ereignisse und Vorher/Nachher-Snapshots; keine Abnahme oder Umsetzung.",
        blocked:
          "Dieser Auftrag braucht Klärung. Ereignisse und Worker-Status prüfen.",
      })[s.selectedTask?.status as string] ||
      "Gespeicherte Ereignisse und Snapshots prüfen.",
  );
  async function open(task: RecordData) {
    taskTrigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    pendingRestore.value = null;
    await router.replace({ path: "/tasks", query: { task: task.id } });
    await nextTick();
    document.querySelector<HTMLElement>("#task-detail-heading")?.focus();
  }
  async function close() {
    pendingRestore.value = s.selectedTask?.id ?? null;
    props.store.closeTask();
    await router.replace("/tasks");
    await nextTick();
    if (!s.busy) restoreTaskFocus();
  }
  function openCard(card: KanbanTask) {
    const task = tasks.value.find((item) => item.id === card.id);
    if (task) void open(task);
  }
  async function page(direction: "next" | "previous") {
    if (await props.store.movePage("tasks", direction)) {
      await nextTick();
      document.querySelector<HTMLElement>("[data-page-state]")?.focus();
    }
  }
  const eventLabels: Record<string, string> = {
    submitted: "Auftrag gespeichert",
    claimed: "An Worker vergeben",
    simulation_finished: "Simulation abgeschlossen",
    review_ready: "Änderungssatz zum Review bereit",
    abandoned: "Versuch abgebrochen",
    lease_expired: "Reservierung abgelaufen",
    snapshot_received: "Snapshot empfangen",
  };
  async function evidence() {
    const id = s.selectedTask?.id;
    if (!id) return;
    s.metricFilters = {
      project: "",
      worker: "",
      iteration: "",
      outcome: "",
      window: "",
      taskId: id,
    };
    await router.push("/metrics");
  }

  return {
    close,
    columns,
    contextState,
    date,
    eventLabels,
    evidence,
    guidance,
    kanbanCopy,
    kanbanTasks,
    layout,
    open,
    openCard,
    page,
    s,
    selectedGate,
    statusFilter,
    statusOptions,
    statuses,
    tasks,
  };
}
