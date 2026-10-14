/* Pure, local-only concept simulation. No network, provider, DOM or Git operations. */
export const projects = [
  {
    id: "atlas",
    name: "Atlas ERP",
    team: "Team Enterprise",
    stack: "Vue · Node.js · PostgreSQL",
    repo: "enterprise/atlas-erp",
    color: "#8be0b8",
  },
  {
    id: "portal",
    name: "Kundenportal",
    team: "Team Experience",
    stack: "React · Node.js · REST",
    repo: "experience/kundenportal",
    color: "#81b6ee",
  },
  {
    id: "field",
    name: "Field Service",
    team: "Team Operations",
    stack: "Angular · NestJS · PostgreSQL",
    repo: "operations/field-service",
    color: "#edc47e",
  },
];
export const states = [
  "queued",
  "running",
  "checks",
  "review",
  "changes",
  "blocked",
  "done",
];
export const labels = {
  queued: "Warteschlange",
  running: "Umsetzung",
  checks: "Qualitätsprüfung",
  review: "PR / Review",
  changes: "Nacharbeit",
  blocked: "Klärung",
  done: "Abgeschlossen",
};
const project = (id) => projects.find((p) => p.id === id),
  active = (t) => ["running", "checks"].includes(t.status),
  waiting = (t) => ["queued", "changes"].includes(t.status);
