import { workerClient, snapshotFixture } from './contract-fixtures.mjs';
import { RemoteGateReconciler } from "../../src/worker/dist/worker/application/reconcile-request-gates.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import { RemoteRequestGates } from "../../src/worker/dist/worker/application/remote-request-gates.js";
import { executeAttempt } from "../../src/worker/dist/worker/application/execute-attempt.js";
import { defaultGatePolicy } from "../../src/worker/dist/worker/application/request-gates.js";
import {
  workerCommands,
  workerBody,
} from "../../scripts/runtime/portable/worker-commands.mjs";
/** @returns {import('../../src/shared/contracts.js').Task} */
const assigned = (lease = "lease-1", attempt = 1) => ({
  id: "task-1",
  project: "demo",
  title: "Feature",
  criteria: ["Done"],
  wikilinks: [],
  provider: "claude",
  priority: 1,
  status: "running",
  attempt,
  workerId: "worker-1",
  lease,
  expiresAt: 11000,
  profile: "claude-1",
  createdAt: 0,
});
async function fixture(t, policy = defaultGatePolicy()) {
  const directory = await mkdtemp(join(tmpdir(), "werk-remote-gates-"));
  const requests = new WorkerRequestJournal(directory);
  await requests.init();
  t.after(async () => {
    requests.close();
    await rm(directory, { recursive: true, force: true });
  });
  requests.setPolicy({ policy, expectedRevision: 0, operationId: "policy-1" });
  const entries = new Map(),
    events = [];
  let invocations = 0;
  /** @type {import('../../src/worker/application/ports.js').AttemptJournal} */
  const journal = {
    async read(pair, phase) {
      return entries.get(`${pair}-${phase}`) ?? null;
    },
    capture(
      task,
      workerId,
      profile,
      state,
      phase,
      before,
      outcome = "pending",
      error = null,
    ) {
      return snapshotFixture({
        id: `${task.lease}-${phase}`,
        pairId: task.lease,
        phase,
        workerId,
        taskId: task.id,
        project: task.project,
        attempt: task.attempt,
        profileId: profile.id,
        provider: profile.provider,
        mode: "mock",
        provenance: {
          ...snapshotFixture().provenance,
          contextManifestHash: null,
          featureId: null,
          sourceCommit: null,
          iterationId: null,
        },
        execution: { ...snapshotFixture().execution, outcome, error },
      });
    },
    async persist(snapshot) {
      entries.set(snapshot.id, snapshot);
      return snapshot;
    },
    async flush(send) {
      for (const snapshot of entries.values()) await send(snapshot);
    },
  };
  const client = workerClient({
    async heartbeat(task) {
      return { ...task, expiresAt: 11000 };
    },
    async publishSnapshot() {},
    async complete() {
      events.push("complete");
    },
    async abandon() {
      events.push("abandon");
    },
    async hold(task, gate) {
      events.push("hold");
      assert.equal(gate.status, "blocked");
      assert.deepEqual(entries.get(`${task.lease}-after`).requestGate, gate);
    },
  });
  const gates = new RemoteRequestGates(requests, "http://line.test", () => ({
    id: "claude-cli",
    model: "fixture",
    instruction: "",
  }));
  /** @type {import('../../src/worker/application/ports.js').AttemptDependencies} */
  const deps = {
    client,
    journal,
    gates,
    adapter: {
      mode: "mock",
      async run() {
        invocations++;
        return { kind: "simulated", summary: "Simulation finished" };
      },
    },
    identity: { id: "worker-1", project: "demo" },
    profiles: [{ id: "claude-1", provider: "claude", mode: "mock" }],
    state: {
      lastContact: null,
      heartbeatErrors: 0,
      lastError: null,
      lastSnapshot: null,
      completedSimulations: 0,
    },
    async saveState() {},
    timeoutMs: 1000,
    now: () => 1000,
  };
  return {
    requests,
    entries,
    events,
    deps,
    gates,
    invocations: () => invocations,
  };
}
test("remote readiness holds skip primary execution and reuse the reviewer intent after lease reassignment", async (t) => {
  const policy = defaultGatePolicy();
  policy.ready.chat.push({
    id: "two-criteria",
    fact: "input.criteriaCount",
    op: "gte",
    value: 2,
  });
  const f = await fixture(t, policy);
  const first = await executeAttempt(
    assigned(),
    new AbortController().signal,
    f.deps,
  );
  assert.equal(first.execution.outcome, "gate_blocked");
  assert.equal(f.invocations(), 0);
  assert.deepEqual(f.events, ["hold"]);
  const request = f.requests.forSession("remote-task-1");
  assert.equal(request.phase, "needs_rework");
  assert.equal(request.reviews.length, 1);
  await executeAttempt(
    assigned("lease-2", 2),
    new AbortController().signal,
    f.deps,
  );
  assert.equal(f.invocations(), 0);
  assert.equal(f.requests.get(request.id).reviews.length, 1);
  assert.deepEqual(f.events, ["hold", "hold"]);
});
test("remote done hold preserves successful execution and known results rebuild terminal snapshots without a paid replay", async (t) => {
  const policy = defaultGatePolicy();
  policy.done.chat.push({
    id: "accepted",
    fact: "operator.accepted",
    op: "eq",
    value: true,
  });
  const f = await fixture(t, policy);
  const result = await executeAttempt(
    assigned(),
    new AbortController().signal,
    f.deps,
  );
  assert.equal(result.execution.outcome, "simulated");
  assert.equal(result.requestGate.status, "blocked");
  assert.equal(result.requestGate.stage, "done");
  assert.deepEqual(f.events, ["hold"]);
  f.entries.delete("lease-1-after");
  await executeAttempt(assigned(), new AbortController().signal, f.deps);
  assert.equal(f.invocations(), 1);
  assert.deepEqual(f.events, ["hold", "hold"]);
  await executeAttempt(
    assigned("lease-2", 2),
    new AbortController().signal,
    f.deps,
  );
  assert.equal(f.invocations(), 1);
  assert.equal(
    f.requests.forSession("remote-task-1").recoveryHold.code,
    "checkpoint_ownership",
  );
  assert.equal(
    f.entries.get("lease-2-after").execution.outcome,
    "gate_blocked",
  );
});
test("default remote gates complete valid simulation without claiming tests passed", async (t) => {
  const f = await fixture(t);
  const after = await executeAttempt(
    assigned(),
    new AbortController().signal,
    f.deps,
  );
  assert.equal(after.requestGate.status, "passed");
  assert.equal(after.requestGate.stage, "done");
  assert.deepEqual(f.events, ["complete"]);
  assert.equal(f.requests.forSession("remote-task-1").phase, "done");
  assert.equal(
    f.requests.forSession("remote-task-1").evaluations.at(-1).facts[
      "tests.passed"
    ],
    undefined,
  );
});
test("request CLI keeps numeric revision guards and action identity out of body input", async () => {
  const catalog = workerCommands({});
  assert.equal(catalog["request list"].mutating, false);
  assert.equal(catalog["request assign"].mutating, true);
  assert.deepEqual(
    await workerBody(
      catalog["request assign"],
      { assignee: "llm" },
      { id: "request-1", "if-match": "2", key: "assign-1" },
    ),
    {
      action: "assign",
      requestId: "request-1",
      expectedRevision: 2,
      operationId: "assign-1",
      assignee: "llm",
    },
  );
  await assert.rejects(
    workerBody(
      catalog["request assign"],
      { action: "attest" },
      { id: "request-1", "if-match": "2", key: "assign-1" },
    ),
  );
  await assert.rejects(
    workerBody(catalog["request list"], undefined, { limit: "1.1" }),
  );
});

