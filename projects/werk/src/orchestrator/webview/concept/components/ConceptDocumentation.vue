<script setup lang="ts">
import { computed, ref } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import { labels } from "../engine.mjs";
import { useConcept } from "../context";
import ConceptSystem from "./ConceptSystem.vue";
const props = defineProps<{ view: string }>();
const { state, engine, openTask } = useConcept();
const selectedTask = ref(""),
  environment = ref("docker"),
  count = ref("3");
const tasks = computed(() =>
  state.value.tasks.filter(
    (task) => task.lineId === state.value.selectedLineId,
  ),
);
const task = computed(
  () =>
    tasks.value.find((item) => String(item.id) === selectedTask.value) ??
    tasks.value[0],
);
const steps = [
  [
    "Iteration planen & importieren",
    "Das Team pflegt Anforderungen, Spezifikationen und Tests. Ready-Features werden idempotent importiert.",
  ],
  [
    "Worker & Draft PR starten",
    "Lease, Konfiguration und Iterations-Commit pinnen; Vorher-Snapshot erfasst.",
  ],
  [
    "Implementieren und prüfen",
    "Build und Tests liefern Nachweise. Drei fehlgeschlagene Prüfversuche erfordern eine Teamentscheidung.",
  ],
  [
    "Nachher-Snapshot & Review",
    "Code und Snapshot-Paar gehören zum bestehenden Feature-PR.",
  ],
  [
    "Review nachhalten",
    "Feedback startet Nacharbeit mit neuen Snapshots. Freigabe und aktuelle Checks ermöglichen den Merge.",
  ],
  [
    "Merge bestätigen",
    "Erst der menschlich bestätigte Merge schließt den Feature-Task ab. Die Iteration bleibt separat.",
  ],
];
const current = computed(() =>
  task.value
    ? {
        queued: 1,
        running: 2,
        checks: 2,
        review: 4,
        changes: 1,
        blocked: -1,
        done: 5,
      }[task.value.status]
    : -1,
);
const commands = computed(() =>
  environment.value === "docker"
    ? "node scripts/init-env.mjs\ndocker compose up --build -d --scale worker=" +
      count.value +
      "\ndocker compose ps\ndocker compose logs -f orchestrator worker\ndocker compose stop"
    : "npm run build\nnpm run dev:fleet -- --workers " +
      count.value +
      "\n# Zweites Terminal: CLI-Zugriff\nsource .state/fleet/env.sh\nnode src/orchestrator/dist/orchestrator/cli.js task list --limit 100",
);
</script>
<template>
  <section v-if="view === 'process'" aria-label="Taskprozess">
    <div class="concept-inline">
      <label for="processTask">Feature im Fokus</label
      ><USelect
        id="processTask"
        :model-value="task ? String(task.id) : ''"
        :items="
          tasks.map((item) => ({
            value: String(item.id),
            label: 'FT-' + item.id + ' · ' + item.title,
          }))
        "
        @update:model-value="selectedTask = String($event)"
      />
    </div>
    <p v-if="!task" class="concept-empty">
      Noch keine Features in dieser Linie. Reiche ein Requirement im Intake ein.
    </p>
    <ol class="concept-process">
      <li
        v-for="(step, index) in steps"
        :key="step[0]"
        :class="{ current: index === current }"
        :aria-current="index === current ? 'step' : undefined"
      >
        <h2>{{ step[0] }}</h2>
        <p>{{ step[1] }}</p>
      </li>
    </ol>
    <section v-if="task" class="concept-section">
      <h2>FT-{{ task.id }} im Fokus</h2>
      <p>
        {{ task.title }} · {{ labels[task.status] }} · Versuch
        {{ task.attempt }}
      </p>
      <p>{{ engine.waitReason(task) }}</p>
      <UButton @click="openTask(task.id)">Feature und Review öffnen</UButton>
    </section>
    <p class="concept-note">
      Alle Git-Ereignisse, Checks und Umsetzungsschritte sind simuliert. Diese
      Darstellung ist keine zugesicherte automatische PR-Publikation des
      Live-Workers.
    </p>
  </section>
  <section v-else-if="view === 'operations'" aria-label="Betrieb und CLI">
    <h2>Unabhängige Prozesse, getrennte persistente Zustände</h2>
    <p>
      Die folgenden Beispiele zeigen den Entwicklungsstarter. Dieser Bildschirm
      führt keine Shell-Befehle aus und startet keine Services.
    </p>
    <div class="concept-form-columns">
      <div>
        <label for="opsEnvironment">Beispielumgebung</label
        ><USelect
          id="opsEnvironment"
          v-model="environment"
          :items="[
            { value: 'docker', label: 'Docker' },
            { value: 'native', label: 'Native · Node 24' },
          ]"
        />
      </div>
      <div>
        <label for="opsWorkers">Demo-Worker-Anzahl</label
        ><UInput
          id="opsWorkers"
          v-model="count"
          type="number"
          min="1"
          max="32"
        />
      </div>
    </div>
    <pre tabindex="0" aria-label="Beispielkommandos">{{ commands }}</pre>
    <section class="concept-section">
      <h2>Speicher und Wiederherstellung</h2>
      <p>
        Factory besitzt den Linienkatalog; Orchestrator besitzt Tasks und
        Leases; Worker besitzt seine Identität und lokalen Journals. Kein
        Prozess teilt eine beschreibbare SQLite-Datei mit einem anderen. Stoppe
        jeden Writer vor einem Dateisystem-Backup.
      </p>
      <p>
        Verfügbarkeit, Heartbeat und Lease sind unterschiedliche Signale. Späte
        Ergebnisse eines alten Versuchs werden abgewiesen. Ungewisse
        in-flight-Aufrufe verlangen eine ausdrückliche Fortsetzung.
      </p>
    </section>
    <section class="concept-section">
      <h2>Demo-Workerstatus</h2>
      <div class="concept-table" tabindex="0">
        <table>
          <thead>
            <tr>
              <th>Worker</th>
              <th>Linie</th>
              <th>Status</th>
              <th>Slots</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="worker in state.workers.filter(
                (item) => item.lineId === state.selectedLineId,
              )"
              :key="worker.id"
            >
              <td>{{ worker.id }}</td>
              <td>{{ worker.lineId }}</td>
              <td>{{ engine.workerStatus(worker) }}</td>
              <td>
                {{ engine.workerTasks(worker).length }} /
                {{ worker.maxParallel ?? 1 }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Beispieldaten, keine Prozessmessungen oder Credentials.</p>
    </section>
  </section>
  <ConceptSystem v-else />
</template>
