import { project, demoCommits } from './simulation-model.mjs';

/** Intake behavior for one isolated, local simulation. */
export function createIntake(state, api) {
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
    const line = api.lineForProject(values.project, values.lineId);
    const t = {
      id: state.data.next++,
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
    state.data.tasks.push(t);
    api.record(
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
        Math.max(0, ...state.data.workers.map((w) => Number(w.id.slice(2)))) + 1,
      ).padStart(2, "0");
    state.data.workers.push({
      id,
      project: p,
      lineId: api.lineForProject(p, lineId).id,
      online: true,
      paused: false,
      quota: false,
      profiles: api.defaultProfiles(id),
    });
    api.record(`${id}: Für ${project(p).name} registriert.`);
    return id;
  }

  function reviseTaskRequirement(id, requirementRef) {
    const t = state.data.tasks.find((t) => t.id === id);
    if (
      !t ||
      t.status !== "blocked" ||
      t.requirementResolution !== "unresolved" ||
      t.attempt !== 0
    )
      throw Error(
        "Nur noch nicht gestartete Requirements in Klärung können korrigiert werden.",
      );
    const parsed = api.parseWiki(requirementRef);
    if (parsed.error) throw Error(parsed.error);
    const resolution = api.resolveWiki(parsed.raw, t.project);
    t.requirementRef = parsed.raw;
    t.title = parsed.path.split("/").at(-1).replace(/\.md$/, "");
    t.intakeRevision = (t.intakeRevision || 1) + 1;
    if (resolution.error) {
      t.blockReason =
        "Requirement-Auflösung erforderlich: " +
        resolution.error +
        " Kein echter Vault verbunden.";
      api.record(
        "FT-" +
          t.id +
          ": Requirement-Referenz korrigiert; Klärung bleibt offen.",
        t,
      );
    } else {
      t.context = api.contextManifest({ project: t.project, links: parsed.raw });
      t.requirementResolution = "demo_resolved";
      t.status = "queued";
      t.blockReason = "";
      api.record(
        "FT-" +
          t.id +
          ": Korrigiertes Requirement im Demo-Index aufgelöst und eingereiht.",
        t,
      );
    }
    return t;
  }

  function addVaultTask(projectId, requirementRef, lineId = null) {
    const parsed = api.parseWiki(requirementRef);
    if (parsed.error) throw Error(parsed.error);
    const resolution = api.resolveWiki(parsed.raw, projectId),
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
      api.record(
        "FT-" +
          t.id +
          ": Referenz gespeichert; Umsetzung wartet auf eindeutig aufgelösten Projektkontext.",
        t,
      );
    } else {
      t.context = api.contextManifest({ project: projectId, links: parsed.raw });
      api.record(
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
    if (api.workerTasks(w).length)
      throw Error("Aktive Versuche zuerst abschließen.");
    const maxParallel = api.boundedInteger(config.maxParallel, 1, 1, 8),
      timeoutSeconds = api.boundedInteger(config.timeoutSeconds, 900, 60, 3600);
    if (
      typeof config.systemPrompt !== "string" ||
      !config.systemPrompt.trim() ||
      config.systemPrompt.length > 20000
    )
      throw Error("Systemprompt muss 1 bis 20.000 Zeichen enthalten.");
    const limits = w.profiles.map((p) => ({
      id: p.id,
      maxParallel: api.boundedInteger(
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
    api.record(
      `${w.id}: Konfiguration v${w.configVersion}, ${w.maxParallel} parallele Tasks.`,
    );
  }

  function importIterationFeatures(projectId, lineId = null) {
    if (!project(projectId)) throw Error("Projekt fehlt.");
    const targetLine = api.lineForProject(projectId, lineId);
    const note = api.repoNotes(projectId)[0],
      featureNames = {
        atlas: ["Bestellfreigabe", "Audit-Protokoll für Freigaben"],
        portal: ["Rechnungsdownload", "Zugriffsprüfung für Rechnungen"],
        field: ["Einsatzplanung", "Qualifikationen in der Einsatzplanung"],
      };
    let count = 0;
    for (const [index, title] of featureNames[projectId].entries()) {
      const id = "REQ-" + (241 + index);
      if (
        state.data.tasks.some(
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
      t.context = api.contextManifest({
        project: projectId,
        links:
          "[[" + note.path.replace(/\.md$/, "") + "#Regeln]]\n[[DoD#Checks]]",
      });
      count++;
    }
    return count;
  }

  return {
    addTask,
    addWorker,
    reviseTaskRequirement,
    addVaultTask,
    applyWorkerConfiguration,
    importIterationFeatures,
  };
}
