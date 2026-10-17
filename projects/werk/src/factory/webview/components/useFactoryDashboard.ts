import { computed } from "vue";
import { count, time, handoff, type FactoryStore } from "../store";
import type { SpatialNode, SpatialEdge } from "../../../shared/webview/types";

/** Owns this page's state, actions and lifecycle; the Vue component owns rendering. */
export function useFactoryDashboard(props: { store: FactoryStore }, emit: (event: "navigate", scope: string, lineId?: string) => void) {
  const s = props.store.state;
  const nodes = computed<SpatialNode[]>(() => {
    const ids = props.store.descendants(),
      factories = s.factories.filter((f) => ids.has(f.id)).slice(0, 20),
      result: SpatialNode[] = factories.map((f, i) => ({
        id: "f:" + f.id,
        model: "factory",
        label: f.name,
        kind: "Fabrik",
        reading: props.store.factoryPath(f.id),
        x: 0,
        z: i * 2,
        color: "#81b6ee",
        description:
          "Registrierte Fabrikzuordnung. Dienste laufen unabhängig weiter.",
        actions: [{ label: "Bereich öffnen", run: () => emit("navigate", f.id) }],
      }));
    for (const [i, line] of props.store.selectedLines.value
      .slice(0, 12)
      .entries()) {
      const observation = props.store.observations.value.get(line.id),
        value = observation?.overview,
        stale =
          s.stale || !value || Date.now() - Date.parse(value.observedAt) > 45000,
        color = stale ? "#edc47e" : "#8be0b8",
        z = i * 2;
      result.push(
        {
          id: "l:" + line.id,
          model: "line",
          label: line.name,
          kind: "Produktionslinie",
          reading: props.store.factoryPath(line.factoryId),
          x: 1,
          z,
          color,
          description: "Registrierung eines unabhängig laufenden Orchestrators.",
          actions: [
            {
              label: "Dashboard öffnen",
              run: () => emit("navigate", s.scope, line.id),
            },
            ...(handoff(line.webviewUrl, "intake")
              ? [
                  {
                    label: "Intake öffnen",
                    href: handoff(line.webviewUrl, "intake"),
                    newTab: true,
                  },
                ]
              : []),
          ],
        },
        {
          id: "o:" + line.id,
          model: "orchestrator",
          label: "Orchestrator · " + line.name,
          kind: "Auftragsrouter",
          reading: value
            ? count(value.tasks.queued) + " wartet"
            : "Arbeit unbekannt",
          x: 2,
          z,
          color,
          description:
            observation?.error ||
            "Vergibt gespeicherte Arbeit nach Fähigkeiten und Kapazität.",
          facts: [["Datenstand", value ? time(value.observedAt) : "Unbekannt"]],
          actions: handoff(line.webviewUrl, "tasks")
            ? [
                {
                  label: "Taskboard öffnen",
                  href: handoff(line.webviewUrl, "tasks"),
                  newTab: true,
                },
              ]
            : [],
        },
        {
          id: "w:" + line.id,
          model: "workers",
          label: "Worker-Pool · " + line.name,
          kind: "Aggregierter Worker-Pool",
          reading: value
            ? count(value.workers.online) +
              " / " +
              count(value.workers.total) +
              " online"
            : "Kapazität unbekannt",
          x: 3,
          z,
          color,
          description:
            "Die Factory kennt zusammengefasste Kapazität. Einzelne Worker findest du in der Linie.",
          facts: [
            [
              "Belegte / gesamte Slots",
              value
                ? count(value.workers.slotsBusy) +
                  " / " +
                  count(value.workers.slotsTotal)
                : "Unbekannt",
            ],
          ],
          actions: handoff(line.webviewUrl, "workers")
            ? [
                {
                  label: "Worker untersuchen",
                  href: handoff(line.webviewUrl, "workers"),
                  newTab: true,
                },
              ]
            : [],
        },
      );
    }
    return result;
  });
  const edges = computed<SpatialEdge[]>(() =>
    props.store.selectedLines.value.slice(0, 12).flatMap((l) => [
      { from: "f:" + l.factoryId, to: "l:" + l.id, color: "#81b6ee" },
      { from: "l:" + l.id, to: "o:" + l.id },
      { from: "o:" + l.id, to: "w:" + l.id },
    ]),
  );
  const statusNames = {
    available: "Erreichbar",
    unavailable: "Nicht erreichbar",
    unauthorized: "Zugriff abgelehnt",
    unconfigured: "Tokenvariable fehlt",
    invalid: "Ungültige Antwort",
  };
  function capability(lineId: string) {
    const capability =
      props.store.observations.value.get(lineId)?.overview?.capabilities;
    if (!capability)
      return "Fähigkeiten nicht gemeldet. Keine Ausführung ableiten.";
    return (
      "Kontext: " +
      capability.context +
      " · Intake: " +
      capability.intake.join(", ")
    );
  }

  return {
    capability,
    count,
    edges,
    handoff,
    nodes,
    s,
    statusNames,
    time,
  };
}
