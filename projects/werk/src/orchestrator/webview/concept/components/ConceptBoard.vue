<script setup lang="ts">
import { computed, toRef } from "vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import TaskKanban from "../../../../shared/webview/components/TaskKanban.vue";
import type { KanbanTask } from "../../../../shared/webview/task-kanban";
import { labels, states } from "../engine.mjs";
import { useConcept } from "../context";
const { state, engine, openTask, workspace } = useConcept();
const query = toRef(workspace, "query"),
  status = toRef(workspace, "statusFilter");
const tasks = computed(() =>
  state.value.tasks.filter(
    (task) =>
      task.lineId === state.value.selectedLineId &&
      (status.value === "all" || task.status === status.value) &&
      (!query.value ||
        (task.id + " " + task.title + " " + (task.pr ?? ""))
          .toLocaleLowerCase("de")
          .includes(query.value.toLocaleLowerCase("de"))),
  ),
);
const columns = computed(() =>
  states
    .filter((value) => status.value === "all" || value === status.value)
    .map((id) => ({ id, label: labels[id], statuses: [id] })),
);
const items = [
  { value: "all", label: "Alle Status" },
  ...states.map((value) => ({ value, label: labels[value] })),
];
const cards = computed<KanbanTask[]>(() =>
  tasks.value.map((task) => ({
    id: String(task.id),
    title: task.title,
    status: task.status,
    sourceId: task.lineId,
    sourceLabel: "Konzeptsimulation",
    priority: task.priority === 2 ? "Hoch" : "Normal",
    workerLabel:
      task.worker ??
      (task.pr ? "Demo-PR #" + task.pr : "Noch nicht zugewiesen"),
    contextLabel: engine.waitReason(task) || "Versuch " + task.attempt,
    gate: { phase: "not_evaluated", label: "Request-Gates nicht ausgewertet" },
  })),
);
const copy = {
  emptyColumn: "Keine geladenen Features in diesem Status.",
  refreshing: "Demo-Aufträge werden aktualisiert…",
  unknownGate: "Request-Gates nicht ausgewertet",
  priority: "Priorität",
  other: "Weitere Status",
  scrollHint: "Scrolle seitlich oder wähle eine Statusspalte.",
  jump: "Statusspalte öffnen",
  loadedTasks: "geladene Features",
};
</script>
<template>
  <section aria-label="Taskboard">
    <div class="concept-board-controls">
      <label for="concept-search">Features suchen</label
      ><UInput
        id="concept-search"
        v-model="query"
        type="search"
        maxlength="100"
        placeholder="Feature, FT-ID oder PR"
      /><label for="concept-filter">Status</label
      ><USelect id="concept-filter" v-model="status" :items="items" /><UButton
        v-if="query || status !== 'all'"
        variant="outline"
        @click="
          query = '';
          status = 'all';
        "
        >Filter zurücksetzen</UButton
      ><span role="status">{{ tasks.length }} Features</span>
    </div>
    <TaskKanban
      :tasks="cards"
      :columns="columns"
      :scope-label="'Taskboard der Demo-Linie ' + state.selectedLineId"
      :status-labels="labels"
      :copy="copy"
      empty-text="Keine Features für diese Auswahl. Ändere Filter oder reiche einen Demo-Auftrag ein."
      @open="openTask(Number($event.id))"
    />
    <p class="concept-note">
      Projekt- und Liniengrenzen bleiben verbindlich. Reviews und Checks sind
      simuliert; kein PR wird tatsächlich erstellt oder gemerged. Request-Gates
      werden von dieser Konzeptsimulation nicht ausgeführt.
    </p>
  </section>
</template>
