const { test } = require("node:test");
const assert = require("node:assert/strict");
const { simulation } = require("./support.cjs");

test("scheduler respects project identity, reuses released slots and never reviews or merges automatically", async () => {
  const { engine: e } = await simulation();
  e.advance();
  assert.equal(e.data.tasks.find((t) => t.id === 104).worker, "W-02");
  assert.equal(e.data.tasks.find((t) => t.id === 105).worker, "W-04");
  assert.equal(e.data.tasks.find((t) => t.id === 102).status, "review");
  e.advance();
  e.advance();
  assert.ok(
    !e.data.tasks.some((t) => ["running", "checks"].includes(t.status)),
  );
  assert.equal(e.data.tasks.filter((t) => t.status === "done").length, 1);
});
test("review gates invalidate approval on changes, reuse the PR and make merged work immutable", async () => {
  const { engine: e } = await simulation();
  e.advance();
  e.advance();
  e.advance();
  assert.equal(e.taskAction(102, "merge"), false);
  assert.ok(e.taskAction(102, "approve"));
  assert.ok(e.taskAction(102, "changes"));
  assert.equal(e.data.tasks.find((t) => t.id === 102).approved, false);
  e.advance();
  e.advance();
  e.advance();
  assert.equal(e.data.tasks.find((t) => t.id === 102).pr, 42);
  assert.ok(e.taskAction(102, "approve"));
  assert.ok(e.taskAction(102, "merge"));
  assert.equal(e.taskAction(102, "changes"), false);
});
test("offline recovery changes leases, draining preserves current work and quota prevents further assignment", async () => {
  const { engine: e } = await simulation(),
    lease = e.data.tasks.find((t) => t.id === 101).lease;
  e.updateWorker("W-01", "online");
  assert.equal(e.data.tasks.find((t) => t.id === 101).worker, null);
  e.advance();
  assert.equal(e.data.tasks.find((t) => t.id === 101).worker, "W-02");
  assert.notEqual(e.data.tasks.find((t) => t.id === 101).lease, lease);
  e.reset();
  e.updateWorker("W-01", "pause");
  assert.equal(e.data.tasks.find((t) => t.id === 101).worker, "W-01");
  e.advance();
  e.advance();
  assert.equal(Boolean(e.busy(e.data.workers[0])), false);
  assert.equal(e.available(e.data.workers[0]), false);
  e.reset();
  e.updateWorker("W-01", "quota");
  assert.equal(e.data.tasks.find((t) => t.id === 101).status, "changes");
  assert.equal(e.available(e.data.workers[0]), false);
});
test("no cross-project scheduling occurs when every eligible project worker is offline", async () => {
  const { engine: e } = await simulation();
  e.data.workers
    .filter((w) => w.project === "atlas")
    .forEach((w) => e.updateWorker(w.id, "online"));
  e.advance();
  assert.equal(e.data.tasks.find((t) => t.id === 104).worker, null);
  assert.match(e.waitReason(e.data.tasks.find((t) => t.id === 104)), /offline/);
});
test("retry ceiling and closed PR require explicit decisions instead of silently respawning work", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = e.data.tasks.filter((t) => t.id === 103);
  e.taskAction(103, "failed");
  e.advance();
  e.advance();
  e.taskAction(103, "failed");
  e.advance();
  e.advance();
  e.taskAction(103, "failed");
  assert.equal(e.data.tasks[0].status, "blocked");
  e.advance();
  assert.equal(e.data.tasks[0].status, "blocked");
  assert.ok(e.taskAction(103, "retry"));
  e.advance();
  assert.equal(e.data.tasks[0].status, "running");
  e.reset();
  e.taskAction(102, "closed");
  assert.equal(e.data.tasks.find((t) => t.id === 102).status, "blocked");
  e.advance();
  assert.equal(e.data.tasks.find((t) => t.id === 102).status, "blocked");
  e.taskAction(102, "retry");
  e.advance();
  e.advance();
  e.advance();
  assert.notEqual(e.data.tasks.find((t) => t.id === 102).pr, 42);
});
test("persistence roundtrip validates event collections, workers, literal user data and connected project topology", async () => {
  const { engine: e } = await simulation();
  assert.equal(
    e.normalize(structuredClone(e.data)).tasks.length,
    e.data.tasks.length,
  );
  assert.throws(() => e.normalize({ ...e.data, events: null }));
  assert.throws(() =>
    e.normalize({
      ...e.data,
      workers: [{ id: "W-01", project: "missing", online: true }],
    }),
  );
  const task = e.addTask({
    title: "<script>alert(1)</script>",
    project: "portal",
    criteria: "<img src=x>",
    priority: 2,
  });
  assert.equal(task.title, "<script>alert(1)</script>");
  assert.equal(task.criteria, "<img src=x>");
  const repositories = new Set();
  for (const line of e.data.lines) {
    e.chooseLine(line.id);
    const graph = e.topology();
    const repos = graph.nodes.filter((n) => n.kind === "repo");
    assert.equal(repos.length, 1);
    repositories.add(repos[0].id);
    assert.ok(graph.edges.some((edge) => edge.kind === "git"));
    assert.ok(graph.edges.some((edge) => edge.kind === "feedback"));
    for (const edge of graph.edges) {
      assert.ok(graph.nodes.some((n) => n.id === edge.from));
      assert.ok(graph.nodes.some((n) => n.id === edge.to));
    }
  }
  assert.equal(repositories.size, 3);
});
test("vault context resolves anchors, aliases and ambiguity while enforcing project and path boundaries", async () => {
  const { engine: e } = await simulation(),
    manifest = e.contextManifest({
      project: "atlas",
      links:
        "[[requirements/Bestellfreigabe#Regeln|Fachregel]]\n[[DoD#Checks]]",
    });
  assert.equal(manifest.references.length, 2);
  assert.match(manifest.references[0].excerpt, /5.000/);
  assert.equal(
    e.resolveWiki("[[Bestellfreigabe#^regel-1]]", "atlas").selector,
    "block",
  );
  assert.equal(e.resolveWiki("[[Glossar]]", "atlas").candidates.length, 2);
  assert.equal(
    e.resolveWiki("[[domain/Glossar]]", "atlas").repoPath,
    "docs/domain/Glossar.md",
  );
  for (const ref of [
    "[[missing]]",
    "[[../Secrets]]",
    "[[#Regeln]]",
    "[[Rechnungsdownload]]",
  ])
    assert.equal(e.resolveContext(ref, "atlas").ok, false);
  assert.equal(
    e.resolveContext("[[DoD]]\n[[quality/Definition of Done]]", "atlas").entries
      .length,
    1,
  );
  const task = e.addTask({
    project: "atlas",
    title: "Test Intake",
    criteria: "Ergebnis pruefbar",
    provider: "codex",
  });
  task.context = manifest;
  assert.equal(
    e.normalize(e.data).tasks.find((t) => t.id === task.id).context.references
      .length,
    2,
  );
});
test("fixed-provider routing, profile-only limits and explicit retry preserve provider authority", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = e.data.tasks.filter((t) => t.id === 104);
  e.data.tasks[0].provider = "codex";
  e.advance();
  const assigned = e.data.tasks[0];
  assert.equal(assigned.execution.provider, "codex");
  assert.equal(assigned.execution.profileId, "W-01-codex");
  e.setProfileState("W-01", "W-01-codex", "limit");
  assert.equal(assigned.status, "blocked");
  assert.equal(
    e.data.workers[0].profiles.find((p) => p.provider === "claude").limited,
    false,
  );
  assert.ok(e.taskAction(104, "retry"));
  e.advance();
  assert.equal(assigned.execution.provider, "codex");
  assert.equal(assigned.worker, "W-02");
  e.reset();
  e.data.tasks = e.data.tasks.filter((t) => t.id === 104);
  e.data.tasks[0].provider = "claude";
  e.data.workers
    .filter((w) => w.project === "atlas")
    .forEach((w) =>
      w.profiles
        .filter((p) => p.provider === "claude")
        .forEach((p) => {
          p.limited = true;
        }),
    );
  e.advance();
  assert.equal(e.data.tasks[0].status, "queued");
  assert.match(e.waitReason(e.data.tasks[0]), /Claude/);
  e.data.tasks[0].provider = "auto";
  e.advance();
  assert.equal(e.data.tasks[0].execution.provider, "codex");
  assert.equal(e.available(e.data.workers[0]), false);
});
test("distinct profile capacity produces before and after snapshots without inventing provider metrics", async () => {
  const { engine: e } = await simulation();
  e.data.tasks = e.data.tasks.filter((t) => t.project === "atlas");
  e.data.tasks.forEach((t) =>
    Object.assign(t, {
      status: "queued",
      worker: null,
      lease: null,
      pr: null,
      execution: null,
    }),
  );
  e.data.workers[0].maxParallel = 2;
  e.data.workers[1].online = false;
  e.advance();
  assert.equal(e.workerTasks(e.data.workers[0]).length, 2);
  assert.ok(
    e.data.tasks.every(
      (t) => t.pr && t.snapshots.some((s) => s.phase === "before"),
    ),
  );
  e.advance();
  e.advance();
  assert.ok(
    e.data.tasks.every((t) => t.snapshots.some((s) => s.phase === "after")),
  );
});