const demoCommits = {
  atlas: "a".repeat(40),
  portal: "b".repeat(40),
  field: "c".repeat(40),
};
export const STORAGE_KEY = "werk-factory-v1";
export function createConceptSimulation(saved) {
  let data,
    currentLineId = null,
    filter = "all";
  function defaultFactoryCatalog() {
    return {
      factories: [
        { id: "factory-werk", name: "Werk", parentId: null },
        {
          id: "factory-products",
          name: "Digitale Produkte",
          parentId: "factory-werk",
        },
        {
          id: "factory-service",
          name: "Service Operations",
          parentId: "factory-werk",
        },
      ],
      lines: projects.map((p) => ({
        id: "line-" + p.id,
        name: p.name,
        factoryId: p.id === "field" ? "factory-service" : "factory-products",
        projectId: p.id,
        orchestratorId: "orchestrator-" + p.id,
      })),
    };
  }

  function validateFactoryCatalog(raw) {
    const fallback = defaultFactoryCatalog(),
      factories = raw.factories ?? fallback.factories,
      lines = raw.lines ?? fallback.lines;
    if (
      !Array.isArray(factories) ||
      !factories.length ||
      !Array.isArray(lines) ||
      !lines.length
    )
      throw Error("Factory-Katalog fehlt");
    const ids = new Set(),
      lineIds = new Set(),
      orchestrators = new Set();
    for (const f of factories) {
      if (
        !f ||
        typeof f.id !== "string" ||
        !/^factory-[a-z0-9-]+$/.test(f.id) ||
        ids.has(f.id) ||
        typeof f.name !== "string" ||
        !f.name.trim() ||
        f.name.length > 80
      )
        throw Error("Ungültige Factory");
      ids.add(f.id);
    }
    for (const f of factories) {
      let node = f;
      const seen = new Set();
      while (node) {
        if (seen.has(node.id)) throw Error("Factory-Zyklus verhindert");
        seen.add(node.id);
        if (node.parentId != null && !ids.has(node.parentId))
          throw Error("Übergeordnete Factory fehlt");
        node = factories.find((x) => x.id === node.parentId);
      }
    }
    for (const l of lines) {
      if (
        !l ||
        typeof l.id !== "string" ||
        !/^line-[a-z0-9-]+$/.test(l.id) ||
        lineIds.has(l.id) ||
        !ids.has(l.factoryId) ||
        !project(l.projectId) ||
        typeof l.name !== "string" ||
        !l.name.trim() ||
        l.name.length > 80 ||
        typeof l.orchestratorId !== "string" ||
        !/^orchestrator-[a-z0-9-]+$/.test(l.orchestratorId) ||
        orchestrators.has(l.orchestratorId)
      )
        throw Error("Ungültige Produktionslinie");
      lineIds.add(l.id);
      orchestrators.add(l.orchestratorId);
    }
    return {
      factories: factories.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId ?? null,
      })),
      lines: lines.map((l) => ({ ...l })),
    };
  }

  function lineForProject(projectId, lineId = null) {
    const selected = data.lines.find(
        (l) => l.id === (lineId || currentLineId) && l.projectId === projectId,
      ),
      line =
        selected ||
        (!lineId && data.lines.find((l) => l.projectId === projectId));
    if (!line) throw Error("Produktionslinie passt nicht zum Projekt");
    return line;
  }

  function selectedLine() {
    return data.lines.find((l) => l.id === currentLineId) || data.lines[0];
  }

  function factoryPath(id) {
    const names = [];
    let f = data.factories.find((f) => f.id === id);
    while (f) {
      names.unshift(f.name);
      f = data.factories.find((x) => x.id === f.parentId);
    }
    return names.join(" / ");
  }

  function createFactory(name, parentId = null) {
    name = String(name).trim();
    if (!name || name.length > 80)
      throw Error("Factory-Name benötigt 1–80 Zeichen");
    if (parentId && !data.factories.some((f) => f.id === parentId))
      throw Error("Übergeordnete Factory fehlt");
    let n = 1;
    while (data.factories.some((f) => f.id === "factory-" + n)) n++;
    const f = { id: "factory-" + n, name, parentId: parentId || null };
    data.factories.push(f);
    record("Factory " + name + " angelegt.");
    return f;
  }

  function updateFactory(id, name, parentId) {
    const f = data.factories.find((f) => f.id === id);
    if (!f) throw Error("Factory fehlt");
    const next = {
      ...f,
      name: String(name).trim(),
      parentId: parentId || null,
    };
    validateFactoryCatalog({
      ...data,
      factories: data.factories.map((x) => (x.id === id ? next : x)),
    });
    Object.assign(f, next);
    record("Factory " + f.name + " aktualisiert.");
    return f;
  }

  function createLine(factoryId, name, projectId) {
    if (!data.factories.some((f) => f.id === factoryId) || !project(projectId))
      throw Error("Factory oder Projekt fehlt");
    name = String(name).trim();
    if (!name || name.length > 80)
      throw Error("Linienname benötigt 1–80 Zeichen");
    let n = 1;
    while (data.lines.some((l) => l.id === "line-" + n)) n++;
    const l = {
      id: "line-" + n,
      name,
      factoryId,
      projectId,
      orchestratorId: "orchestrator-line-" + n,
    };
    data.lines.push(l);
    record(
      "Produktionslinie " +
        name +
        " mit einem Orchestrator und ohne Worker angelegt.",
    );
    return l;
  }

  function assignWorkerToLine(workerId, lineId) {
    const w = data.workers.find((w) => w.id === workerId),
      l = data.lines.find((l) => l.id === lineId);
    if (!w || !l || w.project !== l.projectId)
      throw Error("Worker und Linie müssen zum selben Projekt gehören");
    if (workerTasks(w).length)
      throw Error("Aktive Versuche zuerst abschließen");
    w.lineId = lineId;
    record(w.id + " wurde ausdrücklich der Linie " + l.name + " zugewiesen.");
    return w;
  }

  function factoryDescendants(id) {
    const result = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of data.factories)
        if (result.has(f.parentId) && !result.has(f.id)) {
          result.add(f.id);
          changed = true;
        }
    }
    return result;
  }

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
    const catalog = validateFactoryCatalog(raw);
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
        maxParallel: boundedInteger(w.maxParallel, 1, 1, 8),
        systemPrompt:
          typeof w.systemPrompt === "string"
            ? w.systemPrompt.slice(0, 20000)
            : "Implementiere das Feature anhand des versionierten Projektkontexts. Befolge die Factory-Policy und liefere prüfbare Nachweise.",
        configVersion: boundedInteger(w.configVersion, 1, 1, 1000000),
        timeoutSeconds: boundedInteger(w.timeoutSeconds, 900, 60, 3600),
        profiles: validProfiles(w.profiles, w.id),
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
      if (t.context) validateContext(t.context, t.project);
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

  function record(text, t = null) {
    const e = {
      tick: data.tick,
      time: new Date().toLocaleTimeString("de-DE"),
      text,
      lineId: t?.lineId || null,
      project: t?.project || null,
    };
    data.events.unshift(e);
    data.events = data.events.slice(0, 60);
    if (t) {
      t.history.push({ tick: data.tick, text });
      t.history = t.history.slice(-40);
    }
  }

  function workerTasks(w) {
    return data.tasks.filter((t) => t.worker === w.id && active(t));
  }

  function busy(w) {
    return data.tasks.find((t) => t.worker === w.id && active(t));
  }

  function freeSlots(w, t = null) {
    if (!w.online || w.paused || w.quota) return 0;
    const activeTasks = workerTasks(w),
      profileSlots = eligibleProfiles(w, t).reduce(
        (sum, p) =>
          sum +
          (p.maxParallel || 1) -
          activeTasks.filter((x) => x.execution?.profileId === p.id).length,
        0,
      );
    return Math.max(
      0,
      Math.min((w.maxParallel || 1) - activeTasks.length, profileSlots),
    );
  }

  function available(w, t = null) {
    return freeSlots(w, t) > 0;
  }

  function boundedInteger(value, fallback, min, max) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw Error(
        "Konfiguration benötigt eine ganze Zahl zwischen " +
          min +
          " und " +
          max,
      );
    return value;
  }

  function taskList() {
    return data.tasks.filter(
      (t) =>
        (!currentLineId || t.lineId === currentLineId) &&
        (filter === "all" || t.project === filter),
    );
  }

  function workerList() {
    return data.workers.filter(
      (w) =>
        (!currentLineId || w.lineId === currentLineId) &&
        (filter === "all" || w.project === filter),
    );
  }

  function workerStatus(w) {
    return !w.online
      ? "Offline"
      : w.quota
        ? "Limit erreicht"
        : w.paused
          ? busy(w)
            ? "Laufende Tasks abschließen"
            : "Zuweisung pausiert"
          : busy(w)
            ? "Beschäftigt"
            : !eligibleProfiles(w).length
              ? "Kein bereites Profil"
              : "Verfügbar";
  }

  function waitReason(t) {
    if (t.status === "blocked")
      return t.blockReason || "Entscheidung des Projektteams erforderlich";
    if (t.status === "review")
      return t.approved
        ? "Review freigegeben · Merge ausstehend"
        : "Review des Projektteams ausstehend";
    if (!waiting(t)) return "";
    const ws = data.workers.filter(
      (w) => w.lineId === t.lineId && w.project === t.project,
    );
    if (!ws.length)
      return "Keine Maschine für diese Produktionslinie registriert";
    if (!ws.some((w) => w.online)) return "Alle Projektmaschinen sind offline";
    if (!ws.some((w) => w.online && !w.quota && !w.paused))
      return "Projektmaschinen pausiert oder am Limit";
    if (!ws.some((w) => eligibleProfiles(w, t).length))
      return (
        "Kein bereites " +
        profileName(t.provider) +
        "-Profil für dieses Projekt"
      );
    if (!ws.some((w) => available(w, t)))
      return "Alle passenden Slots sind belegt";
    return "Passende Maschine frei · bereit für nächsten Takt";
  }

  function release(t) {
    if (
      active(t) &&
      !t.snapshots?.some((x) => x.attempt === t.attempt && x.phase === "after")
    )
      demoSnapshot(t, "after", "interrupted");
    t.worker = null;
    t.lease = null;
  }

  function advance() {
    data.tick++;
    let changed = 0;
    for (const t of data.tasks) {
      if (t.status === "running") {
        t.status = "checks";
        t.check = "running";
        record(
          `FT-${t.id}: Umsetzung fertig. Projekttests und Build gestartet.`,
          t,
        );
        changed++;
      } else if (t.status === "checks") {
        demoSnapshot(t, "after");
        t.status = "review";
        t.check = "passed";
        t.pr = t.pr || data.prNext++;
        t.approved = false;
        t.failures = 0;
        release(t);
        record(
          `PR #${t.pr}: Checks erfolgreich. Review bei ${project(t.project).team} angefordert.`,
          t,
        );
        changed++;
      }
    }
    for (const t of data.tasks
      .filter(waiting)
      .sort((a, b) => b.priority - a.priority || a.id - b.id)) {
      const candidates = data.workers.filter(
          (w) =>
            w.lineId === t.lineId && w.project === t.project && available(w, t),
        ),
        w = candidates.find((w) => w.id === t.lastWorkerId) || candidates[0];
      if (w) {
        const chosen = eligibleProfiles(w, t)[0];
        t.execution = { provider: chosen.provider, profileId: chosen.id };
        t.worker = w.id;
        t.status = "running";
        t.check = "pending";
        t.attempt++;
        t.lease = `FT-${t.id}/a${t.attempt}`;
        t.pr = t.pr || data.prNext++;
        t.configVersion = w.configVersion || 1;
        t.startedTick = data.tick;
        t.lastWorkerId = w.id;
        demoSnapshot(t, "before");
        record(
          `Draft PR #${t.pr} → ${t.iterationBranch || "iteration/2026-W42"} geöffnet bzw. fortgeführt; Vorher-Snapshot erfasst.`,
          t,
        );
        record(
          `FT-${t.id} an ${w.id} / ${t.execution.profileId} vergeben. Versuch ${t.attempt}, Lease ${t.lease}.`,
          t,
        );
        changed++;
      }
    }
    return changed;
  }

  function taskAction(id, action) {
    const t = data.tasks.find((t) => t.id === id);
    if (!t) return false;
    if (action === "approve" && t.status === "review" && !t.approved) {
      t.approved = true;
      record(`PR #${t.pr}: Review freigegeben.`, t);
    } else if (
      action === "merge" &&
      t.status === "review" &&
      t.approved &&
      t.check === "passed"
    ) {
      t.status = "done";
      t.merged = true;
      record(`PR #${t.pr} gemerged. FT-${t.id} abgeschlossen.`, t);
    } else if (action === "changes" && t.status === "review") {
      t.status = "changes";
      t.approved = false;
      t.check = "pending";
      record(`PR #${t.pr}: Änderungen angefordert; Nacharbeit eingereiht.`, t);
    } else if (action === "failed" && t.status === "checks") {
      demoSnapshot(t, "after", "checks_failed");
      t.failures++;
      t.status = t.failures >= 3 ? "blocked" : "changes";
      t.approved = false;
      t.check = "failed";
      release(t);
      t.blockReason =
        t.status === "blocked"
          ? "Drei Prüfversuche fehlgeschlagen. Kriterien und Testumgebung prüfen."
          : "";
      record(
        `FT-${t.id}: Checks fehlgeschlagen (${t.failures}/3). ${t.status === "blocked" ? "Teamentscheidung erforderlich." : "Nacharbeit eingereiht."}`,
        t,
      );
    } else if (action === "closed" && t.status === "review") {
      t.closedPrs = [...(t.closedPrs || []), t.pr];
      t.pr = null;
      t.approved = false;
      t.status = "blocked";
      t.check = "pending";
      t.blockReason =
        "PR ohne Merge geschlossen. Neuplanung mit dem Projektteam erforderlich.";
      record(
        `PR #${t.closedPrs.at(-1)} ohne Merge geschlossen. Auftrag zur Klärung angehalten.`,
        t,
      );
    } else if (
      action === "retry" &&
      t.status === "blocked" &&
      t.requirementResolution !== "unresolved"
    ) {
      t.status = t.pr ? "changes" : "queued";
      t.failures = 0;
      t.blockReason = "";
      t.approved = false;
      record(`FT-${t.id}: Projektteam hat erneute Umsetzung freigegeben.`, t);
    } else return false;
    return true;
  }

  function updateWorker(id, action) {
    const w = data.workers.find((w) => w.id === id);
    if (!w) return false;
    if (action === "online") w.online = !w.online;
    if (action === "pause") w.paused = !w.paused;
    if (action === "quota") w.quota = !w.quota;
    if (!w.online || w.quota) {
      for (const t of workerTasks(w)) {
        release(t);
        t.status = t.pr ? "changes" : "queued";
        t.check = "pending";
        t.approved = false;
        record(
          `FT-${t.id}: ${w.id} ${!w.online ? "offline" : "am Nutzungslimit"}. Lease ungültig; Neuvergabe erforderlich.`,
          t,
        );
      }
    }
    record(`${w.id}: ${workerStatus(w)}.`);
    return true;
  }

  function addTask(values) {
    if (
      !project(values.project) ||
      !values.title.trim() ||
      (!values.criteria.trim() && !values.requirementRef)
    )
      throw Error("Titel und Akzeptanzkriterien sind erforderlich.");
    if (
      values.provider &&
      !["auto", "claude", "codex"].includes(values.provider)
    )
      throw Error("Provider nicht verfügbar");
    const line = lineForProject(values.project, values.lineId);
    const t = {
      id: data.next++,
      lineId: line.id,
      provider: values.provider || "auto",
      execution: null,
      title: values.title.trim().slice(0, 120),
      project: values.project,
      criteria: values.criteria.trim().slice(0, 3000),
      iterationBranch: "iteration/2026-W42",
      priority: values.priority === 2 ? 2 : 1,
      status: "queued",
      worker: null,
      lease: null,
      attempt: 0,
      failures: 0,
      check: "pending",
      approved: false,
      history: [],
    };
    data.tasks.push(t);
    record(
      `FT-${t.id}: Feature für ${project(t.project).name} eingereicht.`,
      t,
    );
    return t;
  }

  function addWorker(p, lineId = null) {
    if (!project(p)) throw Error("Projekt fehlt");
    const id =
      "W-" +
      String(
        Math.max(0, ...data.workers.map((w) => Number(w.id.slice(2)))) + 1,
      ).padStart(2, "0");
    data.workers.push({
      id,
      project: p,
      lineId: lineForProject(p, lineId).id,
      online: true,
      paused: false,
      quota: false,
      profiles: defaultProfiles(id),
    });
    record(`${id}: Für ${project(p).name} registriert.`);
    return id;
  }

  function topology(lineId = currentLineId) {
    const ps = projects.filter(
        (p) =>
          (!lineId ||
            data.lines.find((l) => l.id === lineId)?.projectId === p.id) &&
          (filter === "all" || filter === p.id),
      ),
      nodes = [],
      edges = [],
      scopedTasks = data.tasks.filter((t) => !lineId || t.lineId === lineId);
    let cursor = 0;
    for (const p of ps) {
      const ws = data.workers.filter(
          (w) => (!lineId || w.lineId === lineId) && w.project === p.id,
        ),
        rows = Math.max(1, Math.ceil(ws.length / 2)),
        z = cursor + (rows - 1) * 65;
      nodes.push({
        id: p.id,
        kind: "team",
        x: -430,
        z,
        h: 35,
        w: 98,
        d: 68,
        name: p.name,
        sub: p.team,
        color: p.color,
      });
      nodes.push({
        id: "repo:" + p.id,
        kind: "repo",
        x: 390,
        z,
        h: 55,
        w: 90,
        d: 72,
        name: "Git · " + p.name,
        sub:
          scopedTasks.filter((t) => t.project === p.id && t.status === "review")
            .length + " PRs im Review",
        color: p.color,
      });
      edges.push({
        from: p.id,
        to: "orchestrator",
        kind: "command",
        color: p.color,
        animate: scopedTasks.some((t) => t.project === p.id && waiting(t)),
      });
      ws.forEach((w, i) => {
        nodes.push({
          id: w.id,
          kind: "worker",
          x: 30 + (i % 2) * 115,
          z: cursor + Math.floor(i / 2) * 130,
          h: 65,
          w: 62,
          d: 62,
          name: w.id,
          sub: busy(w) ? "FT-" + busy(w).id : workerStatus(w),
          color: w.online ? p.color : "#70828b",
          worker: w,
        });
        edges.push(
          {
            from: "orchestrator",
            to: w.id,
            kind: "command",
            color: p.color,
            animate: !!busy(w),
          },
          {
            from: w.id,
            to: "repo:" + p.id,
            kind: "git",
            color: p.color,
            animate: busy(w)?.status === "checks",
          },
        );
      });
      edges.push({
        from: "repo:" + p.id,
        to: "orchestrator",
        kind: "feedback",
        color: p.color,
        animate: scopedTasks.some(
          (t) => t.project === p.id && t.status === "review",
        ),
      });
      cursor += rows * 130 + 110;
    }
    const center = (cursor - 240) / 2;
    nodes.forEach((n) => (n.z -= center));
    nodes.push({
      id: "orchestrator",
      kind: "orchestrator",
      x: -205,
      z: 0,
      h: 110,
      w: 112,
      d: 100,
      name: "Orchestrator",
      sub: lineId
        ? data.lines.find((l) => l.id === lineId)?.name || "Linie"
        : "Taskboard · Scheduler",
      color: "#bfe5d5",
    });
    return { nodes, edges };
  }

  function repoNotes(id) {
    const feature =
      id === "atlas"
        ? "Bestellfreigabe"
        : id === "portal"
          ? "Rechnungsdownload"
          : "Einsatzplanung";
    return [
      {
        path: "requirements/" + feature + ".md",
        aliases: ["Featureanforderungen"],
        text:
          "# " +
          feature +
          "\n\n## Ziel\n" +
          (id === "atlas"
            ? "Bestellungen nachvollziehbar freigeben."
            : id === "portal"
              ? "Eigene Rechnungen sicher als PDF herunterladen."
              : "Techniker nach Qualifikation und Verfügbarkeit planen.") +
          "\n\n## Regeln\n" +
          (id === "atlas"
            ? "Ab 5.000 EUR sind zwei unterschiedliche Freigaben notwendig."
            : id === "portal"
              ? "Zugriff nur auf Rechnungen des eigenen Kundenkontos."
              : "Nur qualifizierte und verfügbare Techniker dürfen zugewiesen werden.") +
          " ^regel-1\n\n## Akzeptanz\nErfolgsfall, Grenzfälle und fehlende Berechtigung sind getestet.",
      },
      {
        path: "architecture/System.md",
        aliases: ["Systemarchitektur"],
        text:
          "# System\n\n## Grenzen\nUI, Anwendung und Domäne sind getrennt. Der Zugriff auf Infrastruktur erfolgt über Ports.\n\n## Stack\n" +
          project(id).stack,
      },
      {
        path: "quality/Definition of Done.md",
        aliases: ["DoD"],
        text: "# Definition of Done\n\n## Checks\nBuild, Typprüfung und Projekttests sind erfolgreich. Akzeptanzkriterien sind mit Nachweisen belegt.\n\n## Review\nPR enthält Testnachweise und fordert Review beim Projektteam an.",
      },
      {
        path: "domain/Glossar.md",
        aliases: [],
        text: "# Glossar\n\n## Begriffe\nFachbegriffe werden im Projekt einheitlich verwendet.",
      },
      {
        path: "legacy/Glossar.md",
        aliases: [],
        text: "# Glossar\n\n## Begriffe\nHistorische Begriffe; nicht ohne Rücksprache auf neue Features übertragen.",
      },
    ];
  }

  function parseWiki(raw) {
    const source = raw.trim();
    const m = source.match(/^\[\[([^\[\]\r\n]+)\]\]$/);
    if (!m)
      return {
        raw,
        error: "Wikilink erwartet: [[Pfad/Notiz#Abschnitt|Anzeige]]",
      };
    const parts = m[1].split("|");
    if (parts.length > 2)
      return { raw, error: "Nur ein Anzeigealias mit | ist zulässig." };
    const target = parts[0].trim(),
      hash = target.indexOf("#"),
      path = (hash < 0 ? target : target.slice(0, hash)).trim(),
      anchor = hash < 0 ? null : target.slice(hash + 1).trim();
    if (!path)
      return {
        raw,
        error:
          "Im Intake ist ein Notizpfad erforderlich; [[#Abschnitt]] hat keine Ausgangsnotiz.",
      };
    if (
      /[:\\%\u0000]/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((x) => !x || x === ".." || x === ".")
    )
      return {
        raw,
        error: "Nur Pfade innerhalb des Projekt-Vaults sind zulässig.",
      };
    if (anchor !== null && (!anchor || anchor.includes("#")))
      return {
        raw,
        error:
          "Im Demo-Resolver wird genau eine Überschrift oder #^Block-ID unterstützt.",
      };
    return {
      raw: source,
      path: path.endsWith(".md") ? path : path + ".md",
      anchor,
      label: parts[1]?.trim() || target,
    };
  }

  function resolveWiki(raw, id) {
    const parsed = parseWiki(raw);
    if (parsed.error) return parsed;
    const notes = repoNotes(id),
      full = parsed.path,
      short = full.replace(/\.md$/, "");
    let candidates = notes.filter((n) => n.path === full);
    if (!candidates.length && !short.includes("/"))
      candidates = notes.filter(
        (n) => n.path.split("/").at(-1) === full || n.aliases.includes(short),
      );
    if (!candidates.length)
      return { ...parsed, error: "Notiz im Demo-Index nicht gefunden." };
    if (candidates.length > 1)
      return {
        ...parsed,
        error: "Mehrdeutig. Bitte den vollständigen Vault-Pfad verwenden.",
        candidates: candidates.map((n) => n.path),
      };
    const note = candidates[0];
    let excerpt = note.text,
      selector = parsed.anchor ? "heading" : "file";
    if (parsed.anchor?.startsWith("^")) {
      selector = "block";
      const block = parsed.anchor.slice(1);
      if (!/^[a-zA-Z0-9-]+$/.test(block))
        return { ...parsed, error: "Ungültige Block-ID." };
      const found = note.text
        .split(/\n\s*\n/)
        .filter((p) =>
          p
            .split("\n")
            .some(
              (line) => line.endsWith(" ^" + block) || line === "^" + block,
            ),
        );
      if (found.length !== 1)
        return { ...parsed, error: "Block-ID nicht eindeutig vorhanden." };
      excerpt = found[0];
    } else if (parsed.anchor) {
      const lines = note.text.split("\n"),
        matches = [];
      lines.forEach((line, i) => {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading && heading[2] === parsed.anchor)
          matches.push({ i, level: heading[1].length });
      });
      if (matches.length !== 1)
        return { ...parsed, error: "Überschrift nicht eindeutig vorhanden." };
      const start = matches[0];
      let end = lines.length;
      for (let i = start.i + 1; i < lines.length; i++) {
        const h = lines[i].match(/^(#{1,6})\s+/);
        if (h && h[1].length <= start.level) {
          end = i;
          break;
        }
      }
      excerpt = lines.slice(start.i, end).join("\n").trim();
    }
    return {
      ...parsed,
      vaultPath: note.path,
      repoPath: "docs/" + note.path,
      selector,
      excerpt,
      commit: demoCommits[id],
    };
  }

  function resolveContext(text, id) {
    if (!project(id))
      return { ok: false, entries: [], errors: ["Unbekanntes Projekt"] };
    if (!text.trim()) return { ok: true, entries: [], errors: [] };
    const entries = [],
      errors = [],
      seen = new Set();
    for (const line of text
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      if (entries.length >= 12) {
        errors.push("Maximal zwölf Kontextlinks je Auftrag.");
        break;
      }
      const r = resolveWiki(line, id);
      if (r.error) {
        entries.push(r);
        errors.push(r.error);
      } else {
        const key = r.repoPath + "#" + (r.anchor || "");
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(r);
        }
      }
    }
    return { ok: errors.length === 0, entries, errors };
  }

  function contextManifest(draft) {
    const r = resolveContext(draft.links, draft.project);
    if (!r.ok)
      throw Error("Bitte fehlende oder mehrdeutige Kontextlinks korrigieren.");
    return {
      schemaVersion: 1,
      resolverVersion: "demo-v1",
      projectId: draft.project,
      repository: project(draft.project).repo,
      vaultRoot: "docs",
      baseRef: "iteration/2026-W42",
      baseCommit: demoCommits[draft.project],
      source: "Demo-Index; kein Git-Zugriff",
      references: r.entries.map((e) => ({
        raw: e.raw,
        path: e.repoPath,
        anchor: e.anchor,
        selector: e.selector,
        excerpt: e.excerpt,
      })),
      traversal: { mode: "explicit-links", depth: 0, maxReferences: 12 },
    };
  }

  function defaultProfiles(workerId) {
    return ["claude", "codex"].map((provider) => ({
      id: workerId + "-" + provider,
      provider,
      label:
        provider === "claude" ? "Claude Subscription" : "Codex Subscription",
      enabled: true,
      authenticated: true,
      limited: false,
      maxParallel: 1,
      authMode: "subscription",
    }));
  }

  function validProfiles(raw, id) {
    if (raw === undefined) return defaultProfiles(id);
    if (!Array.isArray(raw)) throw Error("Ungültige Provider-Profile");
    const seen = new Set();
    return raw.map((p) => {
      if (
        !p ||
        !["claude", "codex"].includes(p.provider) ||
        typeof p.id !== "string" ||
        !/^W-\d+-(claude|codex)(-\d+)?$/.test(p.id) ||
        !p.id.startsWith(id + "-") ||
        seen.has(p.id)
      )
        throw Error("Ungültiges Provider-Profil");
      seen.add(p.id);
      return {
        id: p.id,
        provider: p.provider,
        label: typeof p.label === "string" ? p.label.slice(0, 80) : p.provider,
        enabled: p.enabled !== false,
        authenticated: p.authenticated !== false,
        limited: !!p.limited,
        maxParallel: boundedInteger(p.maxParallel, 1, 1, 8),
        authMode: "subscription",
      };
    });
  }

  function profileName(id) {
    return id === "claude"
      ? "Claude Code"
      : id === "codex"
        ? "Codex"
        : id === "cursor"
          ? "Cursor"
          : "Automatisch";
  }

  function profileState(p) {
    return !p.enabled
      ? "Deaktiviert"
      : !p.authenticated
        ? "Anmeldung erforderlich"
        : p.limited
          ? "Limit erreicht"
          : "Bereit";
  }

  function eligibleProfiles(w, t = null) {
    return (w.profiles || []).filter(
      (p) =>
        p.enabled &&
        p.authenticated &&
        !p.limited &&
        workerTasks(w).filter((x) => x.execution?.profileId === p.id).length <
          (p.maxParallel || 1) &&
        (!t ||
          !t.provider ||
          t.provider === "auto" ||
          p.provider === t.provider),
    );
  }

  function setProfileState(workerId, profileId, action) {
    const w = data.workers.find((w) => w.id === workerId),
      p = w?.profiles.find((p) => p.id === profileId);
    if (!p) return false;
    const key = { enable: "enabled", auth: "authenticated", limit: "limited" }[
      action
    ];
    if (!key) return false;
    p[key] = !p[key];
    w.quota = false;
    for (const t of workerTasks(w))
      if (
        t.execution?.profileId === p.id &&
        (!p.enabled || !p.authenticated || p.limited)
      ) {
        release(t);
        t.status = "blocked";
        t.check = "pending";
        t.approved = false;
        t.blockReason = `Profil ${p.id}: ${profileState(p)}. Versuch gestoppt; erneute Freigabe erforderlich.`;
        record(`FT-${t.id}: ${t.blockReason}`, t);
      }
    record(`${w.id} / ${p.id}: ${profileState(p)}.`);
    return true;
  }

  function validateContext(c, p) {
    if (
      c.schemaVersion !== 1 ||
      c.projectId !== p ||
      typeof c.baseCommit !== "string" ||
      !/^[a-f0-9]{40}$/.test(c.baseCommit) ||
      typeof c.vaultRoot !== "string" ||
      typeof c.source !== "string" ||
      !Array.isArray(c.references) ||
      c.references.length > 12
    )
      throw Error("Ungültiges Kontextmanifest");
    for (const r of c.references) {
      if (
        !r ||
        typeof r.raw !== "string" ||
        typeof r.path !== "string" ||
        !r.path.startsWith("docs/") ||
        r.path.split("/").includes("..") ||
        typeof r.excerpt !== "string" ||
        (r.anchor != null && typeof r.anchor !== "string")
      )
        throw Error("Ungültige Kontextreferenz");
    }
  }

  function reviseTaskRequirement(id, requirementRef) {
    const t = data.tasks.find((t) => t.id === id);
    if (
      !t ||
      t.status !== "blocked" ||
      t.requirementResolution !== "unresolved" ||
      t.attempt !== 0
    )
      throw Error(
        "Nur noch nicht gestartete Requirements in Klärung können korrigiert werden.",
      );
    const parsed = parseWiki(requirementRef);
    if (parsed.error) throw Error(parsed.error);
    const resolution = resolveWiki(parsed.raw, t.project);
    t.requirementRef = parsed.raw;
    t.title = parsed.path.split("/").at(-1).replace(/\.md$/, "");
    t.intakeRevision = (t.intakeRevision || 1) + 1;
    if (resolution.error) {
      t.blockReason =
        "Requirement-Auflösung erforderlich: " +
        resolution.error +
        " Kein echter Vault verbunden.";
      record(
        "FT-" +
          t.id +
          ": Requirement-Referenz korrigiert; Klärung bleibt offen.",
        t,
      );
    } else {
      t.context = contextManifest({ project: t.project, links: parsed.raw });
      t.requirementResolution = "demo_resolved";
      t.status = "queued";
      t.blockReason = "";
      record(
        "FT-" +
          t.id +
          ": Korrigiertes Requirement im Demo-Index aufgelöst und eingereiht.",
        t,
      );
    }
    return t;
  }

  function addVaultTask(projectId, requirementRef, lineId = null) {
    const parsed = parseWiki(requirementRef);
    if (parsed.error) throw Error(parsed.error);
    const resolution = resolveWiki(parsed.raw, projectId),
      t = addTask({
        project: projectId,
        lineId,
        requirementRef: parsed.raw,
        title: parsed.path.split("/").at(-1).replace(/\.md$/, ""),
        criteria: "",
        provider: "auto",
        priority: 1,
      });
    t.requirementRef = parsed.raw;
    t.requirementResolution = resolution.error ? "unresolved" : "demo_resolved";
    if (resolution.error) {
      t.status = "blocked";
      t.blockReason =
        "Requirement-Auflösung erforderlich: " +
        resolution.error +
        " Kein echter Vault verbunden.";
      record(
        "FT-" +
          t.id +
          ": Referenz gespeichert; Umsetzung wartet auf eindeutig aufgelösten Projektkontext.",
        t,
      );
    } else {
      t.context = contextManifest({ project: projectId, links: parsed.raw });
      record(
        "FT-" +
          t.id +
          ": Requirement im Demo-Index aufgelöst; Inhalt bleibt im Kontextmanifest.",
        t,
      );
    }
    return t;
  }

  function applyWorkerConfiguration(w, config) {
    if (!w) throw Error("Worker fehlt.");
    if (workerTasks(w).length)
      throw Error("Aktive Versuche zuerst abschließen.");
    const maxParallel = boundedInteger(config.maxParallel, 1, 1, 8),
      timeoutSeconds = boundedInteger(config.timeoutSeconds, 900, 60, 3600);
    if (
      typeof config.systemPrompt !== "string" ||
      !config.systemPrompt.trim() ||
      config.systemPrompt.length > 20000
    )
      throw Error("Systemprompt muss 1 bis 20.000 Zeichen enthalten.");
    const limits = w.profiles.map((p) => ({
      id: p.id,
      maxParallel: boundedInteger(
        config.profiles.find((x) => x.id === p.id)?.maxParallel,
        p.maxParallel || 1,
        1,
        8,
      ),
    }));
    Object.assign(w, {
      maxParallel,
      timeoutSeconds,
      systemPrompt: config.systemPrompt,
      configVersion: (w.configVersion || 1) + 1,
    });
    for (const limit of limits)
      w.profiles.find((p) => p.id === limit.id).maxParallel = limit.maxParallel;
    record(
      `${w.id}: Konfiguration v${w.configVersion}, ${w.maxParallel} parallele Tasks.`,
    );
  }

  function importIterationFeatures(projectId, lineId = null) {
    if (!project(projectId)) throw Error("Projekt fehlt.");
    const targetLine = lineForProject(projectId, lineId);
    const note = repoNotes(projectId)[0],
      featureNames = {
        atlas: ["Bestellfreigabe", "Audit-Protokoll für Freigaben"],
        portal: ["Rechnungsdownload", "Zugriffsprüfung für Rechnungen"],
        field: ["Einsatzplanung", "Qualifikationen in der Einsatzplanung"],
      };
    let count = 0;
    for (const [index, title] of featureNames[projectId].entries()) {
      const id = "REQ-" + (241 + index);
      if (
        data.tasks.some(
          (t) =>
            t.lineId === targetLine.id &&
            t.project === projectId &&
            t.sourceFeatureId === id &&
            t.iterationBranch === "iteration/2026-W42",
        )
      )
        continue;
      const t = addTask({
        project: projectId,
        lineId: targetLine.id,
        title: title + " aus der Iterationsplanung",
        criteria:
          "Die verlinkten Regeln sind umgesetzt; Erfolgsfall, Grenzfälle und fehlende Berechtigung sind durch Tests belegt.",
        provider: "auto",
        priority: 1,
      });
      t.sourceFeatureId = id;
      t.sourceCommit = demoCommits[projectId];
      t.intakeRevision = 1;
      t.context = contextManifest({
        project: projectId,
        links:
          "[[" + note.path.replace(/\.md$/, "") + "#Regeln]]\n[[DoD#Checks]]",
      });
      count++;
    }
    return count;
  }

  function demoSnapshot(t, phase, outcome = "simulated") {
    t.snapshots = t.snapshots || [];
    if (t.snapshots.some((s) => s.attempt === t.attempt && s.phase === phase))
      return;
    const w = data.workers.find((w) => w.id === t.worker),
      before = t.snapshots.find(
        (s) => s.attempt === t.attempt && s.phase === "before",
      );
    t.snapshots.push({
      schemaVersion: 2,
      id: `FT-${t.id}-a${t.attempt}-${phase}`,
      phase,
      attempt: t.attempt,
      taskId: t.id,
      workerId: t.worker,
      project: t.project,
      lineId: t.lineId,
      profileId: t.execution?.profileId || null,
      configurationVersion: t.configVersion || w?.configVersion || 1,
      capturedAt: new Date().toISOString(),
      tick: data.tick,
      source: "browser_simulation",
      leaseId: t.lease,
      repository: {
        name: project(t.project).repo,
        targetBranch: t.iterationBranch,
        baseCommit: t.sourceCommit || t.context?.baseCommit || null,
        pullRequest: t.pr,
      },
      execution: {
        outcome: phase === "before" ? "pending" : outcome,
        durationMs: null,
        elapsedTicks:
          phase === "after" && before
            ? Math.max(0, data.tick - before.tick)
            : null,
        reason: "Takte sind Simulationsschritte, keine gemessene Laufzeit",
      },
      resources: {
        scope: "worker_process",
        rssBytes: null,
        cpuTimeMs: null,
        reason: "Kein Zugriff auf einen Worker-Prozess",
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        providerReportedCostUsd: null,
        subscriptionAllocation: null,
        reason: "Keine Anbieter-Telemetrie",
      },
      quality: {
        state:
          phase === "before"
            ? "pending"
            : outcome === "checks_failed"
              ? "simulated_failed"
              : outcome === "simulated"
                ? "simulated_passed"
                : "not_evaluated",
        coveragePercent: null,
      },
      artifactPath: `.factory/runs/FT-${t.id}/attempt-${t.attempt}/lease-${t.attempt}/${phase}.json`,
    });
  }

  function snapshotSeries() {
    return taskList()
      .flatMap((t) =>
        (t.snapshots || [])
          .filter((s) => s.phase === "after")
          .map((after) => ({
            task: t,
            after,
            before: (t.snapshots || []).find(
              (s) => s.attempt === after.attempt && s.phase === "before",
            ),
          })),
      )
      .sort((a, b) => a.after.tick - b.after.tick || a.task.id - b.task.id);
  }
  data = saved === undefined ? seed() : normalize(saved);
  currentLineId = data.selectedLineId;
  filter = selectedLine().projectId;
  function chooseLine(id) {
    const line = data.lines.find((item) => item.id === id);
    if (!line) throw Error("Produktionslinie fehlt");
    currentLineId = id;
    data.selectedLineId = id;
    filter = line.projectId;
    return line;
  }
  function factoryLineSummary(line) {
    const workers = data.workers.filter((w) => w.lineId === line.id),
      tasks = data.tasks.filter((t) => t.lineId === line.id);
    return {
      workers,
      tasks,
      online: workers.filter((w) => w.online).length,
      active: tasks.filter(active).length,
      waiting: tasks.filter(waiting).length,
      review: tasks.filter((t) => t.status === "review").length,
      slots: workers.reduce((n, w) => n + (w.maxParallel || 1), 0),
      free: workers.reduce((n, w) => n + freeSlots(w), 0),
      profiles: workers.reduce((n, w) => n + w.profiles.length, 0),
    };
  }
  function factoryMapLayout(factoryId) {
    const root = data.factories.find((f) => f.id === factoryId);
    if (!root) throw Error("Factory fehlt");
    const depthOf = (f) => {
      const children = data.factories.filter((c) => c.parentId === f.id);
      return children.length ? 1 + Math.max(...children.map(depthOf)) : 0;
    };
    const width = 1000 + depthOf(root) * 48,
      boxes = [],
      lanes = [];
    const place = (factory, depth, y) => {
      const x = 16 + depth * 24,
        w = width - 32 - depth * 48,
        box = { factory, depth, x, y, width: w, height: 0 };
      boxes.push(box);
      let cursor = y + 60;
      for (const line of data.lines.filter((l) => l.factoryId === factory.id)) {
        lanes.push({ line, x: x + 16, y: cursor, width: w - 32, height: 160 });
        cursor += 176;
      }
      const children = data.factories.filter((f) => f.parentId === factory.id);
      for (const child of children)
        cursor = place(child, depth + 1, cursor) + 16;
      if (cursor === y + 60) cursor += 64;
      box.height = cursor - y + 8;
      return y + box.height;
    };
    const height = place(root, 0, 16) + 16;
    return { width, height, boxes, lanes };
  }
  function addProfile(workerId, provider) {
    const w = data.workers.find((item) => item.id === workerId);
    if (!w || !["claude", "codex"].includes(provider))
      throw Error("Worker oder Provider fehlt");
    let n = 2;
    while (w.profiles.some((p) => p.id === w.id + "-" + provider + "-" + n))
      n++;
    const p = {
      id: w.id + "-" + provider + "-" + n,
      provider,
      label: profileName(provider) + " Subscription " + n,
      enabled: true,
      authenticated: true,
      limited: false,
      maxParallel: 1,
      authMode: "subscription",
    };
    w.profiles.push(p);
    record(
      w.id + ": Weiteres " + profileName(provider) + "-Profil registriert.",
    );
    return p;
  }
  return {
    factoryLineSummary,
    factoryMapLayout,
    addProfile,
    get data() {
      return data;
    },
    get currentLineId() {
      return currentLineId;
    },
    get filter() {
      return filter;
    },
    set filter(value) {
      if (value !== "all" && !project(value)) throw Error("Projekt fehlt");
      filter = value;
    },
    reset() {
      data = seed();
      chooseLine(data.selectedLineId);
    },
    replace(value) {
      data = normalize(value);
      chooseLine(data.selectedLineId);
    },
    chooseLine,
    defaultFactoryCatalog,
    validateFactoryCatalog,
    lineForProject,
    selectedLine,
    factoryPath,
    createFactory,
    updateFactory,
    createLine,
    assignWorkerToLine,
    factoryDescendants,
    seed,
    normalize,
    record,
    workerTasks,
    busy,
    freeSlots,
    available,
    boundedInteger,
    taskList,
    workerList,
    workerStatus,
    waitReason,
    release,
    advance,
    taskAction,
    updateWorker,
    addTask,
    addWorker,
    topology,
    repoNotes,
    parseWiki,
    resolveWiki,
    resolveContext,
    contextManifest,
    defaultProfiles,
    validProfiles,
    profileName,
    profileState,
    eligibleProfiles,
    setProfileState,
    validateContext,
    reviseTaskRequirement,
    addVaultTask,
    applyWorkerConfiguration,
    importIterationFeatures,
    demoSnapshot,
    snapshotSeries,
  };
}
