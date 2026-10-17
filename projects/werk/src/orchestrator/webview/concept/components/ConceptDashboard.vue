<script setup lang="ts">
import { computed, ref } from "vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import { labels, states } from "../engine.mjs";
import { useConcept } from "../context";
const { state, engine, openTask } = useConcept();
const tasks = computed(() =>
  state.value.tasks.filter(
    (task) => task.lineId === state.value.selectedLineId,
  ),
);
const series = computed(() => {
  // Track the reactive snapshot before reading the engine projection.
  void state.value;
  return engine.snapshotSeries();
});
const events = computed(() =>
  state.value.events.filter(
    (event) => !event.lineId || event.lineId === state.value.selectedLineId,
  ),
);

const pairStatus = computed(() => {
  const attempts = new Map<
    string,
    {
      task: (typeof tasks.value)[number];
      attempt: number;
      before: boolean;
      after: boolean;
    }
  >();
  for (const task of tasks.value)
    for (const snapshot of task.snapshots ?? []) {
      const key = task.id + ":" + snapshot.attempt,
        item = attempts.get(key) ?? {
          task,
          attempt: snapshot.attempt,
          before: false,
          after: false,
        };
      if (snapshot.phase === "before") item.before = true;
      else item.after = true;
      attempts.set(key, item);
    }
  const complete = [...attempts.values()].filter(
    (item) => item.before && item.after,
  ).length;
  const pending = [...attempts.values()].filter(
    (item) =>
      item.before &&
      !item.after &&
      item.attempt === item.task.attempt &&
      ["running", "checks"].includes(item.task.status),
  ).length;
  return { complete, pending, incomplete: attempts.size - complete - pending };
});
const metric = ref("duration");
const metricItems = [
  { value: "duration", label: "Ausführungsdauer · Simulationstakte" },
  { value: "tokens", label: "Provider-Tokens" },
  { value: "cost", label: "Gemeldete Kosten · USD" },
  { value: "rss", label: "Worker-RSS · Bytes" },
  { value: "quality", label: "Coverage · Prozent" },
];
const measured = computed(() =>
  series.value
    .map((row) => {
      const value =
        metric.value === "duration"
          ? row.after.execution.elapsedTicks
          : metric.value === "cost"
            ? row.after.usage.providerReportedCostUsd
            : metric.value === "rss"
              ? row.after.resources.rssBytes
              : metric.value === "quality"
                ? row.after.quality.coveragePercent
                : row.after.usage.inputTokens !== null &&
                    row.after.usage.outputTokens !== null
                  ? row.after.usage.inputTokens + row.after.usage.outputTokens
                  : null;
      return { row, value };
    })
    .filter(
      (item): item is typeof item & { value: number } =>
        item.value !== null && Number.isFinite(item.value),
    ),
);
const chart = computed(() => {
  const maximumTick = Math.max(
    1,
    ...measured.value.map((item) => item.row.after.tick),
  );
  const maximumValue = Math.max(1, ...measured.value.map((item) => item.value));
  return {
    maximumTick,
    maximumValue,
    points: measured.value.map((item) => ({
      ...item,
      x: 40 + (item.row.after.tick / maximumTick) * 640,
      y: 200 - (item.value / maximumValue) * 160,
    })),
  };
});
const chartPath = computed(() =>
  chart.value.points.map((point) => point.x + "," + point.y).join(" "),
);
</script>
<template>
  <section aria-label="Simuliertes Dashboard">
    <div class="concept-section">
      <h2>Lieferstand dieser Linie</h2>
      <div
        class="concept-table"
        tabindex="0"
        role="region"
        aria-label="Lieferstand"
      >
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Features</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="status in states" :key="status">
              <td>{{ labels[status] }}</td>
              <td>
                {{ tasks.filter((task) => task.status === status).length }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <section class="concept-section">
      <h2>Zeitreihen · gepaarte Snapshot-Versuche</h2>
      <p>
        Takte sind Simulationsschritte, keine gemessenen Minuten. Kosten,
        Tokens, Prozess-Ressourcen und Coverage sind unbekannt. Fehlende Werte
        werden nicht als Null behandelt.
      </p>
      <p role="status">
        {{ pairStatus.complete }} vollständige Paare ·
        {{ pairStatus.pending }} aktive Vorher-Snapshots ·
        {{ pairStatus.incomplete }} unvollständige Versuche
      </p>
      <div class="concept-inline">
        <label for="snapshotMetric">Messgröße</label
        ><USelect id="snapshotMetric" v-model="metric" :items="metricItems" />
      </div>
      <svg
        v-if="measured.length"
        class="concept-snapshot-chart"
        viewBox="0 0 720 240"
        role="img"
        :aria-label="
          metricItems.find((item) => item.value === metric)?.label +
          ' über Simulationsschritte'
        "
      >
        <title>Gepaarte Nachher-Snapshots dieser Linie</title>
        <desc>
          Nur tatsächlich in den Demo-Snapshots bekannte Werte. Takte sind keine
          Laufzeitmessung.
        </desc>
        <path d="M40 30V200H690" fill="none" stroke="currentColor" />
        <polyline
          :points="chartPath"
          fill="none"
          stroke="#8be0b8"
          stroke-width="2"
        />
        <circle
          v-for="point in chart.points"
          :key="point.row.after.id"
          :cx="point.x"
          :cy="point.y"
          r="4"
          fill="#8be0b8"
        >
          <title>
            FT-{{ point.row.task.id }} Versuch {{ point.row.after.attempt }} ·
            Takt {{ point.row.after.tick }} · {{ point.value }}
          </title>
        </circle>
        <text x="8" y="40" fill="currentColor">{{ chart.maximumValue }}</text>
        <text x="40" y="225" fill="currentColor">Takt 0</text>
        <text x="625" y="225" fill="currentColor">
          Takt {{ chart.maximumTick }}
        </text>
      </svg>
      <p v-else class="concept-empty" role="status">
        Für diese Messgröße sind noch keine Werte vorhanden. Unbekannte
        Messungen werden nicht als Null gezeichnet.
      </p>
      <div
        class="concept-table"
        tabindex="0"
        role="region"
        aria-label="Snapshot-Paare"
      >
        <table>
          <thead>
            <tr>
              <th>Feature / Versuch</th>
              <th>Vorher</th>
              <th>Nachher</th>
              <th>Simulationsdauer</th>
              <th>Ergebnis</th>
              <th>Tokens / Kosten</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in series" :key="row.after.id">
              <td>
                <UButton variant="link" @click="openTask(row.task.id)"
                  >FT-{{ row.task.id }} / {{ row.after.attempt }}</UButton
                >
              </td>
              <td>
                {{ row.before ? "Takt " + row.before.tick : "Nicht erfasst" }}
              </td>
              <td>Takt {{ row.after.tick }}</td>
              <td>
                {{
                  row.after.execution.elapsedTicks === null
                    ? "Unbekannt"
                    : row.after.execution.elapsedTicks + " Takte"
                }}
              </td>
              <td>{{ row.after.execution.outcome }}</td>
              <td>Unbekannt</td>
            </tr>
            <tr v-if="!series.length">
              <td colspan="6">
                Noch keine beendeten Versuche. Starte einen Simulationstakt.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <details>
        <summary>Messperspektiven und Grenzen</summary>
        <div class="concept-table" tabindex="0">
          <table>
            <thead>
              <tr>
                <th>Perspektive</th>
                <th>Zielmessgrößen</th>
                <th>Verfügbar</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Kosten</td>
                <td>
                  Tokens, Cache, gemeldete/geschätzte Kosten,
                  Subscription-Zuordnung
                </td>
                <td>Keine Anbieter-Telemetrie</td>
              </tr>
              <tr>
                <td>Performance</td>
                <td>Warte-, Ausführungs-, Reviewzeit, P50/P95, Durchsatz</td>
                <td>Simulationstakte</td>
              </tr>
              <tr>
                <td>Systemzustand</td>
                <td>CPU/RSS, Heartbeat, Event Loop, Lease-Verlust, Slots</td>
                <td>Nur Demo-Workerstatus</td>
              </tr>
              <tr>
                <td>Qualität</td>
                <td>Build, Tests, Coverage, Lint, Security, Nacharbeit</td>
                <td>Checks simuliert</td>
              </tr>
              <tr>
                <td>Nachvollziehbarkeit</td>
                <td>Versuch, Worker, Provider, Konfiguration, Git-Stand</td>
                <td>Versionierte Demo-Snapshots</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
    <section class="concept-section">
      <h2>Letzte Ereignisse</h2>
      <p v-if="!events.length">Noch keine Ereignisse dieser Linie.</p>
      <ol class="concept-history">
        <li v-for="(event, index) in events" :key="index">
          <small>Takt {{ event.tick }} · {{ event.time }}</small>
          <p>{{ event.text }}</p>
        </li>
      </ol>
    </section>
  </section>
</template>
