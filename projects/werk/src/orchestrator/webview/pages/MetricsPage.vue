<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { deriveMetrics } from "../metrics";
import { date, type OrchestratorStore, type RecordData } from "../store";
const { store } = defineProps<{ store: OrchestratorStore }>();
const s = store.state;
const metrics = computed(() => deriveMetrics(s.metrics, s.metricFilters));
const options = computed(() => ({
  projects: [...new Set(s.metrics.map((r) => r.snapshot.project))].sort(),
  workers: [...new Set(s.metrics.map((r) => r.snapshot.workerId))].sort(),
  iterations: [
    ...new Set(
      s.metrics.map((r) => r.snapshot.provenance?.iterationId || "manual"),
    ),
  ].sort(),
}));
watch(
  metrics,
  (value) => {
    if (
      s.selectedSnapshot &&
      !value.records.some(
        (r) => r.snapshot.id === s.selectedSnapshot?.snapshot.id,
      )
    )
      s.selectedSnapshot = null;
  },
  { immediate: true },
);
async function select(row: RecordData) {
  s.selectedSnapshot = row;
  await nextTick();
  document.querySelector<HTMLElement>("#snapshot-heading")?.focus();
}
async function close() {
  s.selectedSnapshot = null;
  await nextTick();
  document.querySelector<HTMLElement>("#metric-summary")?.focus();
}
const bytes = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v)
    ? (v / 1048576).toFixed(1) + " MiB"
    : "Nicht erfasst";
