<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import UButton from "@nuxt/ui/components/Button.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import SpatialMap from "../../../shared/webview/components/SpatialMap.vue";
import type { SpatialNode, SpatialEdge } from "../../../shared/webview/types";
import type { OrchestratorStore } from "../store";
const { store } = defineProps<{ store: OrchestratorStore }>();
const s = store.state,
  router = useRouter();
const counts = computed(() => [
  ["Wartend", s.overview?.tasks?.queued],
  ["Reserviert / aktiv", s.overview?.tasks?.running],
  ["Review", s.overview?.tasks?.review],
  ["Klärung", s.overview?.tasks?.blocked],
  ["Freie Slots", s.overview?.workers?.slotsAvailable],
]);
const nodes = computed<SpatialNode[]>(() => {
  const d = s.overview;
  if (!d) return [];
  return [
    {
      id: "intake",
      model: "intake",
      label: "Intake",
      kind: "Arbeit übergeben",
      x: 0,
      z: 0,
      reading: s.intake.project,
      description:
        "Vault-Verweis oder manuelles Feature übergeben. Simulation ist der Standard.",
      actions: [
        {
          label: "Auftrag vorbereiten",
          disabled: !s.canWrite,
          reason: "Nur Lesezugriff",
          run: () => {
            void router.push("/intake");
          },
        },
      ],
    },
    {
      id: "queue",
      model: "queue",
      label: "Warteschlange",
      kind: "Gespeicherte Aufträge",
      x: 1,
      z: 0,
      reading: String(d.tasks?.queued ?? "Unbekannt"),
      description:
        "Aufträge warten auf ein passendes Projekt, Profil und freie Kapazität.",
      actions: [
        {
          label: "Wartende Aufträge",
          run: () => {
            s.taskStatus = "queued";
            void router.push("/tasks");
          },
        },
      ],
    },
    {
      id: "line",
      model: "orchestrator",
      label: "Produktionslinie",
      kind: "Koordination",
      x: 2,
      z: 0,
      reading: d.project || s.intake.project,
      description:
        "Diese Linie speichert Aufträge, reserviert Arbeit und sammelt Evidenz. Laufende Reservierungen bleiben bei Routing-Änderungen erhalten.",
    },
    {
      id: "workers",
      model: "worker",
      label: "Worker",
      kind: "Ausführungskapazität",
      x: 3,
      z: 0,
      reading: `${d.workers?.online ?? "Unbekannt"} online`,
      facts: [["Freie Slots", d.workers?.slotsAvailable ?? "Unbekannt"]],
      actions: [
        {
          label: "Worker untersuchen",
          run: () => {
            void router.push("/workers");
          },
        },
      ],
    },
    {
      id: "results",
      model: "review",
      label: "Ergebnisse",
      kind: "Menschliches Review",
      x: 4,
      z: 0,
      reading: `${d.tasks?.review ?? "Unbekannt"} im Review`,
      description:
        "Simulation ist keine Umsetzung. Echte Änderungssätze brauchen Review; kein automatischer Merge.",
      facts: [
        ["Simuliert", d.tasks?.simulated ?? "Unbekannt"],
        ["Klärung", d.tasks?.blocked ?? "Unbekannt"],
      ],
      actions: [
        {
          label: "Ergebnisse prüfen",
          run: () => {
            s.taskStatus = "";
            void router.push("/tasks");
          },
        },
      ],
    },
    {
      id: "evidence",
      model: "snapshot",
      label: "Evidenz",
      kind: "Vorher / Nachher",
      x: 3,
      z: 1,
      description:
        "Snapshots dokumentieren Prozesszustand. Fehlende Verbrauchs- und Qualitätsmessungen bleiben unbekannt.",
      actions: [
        {
          label: "Messwerte öffnen",
          run: () => {
            void router.push("/metrics");
          },
        },
      ],
    },
  ];
});
const edges: SpatialEdge[] = [
  { from: "intake", to: "queue" },
  { from: "queue", to: "line" },
  { from: "line", to: "workers" },
  { from: "workers", to: "results" },
  { from: "workers", to: "evidence" },
];
function routingToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open) void store.loadRouting();
}
</script>
<template>
  <section id="system" class="page-section" :aria-busy="s.busy">
    <UAlert
      v-if="s.stale"
      color="warning"
      title="Veralteter letzter Stand"
      description="Die letzte erfolgreiche Beobachtung bleibt sichtbar. Linienzustand erneut laden."
    />
    <ol class="flow-counts" aria-label="Prozessübersicht">
      <li v-for="[label, value] in counts" :key="String(label)">
        <strong>{{ value ?? "—" }}</strong
        ><span>{{ label }}</span>
      </li>
    </ol>
    <SpatialMap
      :nodes="nodes"
      :edges="edges"
      :english="false"
      label="Linienkarte: 3D oder 2D"
      :caption="
        s.overview
          ? 'Beobachteter Zustand dieser Produktionslinie'
          : 'Noch kein Linienzustand geladen'
      "
      :legend="
        s.stale
          ? 'Veralteter letzter Stand. Neu laden, um Veränderungen zu prüfen.'
          : 'Station wählen, um Fakten und nächste Schritte zu sehen.'
      "
    /><UButton
      color="neutral"
      variant="outline"
      :loading="s.busy"
      @click="store.refresh()"
      >Linienzustand aktualisieren</UButton
    >
    <details id="line-routing" @toggle="routingToggle">
      <summary>Auftragsrouting konfigurieren</summary>
      <form class="form-stack" @submit.prevent="store.saveRouting()">
        <fieldset
          :disabled="s.routing.busy || !s.canWrite || !s.routing.loaded"
        >
          <label for="routing-mode">Routing-Methode</label
          ><select id="routing-mode" v-model="s.routing.mode">
            <option value="auto">
              Automatisch · Fähigkeiten und Kapazität
            </option>
            <option value="manual">
              Manuell · ausgewählter Worker
            </option></select
          ><label for="routing-worker">Manueller Ziel-Worker</label
          ><select
            id="routing-worker"
            v-model="s.routing.workerId"
            :disabled="
              s.routing.mode === 'auto' || s.routing.busy || !s.canWrite
            "
          >
            <option value="">Kein Ziel · wartet auf manuelle Auswahl</option>
            <option
              v-if="
                s.routing.workerId &&
                !s.routing.workers.some((w) => w.id === s.routing.workerId)
              "
              :value="s.routing.workerId"
            >
              {{ s.routing.workerId }} · nicht auf der geladenen Seite
            </option>
            <option
              v-for="worker in s.routing.workers"
              :key="worker.id"
              :value="worker.id"
            >
              {{ worker.id }} · {{ worker.online ? "online" : "offline" }}
            </option>
          </select>
          <p class="muted">
            Auswahl aus den ersten 50 registrierten Workern. Ein gespeichertes
            Ziel außerhalb dieser Seite bleibt erhalten.
          </p>
          <label for="routing-order">Reihenfolge</label
          ><select id="routing-order" v-model="s.routing.order">
            <option value="worker">Reihenfolge des Workers</option>
            <option value="priority">Hohe Priorität zuerst</option>
            <option value="fifo">Ältester Auftrag zuerst</option>
          </select>
          <p>
            Ohne passenden Worker wartet der Auftrag. Bereits vergebene Arbeit
            wird nicht verschoben.
          </p>
          <UButton type="submit" :loading="s.routing.busy"
            >Routing speichern</UButton
          >
        </fieldset>
        <p role="status">
          {{ s.routing.busy ? "Routing wird verarbeitet…" : s.routing.message }}
        </p>
        <UButton
          v-if="!s.routing.loaded && !s.routing.busy"
          color="neutral"
          @click="store.loadRouting()"
          >Erneut laden</UButton
        >
      </form>
    </details>
  </section>
</template>
