import { cleanup } from './fixture-cleanup.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import {
  defaultGatePolicy,
  evaluateGate,
  validateGatePolicy,
  inputGateFacts,
  gateDigest,
} from "../../src/worker/dist/worker/application/request-gates.js";
import { unknownUsage } from "../../src/worker/dist/worker/application/run-evidence.js";
import { prepareModelRequest } from "../../src/worker/dist/worker/application/model-contract.js";
const provider = {
  id: "fixture",
  model: "fixture-v1",
  instruction: "No external calls.",
};
const input = {
  kind: "chat",
  title: "Clarify retry semantics",
  message: "Explain retry behavior.",
};
async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "werk-gates-")),
  );
  const journal = new WorkerRequestJournal(directory);
  await journal.init();
  cleanup(t, async () => {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, journal };
}
function admit(journal, patch = {}, key = "root") {
  return journal.ensure({
    owner: { sessionId: "session", rootTurnId: key },
    provider,
    input: { ...input, ...patch },
  });
}
function execute(
  journal,
  request,
  result = { type: "completed", text: "Known answer." },
  facts = {},
) {
  journal.evaluate(request.id, "ready");
  journal.bindTurn(request.id, "turn");
  journal.prepareExecution(request.id, "turn", "run");
  journal.startExecution(request.id, "turn", "run");
  return journal.recordResult(request.id, "turn", "run", result, facts);
}
function command(journal, request, action, rest = {}) {
  return journal.command({
    action,
    requestId: request.id,
    expectedRevision: request.revision,
    operationId: "op-" + action,
    ...rest,
  });
}
const dispatch = () =>
  prepareModelRequest(
    {
      configuration: provider,
      async reply() {
        throw Error("No provider call in tests");
      },
    },
    [
      {
        id: "review",
        role: "user",
        state: "complete",
        text: "Review only.",
        at: new Date().toISOString(),
      },
    ],
  );

test("policy is bounded and typed; missing facts never satisfy neq or numeric comparisons", () => {
  const policy = defaultGatePolicy();
  assert.equal(validateGatePolicy(policy).reviewer.enabled, true);
  for (const value of [
    { ...policy, extra: true },
    {
      ...policy,
      ready: {
        chat: [{ id: "r", fact: "arbitrary.path", op: "eq", value: true }],
        patch: [],
      },
    },
    {
      ...policy,
      done: {
        chat: [{ id: "r", fact: "output.nonEmpty", op: "gte", value: true }],
        patch: [],
      },
    },
    { ...policy, rework: { maxAttempts: 4 } },
    {
      ...policy,
      reviewer: { enabled: true, provider: "same", maxAttempts: 2 },
    },
  ])
    assert.throws(() => validateGatePolicy(value));
  policy.done.chat = [
    { id: "tests", fact: "tests.passed", op: "neq", value: false },
  ];
  assert.deepEqual(
    evaluateGate(policy, "done", "chat", {}).rules.map((r) => r.result),
    ["unknown"],
  );
  assert.equal(
    inputGateFacts({
      ...input,
      kind: "patch",
      files: [{ path: "src/main.ts", bytes: null }],
    })["input.approvedBytes"],
    null,
  );
  assert.equal(
    inputGateFacts({
      ...input,
      kind: "patch",
      files: [{ path: "../escape", bytes: 1 }],
    })["input.pathsValid"],
    false,
  );
});

test("durable policy affects new requests only and command receipts deduplicate before revision checks", async (t) => {
  const { journal, directory } = await fixture(t),
    first = admit(journal);
  const policy = defaultGatePolicy();
  policy.id = "strict";
  policy.done.chat.push({
    id: "operator",
    fact: "operator.accepted",
    op: "eq",
    value: true,
  });
  const body = { policy, expectedRevision: 0, operationId: "policy-1" };
  const saved = journal.setPolicy(body);
  assert.equal(saved.revision, 1);
  assert.equal(journal.setPolicy(body).duplicate, true);
  assert.throws(
    () => journal.setPolicy({ ...body, policy: defaultGatePolicy() }),
    /different input/,
  );
  assert.equal(admit(journal).policy.id, "werk-default");
  assert.equal(admit(journal, {}, "new").policy.id, "strict");
  journal.close();
  const reopened = new WorkerRequestJournal(directory);
  await reopened.init();
  cleanup(t, () => reopened.close());
  assert.equal(reopened.policy().digest, saved.digest);
  assert.equal(reopened.get(first.id).policy.id, "werk-default");
});

