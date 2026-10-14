<script setup lang="ts">
import { computed, onUnmounted, reactive, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import TaskKanban from "../../../shared/webview/components/TaskKanban.vue";
import { createFactoryTaskboard } from "../taskboard";
import { handoff, time, type FactoryStore } from "../store";
const props = defineProps<{ store: FactoryStore }>();
const s = props.store.state;
const board = createFactoryTaskboard(
  (id, cursor, signal) => {
    const query = new URLSearchParams({ limit: "10" });
    if (cursor) query.set("cursor", cursor);
    return props.store.api(
      "/v1/lines/" + encodeURIComponent(id) + "/tasks?" + query,
      { signal },
    );
  },
  (value) => reactive(value) as typeof value,
);
const sources = computed(() =>
  props.store.selectedLines.value
    .filter((line) => !s.lineId || line.id === s.lineId)
    .map((line) => ({
      id: line.id,
      label: line.name,
      webviewUrl: line.webviewUrl,
    })),
);
watch(
  () => [s.token, JSON.stringify(sources.value)] as const,
  () => void board.configure(sources.value, s.token),
  { immediate: true },
);
onUnmounted(board.close);
const rows = computed(board.rows);
const pages = computed(() =>
  board.visibleSources().map((source) => board.state.pages.get(source.id)),
);
const loaded = computed(
  () => pages.value.filter((page) => page?.loaded).length,
);
const partial = computed(
  () =>
    pages.value.some(
      (page) =>
        !page?.loaded || page.error || page.hasMore || page.previous.length,
    ) || sources.value.length > board.sourceLimit,
);
const label = computed(() =>
  s.lineId
    ? (props.store.activeLine.value?.name ?? "Produktionslinie")
    : (props.store.selectedFactory.value?.name ?? "Alle Fabriken"),
);
const columns = [
  { id: "queued", label: "Wartet", statuses: ["queued"] },
  { id: "running", label: "Reserviert / aktiv", statuses: ["running"] },
  { id: "review", label: "Review", statuses: ["review"] },
  {
    id: "completed",
    label: "Simuliert / abgeschlossen",
    statuses: ["completed", "simulated"],
  },
  {
    id: "failed",
    label: "Fehlgeschlagen",
    statuses: ["blocked", "failed", "cancelled"],
  },
];
function taskLink(task: { id: string; sourceId?: string }) {
  const source = board.state.sources.find((item) => item.id === task.sourceId);
  return source
    ? handoff(source.webviewUrl, "/tasks?task=" + encodeURIComponent(task.id))
    : undefined;
}
</script>
<template>
  <section
    class="section-start factory-taskboard"
    aria-labelledby="factory-tasks-heading"
  >
    <div class="section-heading">
      <div>
        <h2 id="factory-tasks-heading">Aufträge · {{ label }}</h2>
        <p>
          Gespeicherte Aufträge der Produktionslinien. Pro Linie bis zu 10
          Aufträge pro Seite. Spalten zählen nur die geladenen Seiten; die
          Statuswerte kommen vom jeweiligen Orchestrator.
        </p>
      </div>
      <UButton
        color="neutral"
        variant="outline"
        :loading="board.state.loading"
        :disabled="!sources.length || board.state.loading"
        @click="board.refresh"
        >Aufträge aktualisieren</UButton
      >
    </div>
    <p role="status">
      {{ loaded }} / {{ board.visibleSources().length }} Linien geladen ·
      {{ rows.length }} Aufträge angezeigt{{ partial ? " · Teilansicht" : "" }}
    </p>
    <div
      v-if="sources.length > board.sourceLimit"
      class="actions"
      aria-label="Seiten der Produktionslinien"
    >
      <UButton
        color="neutral"
        variant="outline"
        :disabled="board.state.sourcePage === 0"
        @click="board.moveSources('previous')"
        >Vorherige Linien</UButton
      >
      <span
        >Linien {{ board.state.sourcePage * board.sourceLimit + 1 }}–{{
          Math.min(
            (board.state.sourcePage + 1) * board.sourceLimit,
            sources.length,
          )
        }}
        von {{ sources.length }}</span
      >
      <UButton
        color="neutral"
        variant="outline"
        :disabled="
          (board.state.sourcePage + 1) * board.sourceLimit >= sources.length
        "
        @click="board.moveSources('next')"
        >Weitere Linien</UButton
      >
    </div>
    <TaskKanban
      :tasks="rows"
      :status-labels="{
        queued: 'Wartet',
        running: 'Reserviert / aktiv',
        review: 'Review',
        simulated: 'Simuliert',
        completed: 'Abgeschlossen',
        blocked: 'Blockiert',
        failed: 'Fehlgeschlagen',
        cancelled: 'Gestoppt',
      }"
      :copy="{
        emptyColumn: 'Keine geladenen Aufträge in diesem Status.',
        refreshing: 'Aufträge werden aktualisiert…',
        unknownGate: 'Request nicht bewertet',
        priority: 'Priorität',
        other: 'Weitere Statuswerte',
        scrollHint: 'Horizontal scrollen oder eine Statusspalte wählen.',
        jump: 'Zur Statusspalte',
        loadedTasks: 'geladene Aufträge',
      }"
      :columns="columns"
      :scope-label="label"
      :loading="board.state.loading"
      :selectable="false"
      empty-text="Keine Aufträge auf den geladenen Seiten. Prüfe die Verbindung und weitere Seiten der Linien."
    >
      <template #actions="{ task }">
        <UButton
          v-if="taskLink(task)"
          :href="taskLink(task)"
          target="_blank"
          rel="noopener noreferrer"
          color="neutral"
          variant="outline"
          >Im Orchestrator öffnen</UButton
        >
      </template>
    </TaskKanban>
    <details v-if="sources.length" class="factory-task-sources" open>
      <summary>Verbindungen und Auftragsseiten</summary>
      <div class="factory-task-source-grid">
        <article
          v-for="source in board.visibleSources()"
          :key="source.id"
          :aria-label="source.label"
        >
          <h3>{{ source.label }}</h3>
          <p>
            {{ source.id }} ·
            {{
              board.state.pages.get(source.id)?.checkedAt
                ? "Stand " + time(board.state.pages.get(source.id)!.checkedAt!)
                : "Noch keine erfolgreiche Abfrage"
            }}
          </p>
          <p
            v-if="board.state.pages.get(source.id)?.error"
            class="error-text"
            role="alert"
          >
            {{ board.state.pages.get(source.id)?.error }} Vorhandene Karten
            behalten ihren letzten Datenstand.
          </p>
          <p v-if="board.state.pages.get(source.id)?.loading">Wird geladen…</p>
          <div class="actions">
            <UButton
              color="neutral"
              variant="outline"
              :disabled="
                board.state.loading ||
                board.state.pages.get(source.id)?.loading ||
                !board.state.pages.get(source.id)?.previous.length
              "
              @click="board.moveTasks(source.id, 'previous')"
              >Vorherige Aufträge</UButton
            >
            <span
              >Seite
              {{
                (board.state.pages.get(source.id)?.previous.length ?? 0) + 1
              }}</span
            >
            <UButton
              color="neutral"
              variant="outline"
              :disabled="
                board.state.loading ||
                board.state.pages.get(source.id)?.loading ||
                !board.state.pages.get(source.id)?.hasMore
              "
              @click="board.moveTasks(source.id, 'next')"
              >Weitere Aufträge</UButton
            >
            <UButton
              v-if="board.state.pages.get(source.id)?.error"
              color="neutral"
              variant="outline"
              :disabled="
                board.state.loading || board.state.pages.get(source.id)?.loading
              "
              @click="board.retry(source.id)"
              >Erneut laden</UButton
            >
          </div>
        </article>
      </div>
    </details>
  </section>
</template>
