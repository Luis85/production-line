const { test } = require("node:test");
const assert = require("node:assert/strict");
const { simulation } = require("./support.cjs");

test("concept initializes isolated instances with Intake and independent selected-line drafts", async () => {
  const first = await simulation(),
    second = await simulation();
  assert.equal(first.workspace.view, "intake");
  first.workspace.getDraft().title = "Private draft";
  assert.equal(second.workspace.getDraft().title, "");
  first.engine.data.tasks.pop();
  assert.notEqual(
    first.engine.data.tasks.length,
    second.engine.data.tasks.length,
  );
});
test("iteration import follows the chosen project, pins context and remains idempotent", async () => {
  const { engine: e } = await simulation();
  e.filter = "field";
  assert.equal(e.importIterationFeatures("portal"), 2);
  const imported = e.data.tasks.filter((t) => t.sourceFeatureId);
  assert.equal(imported.length, 2);
  for (const t of imported) {
    assert.equal(t.project, "portal");
    assert.equal(t.context.projectId, "portal");
    assert.equal(t.context.references.length, 2);
    assert.equal(t.context.baseRef, t.iterationBranch);
    assert.match(t.title, /Rechnung/);
  }
  assert.equal(e.importIterationFeatures("portal"), 0);
  assert.equal(e.importIterationFeatures("atlas"), 2);
});
test("failed checks close the same attempt with a failed snapshot before explicit rework", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = e.data.tasks.filter((t) => t.id === 104);
  e.advance();
  const t = e.data.tasks[0],
    pr = t.pr;
  e.advance();
  assert.equal(e.taskAction(t.id, "failed"), true);
  const after = t.snapshots.find((s) => s.phase === "after");
  assert.equal(after.execution.outcome, "checks_failed");
  assert.equal(after.workerId, "W-01");
  assert.equal(after.quality.state, "simulated_failed");
  assert.equal(after.execution.elapsedTicks, 1);
  assert.equal(t.worker, null);
  e.advance();
  assert.equal(t.pr, pr);
  assert.equal(t.attempt, 2);
  assert.equal(t.snapshots.filter((s) => s.phase === "before").length, 2);
  assert.equal(t.snapshots.filter((s) => s.phase === "after").length, 1);
});
test("parallel machine and profile capacities agree for every linked active task", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = e.data.tasks.filter((t) => t.id === 104);
  const w = e.data.workers[0];
  w.maxParallel = 4;
  w.profiles[0].maxParallel = 2;
  w.profiles[1].maxParallel = 1;
  assert.equal(e.freeSlots(w), 3);
  e.addTask({ project: "atlas", title: "Second job", criteria: "Checked" });
  e.advance();
  assert.equal(e.workerTasks(w).length, 2);
  assert.equal(e.freeSlots(w), 1);
  for (const t of e.workerTasks(w)) {
    assert.equal(t.worker, w.id);
    assert.ok(t.execution.profileId);
    assert.ok(t.lease);
  }
  w.profiles[1].authenticated = false;
  assert.equal(e.freeSlots(w), 0);
});
test("configuration rejects invalid integers atomically and protects running attempts", async () => {
  const { engine: e } = await simulation(),
    w = e.data.workers[1],
    before = JSON.stringify(w),
    config = {
      maxParallel: 2,
      timeoutSeconds: 120,
      systemPrompt: "Test policy",
      profiles: w.profiles.map((p) => ({ id: p.id, maxParallel: 1 })),
    };
  assert.throws(() =>
    e.applyWorkerConfiguration(w, { ...config, maxParallel: 1.5 }),
  );
  assert.equal(JSON.stringify(w), before);
  assert.throws(() =>
    e.applyWorkerConfiguration(w, {
      ...config,
      profiles: [{ id: w.profiles[0].id, maxParallel: 0 }],
    }),
  );
  assert.equal(JSON.stringify(w), before);
  assert.throws(() =>
    e.applyWorkerConfiguration(w, { ...config, systemPrompt: "   " }),
  );
  e.applyWorkerConfiguration(w, config);
  assert.equal(w.configVersion, 2);
  assert.equal(w.maxParallel, 2);
  assert.throws(() => e.applyWorkerConfiguration(e.data.workers[0], config));
});
test("persisted profile overbooking and fractional concurrency are rejected", async () => {
  const { engine: e } = await simulation();
  let copy = structuredClone(e.data);
  copy.workers[0].maxParallel = 2.5;
  assert.throws(() => e.normalize(copy));
  copy = structuredClone(e.data);
  copy.workers[0].maxParallel = 2;
  const second = copy.tasks.find((t) => t.id === 104);
  Object.assign(second, {
    status: "running",
    worker: "W-01",
    attempt: 1,
    execution: { provider: "claude", profileId: "W-01-claude" },
  });
  assert.throws(() => e.normalize(copy), /Profilkapazität/);
  second.execution = { provider: "codex", profileId: "W-01-codex" };
  assert.equal(
    e.normalize(copy).tasks.filter((t) => t.worker === "W-01").length,
    2,
  );
});
test("telemetry derives from paired attempt snapshots and never invents missing measurements", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = e.data.tasks.filter((t) => t.id === 104);
  assert.equal(e.snapshotSeries().length, 0);
  e.advance();
  assert.equal(
    e.data.tasks[0].snapshots.filter((s) => s.phase === "before").length,
    1,
  );
  assert.equal(
    e.data.tasks[0].snapshots.filter((s) => s.phase === "after").length,
    0,
  );
  e.advance();
  e.advance();
  const row = e.snapshotSeries()[0];
  assert.equal(row.after.execution.elapsedTicks, 2);
  assert.equal(row.after.execution.durationMs, null);
  assert.equal(row.after.resources.rssBytes, null);
  assert.equal(row.after.usage.providerReportedCostUsd, null);
  e.filter = "portal";
  assert.equal(e.snapshotSeries().length, 0);
  e.filter = "all";
  e.data.tasks[0].snapshots = e.data.tasks[0].snapshots.filter(
    (s) => s.phase === "after",
  );
  assert.equal(e.snapshotSeries().length, 1);
  assert.equal(e.snapshotSeries()[0].before, undefined);
  assert.equal(e.snapshotSeries()[0].after.phase, "after");
});
test("rework prefers the prior available worker and configuration navigation pauses simulation", async () => {
  const { engine: e, workspace: w } = await simulation();
  e.data.tasks = e.data.tasks.filter((t) => t.id === 104);
  e.data.workers[0].paused = true;
  e.advance();
  const t = e.data.tasks[0];
  assert.equal(t.worker, "W-02");
  e.advance();
  e.advance();
  e.taskAction(t.id, "changes");
  e.data.workers[0].paused = false;
  e.advance();
  assert.equal(t.worker, "W-02");
  w.playing = true;
  w.navigate("providers");
  assert.equal(w.playing, false);
});
