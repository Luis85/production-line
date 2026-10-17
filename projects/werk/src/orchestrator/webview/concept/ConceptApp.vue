<script setup lang="ts">
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import UBadge from "@nuxt/ui/components/Badge.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import SpatialMap from "../../../shared/webview/components/SpatialMap.vue";
import ConceptIntake from "./components/ConceptIntake.vue";
import ConceptFactory from "./components/ConceptFactory.vue";
import ConceptBoard from "./components/ConceptBoard.vue";
import ConceptProviders from "./components/ConceptProviders.vue";
import ConceptDashboard from "./components/ConceptDashboard.vue";
import ConceptDocumentation from "./components/ConceptDocumentation.vue";
import ConceptTaskDetail from "./components/ConceptTaskDetail.vue";
import { useConceptPage } from "./useConceptPage";
const {
  chooseLine,
  connectionLayer,
  edges,
  engine,
  error,
  exportState,
  focusMain,
  heading,
  headingTitle,
  layerItems,
  line,
  lineOptions,
  navigate,
  newFeature,
  nodes,
  playing,
  projects,
  reset,
  resetRequested,
  restoreTaskFocus,
  selectedNode,
  speed,
  speedItems,
  state,
  step,
  storageWarning,
  tabs,
  taskId,
  tasks,
  togglePlay,
  view,
  workers,
} = useConceptPage();
</script>
<template>
  <UApp>
    <a class="concept-skip" href="#concept-main" @click="focusMain"
      >Zum Inhalt</a
    >
    <header class="concept-header">
      <a href="/" class="concept-brand"
        >werk<span>.</span> <small>Software-Fabrik</small></a
      >
      <div class="concept-header-actions">
        <UBadge color="warning" variant="subtle"
          >Lokale Konzeptsimulation</UBadge
        >
        <UButton variant="outline" icon="i-lucide-download" @click="exportState"
          >JSON exportieren</UButton
        >
        <UButton variant="ghost" @click="resetRequested = !resetRequested"
          >Demo zurücksetzen</UButton
        >
        <UButton @click="newFeature">Feature einreichen</UButton>
      </div>
    </header>
    <div
      v-if="resetRequested"
      class="concept-reset"
      role="region"
      aria-label="Demo zurücksetzen bestätigen"
    >
      <p>Alle gespeicherten Änderungen dieser Browserdemo verwerfen?</p>
      <UButton
        color="error"
        @click="
          reset();
          resetRequested = false;
        "
        >Änderungen verwerfen und zurücksetzen</UButton
      >
      <UButton variant="outline" @click="resetRequested = false"
        >Abbrechen</UButton
      >
    </div>
    <nav class="concept-tabs" aria-label="Hauptnavigation">
      <UButton
        v-for="tab in tabs"
        :key="tab.value"
        :variant="view === tab.value ? 'solid' : 'ghost'"
        :aria-current="view === tab.value ? 'page' : undefined"
        @click="navigate(tab.value)"
        >{{ tab.label }}</UButton
      >
    </nav>
    <main id="concept-main" class="concept-main" tabindex="-1">
      <UAlert
        v-if="storageWarning"
        color="warning"
        variant="subtle"
        :description="storageWarning"
      />
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        :description="error"
      />
      <div class="concept-heading">
        <div>
          <h1 ref="heading" tabindex="-1">{{ headingTitle }}</h1>
          <p>
            Alle Projekte, Accounts, Checks und Git-Ereignisse sind
            Beispieldaten. Keine Verbindung zu KI-Anbietern oder Git.
          </p>
        </div>
        <div
          v-if="!['intake', 'factory', 'operations', 'system'].includes(view)"
          class="concept-controls"
        >
          <label for="conceptSpeed">Simulationsintervall</label
          ><USelect id="conceptSpeed" v-model="speed" :items="speedItems" />
          <UButton variant="outline" icon="i-lucide-step-forward" @click="step"
            >Nächster Takt</UButton
          >
          <UButton
            variant="outline"
            :icon="playing ? 'i-lucide-pause' : 'i-lucide-play'"
            :aria-pressed="playing"
            @click="togglePlay"
            >{{
              playing ? "Simulation pausieren" : "Simulation starten"
            }}</UButton
          >
        </div>
      </div>
      <section
        v-if="view !== 'factory'"
        class="concept-line-context"
        aria-label="Aktive Produktionslinie"
      >
        <div>
          <strong>{{ engine.factoryPath(line.factoryId) }}</strong>
          <p>
            {{ line.orchestratorId }} ·
            {{
              projects.find((project) => project.id === line.projectId)?.name
            }}
          </p>
        </div>
        <label for="concept-line">Produktionslinie</label>
        <USelect
          id="concept-line"
          :model-value="line.id"
          :items="lineOptions"
          @update:model-value="chooseLine(String($event))"
        />
        <UButton variant="outline" @click="navigate('factory')"
          >Factories verwalten</UButton
        >
      </section>
      <p
        v-if="!['intake', 'factory', 'operations', 'system'].includes(view)"
        class="concept-status"
        role="status"
      >
        Takt {{ state.tick }} ·
        {{ workers.filter((worker) => worker.online).length }}/{{
          workers.length
        }}
        Demo-Worker online ·
        {{
          tasks.filter((task) => ["running", "checks"].includes(task.status))
            .length
        }}
        aktive Versuche ·
        {{ tasks.filter((task) => task.status === "review").length }} im Review.
        Takte wirken auf alle Linien.
      </p>
      <ConceptIntake v-if="view === 'intake'" :key="state.selectedLineId" />
      <ConceptFactory v-else-if="view === 'factory'" />
      <section
        v-else-if="view === 'architecture'"
        aria-label="Illustrative Architektur"
      >
        <div class="concept-inline">
          <label for="connectionLayer">Verbindungsart</label
          ><USelect
            id="connectionLayer"
            v-model="connectionLayer"
            :items="layerItems"
          />
        </div>
        <SpatialMap
          :nodes="nodes"
          :edges="edges"
          :selected-id="selectedNode"
          :english="false"
          label="Illustrative Architektur dieser Produktionslinie"
          caption="Konzeptsimulation · keine Live-Topologie"
          legend="Durchgezogen: Aufträge · Gestrichelt: Git- und Review-Rückmeldung"
          @select="selectedNode = $event"
        />
      </section>
      <ConceptBoard v-else-if="view === 'board'" />
      <ConceptProviders v-else-if="view === 'providers'" />
      <ConceptDashboard v-else-if="view === 'dashboard'" />
      <ConceptDocumentation v-else :view="view" />
    </main>
    <footer class="concept-footer">
      Konzeptsimulation · Änderungen bleiben in diesem Browser. Token-, Kosten-,
      CPU- und Coverage-Werte bleiben unbekannt.
      <a href="/guide">Systemguide öffnen</a>
    </footer>
    <ConceptTaskDetail
      :task-id="taskId"
      @close="taskId = null"
      @close-auto-focus="restoreTaskFocus"
    />
  </UApp>
</template>
