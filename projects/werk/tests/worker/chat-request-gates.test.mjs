import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerSettings } from "../../src/worker/dist/worker/infrastructure/settings.js";
import { WorkerSessions } from "../../src/worker/dist/worker/application/sessions.js";
import { defaultGatePolicy } from "../../src/worker/dist/worker/application/request-gates.js";
async function until(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Fixture did not settle");
}
async function fixture(t, execute) {
  const directory = await mkdtemp(join(tmpdir(), "werk-chat-gates-")),
    settings = new WorkerSettings(directory);
  await settings.init();
  const model = () => ({
    configuration: {
      id: "codex-cli",
      model: "fixture-model",
      instruction: "Frozen fixture instructions",
    },
    async reply() {
      assert.fail("Structured fixture must receive dispatch");
    },
    execute,
  });
  const f = {
    directory,
    settings,
    sessions: null,
    restart: async () => {
      await f.sessions?.close();
      f.sessions = new WorkerSessions(directory, settings, model);
      await f.sessions.init();
    },
  };
  await f.restart();
  t.after(async () => {
    await f.sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return f;
}
function policy(f, mutate) {
  const value = defaultGatePolicy();
  value.reviewer.enabled = false;
  mutate(value);
  return f.sessions.requests.setPolicy({
    policy: value,
    expectedRevision: f.sessions.requests.policy().revision,
    operationId: "policy-" + crypto.randomUUID(),
  });
}
const current = (f) => f.sessions.requests.forSession("default");
function command(f, action, extra = {}) {
  const request = current(f);
  return f.sessions.requests.command({
    action,
    requestId: request.id,
    expectedRevision: request.revision,
    operationId: action + "-" + crypto.randomUUID(),
    ...extra,
  }).request;
}
test("held chat owns accepted input without fabricating a model reply or admitting execution", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { type: "completed", text: "Fixture reply" };
  });
  policy(f, (p) =>
    p.ready.chat.push({
      id: "criteria-required",
      fact: "input.criteriaCount",
      op: "gte",
      value: 1,
    }),
  );
  await f.sessions.start("Describe the request");
  const held = current(f);
  assert.equal(held.phase, "needs_rework");
  assert.equal(held.execution, null);
  assert.equal(calls, 0);
  assert.equal(f.sessions.interactions.view("default").totalTurns, 0);
  assert.equal(f.sessions.runs.list().total, 0);
  assert.deepEqual(
    f.sessions.chat.snapshot().messages.map((m) => m.role),
    ["user"],
  );
  assert.equal(f.sessions.view().records[0].status, "needs_rework");
  await f.restart();
  assert.equal(calls, 0);
  assert.equal(current(f).id, held.id);
  assert.deepEqual(
    f.sessions.chat.snapshot().messages.map((m) => m.role),
    ["user"],
  );
  await assert.rejects(f.sessions.start("Bypass readiness"), /guarded request/);
  await f.sessions.executeRequest(held.id);
  assert.equal(calls, 0);
});
test("known chat completion with unknown required evidence stays held across restart and cannot resume its provider", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { type: "completed", text: "Known fixture result" };
  });
  policy(f, (p) =>
    p.done.chat.push({
      id: "measured-tests",
      fact: "tests.passed",
      op: "eq",
      value: true,
    }),
  );
  await f.sessions.start("Produce a response");
  await until(() => !f.sessions.busy);
  const held = current(f),
    turn = f.sessions.interactions.view("default");
  assert.equal(held.phase, "needs_rework");
  assert.equal(held.execution.result.text, "Known fixture result");
  assert.equal(
    held.evaluations.at(-1).rules.find((r) => r.ruleId === "measured-tests")
      .result,
    "unknown",
  );
  assert.equal(f.sessions.runs.list().rows[0].outcome, "completed");
  await assert.rejects(f.sessions.start("Retry result"), /guarded request/);
  await assert.rejects(
    f.sessions.interact({
      action: "resume",
      sessionId: "default",
      turnId: turn.latestTurn.id,
      expectedRevision: turn.revision,
      operationId: "do-not-replay",
    }),
    /Completion/,
  );
  await f.restart();
  assert.equal(calls, 1);
  await f.sessions.executeRequest(held.id);
  assert.equal(calls, 1);
  assert.equal(
    f.sessions.chat.snapshot().messages.at(-1).text,
    "Known fixture result",
  );
});
test("guarded accepted chat revision executes once and survives duplicate owner execution and restart", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { type: "completed", text: "Accepted rework completed" };
  });
  policy(f, (p) =>
    p.ready.chat.push({
      id: "clear-input",
      fact: "input.messageLength",
      op: "gte",
      value: 10,
    }),
  );
  await f.sessions.start("Short");
  const original = current(f),
    input = {
      ...original.input,
      message: "A sufficiently explicit requested outcome.",
    };
  const proposed = command(f, "propose", { input });
  const accepted = command(f, "accept_candidate", {
    candidateId: proposed.candidates.at(-1).id,
  });
  assert.equal(accepted.inputRevision, 2);
  assert.equal(original.input.message, "Short");
  const executions = await Promise.allSettled([
    f.sessions.executeRequest(accepted.id),
    f.sessions.executeRequest(accepted.id),
  ]);
  assert.ok(executions.some((r) => r.status === "fulfilled"));
  await until(() => !f.sessions.busy);
  assert.equal(calls, 1);
  assert.equal(current(f).phase, "done");
  await f.sessions.executeRequest(accepted.id);
  await f.restart();
  await f.sessions.executeRequest(accepted.id);
  assert.equal(calls, 1);
  assert.equal(current(f).inputHash, accepted.inputHash);
});
test("completed follow-up creates a new request while stopped follow-up retains root request ownership", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) throw Error("Labelled fixture failure");
    return { type: "completed", text: "Fixture success" };
  });
  await f.sessions.start("Original task");
  await until(() => !f.sessions.busy);
  const stopped = current(f);
  assert.equal(stopped.phase, "failed");
  await f.sessions.requests.evaluate(stopped.id, "ready");
  assert.equal(current(f).phase, "ready");
  await f.sessions.start("Continue the same task");
  await until(() => !f.sessions.busy);
  assert.equal(current(f).id, stopped.id);
  assert.equal(
    f.sessions.interactions.view("default").latestTurn.kind,
    "resume",
  );
  assert.equal(current(f).input.message, "Original task");
  const completed = current(f);
  await f.sessions.start("Next task");
  await until(() => !f.sessions.busy);
  assert.notEqual(current(f).id, completed.id);
  assert.equal(f.sessions.requests.get(completed.id).phase, "done");
  assert.equal(
    f.sessions.requests.forTurn(
      "default",
      f.sessions.interactions.view("default").latestTurn.id,
    ).id,
    current(f).id,
  );
});
test("answer retains frozen request policy when the worker default changes", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () =>
    ++calls === 1
      ? {
          type: "needs_input",
          request: {
            schemaVersion: 1,
            kind: "question",
            message: "Which outcome should the fixture use?",
          },
        }
      : { type: "completed", text: "Answered fixture" },
  );
  await f.sessions.start("Ask for clarification");
  await until(() => !f.sessions.busy);
  const original = current(f);
  policy(f, (p) =>
    p.ready.chat.push({
      id: "new-default-needs-criteria",
      fact: "input.criteriaCount",
      op: "gte",
      value: 1,
    }),
  );
  const pending = f.sessions.interactions.view("default");
  await f.sessions.interact({
    action: "answer",
    sessionId: "default",
    pendingId: pending.pending.id,
    expectedRevision: pending.revision,
    operationId: "answer-original-policy",
    answer: "Keep the original scope.",
  });
  await until(() => !f.sessions.busy);
  assert.equal(calls, 2);
  assert.equal(current(f).id, original.id);
  assert.equal(current(f).policyDigest, original.policyDigest);
  assert.equal(current(f).phase, "done");
});
