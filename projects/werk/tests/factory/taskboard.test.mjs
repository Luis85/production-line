import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const base = pathToFileURL(
  resolve(process.env.WERK_FACTORY_TEST_ROOT ?? "src/factory/dist") + "/",
).href;
const { taskPageQuery, checkedTaskPage } = await import(
  new URL("factory/application/task-pages.js", base)
);
const { HttpLineReader } = await import(
  new URL("factory/infrastructure/poller.js", base)
);
const { FactoryApplication } = await import(
  new URL("factory/application/service.js", base)
);
const { SqliteFactoryRegistry } = await import(
  new URL("factory/infrastructure/registry.js", base)
);
const { createFactoryHandler } = await import(new URL("factory/http.js", base));
const row = () => ({
  id: "task-one",
  title: "Review checkout retry behavior",
  status: "queued",
  project: "demo",
  priority: 1,
  createdAt: 1234,
  workerId: null,
  profile: null,
  executionMode: "mock",
});
const page = () => ({ tasks: [row()], hasMore: false, nextCursor: null });
const line = (url) => ({
  id: "alpha",
  name: "Alpha",
  factoryId: "root",
  orchestratorUrl: url,
  webviewUrl: url,
  tokenEnv: "WERK_LINE_ALPHA_TOKEN",
});
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    url: "http://127.0.0.1:" + server.address().port,
    close: () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  };
}
test("Factory task query rejects unknown, duplicate and unbounded inputs", () => {
  assert.deepEqual(taskPageQuery(new URLSearchParams()), { limit: 50 });
  assert.deepEqual(taskPageQuery(new URLSearchParams("limit=1&cursor=abc_-")), {
    limit: 1,
    cursor: "abc_-",
  });
  for (const query of [
    "limit=51",
    "limit=0",
    "limit=1&limit=2",
    "cursor=",
    "cursor=a&cursor=b",
    "url=https://other",
    "cursor=a.b",
  ])
    assert.throws(
      () => taskPageQuery(new URLSearchParams(query)),
      (e) => e.code === "invalid_input",
    );
});
test("Task cards strip private payload and expose only validated gate phase", () => {
  const raw = page();
  Object.assign(raw.tasks[0], {
    lease: "secret",
    criteria: ["private request"],
    context: { body: "private" },
    requestGate: {
      schemaVersion: 1,
      requestId: "request",
      revision: 0,
      inputDigest: "a".repeat(64),
      policyDigest: "b".repeat(64),
      evaluationId: "evaluation",
      stage: "done",
      status: "blocked",
      failedRules: 1,
      unknownRules: 0,
    },
  });
  const result = checkedTaskPage(raw, 50);
  assert.deepEqual(result.tasks[0].gate, {
    phase: "needs_rework",
    label: "Gate blockiert",
  });
  for (const secret of [
    "secret",
    "criteria",
    "context",
    "inputDigest",
    "policyDigest",
    "evaluationId",
  ])
    assert.ok(!JSON.stringify(result).includes(secret));
  raw.tasks[0].requestGate.status = "passed";
  assert.throws(() => checkedTaskPage(raw, 50));
});
test("Invalid or nonadvancing task pages cannot masquerade as an empty or complete board", () => {
  for (const bad of [
    { ...page(), hasMore: true, nextCursor: null },
    { ...page(), hasMore: false, nextCursor: "stray" },
    { ...page(), tasks: [row(), row()] },
    { ...page(), tasks: [{ ...row(), createdAt: NaN }] },
    { ...page(), tasks: [{ ...row(), title: undefined }] },
  ])
    assert.throws(() => checkedTaskPage(bad, 50));
  assert.throws(() =>
    checkedTaskPage(
      { ...page(), hasMore: true, nextCursor: "same" },
      50,
      "same",
    ),
  );
  assert.equal(
    checkedTaskPage(
      { ...page(), tasks: [{ ...row(), status: "future_status" }] },
      50,
    ).tasks[0].status,
    "future_status",
  );
});
test("Authenticated Factory read proxy selects registry credentials, validates query before I/O and strips private response fields", async () => {
  const calls = [];
  const upstream = await serve((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ...page(),
        tasks: [
          { ...row(), lease: "private-lease", criteria: ["private-input"] },
        ],
      }),
    );
  });
  const registry = new SqliteFactoryRegistry(":memory:"),
    reader = new HttpLineReader({
      WERK_LINE_ALPHA_TOKEN: "line-private-credential",
    });
  const app = new FactoryApplication(
    registry,
    reader,
    new Set(["WERK_LINE_ALPHA_TOKEN"]),
  );
  app.createFactory({ id: "root", name: "Root" });
  app.createLine(line(upstream.url));
  const admin = "factory-admin-".repeat(3),
    viewer = "factory-viewer-".repeat(3);
  const service = await serve(
    createFactoryHandler(app, admin, "<html></html>", () => {}, undefined, {
      schemaVersion: 1,
      principals: [{ id: "viewer", token: viewer, role: "viewer" }],
    }),
  );
  try {
    assert.equal(
      (await fetch(service.url + "/v1/lines/alpha/tasks")).status,
      401,
    );
    const headers = { authorization: "Bearer " + viewer };
    const response = await fetch(
      service.url + "/v1/lines/alpha/tasks?limit=1",
      { headers },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.lineId, "alpha");
    assert.equal(result.tasks.length, 1);
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.deepEqual(calls, [
      { url: "/v1/tasks?limit=1", auth: "Bearer line-private-credential" },
    ]);
    assert.equal(
      (
        await fetch(service.url + "/v1/lines/alpha/tasks?url=http://attacker", {
          headers,
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(service.url + "/v1/lines/missing/tasks", { headers }))
        .status,
      404,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      (
        await fetch(service.url + "/v1/lines/alpha/tasks", {
          method: "POST",
          headers,
        })
      ).status,
      403,
    );
  } finally {
    reader.close();
    registry.close();
    await service.close();
    await upstream.close();
  }
});
test("Task proxy refuses redirects, does not leak upstream errors, bounds concurrency and aborts shutdown", async () => {
  let mode = "ok",
    active = 0,
    peak = 0,
    redirectCalls = 0;
  const target = await serve((_req, res) => {
    redirectCalls++;
    res.end("{}");
  });
  const upstream = await serve((req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { location: target.url });
      res.end();
      return;
    }
    if (mode === "error") {
      res.writeHead(500);
      res.end("private-upstream-prompt");
      return;
    }
    active++;
    peak = Math.max(peak, active);
    const timer = setTimeout(
      () => {
        active--;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(page()));
      },
      mode === "slow" ? 2000 : 30,
    );
    res.once("close", () => clearTimeout(timer));
  });
  const reader = new HttpLineReader(
    { WERK_LINE_ALPHA_TOKEN: "credential" },
    1000,
    2,
  );
  try {
    await Promise.all(
      Array.from({ length: 7 }, () =>
        reader.tasks(line(upstream.url), { limit: 50 }),
      ),
    );
    assert.equal(peak, 2);
    mode = "redirect";
    await assert.rejects(
      reader.tasks(line(upstream.url), { limit: 50 }),
      (e) => e.code === "unavailable",
    );
    assert.equal(redirectCalls, 0);
    mode = "error";
    await assert.rejects(
      reader.tasks(line(upstream.url), { limit: 50 }),
      (e) => !e.message.includes("private-upstream"),
    );
    mode = "slow";
    const pending = Array.from({ length: 5 }, () =>
      reader.tasks(line(upstream.url), { limit: 50 }),
    );
    reader.close();
    const settled = await Promise.allSettled(pending);
    assert.ok(settled.every((r) => r.status === "rejected"));
  } finally {
    reader.close();
    await upstream.close();
    await target.close();
  }
});

