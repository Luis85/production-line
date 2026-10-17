import test from "node:test";
import assert from "node:assert/strict";
import { line, task, deferred } from "../helpers/runtime-harness.mjs";
test("task routing keeps dirty destination through event reload and ignores another task late error", async () => {
  const pending = deferred();
  const f = line((_path, init) =>
    init.method === "PUT" ? pending.promise : undefined,
  );
  f.state.tab = "tasks";
  await f.showTask(task("a"));
  f.state.taskRouting.workerId = "worker-a";
  await f.showTask(task("a"));
  assert.equal(f.state.taskRouting.workerId, "worker-a");
  const save = f.saveTaskRouting();
  await f.showTask(task("b"));
  pending.reject(Error("Old save failed"));
  await save;
  assert.equal(f.state.taskRouting.workerId, "");
  assert.equal(f.state.taskRouting.message, "");
  assert.equal(f.state.taskRouting.busy, false);
});
test("line routing prevents save during load and duplicate writes, preserving failure inputs", async () => {
  const get = deferred(),
    put = deferred();
  const f = line((path, init) =>
    path === "/v1/routing"
      ? init.method === "PUT"
        ? put.promise
        : get.promise
      : undefined,
  );
  const load = f.loadRouting();
  await f.saveRouting();
  assert.equal(f.state.routing.busy, true);
  assert.equal(f.calls.filter((c) => c.method === "PUT").length, 0);
  get.resolve({ mode: "manual", workerId: "worker-a", order: "fifo" });
  await load;
  assert.equal(f.state.routing.loaded, true);
  f.state.routing.workerId = "worker-b";
  const save = f.saveRouting();
  await f.saveRouting();
  assert.equal(f.calls.filter((c) => c.method === "PUT").length, 1);
  put.reject(Error("Offline"));
  await save;
  assert.equal(f.state.routing.workerId, "worker-b");
  assert.equal(f.state.routing.busy, false);
  assert.match(f.state.routing.message, /Offline/);
});
test("authenticated task handoff opens exact requested task and fences old navigation", async () => {
  const old = deferred();
  const f = line((path) =>
    path === "/v1/tasks/old"
      ? old.promise
      : path === "/v1/tasks/new"
        ? task("new")
        : undefined,
  );
  const first = f.showTaskId("old");
  await f.showTaskId("new");
  old.resolve(task("old"));
  await first;
  assert.equal(f.state.selectedTask.id, "new");
  assert.equal(f.calls[0].headers.Authorization, "Bearer fixture");
  const late = deferred();
  const g = line((path) => (path === "/v1/tasks/a" ? late.promise : undefined));
  const read = g.showTaskId("a");
  await g.navigate("workers");
  late.resolve(task("a"));
  await read;
  assert.equal(g.state.selectedTask, null);
  assert.equal(g.state.tab, "workers");
  const count = g.calls.length;
  await g.showTaskId("../secret");
  assert.equal(g.calls.length, count);
});
