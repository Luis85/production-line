<script setup lang="ts">
import UButton from "@nuxt/ui/components/Button.vue";
import SpatialMap from "../../../shared/webview/components/SpatialMap.vue";
import type { FactoryStore } from "../store";
import { useFactoryDashboard } from "./useFactoryDashboard";
const props = defineProps<{ store: FactoryStore }>();
const emit = defineEmits<{ navigate: [scope: string, lineId?: string] }>();
const {
  capability,
  count,
  edges,
  handoff,
  nodes,
  s,
  statusNames,
  time,
} = useFactoryDashboard(props, emit);
</script>
<template>
  <SpatialMap
    id="factory-spatial"
    :nodes="nodes"
    :edges="edges"
    :caption="
      (store.selectedFactory.value?.name || 'Alle Fabriken') +
      ' · ' +
      time(s.overview?.observedAt) +
      (s.stale ? ' · veraltet' : '')
    "
    :legend="
      'Blau: Fabrikzuordnung · Mint: erreichbar · Amber: unbekannt oder veraltet.' +
      (store.selectedLines.value.length > 12 || store.descendants().size > 20
        ? ' Begrenzte Karte: erste 12 Linien / 20 Fabriken. Nutze die Bereichsauswahl oder vollständige Tabelle.'
        : '')
    "
    label="Live-Systemkarte"
    :english="false"
  />
  <section class="section-start" aria-labelledby="overview-heading">
    <h2 id="overview-heading">Ausführung im gewählten Bereich</h2>
    <p>
      {{
        s.overview?.totals.partial
          ? "Teilweise Beobachtung · Werte enthalten nur erreichbare Linien."
          : "Eine nicht erreichbare Linie bedeutet unbekannte Werte, nicht null Arbeit."
      }}
    </p>
    <dl class="overview-facts">
      <div>
        <dt>Erreichbare Linien</dt>
        <dd>
          {{
            s.overview
              ? count(s.overview.totals.availableLines) +
                " / " +
                count(s.overview.totals.lines)
              : "Unbekannt"
          }}
        </dd>
      </div>
      <div>
        <dt>Wartende Aufträge</dt>
        <dd>{{ count(s.overview?.totals.tasks?.queued) }}</dd>
      </div>
      <div>
        <dt>Worker online</dt>
        <dd>{{ count(s.overview?.totals.workers?.online) }}</dd>
      </div>
      <div>
        <dt>Reserviert / aktiv</dt>
        <dd>{{ count(s.overview?.totals.tasks?.running) }}</dd>
      </div>
      <div>
        <dt>Freie Slots</dt>
        <dd>{{ count(s.overview?.totals.workers?.slotsAvailable) }}</dd>
      </div>
      <div>
        <dt>Simulation / Review</dt>
        <dd>
          {{ count(s.overview?.totals.tasks?.simulated) }} /
          {{ count(s.overview?.totals.tasks?.review) }}
        </dd>
      </div>
    </dl>
  </section>
  <section class="section-start" aria-labelledby="lines-heading">
    <div class="section-heading">
      <div>
        <h2 id="lines-heading">Produktionslinien</h2>
        <p>
          Topologie und Tabelle zeigen denselben Bereich. Der Intake öffnet den
          unabhängigen Orchestrator mit seinem eigenen Zugangstoken.
        </p>
      </div>
      <UButton
        :disabled="!s.canWrite || s.saving"
        @click="store.openEditor('line')"
        >Linie registrieren</UButton
      >
    </div>
    <div v-if="!store.selectedLines.value.length" class="empty-state">
      <h3>
        {{
          s.factories.length
            ? "Keine Linie in diesem Bereich"
            : "Noch keine Fabriken"
        }}
      </h3>
      <p>
        Registriere einen laufenden Orchestrator, nachdem du seine Fabrik
        angelegt hast. Die Registrierung startet keinen Dienst.
      </p>
      <UButton
        :disabled="!s.canWrite"
        @click="store.openEditor(s.factories.length ? 'line' : 'factory')"
        >{{
          s.factories.length ? "Linie registrieren" : "Fabrik anlegen"
        }}</UButton
      >
    </div>
    <div v-else>
      <div
        class="actions view-switch"
        role="group"
        aria-label="Darstellung der Produktionslinien"
      >
        <UButton
          :variant="s.lineView === 'topology' ? 'solid' : 'outline'"
          :aria-pressed="s.lineView === 'topology'"
          @click="s.lineView = 'topology'"
          >Topologie</UButton
        ><UButton
          :variant="s.lineView === 'table' ? 'solid' : 'outline'"
          :aria-pressed="s.lineView === 'table'"
          @click="s.lineView = 'table'"
          >Tabelle</UButton
        >
      </div>
      <div v-if="s.lineView === 'topology'" class="line-topology">
        <article
          v-for="line in store.selectedLines.value"
          :key="line.id"
          class="production-flow"
        >
          <h3>{{ line.name }}</h3>
          <p>{{ store.factoryPath(line.factoryId) }}</p>
          <div class="line-stations">
            <section>
              <h4>Orchestrator</h4>
              <p>
                {{
                  statusNames[
                    store.observations.value.get(line.id)?.status ??
                      "unavailable"
                  ]
                }}
              </p>
              <p>
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.tasks
                      .queued,
                  )
                }}
                wartet ·
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.tasks
                      .running,
                  )
                }}
                reserviert / aktiv
              </p>
            </section>
            <section>
              <h4>Worker-Pool</h4>
              <p>
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.workers
                      .online,
                  )
                }}
                /
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.workers
                      .total,
                  )
                }}
                online
              </p>
              <p>
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.workers
                      .slotsAvailable,
                  )
                }}
                freie Slots
              </p>
            </section>
          </div>
          <p>{{ capability(line.id) }}</p>
          <p
            v-if="store.observations.value.get(line.id)?.error"
            class="error-text"
          >
            {{ store.observations.value.get(line.id)?.error }}
          </p>
          <div class="actions">
            <UButton
              color="neutral"
              variant="outline"
              @click="emit('navigate', s.scope, line.id)"
              >Dashboard öffnen</UButton
            ><UButton
              v-if="handoff(line.webviewUrl, 'intake')"
              :href="handoff(line.webviewUrl, 'intake')"
              target="_blank"
              rel="noopener noreferrer"
              color="neutral"
              variant="outline"
              >Intake öffnen</UButton
            ><UButton
              color="neutral"
              variant="ghost"
              :disabled="!store.mayEdit('line', line.id)"
              @click="store.openEditor('line', line)"
              >Bearbeiten</UButton
            ><UButton
              color="error"
              variant="ghost"
              :disabled="!store.mayEdit('line', line.id)"
              @click="store.confirmRemoval('line', line)"
              >Abmelden</UButton
            >
          </div>
        </article>
      </div>
      <div
        v-else
        class="table-wrap"
        tabindex="0"
        role="region"
        aria-label="Produktionslinien"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Linie / Fabrik</th>
              <th scope="col">Verbindung</th>
              <th scope="col">Aufträge</th>
              <th scope="col">Worker</th>
              <th scope="col">Verwalten</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in store.selectedLines.value" :key="line.id">
              <td>
                <strong>{{ line.name }}</strong>
                <p>{{ store.factoryPath(line.factoryId) }}</p>
              </td>
              <td>
                {{
                  statusNames[
                    store.observations.value.get(line.id)?.status ??
                      "unavailable"
                  ]
                }}
                <p>{{ capability(line.id) }}</p>
              </td>
              <td>
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.tasks
                      .queued,
                  )
                }}
                wartet ·
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.tasks
                      .running,
                  )
                }}
                reserviert / aktiv
              </td>
              <td>
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.workers
                      .online,
                  )
                }}
                /
                {{
                  count(
                    store.observations.value.get(line.id)?.overview?.workers
                      .total,
                  )
                }}
                online
              </td>
              <td>
                <div class="actions">
                  <UButton
                    color="neutral"
                    variant="outline"
                    @click="emit('navigate', s.scope, line.id)"
                    >Dashboard</UButton
                  ><UButton
                    v-if="handoff(line.webviewUrl, 'intake')"
                    :href="handoff(line.webviewUrl, 'intake')"
                    target="_blank"
                    rel="noopener noreferrer"
                    color="neutral"
                    variant="outline"
                    >Intake öffnen</UButton
                  ><UButton
                    color="neutral"
                    variant="ghost"
                    :disabled="!store.mayEdit('line', line.id)"
                    @click="store.openEditor('line', line)"
                    >Bearbeiten</UButton
                  ><UButton
                    color="error"
                    variant="ghost"
                    :disabled="!store.mayEdit('line', line.id)"
                    @click="store.confirmRemoval('line', line)"
                    >Abmelden</UButton
                  >
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
