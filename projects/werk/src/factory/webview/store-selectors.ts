import type { StoreContext } from './store-context';
import { computed } from 'vue';

/** Selectors operations keep their own request and session fences. */
export function createSelectors(context: StoreContext) {
  const { state } = context;

  function descendants(id = state.scope) {
    const result = new Set(id ? [id] : state.factories.map((f) => f.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const factory of state.factories)
        if (
          factory.parentId &&
          result.has(factory.parentId) &&
          !result.has(factory.id)
        ) {
          result.add(factory.id);
          changed = true;
        }
    }
    return result;
  }

  function factoryPath(id: string) {
    const names: string[] = [],
      seen = new Set<string>();
    let factory = state.factories.find((f) => f.id === id);
    while (factory && !seen.has(factory.id)) {
      seen.add(factory.id);
      names.unshift(factory.name);
      factory = state.factories.find((f) => f.id === factory?.parentId);
    }
    return names.join(" / ");
  }

  const selectedLines = computed(() =>
    state.lines.filter((line) => descendants().has(line.factoryId)),
  );

  const selectedFactory = computed(() =>
    state.factories.find((f) => f.id === state.scope),
  );

  const observations = computed(
    () =>
      new Map(
        (state.overview?.lines ?? []).map((item) => [item.line.id, item]),
      ),
  );

  const activeLine = computed(() =>
    selectedLines.value.find((line) => line.id === state.lineId),
  );

  const activeObservation = computed(() =>
    observations.value.get(state.lineId),
  );

  const managed = (type: "factory" | "line", id?: string | null) =>
    !!id &&
    state.managed[type === "factory" ? "factories" : "lines"].includes(id);

  const mayEdit = (type: "factory" | "line", id?: string | null) =>
    state.canWrite && !managed(type, id) && !state.saving;

  const nextStep = computed(() =>
    state.loading
      ? "Linienstatus wird geprüft. Registrierte Dienste werden dadurch nicht gestartet."
      : state.stale
        ? "Status veraltet. Aktualisiere die Ansicht, bevor du die Verfügbarkeit beurteilst."
        : !selectedLines.value.length
          ? "Noch keine Linie in diesem Bereich. Registriere einen laufenden Orchestrator oder prüfe die Bereichsauswahl."
          : !state.overview?.totals.availableLines
            ? "Keine Linie erreichbar. Prüfe im Startterminal „system doctor“ mit deinem Zustandsordner."
            : state.overview?.totals.workers?.online
              ? "Öffne den Intake einer Linie mit Online-Workern. Ihr eigenes Zugangstoken wird benötigt."
              : "Orchestratoren erreichbar, aber kein Online-Worker gemeldet. Aufträge können bis zur Verbindung warten.",
  );

  return {
    descendants,
    factoryPath,
    selectedLines,
    selectedFactory,
    observations,
    activeLine,
    activeObservation,
    managed,
    mayEdit,
    nextStep,
  };
}