</script>
<template>
  <section id="metrics" class="page-section" :aria-busy="s.busy">
    <div class="actions">
      <UButton color="neutral" :loading="s.busy" @click="store.refresh()"
        >Messwerte aktualisieren</UButton
      >
    </div>
    <div v-if="s.metricFilters.taskId" class="filter-notice">
      <p>Auftrag: {{ s.metricFilters.taskId }}</p>
      <UButton
        color="neutral"
        variant="outline"
        :to="{ path: '/tasks', query: { task: s.metricFilters.taskId } }"
        >Zurück zum Auftrag</UButton
      ><UButton
        color="neutral"
        variant="ghost"
        @click="s.metricFilters.taskId = ''"
        >Auftragsfilter entfernen</UButton
      >
    </div>
    <details>
      <summary>Messwerte filtern</summary>
      <div class="filters">
        <div>
          <label for="metric-project">Projekt</label
          ><select id="metric-project" v-model="s.metricFilters.project">
            <option value="">Alle Projekte</option>
            <option v-for="value in options.projects" :key="value">
              {{ value }}
            </option>
          </select>
        </div>
        <div>
          <label for="metric-worker">Worker</label
          ><select id="metric-worker" v-model="s.metricFilters.worker">
            <option value="">Alle Worker</option>
            <option v-for="value in options.workers" :key="value">
              {{ value }}
            </option>
          </select>
        </div>
        <div>
          <label for="metric-iteration">Iteration</label
          ><select id="metric-iteration" v-model="s.metricFilters.iteration">
            <option value="">Alle Iterationen</option>
            <option v-for="value in options.iterations" :key="value">
              {{ value }}
            </option>
          </select>
        </div>
        <div>
          <label for="metric-window">Zeitraum</label
          ><select id="metric-window" v-model="s.metricFilters.window">
            <option value="">Alle geladenen</option>
            <option value="3600000">Letzte Stunde</option>
            <option value="86400000">Letzte 24 Stunden</option>
            <option value="604800000">Letzte 7 Tage</option>
          </select>
        </div>
        <div>
          <label for="metric-outcome">Ergebnis</label
          ><select id="metric-outcome" v-model="s.metricFilters.outcome">
            <option value="">Alle Ergebnisse</option>
            <option value="simulated">Simuliert</option>
            <option value="review">Review</option>
            <option value="failed">Fehler</option>
            <option value="interrupted">Abgebrochen</option>
          </select>
        </div>
      </div>
    </details>
    <p id="metric-summary" tabindex="-1" role="status">
      {{ metrics.records.length }} Snapshots · {{ metrics.complete }}/{{
        metrics.pairs
      }}
      Paare im Messfenster vollständig · {{ metrics.failed }} Fehler/Abbrüche.
      {{
        s.metricsTruncated
          ? "Begrenzte Auswahl: neueste 10.000 Snapshots; ältere Messungen fehlen."
          : "Alle geladenen Snapshots berücksichtigt."
      }}
      Unvollständige Paare können laufende Versuche oder Filtergrenzen
      darstellen.
    </p>
    <h2>Versuchsdauer</h2>
    <div class="chart-wrap">
      <svg
        viewBox="0 0 900 225"
        role="img"
        :aria-label="`${metrics.measured} gemessene Versuche; Dauer bis ${Math.round(metrics.top)} Millisekunden. Vollständige Messwerte im Snapshot-Detail.`"
      >
        <template v-if="metrics.points.length">
          <g v-for="fraction in [0, 0.5, 1]" :key="fraction">
            <line
              x1="85"
              :y1="175 - fraction * 140"
              x2="875"
              :y2="175 - fraction * 140"
              stroke="currentColor"
              opacity=".2"
            />
            <text x="8" :y="180 - fraction * 140">
              {{ Math.round(fraction * metrics.top) }} ms
            </text>
          </g>
          <circle
            v-for="point in metrics.points"
            :key="point.row.snapshot.id"
            :cx="point.x"
            :cy="point.y"
            r="4"
            :fill="
              point.row.snapshot.execution.outcome === 'simulated'
                ? '#8be0b8'
                : '#edc47e'
            "
          >
            <title>
              {{ point.row.snapshot.workerId }} ·
              {{ point.row.snapshot.execution.durationMs }} ms ·
              {{ date(point.row.receivedAt) }}
            </title>
          </circle>
          <text x="85" y="207">{{ date(metrics.min) }}</text>
          <text x="875" y="207" text-anchor="end">{{ date(metrics.max) }}</text>
        </template>
        <text v-else x="30" y="110">
          Keine gemessene Versuchsdauer in dieser Auswahl.
        </text>
      </svg>
    </div>
    <p v-if="metrics.points.length < metrics.measured">
      Ausgedünnte Ansicht · Kennzahlen nutzen alle
      {{ metrics.measured }} gemessenen Versuche.
    </p>
    <div class="table-scroll" tabindex="0">
      <table>
        <thead>
          <tr>
            <th>Projekt</th>
            <th>Versuche</th>
            <th>Fehler / Abbruch</th>
            <th>P50 / P95 Dauer</th>
            <th>Kostenmessung</th>
            <th>Qualitätschecks</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in metrics.portfolio" :key="row.project">
            <td>{{ row.project }}</td>
            <td>{{ row.count }}</td>
            <td>{{ row.failed }}</td>
            <td>
              {{ row.p50 === null ? "—" : row.p50 + " ms" }} /
              {{ row.p95 === null ? "—" : row.p95 + " ms" }} (n={{
                row.measured
              }})
            </td>
            <td>
              {{ row.cli ? "Nicht erfasst" : "Unbekannt · Mock-Ausführung" }}
            </td>
            <td>{{ row.cli ? "Nicht verifiziert" : "Nicht ausgeführt" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!metrics.after.length">
      Noch keine abgeschlossenen Versuche in dieser Auswahl.
    </p>
    <h2>Messwerte untersuchen</h2>
    <p>
      CPU und Speicher beziehen sich auf den Worker-Prozess. Parallele Werte
      dürfen nicht als Task-Verbrauch addiert werden. Anbieter-Verbrauch ist in
      diesen Orchestrator-Snapshots nicht erfasst.
    </p>
    <p>
      Neueste {{ Math.min(metrics.records.length, 40) }} von
      {{ metrics.records.length }} Snapshots dieser Auswahl · maximal 40 Zeilen.
      Kennzahlen berücksichtigen alle geladenen Snapshots der Auswahl.
    </p>
    <div class="table-scroll" tabindex="0">
      <table aria-label="Neueste maximal 40 Snapshots">
        <thead>
          <tr>
            <th>Snapshot</th>
            <th>Worker / Profil</th>
            <th>Ergebnis</th>
            <th>RSS</th>
            <th>Event Loop P95</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in metrics.records.slice(-40).reverse()"
            :key="row.snapshot.id"
          >
            <td>
              <UButton variant="link" @click="select(row)"
                >{{ row.snapshot.phase === "before" ? "Vorher" : "Nachher" }} ·
                {{ row.snapshot.taskId.slice(0, 8) }} /
                {{ row.snapshot.attempt }}</UButton
              >
            </td>
            <td>{{ row.snapshot.workerId }} / {{ row.snapshot.profileId }}</td>
            <td>
              {{ row.snapshot.mode === "cli" ? "CLI" : "Simulation" }} ·
              {{ row.snapshot.execution.outcome }}
            </td>
            <td>{{ bytes(row.snapshot.resources?.rssBytes) }}</td>
            <td>
              {{
                Number.isFinite(row.snapshot.health?.eventLoopDelayP95Ms)
                  ? row.snapshot.health.eventLoopDelayP95Ms.toFixed(1) + " ms"
                  : "Nicht erfasst"
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!metrics.records.length">
      Keine Messungen für diese Auswahl. Filter erweitern oder einen Auftrag mit
      passendem Worker ausführen.
    </p>
    <section v-if="s.selectedSnapshot" class="detail">
      <div class="section-heading">
        <h2 id="snapshot-heading" tabindex="-1">
          Snapshot {{ s.selectedSnapshot.snapshot.id }}
        </h2>
        <UButton color="neutral" variant="outline" @click="close"
          >Schließen</UButton
        >
      </div>
      <dl class="facts">
        <div
          v-for="(value, label) in {
            Auftrag: s.selectedSnapshot.snapshot.taskId,
            Phase: s.selectedSnapshot.snapshot.phase,
            Ergebnis: s.selectedSnapshot.snapshot.execution.outcome,
            Ausführung: s.selectedSnapshot.snapshot.mode,
            Worker: s.selectedSnapshot.snapshot.workerId,
            Profil: s.selectedSnapshot.snapshot.profileId,
            'SHA-256': s.selectedSnapshot.sha256,
          }"
          :key="label"
        >
          <dt>{{ label }}</dt>
          <dd>{{ value }}</dd>
        </div>
      </dl>
      <details open>
        <summary>Vollständiger Snapshot (JSON)</summary>
        <pre tabindex="0">{{
          JSON.stringify(s.selectedSnapshot, null, 2)
        }}</pre>
      </details>
    </section>
  </section>
</template>
