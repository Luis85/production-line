const { test } = require("node:test");
const assert = require("node:assert/strict");
const { simulation } = require("./support.cjs");

test("switching lines keeps vault and advanced drafts within their original line", async () => {
  const { workspace: w } = await simulation();
  w.chooseLine("line-atlas");
  Object.assign(w.getDraft(), {
    title: "Atlas draft",
    criteria: "Atlas criteria",
    vaultRef: "[[requirements/Bestellfreigabe]]",
    manualOpen: true,
  });
  w.chooseLine("line-portal");
  assert.equal(w.getDraft().title, "");
  assert.equal(w.getDraft().criteria, "");
  assert.equal(w.getDraft().vaultRef, "");
  assert.equal(w.getDraft().manualOpen, false);
  Object.assign(w.getDraft(), {
    title: "Portal draft",
    vaultRef: "[[portal/Unfinished]]",
  });
  w.chooseLine("line-atlas");
  assert.equal(w.getDraft().title, "Atlas draft");
  assert.equal(w.getDraft().criteria, "Atlas criteria");
  assert.equal(w.getDraft().vaultRef, "[[requirements/Bestellfreigabe]]");
  assert.equal(w.getDraft().manualOpen, true);
  w.chooseLine("line-portal");
  assert.equal(w.getDraft().title, "Portal draft");
  assert.equal(w.getDraft().vaultRef, "[[portal/Unfinished]]");
});
test("Factory overview navigation pauses simulation and retains the active line without mutating task state", async () => {
  const { engine: e, workspace: w } = await simulation();
  w.chooseLine("line-atlas");
  const before = JSON.stringify(e.data);
  w.playing = true;
  w.navigate("factory");
  assert.equal(w.playing, false);
  assert.equal(w.currentLineId, "line-atlas");
  assert.equal(JSON.stringify(e.data), before);
  w.navigate("board");
  assert.equal(w.currentLineId, "line-atlas");
  assert.equal(w.view, "board");
  assert.throws(() => w.navigate("missing"));
});
test("correcting an unresolved reference retains identity and line then enables normal execution", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = [];
  const t = e.addVaultTask("atlas", "[[Missing]]"),
    id = t.id,
    line = t.lineId;
  const updated = e.reviseTaskRequirement(
    id,
    "[[requirements/Bestellifreigabe]]",
  );
  assert.equal(updated.status, "blocked");
  assert.equal(updated.intakeRevision, 2);
  e.reviseTaskRequirement(id, "[[requirements/Bestellfreigabe#Regeln]]");
  assert.equal(t.id, id);
  assert.equal(t.lineId, line);
  assert.equal(t.intakeRevision, 3);
  assert.equal(t.criteria, "");
  assert.equal(t.status, "queued");
  assert.equal(t.context.references.length, 1);
  e.advance();
  assert.equal(t.status, "running");
  assert.throws(() => e.reviseTaskRequirement(id, "[[DoD]]"));
});
test("malformed correction leaves unresolved work unchanged and line membership exposes no eligible unassigned worker", async () => {
  const { engine: e } = await simulation(),
    t = e.addVaultTask("portal", "[[Missing]]"),
    before = JSON.stringify(t);
  assert.throws(() => e.reviseTaskRequirement(t.id, "[[../Secrets]]"));
  assert.equal(JSON.stringify(t), before);
  const line = e.data.lines.find((l) => l.id === "line-portal");
  assert.equal(
    e.data.workers.filter(
      (worker) =>
        worker.project === line.projectId &&
        worker.lineId !== line.id &&
        !e.busy(worker),
    ).length,
    0,
  );
});
