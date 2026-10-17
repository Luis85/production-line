import {
  computed,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  shallowRef,
  toRef,
  watch,
} from "vue";
import type { SpatialNode } from "../../../shared/webview/types";
import {
  createConceptSimulation,
  projects,
  STORAGE_KEY,
  type ConceptData,
} from "./engine.mjs";
import { conceptKey } from "./context";
import { createConceptWorkspace } from "./workspace.mjs";

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useConceptPage() {
  const tabs = [
    { value: "intake", label: "Intake" },
    { value: "factory", label: "Factories" },
    { value: "architecture", label: "Architektur · 3D" },
    { value: "process", label: "Prozess" },
    { value: "board", label: "Taskboard" },
    { value: "dashboard", label: "Dashboard" },
    { value: "providers", label: "Worker & Provider" },
    { value: "operations", label: "Betrieb & CLI" },
    { value: "system", label: "System" },
  ];
  let invalidStored = false,
    saved: unknown;
  const storageWarning = ref("");
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    invalidStored = true;
    storageWarning.value =
      "Gespeicherte Daten konnten nicht geladen werden. Die Demo läuft vorübergehend; vorhandene Daten werden nicht überschrieben. Über „Demo zurücksetzen“ neu beginnen.";
  }
  let engine: ReturnType<typeof createConceptSimulation>;
  try {
    engine = createConceptSimulation(saved);
  } catch {
    engine = createConceptSimulation();
    invalidStored = true;
    storageWarning.value =
      "Gespeicherte Daten sind ungültig und werden nicht überschrieben. Exportiere bei Bedarf die Sitzung oder setze die Demo ausdrücklich zurück.";
  }
  const state = shallowRef<ConceptData>(structuredClone(engine.data));
  const workspace = reactive(createConceptWorkspace(engine));
  workspace.view = tabs.some((tab) => tab.value === location.hash.slice(1))
    ? location.hash.slice(1)
    : "intake";
  const view = toRef(workspace, "view");
  const error = ref(""),
    selectedNode = toRef(workspace, "selected"),
    taskId = ref<number | null>(null),
    playing = toRef(workspace, "playing");
  const receipt = ref<{ lineId: string; taskId?: number; count?: number } | null>(
    null,
  );
  const heading = ref<HTMLElement | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  const speed = ref("4000");
  const speedItems = [
    { value: "2000", label: "2 Sekunden" },
    { value: "4000", label: "4 Sekunden" },
    { value: "8000", label: "8 Sekunden" },
  ];
  watch(speed, () => {
    if (playing.value) {
      clearInterval(timer);
      timer = setInterval(step, Number(speed.value));
    }
  });
  const line = computed(
    () =>
      state.value.lines.find((item) => item.id === state.value.selectedLineId)!,
  );
  const lineOptions = computed(() =>
    state.value.lines.map((item) => ({
      value: item.id,
      label: engine.factoryPath(item.factoryId) + " / " + item.name,
    })),
  );
  const tasks = computed(() =>
    state.value.tasks.filter((task) => task.lineId === line.value.id),
  );
  const workers = computed(() =>
    state.value.workers.filter((worker) => worker.lineId === line.value.id),
  );
  const headingTitle = computed(
    () => tabs.find((tab) => tab.value === view.value)?.label ?? "Intake",
  );
  function pause() {
    playing.value = false;
    clearInterval(timer);
    timer = undefined;
  }
  function persist() {
    if (invalidStored) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(engine.data));
      storageWarning.value = "";
    } catch {
      storageWarning.value =
        "Speichern ist nicht verfügbar. Änderungen gelten nur für diese Sitzung. Exportiere sie bei Bedarf als JSON.";
    }
  }
  function act<T>(operation: () => T): T | undefined {
    error.value = "";
    try {
      const result = operation();
      state.value = structuredClone(engine.data);
      persist();
      return result;
    } catch (failure) {
      error.value =
        failure instanceof Error
          ? failure.message
          : "Die Aktion konnte nicht ausgeführt werden.";
      return undefined;
    }
  }
  function navigate(next: string) {
    if (!tabs.some((tab) => tab.value === next)) return;
    pause();
    workspace.navigate(next);
    history.replaceState(null, "", "#" + next);
    requestAnimationFrame(() => heading.value?.focus({ preventScroll: true }));
  }
  function chooseLine(id: string) {
    pause();
    const selected = act(() => workspace.chooseLine(id));
    if (selected) {
      selectedNode.value = "orchestrator";
      taskId.value = null;
    }
  }
  function getDraft(id: string) {
    return workspace.getDraft(id);
  }
  function openBoard(status = "all") {
    pause();
    act(() => workspace.openProjectBoard(line.value.projectId, status));
    history.replaceState(null, "", "#board");
  }
  function newFeature() {
    pause();
    workspace.newFeature();
    history.replaceState(null, "", "#intake");
  }
  let taskFocusOrigin: HTMLElement | null = null;
  let taskFocusIdentity: { id: number; lineId: string } | null = null;
  function openTask(id: number) {
    pause();
    taskFocusOrigin = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const selected = state.value.tasks.find((task) => task.id === id);
    taskFocusIdentity = selected ? { id, lineId: selected.lineId } : null;
    taskId.value = id;
  }
  function restoreTaskFocus(event: Event) {
    event.preventDefault();
    // Intake may have navigated to the board, removing the original submitter.
    const card = taskFocusIdentity && Array.from(
      document.querySelectorAll<HTMLElement>("[data-task-id][data-source-id]"),
    ).find((element) => element.dataset.taskId === String(taskFocusIdentity!.id)
      && element.dataset.sourceId === taskFocusIdentity!.lineId);
    const target = card ?? (taskFocusOrigin?.isConnected ? taskFocusOrigin : null)
      ?? heading.value;
    target?.focus({ preventScroll: true });
    taskFocusOrigin = null;
    taskFocusIdentity = null;
  }
  function step() {
    act(() => engine.advance());
  }
  function togglePlay() {
    if (playing.value) {
      pause();
      return;
    }
    playing.value = true;
    timer = setInterval(step, Number(speed.value));
  }
  function exportState() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(engine.data, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "werk-concept.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function reset() {
    pause();
    invalidStored = false;
    receipt.value = null;
    taskId.value = null;
    selectedNode.value = "orchestrator";
    act(() => {
      engine.reset();
      workspace.reset();
    });
    navigate("intake");
  }
  const resetRequested = ref(false);
  function focusMain(event: Event) {
    event.preventDefault();
    const main = document.getElementById("concept-main");
    main?.focus();
    main?.scrollIntoView({ block: "start" });
  }
  function handleVisibility() {
    if (document.hidden) pause();
  }
  function handleHash() {
    const next = location.hash.slice(1);
    if (tabs.some((tab) => tab.value === next)) {
      pause();
      view.value = next;
    }
  }
  onMounted(() => {
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("hashchange", handleHash);
  });
  onBeforeUnmount(() => {
    pause();
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("hashchange", handleHash);
  });
  const topology = computed(() => {
    // Track the reactive snapshot before reading the engine projection.
    void state.value;
    return engine.topology(line.value.id);
  });
  const nodes = computed<SpatialNode[]>(() =>
    topology.value.nodes.map((node) => ({
      id: node.id,
      label: node.name,
      kind: node.kind,
      model:
        node.kind === "repo"
          ? "repository"
          : node.kind === "worker"
            ? "workers"
            : node.kind === "team"
              ? "team"
              : "orchestrator",
      reading: node.sub,
      x: node.x / 160,
      z: node.z / 160,
      color: node.color,
      description:
        node.kind === "repo"
          ? "Simuliertes Projekt-Repository. Keine Git-Verbindung."
          : node.kind === "worker"
            ? "Projekt- und liniengebundener Demo-Worker mit lokalen Provider-Profilen."
            : "Illustrative Systemkomponente dieser Produktionslinie.",
      actions: [
        {
          label:
            node.kind === "worker"
              ? "Worker und Provider öffnen"
              : "Taskboard öffnen",
          run: () => navigate(node.kind === "worker" ? "providers" : "board"),
        },
      ],
    })),
  );
  const connectionLayer = ref("all");
  const layerItems = [
    { value: "all", label: "Alle Verbindungen" },
    { value: "command", label: "Aufträge / Zuweisung" },
    { value: "git", label: "Push / Pull Request" },
    { value: "feedback", label: "PR-Status / Rückmeldung" },
  ];
  const edges = computed(() =>
    topology.value.edges
      .filter(
        (edge) =>
          connectionLayer.value === "all" || edge.kind === connectionLayer.value,
      )
      .map((edge) => ({
        ...edge,
        dashed: edge.kind !== "command",
      })),
  );
  provide(conceptKey, {
    state,
    engine,
    error,
    receipt,
    act,
    chooseLine,
    navigate,
    openTask,
    getDraft,
    workspace,
    openBoard,
  });

  return {
    chooseLine,
    connectionLayer,
    edges,
    engine: toRef(() => engine),
    error,
    exportState,
    focusMain,
    heading,
    headingTitle,
    layerItems,
    line,
    lineOptions,
    navigate,
    newFeature,
    nodes,
    playing,
    projects,
    reset,
    resetRequested,
    restoreTaskFocus,
    selectedNode,
    speed,
    speedItems,
    state,
    step,
    storageWarning,
    tabs,
    taskId,
    tasks,
    togglePlay,
    view,
    workers,
  };
}
