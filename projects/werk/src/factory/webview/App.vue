<script setup lang="ts">
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UInput from "@nuxt/ui/components/Input.vue";
import USelect from "@nuxt/ui/components/Select.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import WerkShell from "../../shared/webview/components/WerkShell.vue";
import AccessPanel from "../../shared/webview/components/AccessPanel.vue";
import ConnectionStatus from "../../shared/webview/components/ConnectionStatus.vue";
import PageHeading from "../../shared/webview/components/PageHeading.vue";
import OnboardingTour from "../../shared/webview/components/OnboardingTour.vue";
import FactoryTaskboard from "./components/FactoryTaskboard.vue";
import FactoryDashboard from "./components/FactoryDashboard.vue";
import LineDashboard from "./components/LineDashboard.vue";
import RegistryEditor from "./components/RegistryEditor.vue";
import FactoryIntake from "./components/FactoryIntake.vue";
import { useFactoryApp } from "./useFactoryApp";
const {
  breadcrumbs,
  connect,
  credential,
  dashboardOptions,
  factoryOptions,
  managedGuidance,
  navigate,
  openIntake,
  s,
  scopeNavigationOpen,
  selectionInput,
  selectionValue,
  store,
  time,
  tourOpen,
  tourSteps,
} = useFactoryApp();
</script>
<template>
  <UApp>
    <template v-if="!s.token">
      <AccessPanel
        title="Deine Software-Fabriken im Überblick"
        lead="Verbinde dich, um Produktionslinien, ihren Status und die Lieferung deiner Aufträge zu verfolgen."
        help-title="Wo finde ich mein Zugangstoken?"
        caption="Unabhängige Dienste. Ein gemeinsamer Überblick."
      >
        <form class="operation-form" @submit.prevent="connect">
          <label for="token">Zugangstoken der Fabrikverwaltung</label
          ><UInput
            id="token"
            v-model="credential"
            type="password"
            autocomplete="off"
            required
            :disabled="s.connecting"
            aria-describedby="token-help"
          />
          <p id="token-help">
            WERK_FACTORY_ADMIN_TOKEN · im Startzustand unter
            <code>.werk-system/&lt;System-ID&gt;/factory/credentials.json</code
            >. Bei anderem Zustandsordner gilt der Pfad aus der Startausgabe.
          </p>
          <p v-if="s.error" role="alert" class="error-text">{{ s.error }}</p>
          <UButton
            type="submit"
            :loading="s.connecting"
            :disabled="!credential.trim()"
            >Verbinden</UButton
          >
        </form>
        <template #help
          ><p>
            Verwende das Factory-Zugangstoken. Linien- und Enrollment-Token
            passen hier nicht. Öffne den Zustandsordner auf der Maschine, auf
            der die Factory läuft.
          </p></template
        ><template #privacy
          >Das Token bleibt nur im Arbeitsspeicher dieser Seite. Trennen
          entfernt es und verwirft ungesendete Eingaben.</template
        >
      </AccessPanel>
    </template>
    <WerkShell
      v-else
      home-path="/"
      home-label="Werk Fabriken"
      nav-label="Fabrikbereiche"
    >
      <template #identity
        ><div class="worker-identity">
          <div>
            <strong>Fabriken</strong
            ><span>{{
              s.canWrite
                ? "Zugriff: " +
                  (s.role === "operator" ? "Operator" : "Administration")
                : "Zugriff: nur lesen"
            }}</span>
          </div>
        </div></template
      >
      <template #sidebarBody>
        <details
          class="factory-navigation"
          :open="scopeNavigationOpen"
          @toggle="
            scopeNavigationOpen = ($event.target as HTMLDetailsElement).open
          "
        >
          <summary>
            Fabrik auswählen
            <span>{{
              store.selectedFactory.value?.name || "Alle Fabriken"
            }}</span>
          </summary>
          <div class="factory-navigation-content">
            <label for="scope-picker">Bereich</label
            ><USelect
              id="scope-picker"
              :model-value="selectionValue(s.scope)"
              :items="factoryOptions"
              :disabled="s.saving"
              @update:model-value="navigate(selectionInput($event))"
            />
            <nav class="factory-tree" aria-label="Fabrikhierarchie">
              <UButton
                v-for="factory in s.factories"
                :key="factory.id"
                color="neutral"
                variant="ghost"
                :aria-current="s.scope === factory.id ? 'page' : undefined"
                :style="{
                  paddingInlineStart:
                    (store.factoryPath(factory.id).split(' / ').length - 1) *
                      12 +
                    12 +
                    'px',
                }"
                :disabled="s.saving"
                @click="navigate(factory.id)"
                >{{ factory.name }}</UButton
              >
            </nav>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="!s.canWrite || s.saving"
              @click="store.openEditor('factory')"
              >Fabrik anlegen</UButton
            >
          </div>
        </details></template
      >
      <template #sidebarFooter
        ><p>
          Die Factory zeigt registrierte Linien. Orchestratoren und Worker
          laufen unabhängig weiter.
        </p>
        <a href="/guide" target="_blank" rel="noopener noreferrer"
          >System verstehen</a
        ></template
      >
      <template #status
        ><ConnectionStatus
          :healthy="!s.error && !s.stale"
          :label="s.error ? 'Verbindung prüfen' : 'Verbunden'"
          :detail="s.paused ? 'Live-Updates pausiert' : 'Updates alle 15s'"
      /></template>
      <template #actions
        ><UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-compass"
          @click="tourOpen = true"
          >Tour</UButton
        ><UButton
          color="neutral"
          variant="ghost"
          :icon="s.paused ? 'i-lucide-play' : 'i-lucide-pause'"
          :aria-label="
            s.paused ? 'Live-Updates fortsetzen' : 'Live-Updates pausieren'
          "
          @click="
            s.paused = !s.paused;
            if (!s.paused) store.refresh();
          "
        /><UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          aria-label="Aktualisieren"
          :loading="s.loading"
          @click="store.refresh()"
        /><UButton
          color="neutral"
          variant="outline"
          :disabled="s.saving || s.intakeBusy || s.policyBusy"
          @click="store.disconnect()"
          >Trennen</UButton
        ></template
      >
      <template #notices
        ><UAlert
          v-if="s.error"
          color="warning"
          :description="s.error + ' Angezeigte Werte können veraltet sein.'"
          title="Aktualisierung nicht verfügbar"
        />
        <p
          class="message"
          :class="{ 'sr-only': s.message === 'Verbunden.' }"
          role="status"
        >
          {{ s.message }}
        </p></template
      >
      <nav
        v-if="s.scope || s.lineId"
        aria-label="Brotkrumennavigation"
        class="breadcrumbs"
      >
        <UButton color="neutral" variant="link" @click="navigate('')"
          >Alle Fabriken</UButton
        ><UButton
          v-for="item in breadcrumbs"
          :key="item.id"
          color="neutral"
          variant="link"
          @click="navigate(item.id)"
          >{{ item.name }}</UButton
        >
      </nav>
      <PageHeading
        v-if="!s.lineId"
        :title="store.selectedFactory.value?.name || 'Alle Fabriken'"
        description="Produktionslinien im gewählten Bereich, einschließlich ihrer Unterfabriken."
        ><template #actions
          ><UButton
            v-if="store.selectedFactory.value"
            color="neutral"
            variant="outline"
            :disabled="!store.mayEdit('factory', s.scope)"
            @click="store.openEditor('factory', store.selectedFactory.value)"
            >Fabrik bearbeiten</UButton
          ><UButton
            v-if="store.selectedFactory.value"
            color="error"
            variant="ghost"
            :disabled="!store.mayEdit('factory', s.scope)"
            @click="
              store.confirmRemoval('factory', store.selectedFactory.value)
            "
            >Fabrik löschen</UButton
          ></template
        ></PageHeading
      >
      <details
        v-if="s.managed.factories.length + s.managed.lines.length"
        class="registry-guidance"
      >
        <summary>Durch Systemdefinition verwaltet</summary>
        <p class="page-note">{{ managedGuidance }}</p>
      </details>
      <p>{{ store.nextStep.value }}</p>
      <div class="dashboard-controls">
        <label for="dashboard-scope">Dashboard</label
        ><USelect
          id="dashboard-scope"
          :model-value="selectionValue(s.lineId)"
          :items="dashboardOptions"
          @update:model-value="navigate(s.scope, selectionInput($event))"
        /><UButton color="neutral" variant="outline" @click="openIntake"
          >Factory-Intake öffnen</UButton
        >
      </div>
      <LineDashboard
        v-if="s.lineId"
        :key="s.lineId"
        :store="store"
        @tour="tourOpen = true"
      /><FactoryDashboard v-else :store="store" @navigate="navigate" />
      <FactoryTaskboard :store="store" />
      <RegistryEditor :store="store" /><FactoryIntake :store="store" />
      <OnboardingTour
        v-model:open="tourOpen"
        locale="de"
        :title="s.lineId ? 'Linien-Tour' : 'Factory-Tour'"
        :steps="tourSteps"
      />
      <template #footer
        ><span
          >{{
            s.overview
              ? "Stand " + time(s.overview.observedAt)
              : "Noch keine Statusabfrage"
          }}{{ s.stale ? " · veraltet" : "" }}</span
        ><span>Werk · Fabrikverwaltung</span></template
      >
    </WerkShell>
  </UApp>
</template>
