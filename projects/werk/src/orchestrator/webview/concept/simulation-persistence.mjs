import { project, states, active, labels } from './simulation-model.mjs';

/** Persistence behavior for one isolated, local simulation. */
export function createPersistence(state, api) {
  function seed() {
    return normalize({
      workers: [
        { id: "W-01", project: "atlas", online: true },
        { id: "W-02", project: "atlas", online: true },
        { id: "W-03", project: "portal", online: true },
        { id: "W-04", project: "field", online: true },
        { id: "W-05", project: "field", online: false },
      ],
      tasks: [
        {
          id: 101,
          title: "Bestellfreigabe mit Vier-Augen-Prinzip",
          project: "atlas",
          status: "running",
          worker: "W-01",
          priority: 2,
          criteria:
            "Bestellungen ab 5.000 € benötigen zwei Freigaben. Jede Entscheidung wird protokolliert.",
          attempt: 1,
        },
        {
          id: 102,
          title: "Kunden können Rechnungen herunterladen",
          project: "portal",
          status: "review",
          priority: 2,
          pr: 42,
          criteria:
            "Rechnungen sind nur für das eigene Kundenkonto sichtbar. Download als PDF.",
          attempt: 1,
        },
        {
          id: 103,
          title: "Einsatzplanung nach Qualifikation",
          project: "field",
          status: "checks",
          worker: "W-04",
          priority: 1,
          criteria:
            "Nur verfügbare Techniker mit passender Qualifikation sind auswählbar.",
          attempt: 1,
        },
        {
          id: 104,
          title: "Lieferantenimport mit Dublettenprüfung",
          project: "atlas",
          status: "queued",
          priority: 1,
          criteria:
            "CSV wird validiert; doppelte Lieferanten werden zur Prüfung markiert.",
          attempt: 0,
        },
        {
          id: 105,
          title: "Serviceberichte offline erfassen",
          project: "field",
          status: "queued",
          priority: 2,
          criteria:
            "Berichte bleiben offline verfügbar und werden später synchronisiert.",
          attempt: 0,
        },
        {
          id: 106,
          title: "Benachrichtigungseinstellungen",
          project: "portal",
          status: "done",
          priority: 1,
          pr: 39,
          criteria: "Kunden können Benachrichtigungen je Kanal deaktivieren.",
          attempt: 1,
          merged: true,
        },
      ],
      events: [],
      tick: 0,
    });
  }

  function normalize(raw) {
    if (
      !raw ||
      !Array.isArray(raw.tasks) ||
      !Array.isArray(raw.workers) ||
      !Array.isArray(raw.events)
    )
      throw Error("Ungültige Datenstruktur");
    const catalog = api.validateFactoryCatalog(raw);
    const migrateLine = (id, projectId) => {
      const l =
        catalog.lines.find((l) => l.id === id) ||
        (!id && catalog.lines.find((l) => l.projectId === projectId));
      if (!l || l.projectId !== projectId)
        throw Error("Ungültige Linienbindung");
      return l.id;
    };
    const ids = new Set(),
      occupied = new Map(),
      profileOccupancy = new Map(),
      taskIds = new Set();
    const workers = raw.workers.map((w) => {
      if (
        !w ||
        typeof w.id !== "string" ||
        !/^W-\d+$/.test(w.id) ||
        ids.has(w.id) ||
        !project(w.project) ||
        typeof w.online !== "boolean"
      )
        throw Error("Ungültige Maschine");
      ids.add(w.id);
      return {
        id: w.id,
        project: w.project,
        lineId: migrateLine(w.lineId, w.project),
        online: w.online,
        paused: !!w.paused,
        quota: !!w.quota,
        maxParallel: api.boundedInteger(w.maxParallel, 1, 1, 8),
        systemPrompt:
          typeof w.systemPrompt === "string"
            ? w.systemPrompt.slice(0, 20000)
            : "Implementiere das Feature anhand des versionierten Projektkontexts. Befolge die Factory-Policy und liefere prüfbare Nachweise.",
        configVersion: api.boundedInteger(w.configVersion, 1, 1, 1000000),
        timeoutSeconds: api.boundedInteger(w.timeoutSeconds, 900, 60, 3600),
        profiles: api.validProfiles(w.profiles, w.id),
      };
    });
    const tasks = raw.tasks.map((t) => {
      if (
        !t ||
        !Number.isSafeInteger(t.id) ||
        t.id < 1 ||
        taskIds.has(t.id) ||
        !project(t.project) ||
        !states.includes(t.status) ||
        typeof t.title !== "string" ||
        !t.title.trim() ||
        typeof t.criteria !== "string"
      )
        throw Error("Ungültiger Auftrag");
      taskIds.add(t.id);
      if (t.context) api.validateContext(t.context, t.project);
      const lineId = migrateLine(t.lineId, t.project),
        w = workers.find((w) => w.id === t.worker);
      if (
        active(t) &&
        (!w ||
          w.lineId !== lineId ||
          w.project !== t.project ||
          !w.online ||
          (occupied.get(w.id) || 0) >= w.maxParallel)
      )
        throw Error("Ungültige Zuweisung");
      if (active(t)) {
        occupied.set(w.id, (occupied.get(w.id) || 0) + 1);
        const profileId = t.execution?.profileId || w.profiles[0]?.id,
          p = w.profiles.find((p) => p.id === profileId);
        if (
          !p ||
          (t.execution && t.execution.provider !== p.provider) ||
          (t.provider && t.provider !== "auto" && t.provider !== p.provider)
        )
          throw Error("Ungültiges Ausführungsprofil");
        const profileUse = (profileOccupancy.get(profileId) || 0) + 1;
        if (profileUse > p.maxParallel)
          throw Error("Profilkapazität überschritten");
        profileOccupancy.set(profileId, profileUse);
      }
      if (
        (t.pr != null && (!Number.isSafeInteger(t.pr) || t.pr < 1)) ||
        (["review", "done"].includes(t.status) && !t.pr)
      )
        throw Error("PR-Verknüpfung fehlt");
      if (t.provider && !["auto", "claude", "codex"].includes(t.provider))
        throw Error("Ungültiger Provider");
      return {
        ...t,
        lineId,
        provider: t.provider || "auto",
        execution:
          t.execution ||
          (active(t)
            ? {
                provider: w.profiles[0]?.provider || "claude",
                profileId: w.profiles[0]?.id || w.id + "-claude",
              }
            : null),
        title: t.title.slice(0, 120),
        criteria: t.criteria.slice(0, 3000),
        worker: active(t) ? w.id : null,
        iterationBranch:
          typeof t.iterationBranch === "string"
            ? t.iterationBranch
            : "iteration/2026-W42",
        priority: t.priority === 2 ? 2 : 1,
        attempt: Math.max(0, Number.isSafeInteger(t.attempt) ? t.attempt : 0),
        approved: !!t.approved,
        failures: Number.isSafeInteger(t.failures)
          ? Math.max(0, t.failures)
          : 0,
        check: ["review", "done"].includes(t.status)
          ? "passed"
          : t.status === "checks"
            ? "running"
            : t.check || "pending",
        lease: active(t) ? `FT-${t.id}/a${t.attempt || 1}` : null,
        history: Array.isArray(t.history)
          ? t.history
              .filter((h) => h && typeof h.text === "string")
              .slice(-40)
              .map((h) => ({
                text: h.text.slice(0, 4000),
                tick: Number.isSafeInteger(h.tick) ? h.tick : 0,
              }))
          : [{ tick: 0, text: "Demo-Ausgangszustand: " + labels[t.status] }],
      };
    });
    let draftNext = Math.max(42, ...tasks.map((t) => t.pr || 0)) + 1;
    for (const t of tasks.filter(active)) t.pr = t.pr || draftNext++;
    return {
      schema: 5,
      ...catalog,
      selectedLineId: catalog.lines.some((l) => l.id === raw.selectedLineId)
        ? raw.selectedLineId
        : catalog.lines[0].id,
      workers,
      tasks,
      events: raw.events
        .filter((e) => e && typeof e.text === "string")
        .slice(0, 60)
        .map((e) => ({
          ...e,
          tick: Number.isSafeInteger(e.tick) ? e.tick : 0,
        })),
      tick: Number.isSafeInteger(raw.tick) ? Math.max(0, raw.tick) : 0,
      next: Math.max(100, ...tasks.map((t) => t.id)) + 1,
      prNext:
        Math.max(
          42,
          ...tasks.map((t) => t.pr || 0),
          ...tasks.flatMap((t) =>
            (t.closedPrs || []).filter(Number.isSafeInteger),
          ),
        ) + 1,
    };
  }

  return {
    seed,
    normalize,
  };
}
