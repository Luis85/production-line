import { projects, project, active, waiting } from './simulation-model.mjs';

/** Catalog behavior for one isolated, local simulation. */
export function createCatalog(state, api) {
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
    const selected = state.data.lines.find(
        (l) => l.id === (lineId || state.currentLineId) && l.projectId === projectId,
      ),
      line =
        selected ||
        (!lineId && state.data.lines.find((l) => l.projectId === projectId));
    if (!line) throw Error("Produktionslinie passt nicht zum Projekt");
    return line;
  }

  function selectedLine() {
    return state.data.lines.find((l) => l.id === state.currentLineId) || state.data.lines[0];
  }

  function factoryPath(id) {
    const names = [];
    let f = state.data.factories.find((f) => f.id === id);
    while (f) {
      names.unshift(f.name);
      f = state.data.factories.find((x) => x.id === f.parentId);
    }
    return names.join(" / ");
  }

  function createFactory(name, parentId = null) {
    name = String(name).trim();
    if (!name || name.length > 80)
      throw Error("Factory-Name benötigt 1–80 Zeichen");
    if (parentId && !state.data.factories.some((f) => f.id === parentId))
      throw Error("Übergeordnete Factory fehlt");
    let n = 1;
    while (state.data.factories.some((f) => f.id === "factory-" + n)) n++;
    const f = { id: "factory-" + n, name, parentId: parentId || null };
    state.data.factories.push(f);
    api.record("Factory " + name + " angelegt.");
    return f;
  }

  function updateFactory(id, name, parentId) {
    const f = state.data.factories.find((f) => f.id === id);
    if (!f) throw Error("Factory fehlt");
    const next = {
      ...f,
      name: String(name).trim(),
      parentId: parentId || null,
    };
    validateFactoryCatalog({
      ...state.data,
      factories: state.data.factories.map((x) => (x.id === id ? next : x)),
    });
    Object.assign(f, next);
    api.record("Factory " + f.name + " aktualisiert.");
    return f;
  }

  function createLine(factoryId, name, projectId) {
    if (!state.data.factories.some((f) => f.id === factoryId) || !project(projectId))
      throw Error("Factory oder Projekt fehlt");
    name = String(name).trim();
    if (!name || name.length > 80)
      throw Error("Linienname benötigt 1–80 Zeichen");
    let n = 1;
    while (state.data.lines.some((l) => l.id === "line-" + n)) n++;
    const l = {
      id: "line-" + n,
      name,
      factoryId,
      projectId,
      orchestratorId: "orchestrator-line-" + n,
    };
    state.data.lines.push(l);
    api.record(
      "Produktionslinie " +
        name +
        " mit einem Orchestrator und ohne Worker angelegt.",
    );
    return l;
  }

  function assignWorkerToLine(workerId, lineId) {
    const w = state.data.workers.find((w) => w.id === workerId),
      l = state.data.lines.find((l) => l.id === lineId);
    if (!w || !l || w.project !== l.projectId)
      throw Error("Worker und Linie müssen zum selben Projekt gehören");
    if (api.workerTasks(w).length)
      throw Error("Aktive Versuche zuerst abschließen");
    w.lineId = lineId;
    api.record(w.id + " wurde ausdrücklich der Linie " + l.name + " zugewiesen.");
    return w;
  }

  function factoryDescendants(id) {
    const result = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of state.data.factories)
        if (result.has(f.parentId) && !result.has(f.id)) {
          result.add(f.id);
          changed = true;
        }
    }
    return result;
  }

  function chooseLine(id) {
    const line = state.data.lines.find((item) => item.id === id);
    if (!line) throw Error("Produktionslinie fehlt");
    state.currentLineId = id;
    state.data.selectedLineId = id;
    state.filter = line.projectId;
    return line;
  }

  function factoryLineSummary(line) {
    const workers = state.data.workers.filter((w) => w.lineId === line.id),
      tasks = state.data.tasks.filter((t) => t.lineId === line.id);
    return {
      workers,
      tasks,
      online: workers.filter((w) => w.online).length,
      active: tasks.filter(active).length,
      waiting: tasks.filter(waiting).length,
      review: tasks.filter((t) => t.status === "review").length,
      slots: workers.reduce((n, w) => n + (w.maxParallel || 1), 0),
      free: workers.reduce((n, w) => n + api.freeSlots(w), 0),
      profiles: workers.reduce((n, w) => n + w.profiles.length, 0),
    };
  }

  function factoryMapLayout(factoryId) {
    const root = state.data.factories.find((f) => f.id === factoryId);
    if (!root) throw Error("Factory fehlt");
    const depthOf = (f) => {
      const children = state.data.factories.filter((c) => c.parentId === f.id);
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
      for (const line of state.data.lines.filter((l) => l.factoryId === factory.id)) {
        lanes.push({ line, x: x + 16, y: cursor, width: w - 32, height: 160 });
        cursor += 176;
      }
      const children = state.data.factories.filter((f) => f.parentId === factory.id);
      for (const child of children)
        cursor = place(child, depth + 1, cursor) + 16;
      if (cursor === y + 60) cursor += 64;
      box.height = cursor - y + 8;
      return y + box.height;
    };
    const height = place(root, 0, 16) + 16;
    return { width, height, boxes, lanes };
  }

  return {
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
    chooseLine,
    factoryLineSummary,
    factoryMapLayout,
  };
}
