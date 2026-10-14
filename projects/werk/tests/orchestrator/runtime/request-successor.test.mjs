import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { commands } from "../../../scripts/runtime/portable/commands.mjs";
import { createHash } from "node:crypto";
import { Store } from "../../../src/orchestrator/dist/orchestrator/persistence/store.js";
import { OrchestratorApplication } from "../../../src/orchestrator/dist/orchestrator/application.js";
import {
  createHttpHandler,
  tokenAuthorization,
} from "../../../src/orchestrator/dist/orchestrator/http.js";
import { SnapshotJournal } from "../../../src/worker/dist/worker/infrastructure/journal/snapshots.js";
const input = {
  project: "demo",
  title: "Accepted original",
  criteria: ["Observable result"],
  wikilinks: [],
  provider: "codex",
};
const profiles = [{ id: "codex-1", provider: "codex", mode: "mock" }];
const gate = {
  schemaVersion: 1,
  requestId: "request-1",
  revision: 2,
  inputDigest: "a".repeat(64),
  policyDigest: "b".repeat(64),
  evaluationId: "evaluation-1",
  stage: "ready",
  status: "blocked",
  failedRules: 1,
  unknownRules: 0,
};
function setup(t, ttl = 60000, clock = Date.now) {
  const store = new Store(":memory:", ttl, clock);
  t.after(() => store.close());
  const registration = store.register("demo", profiles);
  const worker = store.worker(registration.token);
  return { store, worker, workerToken: registration.token };
}
function paired(store, worker, task, receipt = gate, outcome = "failed") {
  const journal = new SnapshotJournal(
    "/tmp",
    worker.config.configHash ?? "default",
    "fixture",
  );
  try {
    const status = { lastContact: null, heartbeatErrors: 0 };
    const before = journal.capture(
      task,
      worker.id,
      profiles[0],
      status,
      "before",
    );
    store.snapshot(worker, before);
    const after = journal.capture(
      task,
      worker.id,
      profiles[0],
      status,
      "after",
      before,
      outcome,
    );
    store.snapshot(worker, { ...after, requestGate: receipt });
  } finally {
    journal.close();
  }
}
function held(store, worker, taskInput = input) {
  store.submit(taskInput, "parent");
  const task = store.claim(worker, "claim");
  paired(store, worker, task);
  store.hold(worker, task.id, task.lease, task.attempt, gate);
  return task;
}
const command = (task, extra = {}) => ({
  expectedAttempt: task.attempt,
  evaluationId: gate.evaluationId,
  operationId: "revision-one",
  input: { ...input, title: "Explicit revision" },
  ...extra,
});

test("hold requires matching pair and assignment; semantic duplicate is stable without requeue", (t) => {
  const { store, worker } = setup(t);
  store.submit(input, "parent");
  const task = store.claim(worker, "claim");
  assert.throws(
    () => store.hold(worker, task.id, task.lease, task.attempt, gate),
    /paired/,
  );
  paired(store, worker, task);
  const stranger = store.worker(store.register("demo", profiles).token);
  assert.throws(() =>
    store.hold(stranger, task.id, task.lease, task.attempt, gate),
  );
  assert.throws(
    () =>
      store.hold(worker, task.id, task.lease, task.attempt, {
        ...gate,
        evaluationId: "different",
      }),
    /paired/,
  );
  assert.equal(
    store.hold(worker, task.id, task.lease, task.attempt, gate).status,
    "blocked",
  );
  const reordered = Object.fromEntries(Object.entries(gate).reverse());
  assert.equal(
    store.hold(worker, task.id, task.lease, task.attempt, reordered).status,
    "blocked",
  );
  assert.equal(
    store.events(task.id).filter((e) => e.kind === "gate_held").length,
    1,
  );
  assert.equal(store.claim(worker, "later"), null);
  assert.throws(
    () =>
      store.hold(worker, task.id, task.lease, task.attempt, {
        ...gate,
        revision: 3,
      }),
    /differs/,
  );
});

test("expired assignment cannot hold a request even with a historical complete pair", (t) => {
  let now = 1000;
  const { store, worker } = setup(t, 100, () => now);
  store.submit(input, "parent");
  const task = store.claim(worker, "claim");
  paired(store, worker, task);
  now = 1200;
  assert.throws(() =>
    store.hold(worker, task.id, task.lease, task.attempt, gate),
  );
  assert.notEqual(store.get(task.id).status, "blocked");
});

