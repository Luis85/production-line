import test from "node:test";
import assert from "node:assert/strict";
import {
  line,
  worker,
  deferred,
  httpError,
  page,
} from "../helpers/runtime-harness.mjs";
test("worker selection reads one bounded detail with profiles, capacity and active task identity", async () => {
  const detail = worker("a", {
    activeTasks: [
      {
        id: "task",
        status: "running",
        attempt: 1,
        profile: "codex",
        expiresAt: null,
      },
    ],
  });
  const f = line(() => detail);
  f.state.tab = "workers";
  await f.showWorker("a");
  assert.deepEqual(f.state.workerDetail, detail);
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ["/v1/workers/a"],
  );
});
test("failed worker refresh keeps stale data and retry recovers", async () => {
  let fail = false;
  const f = line(() => {
    if (fail) throw httpError(503);
    return worker("a");
  });
  f.state.tab = "workers";
  await f.showWorker("a");
  fail = true;
  await f.showWorker("a");
  assert.equal(f.state.workerDetail.id, "a");
  assert.match(f.state.workerError, /Veralteter/);
  fail = false;
  await f.showWorker("a");
  assert.equal(f.state.workerError, "");
});
test("late worker detail cannot replace a new worker selection", async () => {
  const old = deferred();
  const f = line((path) => (path.endsWith("/a") ? old.promise : worker("b")));
  f.state.tab = "workers";
  const read = f.showWorker("a");
  await f.showWorker("b");
  old.resolve(worker("a"));
  await read;
  assert.equal(f.state.workerId, "b");
  assert.equal(f.state.workerDetail.id, "b");
});
test("closing worker detail cancels adoption of late response", async () => {
  const pending = deferred();
  const f = line(() => pending.promise);
  f.state.tab = "workers";
  const read = f.showWorker("a");
  f.closeWorker();
  pending.resolve(worker("a"));
  await read;
  assert.equal(f.state.workerId, "");
  assert.equal(f.state.workerDetail, null);
  assert.equal(f.state.workerBusy, false);
});
test("logout removes worker identity and late old-session authentication error is ignored", async () => {
  const pending = deferred();
  const f = line((path) => (path.endsWith("/a") ? pending.promise : undefined));
  f.state.tab = "workers";
  const read = f.showWorker("a");
  f.disconnect();
  await f.connect("new");
  pending.reject(httpError(401));
  await read;
  assert.equal(f.state.token, "new");
  assert.equal(f.state.workerDetail, null);
  assert.equal(f.state.workerId, "");
});
test("current worker authentication expiry ends session", async () => {
  const f = line(() => {
    throw httpError(401);
  });
  f.state.tab = "workers";
  await f.showWorker("a");
  assert.equal(f.state.token, "");
  assert.equal(f.state.workerId, "");
  assert.match(f.state.message, /nicht mehr gültig/);
});
test("missing, malformed and oversized worker details remain recoverable", async () => {
  for (const bad of [
    null,
    worker("wrong"),
    worker("a", { profiles: Array(9).fill(worker().profiles[0]) }),
    worker("a", { config: { maxParallel: -1 } }),
  ]) {
    const f = line(() => bad);
    f.state.tab = "workers";
    await f.showWorker("a");
    assert.equal(f.state.workerDetail, null);
    assert.match(f.state.workerError, /erneut/);
    assert.equal(f.state.workerBusy, false);
  }
});
test("detail polling only reads selected endpoint and honors pause", async () => {
  const f = line((path) =>
    path === "/v1/workers/a" ? worker("a") : undefined,
  );
  f.state.tab = "workers";
  await f.showWorker("a");
  await f.poll();
  f.state.paused = true;
  await f.poll();
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ["/v1/workers/a", "/v1/workers/a"],
  );
  f.closeWorker();
  f.state.paused = false;
  await f.poll();
  assert.equal(f.calls.at(-1).path, "/v1/workers?limit=50");
});
