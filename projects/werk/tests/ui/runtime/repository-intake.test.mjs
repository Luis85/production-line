import test from "node:test";
import assert from "node:assert/strict";
import { factory, line } from "../helpers/runtime-harness.mjs";

test("Factory live intake always sends Codex and keeps its repository through retry and expired access", async () => {
  const f = factory((_path, init) => {
    if (init.method === "POST") throw Error("Lost reply");
  });
  Object.assign(f.state.taskDraft, {
    project: "portal",
    repository: " portal-ui ",
    title: "Review checkout",
    criteria: "The change stays in the selected repository",
    execution: "cli",
    provider: "auto",
  });
  await f.submitIntake();
  f.disconnect(true);
  assert.equal(f.state.taskDraft.repository, " portal-ui ");
  await f.connect("new-fixture");
  await f.submitIntake();
  const writes = f.calls.filter((c) => c.method === "POST");
  assert.equal(writes[0].body.task.project, "portal");
  assert.equal(writes[0].body.task.repository, "portal-ui");
  assert.equal(writes[0].body.task.provider, "codex");
  assert.equal(writes[0].body.task.executionMode, "cli");
  assert.equal(writes[0].headers["Idempotency-Key"], writes[1].headers["Idempotency-Key"]);
  f.state.taskDraft.repository = "portal-api";
  await f.submitIntake();
  const third = f.calls.filter((c) => c.method === "POST")[2];
  assert.equal(third.body.task.repository, "portal-api");
  assert.notEqual(third.headers["Idempotency-Key"], writes[0].headers["Idempotency-Key"]);
  f.disconnect();
  assert.equal(f.state.taskDraft.repository, "");
});

test("Factory reference intake carries an explicit repository and omits a blank assignment", async () => {
  const f = factory((_path, init) => {
    if (init.method === "POST") throw Error("Offline");
  });
  Object.assign(f.state.taskDraft, { project: "portal", repository: "portal-ui", reference: "[[Features/Login]]" });
  await f.submitIntake();
  f.state.taskDraft.repository = "  ";
  await f.submitIntake();
  const writes = f.calls.filter((c) => c.method === "POST");
  assert.equal(writes[0].body.task.repository, "portal-ui");
  assert.equal(writes[0].body.task.requirementRef, "[[Features/Login]]");
  assert.equal(Object.hasOwn(writes[1].body.task, "repository"), false);
});

test("line intake preserves the repository independently of project and Vault/manual mode", () => {
  const f = line();
  Object.assign(f.state.intake, { project: "portal", repository: " portal-ui ", requirementRef: "[[Features/Login]]" });
  assert.deepEqual(f.intakePayload(), { project: "portal", repository: "portal-ui", requirementRef: "[[Features/Login]]" });
  Object.assign(f.state.intake, { executionMode: "cli", title: "Review checkout", criteria: "Expected", provider: "claude" });
  assert.equal(f.intakePayload().repository, "portal-ui");
  assert.equal(f.intakePayload().provider, "codex");
  f.state.intake.repository = "  ";
  assert.equal(Object.hasOwn(f.intakePayload(), "repository"), false);
});

test("line repository draft survives navigation, disconnect and ambiguous retries; a changed selection gets a new key", async () => {
  const f = line((_path, init) => {
    if (init.method === "POST") throw Error("Lost reply");
  });
  Object.assign(f.state.intake, { project: "portal", repository: "portal-ui", mode: "manual", title: "Review checkout", criteria: "Expected" });
  await f.submitTask();
  await f.navigate("workers");
  f.disconnect();
  assert.equal(f.state.intake.repository, "portal-ui");
  await f.connect("new-fixture");
  await f.submitTask();
  const writes = f.calls.filter((c) => c.method === "POST");
  assert.equal(writes[0].headers["Idempotency-Key"], writes[1].headers["Idempotency-Key"]);
  assert.equal(writes[1].body.repository, "portal-ui");
  f.state.intake.repository = "portal-api";
  await f.submitTask();
  const third = f.calls.filter((c) => c.method === "POST")[2];
  assert.equal(third.body.repository, "portal-api");
  assert.notEqual(third.headers["Idempotency-Key"], writes[0].headers["Idempotency-Key"]);
});
