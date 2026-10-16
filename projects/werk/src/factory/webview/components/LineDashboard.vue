<script setup lang="ts">
import { computed, ref } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import SpatialMap from "../../../shared/webview/components/SpatialMap.vue";
import LineInteractionPanel from "../../../shared/webview/components/LineInteractionPanel.vue";
import type { InteractionTask, LineSubmissionReceipt } from '../../../shared/webview/line-interaction';
import { count, time, handoff, type FactoryStore } from "../store";
import type { SpatialNode } from "../../../shared/webview/types";
const props = defineProps<{ store: FactoryStore }>(),
  emit = defineEmits<{ tour: [] }>(),
  s = props.store.state,
  interaction = ref(false);
const line = computed(() => props.store.activeLine.value),
  observed = computed(() => props.store.activeObservation.value),
  value = computed(() => observed.value?.overview),
  stale = computed(
    () =>
      s.stale ||
      !value.value ||
      Date.now() - Date.parse(value.value.observedAt) > 45000,
  );
const nodes = computed<SpatialNode[]>(() =>
  [
    {
      id: "intake",
      model: "task",
      label: "Intake",
      kind: "Anforderungen",
      reading: value.value?.project || "Projekt unbekannt",
      x: 0,
      z: 0,
      description:
        "Neue Arbeit wird in die Warteschlange dieser Linie übergeben.",
      actions: [
        { label: "Interaktion öffnen", run: () => (interaction.value = true) },
      ],
    },
    {
      id: "queue",
      model: "queue",
      label: "Warteschlange",
      kind: "Gespeicherte Arbeit",
      reading: count(value.value?.tasks.queued) + " wartet",
      x: 1,
      z: 0,
      description:
        "Der Orchestrator vergibt Arbeit gemäß seiner konfigurierten Routing-Methode.",
    },
    {
      id: "orchestrator",
      model: "orchestrator",
      label: "Orchestrator",
      kind: "Auftragsrouter",
      reading: count(value.value?.tasks.running) + " reserviert / aktiv",
      x: 2,
      z: 0,
      description:
        "Fähigkeiten, Projekt und verfügbare Kapazität begrenzen jede Vergabe.",
    },
    {
      id: "workers",
      model: "workers",
      label: "Worker",
      kind: "Ausführung",
      reading: value.value
        ? count(value.value.workers.online) +
          " / " +
          count(value.value.workers.total) +
          " online"
        : "Unbekannt",
      x: 3,
      z: 0,
      description: "Unabhängige Worker führen angenommene Aufgaben aus.",
    },
    {
      id: "review",
      model: "evidence",
      label: "Review & Evidenz",
      kind: "Ergebnisse",
      reading: value.value
        ? count(value.value.tasks.review ?? 0) +
          " Review · " +
          count(value.value.tasks.simulated) +
          " simuliert"
        : "Unbekannt",
      x: 3,
      z: 1.5,
      description:
        "Simulierte Ergebnisse und Änderungssätze bleiben getrennt. Menschen entscheiden über Freigabe.",
    },
  ].map((n) => ({
    ...n,
    color: stale.value ? "#edc47e" : "#8be0b8",
    facts: [
      [
        "Datenstand",
        stale.value ? "Unbekannt / veraltet" : time(value.value?.observedAt),
      ],
    ] as [string, unknown][],
  })),
);
async function submitInteraction(task: InteractionTask, key: string): Promise<LineSubmissionReceipt> {
  const target = line.value;
  if (!target) throw new Error('Select a production line before submitting.');
  const result = await props.store.api<{ id: string; status: string }>('/v1/intake', { method: 'POST', body: { factoryId: target.factoryId, lineId: target.id, task }, key });
  return { kind: 'factory', id: result.id, status: result.status === 'delivered' ? 'delivered' : 'pending' };
}
</script>
<template>
  <section class="line-dashboard" aria-labelledby="line-dashboard-title">
    <h1 id="line-dashboard-title" tabindex="-1">
      {{
        line ? line.name + " · Dashboard" : "Produktionslinie nicht verfügbar"
      }}
    </h1>
    <p>
      {{
        line
          ? store.factoryPath(line.factoryId) +
            " · " +
            (stale
              ? "Daten nicht verfügbar oder veraltet"
              : "Stand " + time(value?.observedAt))
          : "Die Linie ist nicht in diesem Factory-Bereich registriert. Wähle ein anderes Dashboard."
      }}
    </p>
    <template v-if="line">
      <p v-if="observed?.error" class="error-text">{{ observed.error }}</p>
      <div class="actions operation-actions">
        <UButton @click="interaction = true">Interaktion öffnen</UButton
        ><UButton color="neutral" variant="outline" @click="emit('tour')"
          >Linien-Tour</UButton
        ><UButton
          v-if="handoff(line.webviewUrl, 'system')"
          :href="handoff(line.webviewUrl, 'system')"
          target="_blank"
          rel="noopener noreferrer"
          color="neutral"
          variant="outline"
          >Orchestrator öffnen</UButton
        >
      </div>
      <dl class="overview-facts dashboard-flow">
        <div
          v-for="[name, number] in [
            ['Wartend', value?.tasks.queued],
            ['Reserviert / aktiv', value?.tasks.running],
            ['Review', value ? (value.tasks.review ?? 0) : undefined],
            ['Klärung', value?.tasks.blocked],
            ['Freie Slots', value?.workers.slotsAvailable],
          ]"
          :key="String(name)"
        >
          <dt>{{ name }}</dt>
          <dd>{{ count(number) }}</dd>
        </div>
      </dl>
      <SpatialMap
        :nodes="nodes"
        :edges="[
          { from: 'intake', to: 'queue' },
          { from: 'queue', to: 'orchestrator' },
          { from: 'orchestrator', to: 'workers' },
          { from: 'workers', to: 'review' },
        ]"
        :caption="
          line.name + ' · ' + (stale ? 'Stand prüfen' : time(value?.observedAt))
        "
        legend="Auftrag → Warteschlange → Vergabe → Ausführung → Review. Reservierte Arbeit kann noch im Worker warten."
        label="Produktionslinie: 3D oder 2D"
        :english="false"
      />
      <LineInteractionPanel
        v-model:open="interaction"
        :title="'Interaktion · ' + line.name"
        :project="value?.project || ''"
        :can-write="s.canWrite"
        :request="
          (body) =>
            store.api(
              '/v1/lines/' + encodeURIComponent(line!.id) + '/interaction',
              { method: 'POST', body },
            )
        "
        :submit="submitInteraction"
      />
    </template>
  </section>
</template>