test("default gates retain successful results, while strict operator acceptance binds exact current output", async (t) => {
  const { journal } = await fixture(t),
    request = admit(journal);
  const completed = execute(journal, request);
  assert.equal(completed.phase, "done");
  assert.equal(completed.execution.outcome, "completed");
  assert.throws(() => journal.evaluate(request.id, "ready"), /Completion/);
  assert.throws(
    () =>
      journal.recordResult(request.id, "turn", "run", {
        type: "completed",
        text: "Replacement.",
      }),
    /immutable/,
  );
  const strict = defaultGatePolicy();
  strict.done.chat.push({
    id: "acceptance",
    fact: "operator.accepted",
    op: "eq",
    value: true,
  });
  const held = journal.ensure({
    owner: { sessionId: "other", rootTurnId: "strict" },
    input,
    provider,
    policy: strict,
  });
  const reviewed = execute(journal, held);
  assert.equal(reviewed.phase, "review");
  assert.equal(reviewed.execution.outcome, "completed");
  assert.throws(
    () =>
      command(journal, reviewed, "attest", {
        inputHash: reviewed.inputHash,
        outputDigest: "wrong",
        note: "Reviewed.",
      }),
    /current input/,
  );
  const result = command(journal, reviewed, "attest", {
    inputHash: reviewed.inputHash,
    outputDigest: reviewed.execution.outputDigest,
    note: "Accepted by the operator.",
  });
  assert.equal(result.request.phase, "done");
  assert.equal(result.request.attestation.actor, "operator");
  assert.equal(result.request.execution.result.text, "Known answer.");
});

test("failed readiness queues one review and survives restart without phantom primary execution", async (t) => {
  const { journal, directory } = await fixture(t),
    request = admit(journal, { message: "" });
  const gate = journal.evaluate(request.id, "ready");
  assert.equal(gate.passed, false);
  assert.equal(journal.get(request.id).phase, "needs_rework");
  assert.equal(journal.get(request.id).execution, null);
  journal.evaluate(request.id, "ready");
  assert.equal(journal.queuedReviews().length, 1);
  const intent = journal.queuedReviews()[0];
  journal.startReview(request.id, intent.id, "review-run", dispatch());
  const usage = {
    ...unknownUsage(),
    inputTokens: 12,
    outputTokens: 3,
    source: "provider_reported",
    reason: null,
  };
  journal.observeReviewUsage(request.id, intent.id, usage);
  journal.close();
  const reopened = new WorkerRequestJournal(directory);
  await reopened.init();
  cleanup(t, () => reopened.close());
  const retained = reopened.get(request.id);
  assert.equal(retained.reviews[0].status, "interrupted");
  assert.equal(retained.reviews[0].usage.inputTokens, 12);
  assert.ok(retained.reviews[0].dispatch.renderedPrompt);
  assert.equal(reopened.queuedReviews().length, 0);
  reopened.evaluate(request.id, "ready");
  assert.equal(reopened.get(request.id).reviews.length, 1);
  assert.equal(reopened.queuedReviews().length, 0);
});

test("advisory approval cannot pass a gate or change file scope; accepted candidate is immutable and guarded", async (t) => {
  const { journal } = await fixture(t),
    request = admit(journal, { message: "" });
  journal.evaluate(request.id, "ready");
  const intent = journal.queuedReviews()[0];
  journal.startReview(request.id, intent.id, "review-run", dispatch());
  const advice = {
    summary: "Looks acceptable, but this is advisory.",
    findings: [],
    candidate: { ...request.input, message: "Explicit revised input." },
  };
  const reviewed = journal.completeReview(
    request.id,
    intent.id,
    advice,
    unknownUsage(),
  );
  assert.equal(reviewed.phase, "needs_rework");
  assert.equal(reviewed.attestation, null);
  assert.throws(
    () =>
      command(journal, reviewed, "propose", {
        input: { ...request.input, files: [{ path: "secret", bytes: 1 }] },
      }),
    /approved file scope/,
  );
  const body = {
    action: "accept_candidate",
    requestId: request.id,
    expectedRevision: reviewed.revision,
    operationId: "accept-1",
    candidateId: reviewed.candidates[0].id,
  };
  const accepted = journal.command(body);
  assert.equal(accepted.request.inputRevision, 2);
  assert.equal(accepted.request.phase, "ready");
  assert.equal(accepted.request.input.message, "Explicit revised input.");
  assert.equal(journal.command(body).duplicate, true);
  assert.throws(
    () => journal.command({ ...body, operationId: "stale-new" }),
    /changed/,
  );
  assert.equal(journal.get(request.id).reworkCount, 1);
});

