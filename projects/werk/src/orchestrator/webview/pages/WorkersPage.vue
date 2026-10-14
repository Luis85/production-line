<script setup lang="ts">
import { computed, nextTick } from "vue";
import { useRouter } from "vue-router";
import UButton from "@nuxt/ui/components/Button.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import SpatialMap from "../../../shared/webview/components/SpatialMap.vue";
import type { SpatialNode, SpatialEdge } from "../../../shared/webview/types";
import Pagination from "../components/Pagination.vue";
import { date, type OrchestratorStore } from "../store";
const { store } = defineProps<{ store: OrchestratorStore }>();
const s = store.state,
  router = useRouter();
async function open(id: string) {
  const pending = store.showWorker(id);
  await nextTick();
  document.querySelector<HTMLElement>("#worker-detail-heading")?.focus();
  await pending;
}
async function close() {
  const id = s.workerId;
  store.closeWorker();
  await nextTick();
  [...document.querySelectorAll<HTMLElement>("[data-worker-id]")]
    .find((el) => el.dataset.workerId === id)
    ?.focus();
}
async function page(direction: "next" | "previous") {
  if (await store.movePage("workers", direction)) {
    await nextTick();
    document.querySelector<HTMLElement>("[data-page-state]")?.focus();
  }
}
const graph = computed(() => {
  const worker = s.workerDetail;
  if (!worker)
    return { nodes: [] as SpatialNode[], edges: [] as SpatialEdge[] };
  const nodes: SpatialNode[] = [
    {
      id: worker.id,
      label: "Worker",
      model: "worker",
      kind: worker.project,
      reading: worker.online ? "Online" : "Offline",
      x: 0,
      z: 0,
      description:
        "Maschinenslots begrenzen alle Profile gemeinsam. Diese Konfiguration ist lesend.",
      facts: [
        ["Identität", worker.id],
        ["Slots", worker.config.maxParallel],
        ["Reihenfolge", worker.config.order],
        ["Maximale Versuche", worker.config.maxAttempts],
      ],
      actions: [
        {
          label: "Konfiguration verstehen",
          href: "/guide#deployment",
          newTab: true,
        },
      ],
    },
  ];
  const edges: SpatialEdge[] = [];
  worker.profiles.forEach((p: any, i: number) => {
    nodes.push({
      id: "profile:" + p.id,
      label: p.id,
      model: "profile",
      kind: "Ausführungsprofil",
      reading: p.provider + " · " + p.mode,
      x: 1,
      z: i,
      facts: [
        ["Profilslots", p.maxParallel],
        ["Modus", p.mode === "cli" ? "Echte lokale Änderungen" : "Simulation"],
      ],
    });
    edges.push({ from: worker.id, to: "profile:" + p.id });
  });
  worker.activeTasks.forEach((t: any, i: number) => {
    nodes.push({
      id: t.id,
      label: "Auftrag " + t.id.slice(0, 8),
      model: "task",
      kind: "Aktive Reservierung",
      reading: "Versuch " + t.attempt,
      x: 2,
      z: i,
      facts: [
        ["Auftrags-ID", t.id],
        ["Profil", t.profile],
        [
          "Reservierung bis",
          t.expiresAt === null ? "Unbekannt" : date(t.expiresAt),
        ],
      ],
      actions: [
        {
          label: "Auftragsereignisse öffnen",
          run: () => {
            void router.push({ path: "/tasks", query: { task: t.id } });
          },
        },
      ],
    });
    edges.push({
      from: nodes.some((n) => n.id === "profile:" + t.profile)
        ? "profile:" + t.profile
        : worker.id,
      to: t.id,
    });
  });
  return { nodes, edges };
});
</script>
<template>
  <section id="workers" class="page-section">
    <template v-if="!s.workerId"
      ><Pagination
        :page="s.workerPage"
        :busy="s.busy"
        label="Worker"
        @move="page"
        @refresh="store.refresh({ reset: true })" /><UAlert
        v-if="!s.workers.length && !s.busy"
        color="neutral"
        title="Noch keine Worker auf dieser Seite"
        description="Starte einen Worker mit passender Projektkonfiguration. Prüfe dann die Linie erneut." />
      <div class="worker-grid">
        <article
          v-for="worker in s.workers"
          :key="worker.id"
          class="worker-card"
        >
          <h2>{{ worker.id }}</h2>
          <p>
            <span class="status-dot" :class="{ online: worker.online }"></span
            >{{ worker.online ? "Online" : "Offline" }} · {{ worker.project }}
          </p>
          <p>Maschine: {{ worker.config?.maxParallel ?? "Unbekannt" }} Slots</p>
          <ul>
            <li v-for="profile in worker.profiles" :key="profile.id">
              {{ profile.id }} · {{ profile.provider }} ·
              {{ profile.mode === "cli" ? "CLI" : "Simulation" }} ·
              {{ profile.maxParallel }} Slots
            </li>
          </ul>
          <UButton
            color="neutral"
            variant="outline"
            :data-worker-id="worker.id"
            @click="open(worker.id)"
            >Worker untersuchen</UButton
          >
        </article>
      </div>
      <details v-if="s.workers.length">
        <summary>Worker als Tabelle</summary>
        <div class="table-scroll" tabindex="0">
          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Projekt</th>
                <th>Verbindung</th>
                <th>Profile</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="worker in s.workers" :key="worker.id">
                <td>
                  <UButton variant="link" @click="open(worker.id)">{{
                    worker.id
                  }}</UButton>
                </td>
                <td>{{ worker.project }}</td>
                <td>
                  {{ worker.online ? "Online" : "Offline" }} ·
                  {{ date(worker.seen) }}
                </td>
                <td>
                  {{
                    worker.profiles
                      .map(
                        (p: any) =>
                          p.provider +
                          " / " +
                          p.id +
                          " · " +
                          p.maxParallel +
                          " Slots",
                      )
                      .join(" · ")
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
      <Pagination
        v-if="s.workers.length"
        :page="s.workerPage"
        :busy="s.busy"
        label="Worker"
        @move="page"
        @refresh="store.refresh({ reset: true })"
    /></template>
    <section v-else class="detail" :aria-busy="s.workerBusy">
      <div class="section-heading">
        <h2 id="worker-detail-heading" tabindex="-1">
          Worker {{ s.workerId }}
        </h2>
        <div class="actions">
          <UButton
            color="neutral"
            :loading="s.workerBusy"
            @click="store.showWorker(s.workerId)"
            >Details aktualisieren</UButton
          ><UButton color="neutral" variant="outline" @click="close"
            >Zur Liste</UButton
          >
        </div>
      </div>
      <p v-if="s.workerBusy" role="status">
        Details werden geladen · der letzte Stand bleibt sichtbar.
      </p>
      <UAlert v-if="s.workerError" color="warning" :title="s.workerError" />
      <template v-if="s.workerDetail"
        ><SpatialMap
          :nodes="graph.nodes"
          :edges="graph.edges"
          :english="false"
          label="Worker, Profile und aktive Aufgaben"
          :caption="'Beobachteter Worker · ' + s.workerId"
          :legend="
            s.workerDetail.activeTasksTruncated
              ? 'Begrenzte Auswahl: maximal 8 aktive Aufgaben.'
              : 'Alle Profile und aktiven Aufgaben dieser Antwort.'
          "
        />
        <dl class="facts">
          <div
            v-for="(value, label) in {
              Projekt: s.workerDetail.project,
              Verbindung: s.workerDetail.online ? 'Online' : 'Offline',
              'Letzter Kontakt': date(s.workerDetail.seen),
              Maschinenslots: s.workerDetail.config.maxParallel,
              Vergabereihenfolge: s.workerDetail.config.order,
              'Maximale Versuche': s.workerDetail.config.maxAttempts,
            }"
            :key="label"
          >
            <dt>{{ label }}</dt>
            <dd>{{ value }}</dd>
          </div>
        </dl>
        <h3>Ausführungsprofile</h3>
        <div class="table-scroll" tabindex="0">
          <table>
            <thead>
              <tr>
                <th>Profil</th>
                <th>Provider</th>
                <th>Ausführung</th>
                <th>Slots</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in s.workerDetail.profiles" :key="p.id">
                <td>{{ p.id }}</td>
                <td>{{ p.provider }}</td>
                <td>
                  {{
                    p.mode === "cli" ? "CLI · echte Ausführung" : "Simuliert"
                  }}
                </td>
                <td>{{ p.maxParallel }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!s.workerDetail.profiles.length">Keine Profile gemeldet.</p>
        <h3>Aktive Reservierungen</h3>
        <p>
          {{ s.workerDetail.activeTasks.length }} Aufgaben angezeigt, maximal 8.
          {{
            s.workerDetail.activeTasksTruncated
              ? "Weitere Aufgaben fehlen; die Auswahl ist unvollständig."
              : "Vollständiger beobachteter Stand."
          }}
        </p>
        <div class="table-scroll" tabindex="0">
          <table>
            <thead>
              <tr>
                <th>Auftrag</th>
                <th>Profil</th>
                <th>Versuch</th>
                <th>Reserviert bis</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in s.workerDetail.activeTasks" :key="t.id">
                <td>
                  <UButton
                    variant="link"
                    :to="{ path: '/tasks', query: { task: t.id } }"
                    >{{ t.id }}</UButton
                  >
                </td>
                <td>{{ t.profile ?? "Nicht gemeldet" }}</td>
                <td>{{ t.attempt }}</td>
                <td>
                  {{
                    t.expiresAt === null ? "Nicht gemeldet" : date(t.expiresAt)
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div></template
      >
    </section>
  </section>
</template>
