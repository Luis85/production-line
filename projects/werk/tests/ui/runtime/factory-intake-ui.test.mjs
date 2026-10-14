import test from "node:test";
import assert from "node:assert/strict";
import { factory, response, deferred } from "../helpers/runtime-harness.mjs";
const fill = (f) =>
  Object.assign(f.state.taskDraft, {
    project: "demo",
    title: "Review checkout retry behavior",
    criteria: "Retry remains recoverable",
    reference: "",
  });
test("Factory expiry retains unsent intake and retry key; explicit disconnect clears them", async () => {
  const f = factory((_p, init) => {
    if (init.method === "POST") throw Error("Offline");
  });
  fill(f);
  await f.submitIntake();
  f.disconnect(true);
  assert.equal(f.state.taskDraft.title, "Review checkout retry behavior");
  await f.connect("new-fixture");
  await f.submitIntake();
  const writes = f.calls.filter((c) => c.method === "POST");
  assert.equal(
    writes[0].headers["Idempotency-Key"],
    writes[1].headers["Idempotency-Key"],
  );
  f.disconnect();
  assert.equal(f.state.taskDraft.title, "");
  assert.equal(f.state.taskDraft.reference, "");
});
test("Factory intake blocks duplicate submit and reference success restores an empty manual draft", async () => {
  const pending = deferred();
  const f = factory((_p, init) =>
    init.method === "POST" ? pending.promise : undefined,
  );
  fill(f);
  f.state.taskDraft.reference = "[[Fixtures/Requirement]]";
  const send = f.submitIntake();
  await f.submitIntake();
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(f.state.intakeBusy, true);
  const write = f.calls[0];
  assert.deepEqual(write.body.task, {
    project: "demo",
    provider: "auto",
    executionMode: "mock",
    priority: 1,
    requirementRef: "[[Fixtures/Requirement]]",
  });
  pending.resolve(response({ id: "saved", reason: "Delivery pending" }));
  await send;
  assert.equal(f.state.taskDraft.reference, "");
  assert.equal(f.state.taskDraft.title, "");
  assert.equal(f.state.intakeBusy, false);
  assert.match(f.state.intakeMessage, /Gespeichert: saved/);
});
test("Factory failed intake keeps input and stable key; changed body receives new key", async () => {
  const f = factory((_p, init) => {
    if (init.method === "POST") throw Error("Offline");
  });
  fill(f);
  await f.submitIntake();
  await f.submitIntake();
  f.state.taskDraft.title = "Changed";
  await f.submitIntake();
  const writes = f.calls.filter((c) => c.method === "POST");
  assert.equal(
    writes[0].headers["Idempotency-Key"],
    writes[1].headers["Idempotency-Key"],
  );
  assert.notEqual(
    writes[1].headers["Idempotency-Key"],
    writes[2].headers["Idempotency-Key"],
  );
  assert.equal(f.state.taskDraft.title, "Changed");
  assert.match(f.state.intakeMessage, /Eingaben bleiben erhalten/);
  assert.equal(f.state.intakeBusy, false);
});
test("Factory saved routing draft survives background refresh and late reads cannot change another factory", async () => {
  const pending = deferred();
  const f = factory((path) =>
    path.includes("/factories/root/routing") ? pending.promise : undefined,
  );
  f.state.policy = { mode: "manual", lineId: "line-a", paused: true };
  f.editPolicy();
  await f.loadPolicy();
  assert.deepEqual(
    { ...f.state.policy },
    { mode: "manual", lineId: "line-a", paused: true },
  );
  assert.equal(f.calls.length, 0);
  f.state.policyDrafts.clear();
  const loading = f.loadPolicy();
  assert.equal(f.state.policyLoading, true);
  f.state.intakeFactory = "child";
  await f.loadPolicy();
  pending.resolve(response({ mode: "manual", lineId: "wrong", paused: true }));
  await loading;
  assert.equal(f.state.policy.lineId, null);
  assert.equal(f.state.policyLoading, false);
});
test("routing save blocks duplicate writes and retains the selected values on failure", async () => {
  const pending = deferred();
  const f = factory((_p, init) =>
    init.method === "PUT" ? pending.promise : undefined,
  );
  f.state.policy = { mode: "manual", lineId: "line-a", paused: true };
  const save = f.savePolicy();
  await f.savePolicy();
  f.navigate("other");
  assert.equal(f.state.scope, "");
  assert.equal(f.calls.filter((c) => c.method === "PUT").length, 1);
  pending.reject(Error("Offline"));
  await save;
  assert.equal(f.state.policy.lineId, "line-a");
  assert.equal(f.state.policyBusy, false);
  assert.match(f.state.policyError, /Offline/);
});

test("clearing a queued intake destination sends null to restore automatic routing", async () => {
  const f = factory();
  f.state.queueTargets.set("saved", "");
  await f.assignTarget({ id: "saved", lineId: "line-a" });
  assert.deepEqual(f.calls.find((c) => c.method === "PUT").body, {
    lineId: null,
  });
});