test("passed remote Done gate reconciles its historical held lease once and preserves original snapshots", async (t) => {
  const policy = defaultGatePolicy();
  policy.done.chat.push({
    id: "accepted",
    fact: "operator.accepted",
    op: "eq",
    value: true,
  });
  const f = await fixture(t, policy);
  await executeAttempt(assigned(), new AbortController().signal, f.deps);
  const before = structuredClone(f.entries.get("lease-1-after"));
  const held = f.requests.forSession("remote-task-1");
  f.requests.command({
    action: "attest",
    requestId: held.id,
    expectedRevision: held.revision,
    operationId: "accept-result",
    inputHash: held.inputHash,
    outputDigest: held.execution.outputDigest,
    note: "Operator accepts this exact fixture result.",
  });
  const calls = [];
  f.deps.client.resolveHold = async (task, evaluationId, gate) => {
    calls.push({ task, evaluationId, gate });
  };
  const reconciler = new RemoteGateReconciler(f.requests, f.deps.journal);
  const identity = {
    id: "worker-1",
    project: "demo",
    url: "http://line.test",
    token: "fixture",
    configHash: "default",
  };
  assert.deepEqual(await reconciler.tick(f.deps.client, identity, 1000), {
    failed: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].evaluationId, before.requestGate.evaluationId);
  assert.equal(calls[0].gate.status, "passed");
  assert.deepEqual(calls[0].task, {
    id: "task-1",
    attempt: 1,
    lease: "lease-1",
  });
  await reconciler.tick(f.deps.client, identity, 12000);
  assert.equal(calls.length, 1);
  assert.deepEqual(f.entries.get("lease-1-after"), before);
  assert.equal(f.invocations(), 1);
});

test('remote repository selection is frozen in the accepted request and legacy requests retain their shape', async t => {
  const f = await fixture(t), task = { ...assigned(), repository: 'backend' };
  await f.deps.gates.ready(task);
  const context = f.requests.forTurn('remote-task-1', 'remote-task-1').input.context;
  assert.ok(context && typeof context === 'object' && 'repository' in context);
  assert.equal(context.repository, 'backend');
  await assert.rejects(f.deps.gates.ready({ ...task, repository: 'frontend' }), /context changed/);
  await assert.rejects(f.deps.gates.ready(assigned()), /context changed/);
  const legacy = { ...assigned(), id: 'legacy' };
  await f.deps.gates.ready(legacy);
  const legacyContext = f.requests.forTurn('remote-legacy', 'remote-legacy').input.context;
  assert.ok(legacyContext && typeof legacyContext === 'object');
  assert.equal(Object.hasOwn(legacyContext, 'repository'), false);
  await f.deps.gates.ready(legacy);
});
