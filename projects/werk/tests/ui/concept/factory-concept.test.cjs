const { test } = require("node:test");
const assert = require("node:assert/strict");
const { simulation } = require("./support.cjs");

test("legacy state gains hierarchy and project lines without losing active assignments", async () => {
  const { engine: e } = await simulation(),
    legacy = structuredClone(e.data);
  delete legacy.factories;
  delete legacy.lines;
  for (const t of legacy.tasks) delete t.lineId;
  for (const w of legacy.workers) delete w.lineId;
  const migrated = e.normalize(legacy);
  assert.equal(migrated.factories.length, 3);
  assert.equal(migrated.lines.length, 3);
  assert.equal(migrated.tasks.find((t) => t.id === 101).lineId, "line-atlas");
  assert.equal(migrated.workers[0].lineId, "line-atlas");
  assert.equal(migrated.tasks.find((t) => t.id === 101).worker, "W-01");
  assert.equal(
    new Set(migrated.lines.map((l) => l.orchestratorId)).size,
    migrated.lines.length,
  );
});
test("factory reparenting rejects cycles atomically and preserves line ownership on rename", async () => {
  const { engine: e } = await simulation(),
    child = e.createFactory("Platform", "factory-products"),
    before = JSON.stringify(e.data);
  assert.throws(
    () => e.updateFactory("factory-werk", "Werk", child.id),
    /Zyklus/,
  );
  assert.equal(JSON.stringify(e.data), before);
  e.updateFactory(child.id, "Platform Services", "factory-service");
  assert.equal(
    e.data.factories.find((f) => f.id === child.id).parentId,
    "factory-service",
  );
  assert.equal(
    e.data.lines.find((l) => l.id === "line-atlas").factoryId,
    "factory-products",
  );
  assert.throws(
    () =>
      e.normalize({
        ...e.data,
        factories: [
          ...e.data.factories,
          { id: "factory-cycle", name: "Cycle", parentId: "factory-cycle" },
        ],
      }),
    /Zyklus/,
  );
});
test("new same-project line starts empty and cannot consume workers from another line", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = [];
  const line = e.createLine("factory-products", "Atlas Parallel", "atlas");
  assert.equal(e.data.workers.filter((w) => w.lineId === line.id).length, 0);
  const t = e.addTask({
    project: "atlas",
    lineId: line.id,
    title: "Isolated job",
    criteria: "Checked",
  });
  e.advance();
  assert.equal(t.status, "queued");
  assert.match(e.waitReason(t), /Produktionslinie/);
  e.assignWorkerToLine("W-02", line.id);
  e.advance();
  assert.equal(t.worker, "W-02");
  assert.equal(t.status, "running");
  assert.equal(t.lineId, line.id);
  assert.throws(() => e.assignWorkerToLine("W-02", "line-atlas"), /Aktive/);
  assert.throws(() => e.assignWorkerToLine("W-03", line.id), /selben Projekt/);
});
test("stored cross-line active assignment is rejected even within one project", async () => {
  const { engine: e } = await simulation(),
    line = e.createLine("factory-products", "Atlas Second", "atlas"),
    copy = structuredClone(e.data);
  copy.tasks.find((t) => t.id === 101).lineId = line.id;
  assert.throws(() => e.normalize(copy), /Zuweisung/);
});
test("selected line scopes work, import identity and topology independently of same-project lines", async () => {
  const { engine: e, workspace: w } = await simulation(),
    line = e.createLine("factory-products", "Atlas Second", "atlas");
  w.chooseLine(line.id);
  assert.equal(e.taskList().length, 0);
  assert.equal(e.workerList().length, 0);
  const graph = e.topology();
  assert.equal(graph.nodes.filter((n) => n.kind === "orchestrator").length, 1);
  assert.equal(graph.nodes.filter((n) => n.kind === "worker").length, 0);
  assert.equal(graph.nodes.filter((n) => n.kind === "repo").length, 1);
  assert.equal(e.importIterationFeatures("atlas"), 2);
  assert.equal(e.importIterationFeatures("atlas"), 0);
  assert.equal(e.taskList().length, 2);
  w.chooseLine("line-atlas");
  assert.equal(e.importIterationFeatures("atlas"), 2);
  assert.ok(e.taskList().every((t) => t.lineId === "line-atlas"));
  assert.equal(w.view, "intake");
});
test("unknown vault-note intake preserves unknown authority and blocks execution without fabricated criteria", async () => {
  const { engine: e } = await simulation(),
    t = e.addVaultTask("atlas", "[[Features/Customer portal]]");
  assert.equal(t.title, "Customer portal");
  assert.equal(t.criteria, "");
  assert.equal(t.requirementResolution, "unresolved");
  assert.equal(t.status, "blocked");
  assert.equal(e.taskAction(t.id, "retry"), false);
  e.advance();
  assert.equal(t.status, "blocked");
  assert.equal(t.worker, null);
  assert.equal(
    e.normalize(e.data).tasks.find((x) => x.id === t.id).requirementRef,
    "[[Features/Customer portal]]",
  );
  assert.throws(() => e.addVaultTask("atlas", "[[../secrets]]"));
  assert.throws(() => e.addVaultTask("atlas", "[[One]] [[Two]]"));
});
test("known requirement resolves its supplied note without requesting invented title or criteria", async () => {
  const { engine: e } = await simulation(),
    t = e.addVaultTask("atlas", "[[requirements/Bestellfreigabe#Regeln]]");
  assert.equal(t.requirementResolution, "demo_resolved");
  assert.equal(t.criteria, "");
  assert.equal(t.context.references.length, 1);
  assert.equal(
    t.context.references[0].path,
    "docs/requirements/Bestellfreigabe.md",
  );
  assert.equal(t.status, "queued");
});
