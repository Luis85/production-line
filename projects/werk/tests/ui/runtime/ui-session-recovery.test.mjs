import test from "node:test";
import assert from "node:assert/strict";
import {
  line,
  factory,
  task,
  worker,
  page,
  deferred,
  httpError,
  response,
  status,
  diagnosticModule,
} from "../helpers/runtime-harness.mjs";
for (const code of [401, 503])
  test(`Factory ${code} ${code === 401 ? "expires access while retaining drafts" : "retains usable session for retry"}`, async () => {
    const f = factory((path) =>
      path.startsWith("/v1/overview")
        ? response({ error: "Unavailable" }, code)
        : undefined,
    );
    f.state.taskDraft.title = "Unsent";
    await f.refresh(false);
    assert.equal(!!f.state.token, code !== 401);
    assert.equal(f.state.taskDraft.title, "Unsent");
    assert.equal(f.state.loading, false);
  });
test("Factory late old-session 401 cannot disconnect newly authenticated session", async () => {
  const pending = deferred();
  let old = true;
  const f = factory((path) =>
    path.startsWith("/v1/overview") && old ? pending.promise : undefined,
  );
  const read = f.refresh(false);
  f.disconnect();
  old = false;
  await f.connect("new");
  pending.resolve(response({ error: "expired" }, 401));
  await read;
  assert.equal(f.state.token, "new");
});
test("line logout clears hidden identities, selected snapshots and filter options", () => {
  const f = line();
  f.state.selectedTask = task();
  f.state.events = [{ seq: 1 }];
  f.state.metrics = [{ taskId: "secret" }];
  f.state.selectedSnapshot = { taskId: "secret" };
  f.state.metricFilters.project = "secret";
  f.state.workerDetail = worker();
  f.state.workerId = "worker-a";
  f.disconnect();
  assert.equal(f.state.selectedTask, null);
  assert.deepEqual(f.state.events, []);
  assert.deepEqual(f.state.metrics, []);
  assert.equal(f.state.selectedSnapshot, null);
  assert.equal(f.state.metricFilters.project, "");
  assert.equal(f.state.workerId, "");
});
test("current task-event 401 expires access while stale old rejection cannot end newer session", async () => {
  const f = line(() => {
    throw httpError(401);
  });
  f.state.tab = "tasks";
  await f.showTask(task());
  assert.equal(f.state.token, "");
  assert.match(f.state.message, /nicht mehr gültig/);
  const pending = deferred();
  const g = line((path) =>
    path.includes("/events?") ? pending.promise : undefined,
  );
  g.state.tab = "tasks";
  const read = g.showTask(task());
  g.disconnect();
  await g.connect("new");
  pending.reject(httpError(401));
  await read;
  assert.equal(g.state.token, "new");
});
test("diagnostic pause/resume retains failure until successful retry and keeps paused state explicit", async () => {
  let fail = true;
  const f = diagnosticModule.createDiagnosticStore(null, {
    fetcher: async () => {
      if (fail) throw Error();
      return response(status());
    },
  });
  await f.refresh();
  await f.setPaused(true);
  assert.equal(f.state.failed, true);
  assert.match(f.state.announcement, /paused/);
  await f.setPaused(false);
  assert.equal(f.state.failed, true);
  fail = false;
  await f.refresh();
  assert.equal(f.state.failed, false);
  assert.match(f.state.announcement, /Live status/);
});
test("CLI diagnostics distinguish acknowledged review from simulations and reject unknown modes", () => {
  const cli = diagnosticModule.statusSummary(
    status({ mode: "cli", state: "executing" }),
  );
  assert.match(cli.state, /Codex CLI/);
  assert.match(cli.result, /pending human review/);
  assert.match(cli.result, /not verified/);
  const mock = diagnosticModule.statusSummary(status());
  assert.match(mock.result, /not an implemented feature/);
  assert.throws(
    () => diagnosticModule.validateStatus(status({ mode: "unknown" })),
    /Invalid/,
  );
});