test("known result survives recovery; unknown started execution interrupts without changing provider accounting", async (t) => {
  const { journal, directory } = await fixture(t),
    first = execute(journal, admit(journal));
  const pending = admit(journal, {}, "pending");
  journal.evaluate(pending.id, "ready");
  journal.bindTurn(pending.id, "pending-turn");
  journal.prepareExecution(pending.id, "pending-turn", "pending-run");
  journal.startExecution(pending.id, "pending-turn", "pending-run");
  journal.close();
  const reopened = new WorkerRequestJournal(directory);
  await reopened.init();
  cleanup(t, () => reopened.close());
  assert.equal(reopened.get(first.id).phase, "done");
  assert.equal(reopened.get(first.id).execution.result.text, "Known answer.");
  assert.equal(reopened.get(pending.id).phase, "interrupted");
  // A stronger, already durable result in the interaction journal can reconcile after restart.
  const reconciled = reopened.recordResult(
    pending.id,
    "pending-turn",
    "pending-run",
    { type: "completed", text: "Saved before projection failed." },
  );
  assert.equal(reconciled.phase, "done");
});

test("remote checkpoint hold retains known result and requires upstream successor for changed input", async (t) => {
  const { journal } = await fixture(t);
  const request = journal.ensure({
    owner: {
      sessionId: "remote-task",
      rootTurnId: "root",
      remote: {
        origin: "http://localhost:4300",
        taskId: "task",
        attempt: 1,
        lease: "lease-one",
      },
    },
    input,
    provider,
  });
  const completed = execute(journal, request);
  const held = journal.holdRecovery(request.id);
  assert.equal(held.phase, "needs_rework");
  assert.equal(held.execution.outputDigest, completed.execution.outputDigest);
  assert.equal(held.evaluations.at(-1).passed, false);
  const count = held.reviews.length;
  journal.holdRecovery(request.id);
  assert.equal(journal.get(request.id).reviews.length, count);
  assert.throws(
    () => journal.prepareExecution(request.id, "another", "new-run"),
    /different checkpoint/,
  );
  const proposed = command(journal, journal.get(request.id), "propose", {
    input: { ...input, message: "Revised remote request." },
  }).request;
  assert.throws(
    () =>
      command(journal, proposed, "accept_candidate", {
        candidateId: proposed.candidates[0].id,
      }),
    /owning orchestrator/,
  );
});

test("request paging and private cleanup retain unrelated sessions and reject journal symlinks", async (t) => {
  const { journal, directory } = await fixture(t);
  for (let i = 0; i < 105; i++) admit(journal, {}, "request-" + i);
  const first = journal.list({ limit: 100 });
  assert.equal(first.rows.length, 100);
  assert.equal(first.total, 105);
  assert.equal(first.nextOffset, 100);
  assert.equal(journal.list({ limit: 100, offset: 100 }).rows.length, 5);
  const id = first.rows[0].id,
    event = journal.events(id);
  assert.equal(event.events.length, 1);
  assert.deepEqual(journal.events(id, event.nextAfter).events, []);
  assert.equal(journal.events(id, event.nextAfter).nextAfter, event.nextAfter);
  assert.throws(() => journal.list({ limit: 101 }));
  assert.throws(() => journal.events(id, -1));
  journal.ensure({
    owner: { sessionId: "retained", rootTurnId: "retained" },
    input,
    provider,
  });
  journal.deleteSession("session");
  assert.equal(journal.list().total, 1);
  assert.throws(() => journal.get(id), /not found/);
  const other = join(directory, "symlink");
  await import("node:fs/promises").then((fs) => fs.mkdir(other));
  const target = join(directory, "outside");
  await writeFile(target, "untouched");
  await symlink(target, join(other, "worker-requests.sqlite"));
  const rejected = new WorkerRequestJournal(other);
  await assert.rejects(rejected.init(), /regular file/);
  assert.equal(await readFile(target, "utf8"), "untouched");
});

