<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
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
import {
  createFactoryStore,
  emptySelection,
  selectionValue,
  selectionInput,
  decodeScope,
  time,
  managedGuidance,
} from "./store";
const scopeNavigationOpen = ref(
  window.matchMedia("(min-width: 761px)").matches,
);
const store = createFactoryStore(),
  s = store.state,
  route = useRoute(),
  router = useRouter(),
  credential = ref(""),
  tourOpen = ref(false);
const factoryOptions = computed(() => [
  { label: "Alle Fabriken", value: emptySelection },
  ...s.factories.map((f) => ({ label: store.factoryPath(f.id), value: f.id })),
]);
const dashboardOptions = computed(() => [
  { label: "Factory · alle Linien", value: emptySelection },
  ...store.selectedLines.value.map((l) => ({ label: l.name, value: l.id })),
]);
const breadcrumbs = computed(() => {
  const result: { id: string; name: string }[] = [];
  let f = store.selectedFactory.value;
  const seen = new Set<string>();
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    result.unshift({ id: f.id, name: f.name });
    f = s.factories.find((item) => item.id === f!.parentId);
  }
  return result;
});
const tourSteps = computed(() =>
  s.lineId
    ? [
        {
          title: "Dein Produktionslinien-Dashboard",
          text: "Diese Ansicht verfolgt nur die ausgewählte Linie. Wartende Aufträge, reservierte Arbeit, Review und freie Kapazität kommen von ihrem Orchestrator.",
          target: ".line-dashboard",
        },
        {
          title: "Prozess in 3D oder 2D",
          text: "Wähle eine Station, um ihre Rolle zu verstehen. Beide Ansichten verwenden dieselbe Beobachtung. Unbekannte und veraltete Daten bleiben gekennzeichnet.",
          target: ".spatial-layout",
        },
        {
          title: "Interaktion und Orchestrator",
          text: "Chat arbeitet mit einem registrierten Worker. Neue Aufgaben gelangen in den Router dieser Linie. Einzelne Aufträge, Worker und Evidenz findest du im unabhängigen Orchestrator.",
          target: ".operation-actions",
        },
      ]
    : [
        {
          title: "Dashboard der ganzen Factory",
          text: "Die Übersicht umfasst registrierte Linien des gewählten Bereichs und seiner Unterfabriken. Teilwerte sind keine vollständigen Summen.",
          target: "#overview-heading",
        },
        {
          title: "Jede Produktionslinie untersuchen",
          text: "Wähle eine Linie im Dashboard, um ihre Prozessansicht zu öffnen. Jede Linie behält ihre eigene Warteschlange und ihre Worker.",
          target: "#dashboard-scope",
        },
        {
          title: "Arbeit erhalten und routen",
          text: "Der Factory-Intake speichert Arbeit dauerhaft. Automatisches Routing prüft Projekt, Provider und freie Kapazität. Manuelles Routing wartet auf deine gewählte Linie.",
          target: "#factory-intake",
          activate: () => {
            s.intakeOpen = true;
          },
        },
      ],
);
async function navigate(scope: string, lineId = "") {
  if (s.saving || s.intakeBusy || s.policyBusy) return;
  await router.push({
    path: scope ? "/factories/" + encodeURIComponent(scope) : "/",
    hash: lineId ? "#line=" + encodeURIComponent(lineId) : "",
  });
}
function openIntake() {
  s.intakeOpen = true;
  void nextTick(() =>
    document
      .getElementById("factory-intake")
      ?.scrollIntoView({ block: "start" }),
  );
}
async function connect() {
  await store.connect(credential.value);
  if (s.token) {
    credential.value = "";
    await nextTick();
    document.querySelector<HTMLElement>("h1")?.focus();
  }
}
watch(
  () => route.fullPath,
  () => {
    store.navigate(
      decodeScope(route.path),
      new URLSearchParams(route.hash.slice(1)).get("line") ?? "",
    );
  },
  { immediate: true },
);
watch(
  () => s.scope,
  (scope) => {
    if (s.token && decodeScope(route.path) !== scope)
      void router.replace({
        path: scope ? "/factories/" + encodeURIComponent(scope) : "/",
        hash: s.lineId ? "#line=" + encodeURIComponent(s.lineId) : "",
      });
  },
);
watch(
  () => s.token,
  async (token) => {
    if (!token) {
      credential.value = "";
      tourOpen.value = false;
      await nextTick();
      document.getElementById("token")?.focus();
    }
  },
);
let returnFocus: HTMLElement | null = null;
watch(
  () => Boolean(s.editor || s.deletion),
  async (open, previous) => {
    if (open && !previous)
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    else if (!open && previous) {
      await nextTick();
      (returnFocus?.isConnected
        ? returnFocus
        : document.querySelector<HTMLElement>("h1")
      )?.focus({ preventScroll: true });
      returnFocus = null;
    }
  },
);
let timer: ReturnType<typeof setInterval>;
function visibility() {
  if (!document.hidden && !s.paused) void store.refresh();
}
onMounted(() => {
  timer = setInterval(() => {
    if (s.token && !s.paused && !s.loading && !s.saving && !document.hidden)
      void store.refresh();
  }, 15000);
  document.addEventListener("visibilitychange", visibility);
});
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener("visibilitychange", visibility);
  store.disconnect();
});
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