test("successor keeps original immutable and deduplicates before state checks; changed/stale input rejects", (t) => {
  const { store, worker } = setup(t),
    task = held(store, worker),
    body = command(task),
    before = store.get(task.id);
  const result = store.submitSuccessor(task.id, body);
  assert.equal(result.duplicate, false);
  assert.equal(result.task.status, "queued");
  assert.notEqual(result.task.id, task.id);
  assert.deepEqual(store.get(task.id), before);
  assert.equal(
    store.submitSuccessor(task.id, {
      ...body,
      input: Object.fromEntries(Object.entries(body.input).reverse()),
    }).task.id,
    result.task.id,
  );
  assert.throws(
    () =>
      store.submitSuccessor(task.id, {
        ...body,
        input: { ...body.input, title: "Changed" },
      }),
    /different input/,
  );
  assert.throws(
    () => store.submitSuccessor(task.id, { ...body, operationId: "another" }),
    /already has/,
  );
  assert.throws(
    () =>
      store.submitSuccessor(task.id, {
        ...body,
        operationId: "stale",
        expectedAttempt: 2,
      }),
    /current held/,
  );
  assert.equal(store.list().length, 2);
  assert.equal(
    store.events(task.id).filter((e) => e.kind === "successor_created").length,
    1,
  );
  assert.equal(
    store.events(result.task.id).filter((e) => e.kind === "predecessor_linked")
      .length,
    1,
  );
  assert.equal(store.claim(worker, "next").id, result.task.id);
  assert.equal(store.submitSuccessor(task.id, body).task.status, "running");
});

function manifest(ref, title, commit = "c".repeat(40)) {
  const unsigned = {
    schemaVersion: 1,
    project: "demo",
    commit,
    requirement: {
      wikilink: ref,
      title,
      acceptance: ["Pinned acceptance"],
      featureId: "feature",
      path: "features/new.md",
    },
    files: [],
  };
  return {
    ...unsigned,
    sha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
}
test("bound successor pins freshly resolved context; concurrent resolvers produce one child and retry never repins", async (t) => {
  const { store, worker } = setup(t),
    task = held(store, worker);
  let count = 0,
    release;
  const gatePromise = new Promise((r) => (release = r));
  const application = new OrchestratorApplication(store, "demo", {
    assertOpen() {},
    async resolve(ref) {
      count++;
      await gatePromise;
      return manifest(ref, "New pinned title");
    },
  });
  const body = command(task, {
    input: { project: "demo", requirementRef: "[[Revision]]" },
  });
  const first = application.createSuccessor(task.id, body),
    second = application.createSuccessor(task.id, body);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.task.id, b.task.id);
  assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
  assert.equal(a.task.title, "New pinned title");
  assert.equal(store.context(a.task.id).commit, "c".repeat(40));
  assert.equal(store.get(task.id).title, input.title);
  assert.equal(
    (await application.createSuccessor(task.id, body)).task.id,
    a.task.id,
  );
  assert.equal(count, 2);
});