test("cancel interrupts reviewer intent and retains late result without reopening findings or candidates", async (t) => {
  const { journal } = await fixture(t),
    request = admit(journal, { message: "" });
  journal.evaluate(request.id, "ready");
  const intent = journal.queuedReviews()[0];
  journal.startReview(request.id, intent.id, "review-run", dispatch());
  assert.equal(journal.hasActiveReview("session"), true);
  const prior = journal.get(request.id);
  const cancelled = command(journal, prior, "cancel").request;
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.reviews[0].status, "interrupted");
  assert.equal(journal.hasActiveReview("session"), false);
  const late = journal.completeReview(
    request.id,
    intent.id,
    {
      summary: "Late advisory result",
      findings: [{ kind: "question", message: "Late question" }],
      candidate: { ...input, message: "Late revision" },
    },
    unknownUsage(),
  );
  assert.equal(late.phase, "cancelled");
  assert.equal(late.candidates.length, 0);
  assert.equal(late.findings.length, prior.findings.length);
  assert.ok(late.reviews[0].result);
});
test("explicit readiness confirmation can resume cancelled attempts without replacing historical results", async (t) => {
  const { journal } = await fixture(t),
    request = admit(journal);
  journal.evaluate(request.id, "ready");
  journal.bindTurn(request.id, "turn");
  journal.prepareExecution(request.id, "turn", "run");
  journal.startExecution(request.id, "turn", "run");
  journal.failExecution(request.id, "turn", "cancelled");
  journal.evaluate(request.id, "ready");
  assert.equal(journal.get(request.id).phase, "ready");
  journal.bindTurn(request.id, "next");
  journal.prepareExecution(request.id, "next", "next-run");
  assert.equal(journal.execution(request.id, "turn").status, "cancelled");
});

test("execute and evaluate are different idempotent intents", async (t) => {
  const { journal } = await fixture(t),
    request = admit(journal);
  const first = journal.command({
    action: "evaluate",
    stage: "ready",
    requestId: request.id,
    expectedRevision: request.revision,
    operationId: "decision",
  });
  assert.throws(
    () =>
      journal.command({
        action: "execute",
        requestId: request.id,
        expectedRevision: request.revision,
        operationId: "decision",
      }),
    /different input/,
  );
  const body = {
    action: "execute",
    requestId: request.id,
    expectedRevision: first.request.revision,
    operationId: "execute",
  };
  assert.equal(journal.command(body).duplicate, false);
  assert.equal(journal.command(body).duplicate, true);
});

test("passing a gate or accepting new input supersedes queued advisory work", async (t) => {
  const { journal } = await fixture(t),
    policy = defaultGatePolicy();
  policy.done.chat.push({
    id: "accept",
    fact: "operator.accepted",
    op: "eq",
    value: true,
  });
  const request = journal.ensure({
    owner: { sessionId: "attest", rootTurnId: "root" },
    provider,
    input,
    policy,
  });
  const held = execute(journal, request);
  assert.equal(journal.hasActiveReview("attest"), true);
  const accepted = command(journal, held, "attest", {
    inputHash: held.inputHash,
    outputDigest: held.execution.outputDigest,
    note: "Operator checked the result",
  }).request;
  assert.equal(accepted.phase, "done");
  assert.equal(accepted.reviews[0].errorCode, "superseded");
  assert.equal(journal.hasActiveReview("attest"), false);
  const draft = admit(journal, { message: "" }, "held");
  journal.evaluate(draft.id, "ready");
  const proposed = command(journal, journal.get(draft.id), "propose", {
    input: { ...draft.input, message: "Revised explicit input" },
  }).request;
  const revised = command(journal, proposed, "accept_candidate", {
    candidateId: proposed.candidates[0].id,
  }).request;
  assert.equal(revised.phase, "ready");
  assert.equal(journal.hasActiveReview("session"), false);
});
