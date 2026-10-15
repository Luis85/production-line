<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UCheckbox from "@nuxt/ui/components/Checkbox.vue";
import TaskKanban from "../../../shared/webview/components/TaskKanban.vue";
import type { KanbanTask } from "../../../shared/webview/task-kanban";
import type { RequestGateEvidence } from "../../../shared/request-gate";
import UAlert from "@nuxt/ui/components/Alert.vue";
import Pagination from "../components/Pagination.vue";
import {
  statuses,
  contextState,
  date,
  type OrchestratorStore,
  type RecordData,
} from "../store";
const { store } = defineProps<{ store: OrchestratorStore }>();
const s = store.state,
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
  store.closeTask();
  await router.replace("/tasks");
  await nextTick();
  if (!s.busy) restoreTaskFocus();
}
function openCard(card: KanbanTask) {
  const task = tasks.value.find((item) => item.id === card.id);
  if (task) void open(task);
}
async function page(direction: "next" | "previous") {
  if (await store.movePage("tasks", direction)) {
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
</script>
<template>
  <section id="tasks" class="page-section" :aria-busy="s.busy">
    <div class="filters">
      <div>
        <label for="task-search">Suche auf dieser Seite</label
        ><UInput
          id="task-search"
          v-model="s.taskSearch"
          type="search"
          placeholder="Feature, ID, Projekt oder Wikilink"
        />
      </div>
      <div>
        <label for="task-status">Status</label
        ><USelect
          id="task-status"
          v-model="statusFilter"
          :items="statusOptions"
        />
      </div>
      <UButton v-if="s.canWrite" to="/intake">Neuer Auftrag</UButton>
    </div>
    <div class="actions" role="group" aria-label="Auftragsdarstellung">
      <UButton
        :variant="layout === 'board' ? 'solid' : 'outline'"
        :aria-pressed="layout === 'board'"
        @click="layout = 'board'"
        >Kanban</UButton
      ><UButton
        :variant="layout === 'table' ? 'solid' : 'outline'"
        :aria-pressed="layout === 'table'"
        @click="layout = 'table'"
        >Tabelle</UButton
      >
    </div>
    <p role="status">
      {{ tasks.length }} von {{ s.tasks.length }} Aufträgen auf dieser Seite.
      Suche und Status gelten nur für diese Seite.
    </p>
    <Pagination
      :page="s.taskPage"
      :busy="s.busy"
      label="Aufträge"
      @move="page"
      @refresh="store.refresh({ reset: true })"
    />
    <UAlert
      v-if="!tasks.length && !s.busy"
      color="neutral"
      :title="
        s.tasks.length
          ? 'Keine passenden Aufträge auf dieser Seite'
          : 'Noch keine Aufträge auf dieser Seite'
      "
      :description="
        s.tasks.length
          ? 'Filter ändern oder eine andere Seite öffnen.'
          : 'Importiere Ready-Features oder übergib einen ersten Auftrag im Intake.'
      "
    />
    <UCheckbox
      v-if="tasks.length && layout === 'board'"
      v-model="s.showEmptyStatuses"
      label="Leere Statusgruppen anzeigen"
    />
    <TaskKanban
      v-if="tasks.length && layout === 'board'"
      :tasks="kanbanTasks"
      :columns="columns"
      scope-label="Geladene Aufträge dieser Produktionslinie"
      :status-labels="statuses"
      :loading="s.busy"
      :copy="kanbanCopy"
      @open="openCard"
    />
    <section
      v-if="tasks.length && layout === 'table'"
      aria-label="Aufträge als Tabelle"
    >
      <div class="table-scroll" tabindex="0">
        <table>
          <thead>
            <tr>
              <th>Auftrag</th>
              <th>Projekt</th>
              <th>Status</th>
              <th>Profil / Provider</th>
              <th>Versuch</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in tasks" :key="task.id">
              <td>
                <UButton
                  variant="link"
                  :data-task-id="task.id"
                  @click="open(task)"
                  >{{ task.title }}</UButton
                ><small v-if="task.requirementRef"
                  >{{ task.requirementRef }} · {{ contextState(task) }}</small
                >
              </td>
              <td>{{ task.project }}</td>
              <td>{{ statuses[task.status] || task.status }}</td>
              <td>{{ task.profile || task.provider }}</td>
              <td>{{ task.attempt }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <Pagination
      v-if="tasks.length"
      :page="s.taskPage"
      :busy="s.busy"
      label="Aufträge"
      @move="page"
      @refresh="store.refresh({ reset: true })"
    />
    <section
      v-if="s.selectedTask"
      class="detail"
      aria-labelledby="task-detail-heading"
    >
      <div class="section-heading">
        <h2 id="task-detail-heading" tabindex="-1">
          {{ s.selectedTask.title }} · Ereignisse
        </h2>
        <UButton variant="outline" color="neutral" @click="close"
          >Schließen</UButton
        >
      </div>
      <p>{{ guidance }}</p>
      <p v-if="s.selectedTask.repository || s.selectedTask.executionMode === 'cli'">
        Repository-Zuweisung:
        {{ s.selectedTask.repository || s.selectedTask.project }}
        {{ s.selectedTask.repository ? "" : "(Projekt-Standard)" }}
      </p>
      <p v-if="s.selectedTask.requirementRef">
        {{ s.selectedTask.requirementRef }} · {{ contextState(s.selectedTask) }}
      </p>
      <section aria-label="Request-Gate-Nachweis">
        <h3>Request-Gate-Nachweis</h3>
        <p v-if="!selectedGate">
          Für diesen Versuch ist kein Gate-Nachweis gespeichert. Gates wurden
          nicht ausgewertet; ein Modell- oder Simulationsergebnis ist keine
          Abnahme.
        </p>
        <template v-else
          ><p>
            Gate {{ selectedGate.stage }} ·
            {{ selectedGate.status === "passed" ? "bestanden" : "blockiert" }} ·
            {{ selectedGate.failedRules }} fehlgeschlagene und
            {{ selectedGate.unknownRules }} unbekannte Regeln. Private
            Anforderungen, Policy und Reviewer-Findings verbleiben auf dem
            Worker.
          </p>
          <details>
            <summary>Numerischer Nachweis und Zuordnung</summary>
            <pre tabindex="0">{{ JSON.stringify(selectedGate, null, 2) }}</pre>
          </details>
          <div v-if="selectedGate.status === 'blocked'" class="notice">
            <p>
              Der Auftrag ist für Nacharbeit gehalten. Die aktuelle Lease wird
              nicht mit geänderten Eingaben fortgesetzt. Ein berechtigter
              Operator erstellt im zuständigen Orchestrator einen ausdrücklichen
              Nachfolger mit aktueller Versuchszahl, Evaluation und eigenem
              Operationsschlüssel. Der neue Auftrag erhält frisch aufgelösten
              Kontext; dieser gehaltene Auftrag bleibt erhalten.
            </p>
            <pre
              tabindex="0"
              aria-label="Nachfolger über die native Orchestrator-CLI"
            >
node src/orchestrator/dist/orchestrator/cli.js task successor --id {{
                s.selectedTask.id
              }} --attempt {{ s.selectedTask.attempt }} --evaluation {{
                selectedGate.evaluationId
              }} --key YOUR_UNIQUE_OPERATION --file revised-task.json</pre
            >
            <p>
              Die Datei enthält dieselben Eingabefelder wie ein neuer Auftrag.
              Bei gebundenen Projekten verwende Projekt und einen aktuellen
              Requirement-Verweis. Wiederhole bei ungewisser Antwort denselben
              Schlüssel und dieselbe Eingabe; ein alter Versuch oder abweichende
              Wiederholung wird abgewiesen.
            </p>
          </div></template
        >
      </section>
      <div class="actions">
        <UButton color="neutral" @click="evidence"
          >Vorher/Nachher-Snapshots</UButton
        ><UButton
          v-if="['queued', 'blocked'].includes(s.selectedTask.status)"
          color="neutral"
          variant="outline"
          to="/workers"
          >Worker prüfen</UButton
        >
      </div>
      <UAlert v-if="s.eventError" color="warning" :title="s.eventError" />
      <Pagination
        :page="s.eventPage"
        :busy="s.eventBusy"
        :limit="200"
        label="Ereignisse"
        @move="store.loadEvents"
        @refresh="store.loadEvents()"
      />
      <ol class="timeline">
        <li v-for="event in s.events" :key="event.seq">
          <strong>{{
            eventLabels[event.kind] || event.kind || "Ereignis"
          }}</strong
          ><small>Nr. {{ event.seq }} · {{ date(event.at) }}</small>
          <p>
            {{
              [
                event.detail?.phase === "before"
                  ? "Vor der Ausführung"
                  : event.detail?.phase === "after"
                    ? "Nach der Ausführung"
                    : "",
                event.detail?.workerId
                  ? "Worker: " + event.detail.workerId
                  : "",
                event.detail?.attempt ? "Versuch " + event.detail.attempt : "",
                event.detail?.status
                  ? statuses[event.detail.status] || event.detail.status
                  : "",
                event.detail?.message || event.detail?.reason || "",
              ]
                .filter(Boolean)
                .join(" · ") || "Im Orchestrator dieser Linie gespeichert."
            }}
          </p>
        </li>
      </ol>
      <p v-if="!s.events.length && !s.eventBusy">
        Für diesen Lesestand liegen keine Ereignisse vor.
      </p>
      <details>
        <summary>Vollständige Ereignisdaten (JSON)</summary>
        <pre tabindex="0">{{
          JSON.stringify({ events: s.events }, null, 2)
        }}</pre>
      </details>
      <details v-if="s.selectedTask.status === 'queued' && s.canWrite">
        <summary>Ziel für diesen wartenden Auftrag ändern</summary>
        <form class="form-stack" @submit.prevent="store.saveTaskRouting()">
          <label for="task-destination"
            >Neuer Ziel-Worker · leer für Routing-Standard</label
          ><input
            id="task-destination"
            v-model="s.taskRouting.workerId"
            :disabled="s.taskRouting.busy"
          />
          <p>
            Diese Eingabe ändert das Ziel. Sie zeigt keine gespeicherte
            Zielauswahl an. Leer entfernt die auftragsspezifische Zuweisung.
          </p>
          <UButton
            type="submit"
            :loading="s.taskRouting.busy"
            :disabled="s.taskRouting.busy"
            >Ziel speichern</UButton
          >
          <p role="status">{{ s.taskRouting.message }}</p>
        </form>
      </details>
    </section>
  </section>
</template>

<style scoped>
#tasks {
  grid-template-columns: minmax(0, 1fr);
}
#tasks > section[aria-label="Aufträge als Tabelle"] {
  min-width: 0;
  max-width: 100%;
}
#tasks .table-scroll {
  min-width: 0;
  width: 100%;
}
</style>
