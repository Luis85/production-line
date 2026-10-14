import test from "node:test";
import assert from "node:assert/strict";
import {
  line,
  page,
  task,
  worker,
  deferred,
  status,
  diagnosticModule,
} from "../helpers/runtime-harness.mjs";
import { statusHtml } from "../../../src/worker/dist/worker/status/server.js";
test("runtime navigation fences older responses even when cancellation is ignored", async () => {
  const old = deferred();
  const f = line((path) =>
    path.startsWith("/v1/tasks?")
      ? old.promise
      : path.startsWith("/v1/workers?")
        ? page("workers", [worker("new")])
        : undefined,
  );
  const read = f.navigate("tasks");
  await f.navigate("workers");
  old.resolve(page("tasks", [task("old")]));
  await read;
  assert.equal(f.state.tab, "workers");
  assert.equal(f.state.workers[0].id, "new");
  assert.deepEqual(f.state.tasks, []);
});
test("ambiguous task retry keeps its key and draft until success, next intent gets new key", async () => {
  let fail = true;
  const f = line((_path, init) => {
    if (init.method === "POST") {
      if (fail) throw Error("Lost reply");
      return task("saved");
    }
  });
  Object.assign(f.state.intake, {
    mode: "manual",
    title: "Feature",
    criteria: "Expected",
  });
  await f.submitTask();
  assert.equal(f.state.intake.title, "Feature");
  fail = false;
  await f.submitTask();
  const writes = f.calls.filter((c) => c.method === "POST");
  assert.equal(
    writes[0].headers["Idempotency-Key"],
    writes[1].headers["Idempotency-Key"],
  );
  assert.equal(f.state.intake.title, "");
  Object.assign(f.state.intake, { title: "Feature", criteria: "Expected" });
  await f.submitTask();
  assert.notEqual(
    f.calls.filter((c) => c.method === "POST")[2].headers["Idempotency-Key"],
    writes[1].headers["Idempotency-Key"],
  );
});
test("metrics follows advancing newest-first cursors while retaining all records for aggregates", async () => {
  const f = line((path) =>
    path.includes("before=")
      ? { snapshots: [{ seq: 1 }], nextCursor: null, hasMore: false }
      : { snapshots: [{ seq: 2 }], nextCursor: 2, hasMore: true },
  );
  await f.navigate("metrics");
  assert.match(f.calls[0].path, /order=desc&limit=1000/);
  assert.match(f.calls[1].path, /before=2/);
  assert.deepEqual(
    f.state.metrics.map((r) => r.seq),
    [1, 2],
  );
  assert.equal(f.state.metricsTruncated, false);
});
test("metrics stops at ten pages and makes truncation explicit; repeated cursor rejects adoption", async () => {
  let seq = 20000;
  const f = line(() => ({
    snapshots: [{ seq: seq-- }],
    nextCursor: seq,
    hasMore: true,
  }));
  await f.navigate("metrics");
  assert.equal(f.calls.length, 10);
  assert.equal(f.state.metrics.length, 10);
  assert.equal(f.state.metricsTruncated, true);
  const broken = line(() => ({
    snapshots: [{ seq: 1 }],
    nextCursor: "same",
    hasMore: true,
  }));
  broken.state.metrics = [{ seq: 99 }];
  await broken.navigate("metrics");
  assert.deepEqual(broken.state.metrics, [{ seq: 99 }]);
  assert.equal(broken.state.stale, true);
});
test("worker export embeds an exact safely escaped snapshot including dollar replacement text and Unicode separators", async () => {
  const label = "</script><img src=x onerror=alert(1)> $& $` $' \u2028 \u2029";
  const initial = status({
    workerId: label,
    updatedAt: "2026-10-14T00:00:00Z",
  });
  const html = statusHtml(initial);
  const blocks = [
    ...html.matchAll(
      /<script\b[^>]*id="werk-status-data"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0][1]), initial);
  assert.match(blocks[0][1], /\\u003c\/script>/);
  assert.match(blocks[0][1], /\\u2028/);
  assert.match(blocks[0][1], /\\u2029/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(
    html,
    /<script[^>]+src=|<link[^>]+rel="stylesheet"[^>]+href=/,
  );
  let calls = 0;
  const offline = diagnosticModule.createDiagnosticStore(
    JSON.parse(blocks[0][1]),
    {
      fetcher: () => {
        calls++;
        throw Error("Offline export fetched");
      },
    },
  );
  await offline.refresh();
  assert.equal(calls, 0);
  assert.equal(offline.state.offline, true);
  assert.equal(offline.state.snapshot.workerId, label);
  assert.match(offline.state.announcement, /Static export/);
  const live = statusHtml();
  assert.match(
    live,
    /<script id="werk-status-data" type="application\/json">null<\/script>/,
  );
});
test("closing task evidence ignores late events and reopened selection loads current evidence", async () => {
  const pending = deferred();
  let reads = 0;
  const f = line((path) =>
    path.includes("/events?")
      ? ++reads === 1
        ? pending.promise
        : page("events", [{ seq: 2, kind: "reviewed" }])
      : undefined,
  );
  f.state.tab = "tasks";
  const read = f.showTask(task("selected"));
  f.closeTask();
  pending.resolve(page("events", [{ seq: 1 }]));
  await read;
  assert.equal(f.state.selectedTask, null);
  assert.deepEqual(f.state.events, []);
  await f.showTask(task("selected"));
  assert.equal(f.state.events[0].kind, "reviewed");
});
