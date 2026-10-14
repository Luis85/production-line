import test from "node:test";
import assert from "node:assert/strict";
import {
  line,
  lineModule,
  overview,
  httpError,
  deferred,
  page,
  task,
} from "../helpers/runtime-harness.mjs";
test("first run has no credentials, operational data, or implicit requests", () => {
  const f = line(undefined, { connected: false });
  assert.equal(f.state.token, "");
  assert.equal(f.state.canWrite, false);
  assert.equal(f.state.overview, null);
  assert.equal(f.state.tasks.length, 0);
  assert.equal(f.calls.length, 0);
});
test("login learns project through one authenticated bounded overview request", async () => {
  const f = line(() => overview({ project: "checkout" }), { connected: false });
  await f.connect(" fixture ");
  assert.equal(f.state.intake.project, "checkout");
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ["/v1/overview"],
  );
  assert.equal(f.calls[0].headers.Authorization, "Bearer fixture");
});
test("project edited while login is pending supersedes server default", async () => {
  const pending = deferred();
  const f = line(() => pending.promise, { connected: false });
  const login = f.connect("fixture");
  f.state.intake.project = "mine";
  f.state.intake.projectEdited = true;
  pending.resolve(overview({ project: "server" }));
  await login;
  assert.equal(f.state.intake.project, "mine");
});
test("invalid credentials and unavailable server remain distinct recoverable login errors", async () => {
  for (const code of [401, 503]) {
    const f = line(
      () => {
        throw httpError(code);
      },
      { connected: false },
    );
    await f.connect("fixture");
    assert.equal(f.state.token, "");
    assert.equal(f.state.connecting, false);
    assert.match(
      f.state.message,
      code === 401 ? /Token nicht akzeptiert/ : /Verbindung nicht möglich/,
    );
  }
});
test("manual intake navigation preserves unsent draft and never submits automatically", async () => {
  const f = line();
  f.state.intake.title = "Draft";
  f.state.intake.mode = "manual";
  await f.navigate("intake");
  assert.equal(f.state.intake.title, "Draft");
  assert(f.calls.every((c) => c.method === "GET"));
  assert.equal(f.state.intakeSample.count, 0);
});
test("bounded intake sample distinguishes imported features and additional pages", async () => {
  const f = line((path) =>
    path.startsWith("/v1/tasks?")
      ? page(
          "tasks",
          [task("a", { source: { path: "feature.md" } }), task("b")],
          "next",
        )
      : undefined,
  );
  await f.navigate("intake");
  assert.deepEqual(f.state.intakeSample, {
    count: 2,
    imported: 1,
    hasMore: true,
  });
  assert.equal(f.calls[0].path, "/v1/tasks?limit=50");
});
test("task guidance uses pinned context and never calls simulation implementation", () => {
  assert.match(
    lineModule.contextState(
      task("a", { context: { commit: "abc" }, executionMode: "mock" }),
    ),
    /abc.*simuliert/,
  );
  assert.match(
    lineModule.contextState(
      task("a", { context: { commit: "abc" }, executionMode: "cli" }),
    ),
    /Review/,
  );
  assert.match(lineModule.contextState(task()), /nicht aufgelöst/);
});
test("disconnect clears credentials and private data while retaining unsent intake", () => {
  const f = line();
  f.state.intake.title = "Draft";
  f.state.tasks = [task()];
  f.disconnect();
  assert.equal(f.state.token, "");
  assert.equal(f.state.tasks.length, 0);
  assert.equal(f.state.intake.title, "Draft");
});
test("viewer and malformed declared access guard programmatic mutations", async () => {
  for (const access of [
    { principal: { role: "viewer" }, permissions: { write: false } },
    { principal: { role: "admin" }, permissions: { write: "true" } },
  ]) {
    const f = line(() => overview({ access }), { connected: false });
    await f.connect("fixture");
    f.state.intake.mode = "manual";
    f.state.intake.title = "Task";
    f.state.intake.criteria = "Expected";
    await f.submitTask();
    await f.saveRouting();
    assert.equal(f.state.canWrite, false);
    assert(f.calls.every((c) => c.method === "GET"));
  }
});
test("readiness retry rejects an old session and keeps unknown distinct from measured zero", async () => {
  const pending = deferred();
  const f = line(() => pending.promise);
  f.state.overview = { workers: { online: 0 } };
  const read = f.checkReadiness();
  f.disconnect();
  pending.resolve({ workers: { online: 99 } });
  await read;
  assert.equal(f.state.overview, null);
  const unknown = line(() => ({ project: "demo" }));
  await unknown.checkReadiness();
  assert.equal(unknown.state.overview.workers, undefined);
});
test("explicit live mode forces manual Codex input and preserves the separate vault draft", () => {
  const f = line();
  Object.assign(f.state.intake, {
    executionMode: "cli",
    provider: "claude",
    mode: "vault",
    title: "Review",
    criteria: "Expected",
    requirementRef: "[[Saved]]",
  });
  assert.deepEqual(f.intakePayload(), {
    project: "demo",
    title: "Review",
    criteria: ["Expected"],
    wikilinks: [],
    provider: "codex",
    executionMode: "cli",
  });
  f.state.intake.executionMode = "mock";
  assert.equal(f.intakePayload().requirementRef, "[[Saved]]");
});
