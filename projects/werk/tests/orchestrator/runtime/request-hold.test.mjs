import test from "node:test";
import assert from "node:assert/strict";
import { OrchestratorApplication } from "../../../src/orchestrator/dist/orchestrator/application.js";
import { input, profiles, gate, setup, paired, held, command } from './request-fixtures.mjs';

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
  const reordered = /** @type {typeof gate} */ (Object.fromEntries(Object.entries(gate).reverse()));
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

test("passed completion resolves held result once without mutating snapshots or reexecuting", (t) => {
  const { store, worker, workerToken } = setup(t);
  store.submit(input, "parent");
  const task = store.claim(worker, "claim");
  const heldGate = /** @satisfies {import('../../../src/orchestrator/dist/shared/request-gate.js').RequestGateEvidence} */ ({ ...gate, stage: "done" });
  paired(store, worker, task, heldGate, "simulated");
  store.hold(worker, task.id, task.lease, task.attempt, heldGate);
  const original = store.snapshots(),
    passed = /** @satisfies {import('../../../src/orchestrator/dist/shared/request-gate.js').RequestGateEvidence} */ ({
      ...heldGate,
      status: "passed",
      revision: heldGate.revision + 2,
      evaluationId: "passed-evaluation",
      failedRules: 0,
    });
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
  const passed = /** @satisfies {import('../../../src/orchestrator/dist/shared/request-gate.js').RequestGateEvidence} */ ({
    ...gate,
    status: "passed",
    stage: "done",
    revision: 4,
    evaluationId: "pass",
    failedRules: 0,
  });
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
    doneGate = /** @satisfies {import('../../../src/orchestrator/dist/shared/request-gate.js').RequestGateEvidence} */ ({ ...gate, stage: "done", evaluationId: "held-done" });
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