test("Rich task pages remain bounded and every task is reachable through the upstream cursor", async () => {
  const tasks = Array.from({ length: 50 }, (_, index) => ({
    ...row(),
    id: "rich-" + index,
    criteria: Array.from({ length: 30 }, () => "x".repeat(2000)),
  }));
  assert(
    Buffer.byteLength(
      JSON.stringify({ tasks, hasMore: false, nextCursor: null }),
    ) > 3_000_000,
  );
  const limits = [];
  const upstream = await serve((req, res) => {
    const query = new URL(req.url, "http://localhost").searchParams;
    const limit = Number(query.get("limit")),
      offset = Number(query.get("cursor") ?? 0);
    limits.push(limit);
    const next = offset + limit,
      hasMore = next < tasks.length;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        tasks: tasks.slice(offset, next),
        hasMore,
        nextCursor: hasMore ? String(next) : null,
      }),
    );
  });
  const reader = new HttpLineReader({ WERK_LINE_ALPHA_TOKEN: "fixture" });
  try {
    const seen = [];
    let cursor;
    do {
      const result = await reader.tasks(line(upstream.url), {
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      assert(result.tasks.length <= 10);
      assert(!JSON.stringify(result).includes("criteria"));
      seen.push(...result.tasks.map((task) => task.id));
      cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(
      seen,
      tasks.map((task) => task.id),
    );
    assert.deepEqual(limits, [10, 10, 10, 10, 10]);
    const one = await reader.tasks(line(upstream.url), { limit: 1 });
    assert.equal(one.tasks.length, 1);
    assert.equal(limits.at(-1), 1);
  } finally {
    reader.close();
    await upstream.close();
  }
});
