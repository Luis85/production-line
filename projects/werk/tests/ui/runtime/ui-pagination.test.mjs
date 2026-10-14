import test from "node:test";
import assert from "node:assert/strict";
import {
  line,
  page,
  task,
  worker,
  deferred,
  lineModule,
} from "../helpers/runtime-harness.mjs";
for (const kind of ["tasks", "workers"])
  test(`${kind} failed and malformed next pages retain rows/cursor for one-click retry`, async () => {
    let mode = "bad";
    const row = kind === "tasks" ? task : worker;
    const f = line((path) => {
      if (path.includes("cursor=next")) {
        if (mode === "bad") throw Error("offline");
        if (mode === "malformed") return page(kind, [row("b")], "next");
        return page(kind, [row("b")]);
      }
      return page(kind, [row("a")], "next");
    });
    await f.navigate(kind);
    assert.equal(f.state[kind][0].id, "a");
    for (mode of ["bad", "malformed"]) {
      assert.equal(await f.movePage(kind, "next"), false);
      assert.equal(f.state[kind][0].id, "a");
      assert.equal(
        f.state[kind === "tasks" ? "taskPage" : "workerPage"].cursor,
        null,
      );
    }
    mode = "good";
    assert.equal(await f.movePage(kind, "next"), true);
    assert.equal(f.state[kind][0].id, "b");
    assert.equal(
      f.state[kind === "tasks" ? "taskPage" : "workerPage"].cursor,
      "next",
    );
    await f.movePage(kind, "previous");
    assert.equal(f.state[kind][0].id, "a");
    assert(f.calls.every((c) => c.path.includes("limit=50")));
  });
test("page-local filters do not download additional inventory", async () => {
  const f = line((path) =>
    path.startsWith("/v1/tasks?") ? page("tasks", [task()], "next") : undefined,
  );
  await f.navigate("tasks");
  f.state.taskSearch = "checkout";
  f.state.taskStatus = "queued";
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.taskPage.hasMore, true);
  assert.equal(f.state.tasks.length, 1);
});
test("intake uses a bounded imported-feature sample rather than aggregate count", async () => {
  const f = line((path) =>
    path.startsWith("/v1/tasks?")
      ? page("tasks", [task("a", { source: {} })], "more")
      : undefined,
  );
  await f.navigate("intake");
  assert.deepEqual(f.state.intakeSample, {
    count: 1,
    imported: 1,
    hasMore: true,
  });
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ["/v1/tasks?limit=50"],
  );
});
test("event pagination retains evidence on failure and rejects late prior-task response", async () => {
  let fail = true;
  const old = deferred();
  const f = line((path) => {
    if (path.includes("/a/events")) {
      if (path.includes("cursor=")) {
        if (fail) throw Error("Offline");
        return old.promise;
      }
      return page("events", [{ seq: 1 }], "next");
    }
    if (path.includes("/b/events")) return page("events", [{ seq: 7 }]);
  });
  f.state.tab = "tasks";
  await f.showTask(task("a"));
  await f.loadEvents("next");
  assert.deepEqual(f.state.events, [{ seq: 1 }]);
  assert.equal(f.state.eventPage.cursor, null);
  fail = false;
  const pending = f.loadEvents("next");
  await f.showTask(task("b"));
  old.resolve(page("events", [{ seq: 2 }]));
  await pending;
  assert.equal(f.state.selectedTask.id, "b");
  assert.deepEqual(f.state.events, [{ seq: 7 }]);
  assert(f.calls.every((c) => c.path.includes("limit=200")));
});
test("selected task remains available when its row leaves the displayed page", async () => {
  const f = line((path) =>
    path.startsWith("/v1/tasks?") ? page("tasks", [task("other")]) : undefined,
  );
  f.state.tab = "tasks";
  await f.showTask(task("selected"));
  await f.refresh();
  assert.equal(f.state.selectedTask.id, "selected");
  await f.inspectSnapshots("selected");
  assert.equal(f.state.metricFilters.taskId, "selected");
  assert.equal(f.state.selectedTask.id, "selected");
});
test("successful intake clears hiding filters and opens saved task absent from newest page", async () => {
  const f = line((path, init) =>
    init.method === "POST"
      ? task("saved")
      : path.startsWith("/v1/tasks?")
        ? page("tasks", [task("other")])
        : undefined,
  );
  Object.assign(f.state.intake, {
    mode: "manual",
    title: "Saved",
    criteria: "Expected",
  });
  f.state.taskSearch = "hidden";
  f.state.taskStatus = "blocked";
  await f.submitTask();
  assert.equal(f.state.selectedTask.id, "saved");
  assert.equal(f.state.tasks[0].id, "other");
  assert.equal(f.state.taskSearch, "");
  assert.equal(f.state.taskStatus, "");
  assert.equal(f.state.tab, "tasks");
  assert.equal(f.state.taskPage.cursor, null);
  assert(f.calls.some((c) => c.path === "/v1/tasks/saved/events?limit=200"));
});
test("pinned requirement commit comes from server and unresolved context stays explicit", () => {
  assert.match(
    lineModule.contextState(task("a", { context: { commit: "abc123" } })),
    /abc123/,
  );
  assert.match(lineModule.contextState(task()), /noch nicht aufgelöst/);
});
test("superseded page request cannot adopt rows or paging state after newer refresh", async () => {
  const old = deferred();
  let reads = 0;
  const f = line((path) =>
    path.startsWith("/v1/tasks?")
      ? ++reads === 1
        ? old.promise
        : page("tasks", [task("new")])
      : undefined,
  );
  f.state.tab = "tasks";
  const pending = f.refresh();
  await f.refresh();
  old.resolve(page("tasks", [task("old")], "old-next"));
  await pending;
  assert.equal(f.state.tasks[0].id, "new");
  assert.equal(f.state.taskPage.hasMore, false);
  assert.equal(f.state.busy, false);
});
