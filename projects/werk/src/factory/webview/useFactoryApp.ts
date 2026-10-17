import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  createFactoryStore,
  emptySelection,
  selectionValue,
  selectionInput,
  decodeScope,
  time,
  managedGuidance,
} from "./store";

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useFactoryApp() {
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

  return {
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
  };
}