test("HTTP successor requires write authority and blocks worker credentials", async (t) => {
  const { store, worker, workerToken } = setup(t),
    task = held(store, worker);
  const admin = "a".repeat(32),
    enroll = "e".repeat(32),
    viewer = "v".repeat(32);
  const application = new OrchestratorApplication(store, "demo");
  const server = createServer(
    createHttpHandler({
      application,
      schemaVersion: 6,
      authorize: tokenAuthorization(admin, enroll, {
        schemaVersion: 1,
        principals: [{ id: "viewer", role: "viewer", token: viewer }],
      }),
      audit() {},
      views: { intake: "", concept: "" },
      reportError() {},
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/tasks/${task.id}/successor`;
  const call = (token) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(command(task)),
    });
  for (const token of ["", enroll, workerToken, "wrong"]) {
    const response = await call(token);
    assert.equal(response.status, 401);
    await response.text();
  }
  const forbidden = await call(viewer);
  assert.equal(forbidden.status, 403);
  await forbidden.text();
  const response = await call(admin);
  assert.equal(response.status, 201);
  const accepted = await response.json();
  assert.equal(accepted.parentTaskId, task.id);
  const again = await call(admin);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).task.id, accepted.task.id);
});

test("native CLI sends explicit guarded successor from stdin and portable catalog exposes full envelope", async (t) => {
  let received;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = {
      path: req.url,
      body: JSON.parse(body),
      key: req.headers["idempotency-key"],
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        task: { id: "successor" },
        parentTaskId: "parent",
        duplicate: false,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sourceFixture = process.execArgv.includes("--import");
  const entry = sourceFixture
    ? "src/orchestrator/cli.ts"
    : "src/orchestrator/dist/orchestrator/cli.js";
  const child = spawn(
    process.execPath,
    [
      ...(sourceFixture ? process.execArgv : []),
      entry,
      "task",
      "successor",
      "--id",
      "parent",
      "--attempt",
      "2",
      "--evaluation",
      "gate-eval",
      "--key",
      "op-1",
      "--file",
      "-",
      "--url",
      `http://127.0.0.1:${server.address().port}`,
    ],
    {
      env: { ...process.env, WERK_ADMIN_TOKEN: "fixture-token" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  child.stdin.end(JSON.stringify(input));
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).task.id, "successor");
  assert.deepEqual(received, {
    path: "/v1/tasks/parent/successor",
    body: {
      expectedAttempt: 2,
      evaluationId: "gate-eval",
      operationId: "op-1",
      input,
    },
    key: "op-1",
  });
  const spec = commands("orchestrator")["task successor"];
  assert.equal(spec.path, "/v1/tasks/:id/successor");
  assert.deepEqual(spec.required, ["id"]);
  assert.equal(spec.example.operationId, "rework-1");
});

test("successor transaction rolls back child, context and receipt when a later link write fails", (t) => {
  const { store, worker } = setup(t),
    task = held(store, worker),
    body = command(task, {
      input: { project: "demo", requirementRef: "[[Revision]]" },
    }),
    originalEvent = store.event;
  store.event = function (id, kind, detail) {
    if (kind === "successor_created")
      throw Error("Injected link write failure");
    return originalEvent.call(this, id, kind, detail);
  };
  assert.throws(
    () =>
      store.submitSuccessor(task.id, body, manifest("[[Revision]]", "Revised")),
    /Injected/,
  );
  store.event = originalEvent;
  assert.equal(store.list().length, 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM task_contexts").get().count,
    0,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM task_successors").get()
      .count,
    0,
  );
  assert.equal(
    store.submitSuccessor(task.id, body, manifest("[[Revision]]", "Revised"))
      .duplicate,
    false,
  );
});

test("passed completion resolves held result once without mutating snapshots or reexecuting", (t) => {
  const { store, worker, workerToken } = setup(t);
  store.submit(input, "parent");
  const task = store.claim(worker, "claim");
  const heldGate = { ...gate, stage: "done" };
  paired(store, worker, task, heldGate, "simulated");
  store.hold(worker, task.id, task.lease, task.attempt, heldGate);
  const original = store.snapshots(),
    passed = {
      ...heldGate,
      status: "passed",
      revision: heldGate.revision + 2,
      evaluationId: "passed-evaluation",
      failedRules: 0,
    };
  const body = {
    lease: task.lease,
    attempt: task.attempt,
    heldEvaluationId: heldGate.evaluationId,
    gate: passed,
  };
  const stranger = store.worker(store.register("demo", profiles).token);
  assert.throws(
    () =>
      store.resolveHold(
        stranger,
        task.id,
        task.lease,
        task.attempt,
        heldGate.evaluationId,
        passed,
      ),
    /another worker/,
  );
  for (const changed of [
    { ...passed, inputDigest: "c".repeat(64) },
    { ...passed, policyDigest: "c".repeat(64) },
    { ...passed, requestId: "wrong" },
    { ...passed, evaluationId: heldGate.evaluationId },
    { ...passed, revision: heldGate.revision },
  ])
    assert.throws(
      () =>
        store.resolveHold(
          worker,
          task.id,
          task.lease,
          task.attempt,
          heldGate.evaluationId,
          changed,
        ),
      /same accepted/,
    );
  const application = new OrchestratorApplication(store, "demo");
  const resolved = application
    .worker(workerToken)
    .execute("resolve-hold", task.id, body);
  assert.equal(resolved.status, "simulated");
  assert.deepEqual(resolved.requestGate, passed);
  assert.deepEqual(store.snapshots(), original);
  assert.equal(store.claim(worker, "later"), null);
  assert.equal(
    application
      .worker(workerToken)
      .execute("resolve-hold", task.id, {
        ...body,
        gate: Object.fromEntries(Object.entries(passed).reverse()),
      }).status,
    "simulated",
  );
  assert.equal(
    store.events(task.id).filter((e) => e.kind === "gate_released").length,
    1,
  );
  assert.equal(
    application
      .worker(workerToken)
      .execute("resolve-hold", task.id, {
        ...body,
        gate: { ...passed, revision: passed.revision + 1 },
      }).status,
    "simulated",
  );
  assert.equal(
    store.events(task.id).filter((e) => e.kind === "gate_released").length,
    1,
  );
  assert.throws(
    () =>
      application
        .worker(workerToken)
        .execute("resolve-hold", task.id, {
          ...body,
          gate: { ...passed, evaluationId: "different" },
        }),
    /acknowledged/,
  );
});
test("readiness holds and superseded completion holds cannot be released by an unrelated passed gate", (t) => {
  const { store, worker } = setup(t),
    task = held(store, worker);
  const passed = {
    ...gate,
    status: "passed",
    stage: "done",
    revision: 4,
    evaluationId: "pass",
    failedRules: 0,
  };
  assert.throws(
    () =>
      store.resolveHold(
        worker,
        task.id,
        task.lease,
        task.attempt,
        gate.evaluationId,
        passed,
      ),
    /same accepted/,
  );
  store.submit(input, "other");
  const other = store.claim(worker, "second"),
    doneGate = { ...gate, stage: "done", evaluationId: "held-done" };
  paired(store, worker, other, doneGate, "simulated");
  store.hold(worker, other.id, other.lease, other.attempt, doneGate);
  store.submitSuccessor(other.id, {
    ...command(other),
    evaluationId: doneGate.evaluationId,
  });
  assert.throws(
    () =>
      store.resolveHold(
        worker,
        other.id,
        other.lease,
        other.attempt,
        doneGate.evaluationId,
        { ...passed, evaluationId: "pass-done" },
      ),
    /successor/,
  );
});
