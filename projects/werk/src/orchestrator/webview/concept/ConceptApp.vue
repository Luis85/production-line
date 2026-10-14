<script setup lang="ts">
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
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import SpatialMap from "../../../shared/webview/components/SpatialMap.vue";
import type { SpatialNode } from "../../../shared/webview/types";
import {
  createConceptSimulation,
  projects,
  STORAGE_KEY,
  type ConceptData,
} from "./engine.mjs";
import { conceptKey } from "./context";
import { createConceptWorkspace } from "./workspace.mjs";
import ConceptIntake from "./components/ConceptIntake.vue";
import ConceptFactory from "./components/ConceptFactory.vue";
import ConceptBoard from "./components/ConceptBoard.vue";
import ConceptProviders from "./components/ConceptProviders.vue";
import ConceptDashboard from "./components/ConceptDashboard.vue";
import ConceptDocumentation from "./components/ConceptDocumentation.vue";
import ConceptTaskDetail from "./components/ConceptTaskDetail.vue";
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
  state.value;
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
</script>
<template>
  <UApp>
    <a class="concept-skip" href="#concept-main" @click="focusMain"
      >Zum Inhalt</a
    >
    <header class="concept-header">
      <a href="/" class="concept-brand"
        >werk<span>.</span> <small>Software-Fabrik</small></a
      >
      <div class="concept-header-actions">
        <UBadge color="warning" variant="subtle"
          >Lokale Konzeptsimulation</UBadge
        >
        <UButton variant="outline" icon="i-lucide-download" @click="exportState"
          >JSON exportieren</UButton
        >
        <UButton variant="ghost" @click="resetRequested = !resetRequested"
          >Demo zurücksetzen</UButton
        >
        <UButton @click="newFeature">Feature einreichen</UButton>
      </div>
    </header>
    <div
      v-if="resetRequested"
      class="concept-reset"
      role="region"
      aria-label="Demo zurücksetzen bestätigen"
    >
      <p>Alle gespeicherten Änderungen dieser Browserdemo verwerfen?</p>
      <UButton
        color="error"
        @click="
          reset();
          resetRequested = false;
        "
        >Änderungen verwerfen und zurücksetzen</UButton
      >
      <UButton variant="outline" @click="resetRequested = false"
        >Abbrechen</UButton
      >
    </div>
    <nav class="concept-tabs" aria-label="Hauptnavigation">
      <UButton
        v-for="tab in tabs"
        :key="tab.value"
        :variant="view === tab.value ? 'solid' : 'ghost'"
        :aria-current="view === tab.value ? 'page' : undefined"
        @click="navigate(tab.value)"
        >{{ tab.label }}</UButton
      >
    </nav>
    <main id="concept-main" class="concept-main" tabindex="-1">
      <UAlert
        v-if="storageWarning"
        color="warning"
        variant="subtle"
        :description="storageWarning"
      />
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :description="error"
      />
      <div class="concept-heading">
        <div>
          <h1 ref="heading" tabindex="-1">{{ headingTitle }}</h1>
          <p>
            Alle Projekte, Accounts, Checks und Git-Ereignisse sind
            Beispieldaten. Keine Verbindung zu KI-Anbietern oder Git.
          </p>
        </div>
        <div
          v-if="!['intake', 'factory', 'operations', 'system'].includes(view)"
          class="concept-controls"
        >
          <label for="conceptSpeed">Simulationsintervall</label
          ><USelect id="conceptSpeed" v-model="speed" :items="speedItems" />
          <UButton variant="outline" icon="i-lucide-step-forward" @click="step"
            >Nächster Takt</UButton
          >
          <UButton
            variant="outline"
            :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
            :aria-pressed="playing"
            @click="togglePlay"
            >{{
              playing ? "Simulation pausieren" : "Simulation starten"
            }}</UButton
          >
        </div>
      </div>
      <section
        v-if="view !== 'factory'"
        class="concept-line-context"
        aria-label="Aktive Produktionslinie"
      >
        <div>
          <strong>{{ engine.factoryPath(line.factoryId) }}</strong>
          <p>
            {{ line.orchestratorId }} ·
            {{
              projects.find((project) => project.id === line.projectId)?.name
            }}
          </p>
        </div>
        <label for="concept-line">Produktionslinie</label>
        <USelect
          id="concept-line"
          :model-value="line.id"
          :items="lineOptions"
          @update:model-value="chooseLine(String($event))"
        />
        <UButton variant="outline" @click="navigate('factory')"
          >Factories verwalten</UButton
        >
      </section>
      <p
        v-if="!['intake', 'factory', 'operations', 'system'].includes(view)"
        class="concept-status"
        role="status"
      >
        Takt {{ state.tick }} ·
        {{ workers.filter((worker) => worker.online).length }}/{{
          workers.length
        }}
        Demo-Worker online ·
        {{
          tasks.filter((task) => ["running", "checks"].includes(task.status))
            .length
        }}
        aktive Versuche ·
        {{ tasks.filter((task) => task.status === "review").length }} im Review.
        Takte wirken auf alle Linien.
      </p>
      <ConceptIntake v-if="view === 'intake'" :key="state.selectedLineId" />
      <ConceptFactory v-else-if="view === 'factory'" />
      <section
        v-else-if="view === 'architecture'"
        aria-label="Illustrative Architektur"
      >
        <div class="concept-inline">
          <label for="connectionLayer">Verbindungsart</label
          ><USelect
            id="connectionLayer"
            v-model="connectionLayer"
            :items="layerItems"
          />
        </div>
        <SpatialMap
          :nodes="nodes"
          :edges="edges"
          :selected-id="selectedNode"
          :english="false"
          label="Illustrative Architektur dieser Produktionslinie"
          caption="Konzeptsimulation · keine Live-Topologie"
          legend="Durchgezogen: Aufträge · Gestrichelt: Git- und Review-Rückmeldung"
          @select="selectedNode = $event"
        />
      </section>
      <ConceptBoard v-else-if="view === 'board'" />
      <ConceptProviders v-else-if="view === 'providers'" />
      <ConceptDashboard v-else-if="view === 'dashboard'" />
      <ConceptDocumentation v-else :view="view" />
    </main>
    <footer class="concept-footer">
      Konzeptsimulation · Änderungen bleiben in diesem Browser. Token-, Kosten-,
      CPU- und Coverage-Werte bleiben unbekannt.
      <a href="/guide">Systemguide öffnen</a>
    </footer>
    <ConceptTaskDetail
      :task-id="taskId"
      @close="taskId = null"
      @close-auto-focus="restoreTaskFocus"
    />
  </UApp>
</template>
