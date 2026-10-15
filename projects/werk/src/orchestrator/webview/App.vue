<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import WerkShell from "../../shared/webview/components/WerkShell.vue";
import AccessPanel from "../../shared/webview/components/AccessPanel.vue";
import PageHeading from "../../shared/webview/components/PageHeading.vue";
import ConnectionStatus from "../../shared/webview/components/ConnectionStatus.vue";
import OnboardingTour from "../../shared/webview/components/OnboardingTour.vue";
import LineInteractionPanel from "../../shared/webview/components/LineInteractionPanel.vue";
import { createOrchestratorStore, names, type Tab } from "./store";
const store = createOrchestratorStore({
  reactive: (value) => reactive(value) as typeof value,
});
const s = store.state,
  route = useRoute(),
  router = useRouter(),
  tokenDraft = ref("");
const links = [
  { path: "/system", label: "Dashboard", icon: "i-lucide-workflow" },
  { path: "/intake", label: "Intake", icon: "i-lucide-plus" },
  { path: "/tasks", label: "Aufträge", icon: "i-lucide-columns-3" },
  { path: "/workers", label: "Worker", icon: "i-lucide-server" },
  {
    path: "/metrics",
    label: "Messwerte",
    icon: "i-lucide-chart-no-axes-combined",
  },
];
const leads: Record<Tab, string> = {
  system: "Aufträge, Kapazität und Ergebnisse dieser Produktionslinie.",
  intake:
    "Vault-Verweis oder Feature mit Akzeptanzkriterien übergeben. Die Vorschau zeigt den nächsten Schritt.",
  tasks:
    "Wähle einen Auftrag für Ereignisse, Ergebnis und Vorher/Nachher-Snapshots.",
  workers: "Kapazität und Ausführungsprofile dieser Linie untersuchen.",
  metrics: "Versuche vergleichen und ihre gespeicherte Evidenz prüfen.",
};
const title = computed(() => names[s.tab]);
let routeRequest = 0;
async function openRoute(focus = true) {
  if (!s.token) return;
  const id = ++routeRequest,
    tab = route.path.slice(1) as Tab;
  const page = Object.hasOwn(names, tab) ? tab : "system";
  // Change tabs before awaiting reads; detail request fences belong to the store.
  const read = store.navigate(page);
  if (page === "tasks" && typeof route.query.task === "string")
    await store.showTaskId(route.query.task);
  else if (page === "tasks") store.closeTask();
  await read;
  if (id !== routeRequest || !s.token) return;
  await nextTick();
  if (focus)
    document
      .querySelector<HTMLElement>(
        page === "tasks" && s.selectedTask
          ? "#task-detail-heading"
          : ".page-heading h1",
      )
      ?.focus();
}
watch(
  () => route.fullPath,
  (next, previous) => {
    const currentUrl = new URL(next, location.origin),
      priorUrl = new URL(previous, location.origin);
    const closesTask =
      currentUrl.pathname === "/tasks" &&
      priorUrl.pathname === "/tasks" &&
      priorUrl.searchParams.has("task") &&
      !currentUrl.searchParams.has("task");
    void openRoute(!closesTask);
  },
);
watch(
  () => s.token,
  async (token, previous) => {
    if (token && !previous) await openRoute();
    else if (!token) {
      ++routeRequest;
      tokenDraft.value = "";
      await nextTick();
      document.querySelector<HTMLInputElement>("#token")?.focus();
    }
  },
);
watch(
  () => s.tab,
  (value) => {
    document.title = `${names[value]} · Werk Produktionslinie`;
  },
);
// A successful intake mutation acknowledges its task independently of the current read.
watch(
  () => s.selectedTask?.id,
  (id) => {
    if (id && s.tab === "tasks" && route.path !== "/tasks")
      void router.replace({ path: "/tasks", query: { task: id } });
  },
);
async function connect() {
  await store.connect(tokenDraft.value);
  if (s.token) tokenDraft.value = "";
}
function pause() {
  s.paused = !s.paused;
  if (!s.paused) void store.poll();
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    if (!document.hidden) void store.poll();
  }, 5000);
});
onUnmounted(() => {
  clearInterval(timer);
  store.clearSession();
});
const steps = [
  {
    title: "Diese Produktionslinie verstehen",
    text: "Das Dashboard verfolgt Aufträge von Intake über Worker bis zum Review. 3D und 2D zeigen denselben beobachteten Stand.",
    target: "#system",
    activate: () => router.push("/system"),
  },
  {
    title: "Interaktion und Auftragsübergabe",
    text: "Die Interaktion verbindet dich mit einem registrierten Worker. Einen Auftrag über die Linie zu übergeben ist eine eigene Aktion.",
    target: "#line-actions",
  },
  {
    title: "Auftragsrouting wählen",
    text: "Automatisches Routing berücksichtigt Projekt, Provider und Kapazität. Manuelles Routing wartet auf das gewählte Ziel. Laufende Reservierungen bleiben erhalten.",
    target: "#line-routing",
    activate: async () => {
      await router.push("/system");
      await nextTick();
      const el = document.querySelector<HTMLDetailsElement>("#line-routing");
      if (el) el.open = true;
      await store.loadRouting();
    },
  },
  {
    title: "Aufträge und Ergebnisse verfolgen",
    text: "Das Taskboard gruppiert die geladene Seite nach Status. Öffne einen Auftrag für Ereignisse und Evidenz. Review bleibt eine menschliche Entscheidung.",
    target: "#tasks",
    activate: () => router.push("/tasks"),
  },
  {
    title: "Einen Worker untersuchen",
    text: "Worker zeigen registrierte Profile, Kapazität und Reservierungen. Ihre eigene Webansicht bietet Chat, History und Dashboard.",
    target: "#workers",
    activate: () => router.push("/workers"),
  },
];
</script>
<template>
  <UApp>
    <AccessPanel
      v-if="!s.token"
      title="Willkommen bei Werk"
      lead="Verbinde dich mit deiner Produktionslinie. Übergib einen Auftrag und prüfe Ausführung und Evidenz."
      help-title="Wo finde ich das Zugangstoken?"
      caption="Produktionslinie · Simulation standardmäßig. Echte Codex-Ausführung ausdrücklich optional."
    >
      <form class="access-form" @submit.prevent="connect">
        <label for="token">Zugangstoken</label
        ><input
          id="token"
          v-model="tokenDraft"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="WERK_ADMIN_TOKEN dieser Linie"
          :disabled="s.connecting"
          required
        /><UButton
          type="submit"
          block
          :loading="s.connecting"
          :disabled="s.connecting"
          >Verbinden</UButton
        >
      </form>
      <p
        v-if="s.message"
        :role="s.messageKind === 'error' ? 'alert' : 'status'"
        :class="{ 'error-text': s.messageKind === 'error' }"
      >
        {{ s.message }}
      </p>
      <template #help
        ><p>
          Native Installation: <code>.werk/credentials.json</code> im
          Projektordner. Kopiere <code>WERK_ADMIN_TOKEN</code> dieser
          Produktionslinie ohne Anführungszeichen. Systeminstallationen
          verwenden die Zugangsdaten ihrer Linie.
        </p>
        <p>
          Docker: Zugangsdaten über die dokumentierte Exportfunktion aus dem
          privaten Zustandsvolume lesen. Prüfe die Linienadresse und das
          Startterminal, wenn die Verbindung fehlschlägt.
        </p>
        <a href="/guide" target="_blank" rel="noopener noreferrer"
          >Installations- und Zugangshilfe</a
        ></template
      ><template #privacy
        >Das Token bleibt nur im Speicher dieser Seite. Neuladen oder Trennen
        entfernt den Zugang. Aufträge bleiben im Orchestrator
        gespeichert.</template
      >
    </AccessPanel>
    <WerkShell
      v-else
      :links="links"
      home-path="/system"
      home-label="Werk Produktionslinie"
      nav-label="Ansichten dieser Linie"
    >
      <template #identity
        ><p class="shell-identity">
          Produktionslinie<br /><strong>{{
            s.overview?.project || s.intake.project
          }}</strong>
        </p></template
      >
      <template #sidebarFooter
        ><p>{{ s.role }}</p>
        <a href="/guide" target="_blank" rel="noopener noreferrer">Anleitung</a
        ><a href="/concept" target="_blank" rel="noopener noreferrer"
          >Separate Konzeptdemo</a
        ></template
      >
      <template #status
        ><ConnectionStatus
          :healthy="!s.stale"
          :label="s.stale ? 'Letzter Stand veraltet' : 'Verbunden'"
          :detail="
            s.paused ? 'Live-Updates pausiert' : 'Abfrage alle 5 Sekunden'
          "
      /></template>
      <template #actions
        ><UButton
          color="neutral"
          variant="ghost"
          :aria-pressed="s.paused"
          @click="pause"
          >{{ s.paused ? "Updates fortsetzen" : "Updates pausieren" }}</UButton
        ><UButton
          color="neutral"
          variant="outline"
          :disabled="s.submitting"
          @click="store.disconnect()"
          >Trennen</UButton
        ></template
      >
      <template #notices
        ><UAlert
          variant="soft"
          v-if="s.message"
          :color="
            s.messageKind === 'error'
              ? 'error'
              : s.messageKind === 'success'
                ? 'success'
                : 'neutral'
          "
          :title="s.message"
          class="notice"
      /></template>
      <PageHeading :title="title" :description="leads[s.tab]"
        ><template #actions
          ><div id="line-actions" class="actions">
            <UButton
              icon="i-lucide-messages-square"
              @click="s.interactionOpen = true"
              >Interaktion öffnen</UButton
            ><UButton
              color="neutral"
              variant="outline"
              @click="s.tourOpen = true"
              >Tour starten</UButton
            >
          </div></template
        ></PageHeading
      >
      <p class="sync-note" role="status">
        {{ s.sync }}{{ s.paused ? " · pausiert" : "" }}
      </p>
      <RouterView :store="store" />
      <details class="access-disclosure">
        <summary>Zugriff und Berechtigungen</summary>
        <p>
          {{ s.role }} ·
          {{
            s.canWrite
              ? "Aufträge lesen und übergeben; Routing ändern."
              : "Taskboard, Worker und Messwerte lesen. Für Änderungen mit einem Operator- oder Administrationstoken verbinden."
          }}
        </p>
      </details>
      <template #footer
        >Simulation bestätigt einen technischen Testlauf. Echte Änderungssätze
        brauchen menschliches Review; kein automatischer Push oder
        Merge.</template
      >
    </WerkShell>
    <LineInteractionPanel
      v-if="s.token"
      v-model:open="s.interactionOpen"
      :title="'Interaktion · ' + s.intake.project"
      :project="s.intake.project"
      :can-write="s.canWrite"
      :request="(body) => store.api('/v1/interaction', body, 'POST')"
      :submit="
        (body, key) => store.api('/v1/tasks', body, 'POST', undefined, key)
      "
    />
    <OnboardingTour
      v-if="s.token"
      locale="de"
      v-model:open="s.tourOpen"
      title="Orchestrator / Produktionslinie"
      :steps="steps"
    />
  </UApp>
</template>
