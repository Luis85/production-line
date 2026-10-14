const { test } = require("node:test");
const assert = require("node:assert/strict");
const { simulation } = require("./support.cjs");

test("individual intake opens deliberately and preserves the unfinished draft", async () => {
  const { workspace: w } = await simulation();
  assert.equal(w.getDraft().manualOpen, false);
  w.getDraft().title = "Preserve unfinished feature";
  w.newFeature();
  assert.equal(w.view, "intake");
  assert.equal(w.getDraft().manualOpen, true);
  assert.equal(w.getDraft().title, "Preserve unfinished feature");
});
test("iteration import receipt leads to the correct project board and clears stale filters", async () => {
  const { engine: e, workspace: w } = await simulation();
  w.filter = "field";
  w.query = "Old search";
  w.statusFilter = "done";
  assert.equal(e.data.tasks.filter((t) => t.sourceFeatureId).length, 0);
  assert.equal(e.importIterationFeatures("portal"), 2);
  w.openProjectBoard("portal");
  assert.equal(w.view, "board");
  assert.equal(w.filter, "portal");
  assert.equal(w.query, "");
  assert.equal(w.statusFilter, "all");
  assert.equal(e.data.tasks.filter((t) => t.sourceFeatureId).length, 2);
  assert.ok(e.taskList().every((t) => t.project === "portal"));
});
test("review navigation clears search without changing task authority or accepting unknown projects", async () => {
  const { engine: e, workspace: w } = await simulation(),
    before = JSON.stringify(e.data.tasks);
  w.query = "Supplier";
  w.openProjectBoard("portal", "review");
  assert.equal(w.filter, "portal");
  assert.equal(w.statusFilter, "review");
  assert.equal(w.query, "");
  assert.equal(JSON.stringify(e.data.tasks), before);
  const reviews = e.taskList().filter((t) => t.status === w.statusFilter);
  assert.ok(reviews.some((t) => /Rechnungen herunterladen/.test(t.title)));
  assert.ok(reviews.every((t) => t.project === "portal"));
  assert.throws(() => w.openProjectBoard("missing", "review"));
  assert.equal(w.filter, "portal");
});
