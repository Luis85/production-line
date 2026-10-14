import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RequestReviewManager,
  parseAdvisoryReview,
} from "../../src/worker/dist/worker/application/request-review.js";
import { SerialExecutor } from "../../src/worker/dist/worker/application/serial-executor.js";
import { unknownUsage } from "../../src/worker/dist/worker/application/run-evidence.js";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import { defaultGatePolicy } from "../../src/worker/dist/worker/application/request-gates.js";
import { WorkerRunJournal } from "../../src/worker/dist/worker/infrastructure/journal/local-runs.js";
const usage = {
  ...unknownUsage(),
  inputTokens: 12,
  outputTokens: 4,
  source: "provider_reported",
  reason: null,
};
const input = {
  kind: "patch",
  title: "Improve clarity",
  message: "Original request",
  criteria: ["Keep the layout"],
  files: [{ path: "approved.txt", bytes: 4 }],
  context: { approved: ["approved.txt"], sourceText: "data only" },
};
const valid = JSON.stringify({
  schemaVersion: 1,
  findings: [{ kind: "gap", message: "Specify the target.", blocking: true }],
  candidate: { message: "Revised request text" },
});
const wait = async (check) => {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("Fixture did not settle.");
};
function fixture({
  kind = "review",
  model,
  startFailure = false,
  completeFailure = false,
  finishFailure = false,
  runtimeMs = 1000,
} = {}) {
  const intent = {
    id: "intent-1",
    requestId: "request-1",
    kind,
    stage: "ready",
    evaluationId: "eval-1",
    inputHash: "input-1",
    policyDigest: "policy-1",
    status: "queued",
    provider: {
      id: "fixture",
      model: "original-model",
      instruction: "original-instruction",
    },
    runId: null,
    dispatch: null,
    result: null,
    usage: null,
    errorCode: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    finishedAt: null,
  };
  const request = {
    id: "request-1",
    owner: { sessionId: "session-1", rootTurnId: "turn-1", taskId: "task-1" },
    input: structuredClone(input),
    inputRevision: 1,
    inputHash: "input-1",
    policyDigest: "policy-1",
    phase: "needs_rework",
    evaluations: [{ id: "eval-1", stage: "ready", passed: false, rules: [] }],
    findings: [],
    reviews: [intent],
  };
  const events = [],
    records = [];
  let calls = 0;
  const gates = {
    get() {
      return structuredClone(request);
    },
    queuedReviews() {
      return request.reviews
        .filter((r) => r.status === "queued")
        .map((r) => structuredClone(r));
    },
    startReview(_request, id, runId, dispatch) {
      events.push("prepared");
      if (startFailure) throw Error("write failed");
      Object.assign(intent, {
        status: "running",
        runId,
        dispatch: structuredClone(dispatch),
      });
      return structuredClone(intent);
    },
    observeReviewUsage(_request, id, value) {
      intent.usage = structuredClone(value);
    },
    completeReview(_request, id, result, value) {
      events.push("completed");
      Object.assign(intent, {
        status: "completed",
        result: structuredClone(result),
        usage: structuredClone(value),
      });
      if (completeFailure) throw Error("late projection failed");
      return structuredClone(request);
    },
    failReview(_request, id, code, value) {
      events.push("failed");
      Object.assign(intent, {
        status: code === "interrupted" ? "interrupted" : "failed",
        errorCode: code,
        usage: structuredClone(value),
      });
      return structuredClone(request);
    },
  };
  const runs = {
    async begin(metadata) {
      records.push({ ...metadata, id: "run-1", outcome: "queued" });
      events.push("begin");
      return records[0];
    },
    async start() {
      records[0].outcome = "running";
      events.push("started");
    },
    observeUsage(_id, value) {
      records[0].usage = structuredClone(value);
    },
    async finish(_id, outcome, value) {
      records[0].outcome = outcome;
      records[0].usage = structuredClone(value);
      events.push("finished");
      if (finishFailure) throw Error("ledger write failed");
      return records[0];
    },
  };
  const executor = new SerialExecutor();
  const configured =
    model === null
      ? undefined
      : {
          reply: async () => {
            throw Error("legacy reply must not run");
          },
          configuration: {
            id: "fixture",
            model: "changed-model",
            instruction: "changed-instruction",
          },
          async execute(dispatch, signal, onUsage) {
            calls++;
            events.push("invoked");
            assert.equal(intent.status, "running");
            assert.deepEqual(intent.dispatch, dispatch);
            return model
              ? model(dispatch, signal, onUsage)
              : { type: "completed", text: valid };
          },
        };
  const manager = new RequestReviewManager({
    gates,
    runs,
    executor,
    model: () => configured,
    maxRuntimeMs: () => runtimeMs,
  });
  return {
    manager,
    gates,
    runs,
    executor,
    request,
    intent,
    events,
    records,
    get calls() {
      return calls;
    },
  };
}
test("strict advisory schema forbids authority, approved-file changes and unbounded output", () => {
  const parsed = parseAdvisoryReview(valid, input, "ready");
  assert.equal(parsed.findings[0].blocking, true);
  assert.equal(parsed.candidate.message, "Revised request text");
  for (const key of ["kind", "title", "criteria", "files", "context"])
    assert.deepEqual(parsed.candidate[key], input[key]);
  assert.equal(input.message, "Original request");
  const candidates = [
    { schemaVersion: 1, findings: [], facts: { "tests.passed": true } },
    { schemaVersion: 1, findings: [], attestation: true },
    { schemaVersion: 1, findings: [], policy: {} },
    {
      schemaVersion: 1,
      findings: [],
      candidate: { message: "Changed", files: [] },
    },
    {
      schemaVersion: 1,
      findings: [{ kind: "gap", message: "", blocking: true }],
    },
    {
      schemaVersion: 1,
      findings: [{ kind: "gap", message: "Fine", blocking: "false" }],
    },
    {
      schemaVersion: 1,
      findings: Array.from({ length: 33 }, () => ({
        kind: "gap",
        message: "Fine",
        blocking: false,
      })),
    },
    {
      schemaVersion: 1,
      findings: [{ kind: "gap", message: "x".repeat(4001), blocking: true }],
    },
  ];
  for (const candidate of candidates)
    assert.throws(
      () => parseAdvisoryReview(JSON.stringify(candidate), input, "ready"),
      (error) => error.code === "protocol",
    );
  assert.throws(
    () => parseAdvisoryReview("Arbitrary prose", input, "ready"),
    (error) => error.code === "protocol",
  );
  assert.throws(
    () => parseAdvisoryReview("x".repeat(262145), input, "ready"),
    (error) => error.code === "protocol",
  );
});
test("review persists exact dispatch before invoking a frozen provider and never mutates accepted input", async () => {
  const f = fixture();
  f.manager.tick();
  await wait(
    () => f.intent.status === "completed" && !f.manager.snapshot().active,
  );
  assert.equal(f.calls, 1);
  assert.equal(f.intent.dispatch.provider.model, "original-model");
  assert.equal(f.intent.dispatch.provider.instruction, "original-instruction");
  assert.equal(f.intent.dispatch.policy.maxRuntimeMs, 1000);
  assert.deepEqual(f.request.input, input);
  assert.equal(f.intent.result.candidate.message, "Revised request text");
  assert.equal(f.records[0].purpose, "gate_review");
  assert.equal(f.records[0].requestId, "request-1");
  assert.equal(f.records[0].kind, "local");
  assert.ok(f.events.indexOf("prepared") < f.events.indexOf("invoked"));
  assert.ok(f.events.indexOf("started") < f.events.indexOf("invoked"));
  await f.manager.close();
});
test("queued review waits for main work then rejects a superseded input generation without billing", async () => {
  const f = fixture(),
    release = await f.executor.acquire("primary", new AbortController().signal);
  f.manager.tick();
  await wait(() => f.records.length === 1);
  assert.equal(f.calls, 0);
  f.request.inputHash = "new-input-generation";
  release();
  await wait(() => !f.manager.snapshot().active);
  assert.equal(f.calls, 0);
  assert.equal(f.intent.errorCode, "superseded");
  assert.equal(f.records[0].outcome, "failed");
  await f.manager.close();
});
test("missing provider fails a durable intent once instead of retrying every tick", async () => {
  const f = fixture({ model: null });
  f.manager.tick();
  await wait(() => !f.manager.snapshot().active);
  assert.equal(f.intent.errorCode, "unavailable");
  for (let n = 0; n < 5; n++) f.manager.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.intent.status, "failed");
  assert.equal(f.records.length, 0);
  await f.manager.close();
});
test("explicit rework only proposes message text and reports separate accounted purpose", async () => {
  const f = fixture({ kind: "rework" });
  f.manager.tick();
  await wait(() => !f.manager.snapshot().active);
  assert.equal(f.calls, 1);
  assert.equal(f.records[0].purpose, "rework");
  assert.equal(f.intent.result.summary, "Advisory rework candidate.");
  assert.deepEqual(f.intent.result.candidate.files, input.files);
  assert.equal(f.request.inputRevision, 1);
  assert.equal(f.request.inputHash, "input-1");
  await f.manager.close();
});
test("typed needs_input becomes a blocking advisory question with no gate approval", async () => {
  const f = fixture({
    model: async () => ({
      type: "needs_input",
      request: { schemaVersion: 1, kind: "question", message: "Which target?" },
    }),
  });
  f.manager.tick();
  await wait(() => !f.manager.snapshot().active);
  assert.deepEqual(f.intent.result.findings, [
    { kind: "question", message: "Which target?", blocking: true },
  ]);
  assert.equal(f.request.phase, "needs_rework");
  assert.equal(f.intent.result.candidate, undefined);
  await f.manager.close();
});
test("shutdown interrupts an advisory attempt while retaining reported consumption and releasing the permit", async () => {
  const f = fixture({
    model: async (_request, signal, onUsage) => {
      onUsage(usage);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  f.manager.tick();
  await wait(() => f.calls === 1);
  await f.manager.close();
  assert.equal(f.intent.status, "interrupted");
  assert.equal(f.intent.usage.inputTokens, 12);
  assert.equal(f.records[0].outcome, "interrupted");
  assert.equal(f.records[0].usage.outputTokens, 4);
  assert.equal(f.executor.current, null);
  const restarted = new RequestReviewManager({
    gates: f.gates,
    runs: f.runs,
    executor: f.executor,
    model: () => {
      throw Error("must not replay");
    },
  });
  restarted.tick();
  assert.equal(restarted.snapshot().active, null);
  assert.equal(f.calls, 1);
  await restarted.close();
});
test("dispatch persistence failure prevents inference and committed results survive later projection failure", async () => {
  const blocked = fixture({ startFailure: true });
  blocked.manager.tick();
  await wait(() => !blocked.manager.snapshot().active);
  assert.equal(blocked.calls, 0);
  assert.equal(blocked.intent.status, "failed");
  await blocked.manager.close();
  const committed = fixture({ completeFailure: true });
  committed.manager.tick();
  await wait(() => !committed.manager.snapshot().active);
  assert.equal(committed.calls, 1);
  assert.equal(committed.intent.status, "completed");
  assert.equal(committed.records[0].outcome, "completed");
  committed.manager.tick();
  assert.equal(committed.calls, 1);
  await committed.manager.close();
});
test("malformed advisory output retains usage and never produces a candidate or paid retry", async () => {
  const f = fixture({
    model: async (_request, _signal, onUsage) => {
      onUsage(usage);
      return {
        type: "completed",
        text: JSON.stringify({
          schemaVersion: 1,
          findings: [],
          facts: { "operator.accepted": true },
        }),
      };
    },
  });
  f.manager.tick();
  await wait(() => !f.manager.snapshot().active);
  assert.equal(f.intent.status, "failed");
  assert.equal(f.intent.errorCode, "protocol");
  assert.equal(f.intent.result, null);
  assert.equal(f.records[0].usage.inputTokens, 12);
  f.manager.tick();
  assert.equal(f.calls, 1);
  await f.manager.close();
});
test("run purpose and request identity roundtrip durably while legacy records stay compatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "werk-review-runs-"));
  let journal = new WorkerRunJournal(directory);
  try {
    await journal.init();
    const metadata = {
      sessionId: "session-1",
      taskId: "task-1",
      kind: "chat",
      title: "Advisory review",
      provider: "fixture",
      model: "m",
      purpose: "gate_review",
      requestId: "request-1",
    };
    const run = await journal.begin(metadata);
    await journal.start(run.id);
    await journal.finish(run.id, "completed", usage);
    const legacy = await journal.begin({
      ...metadata,
      purpose: undefined,
      requestId: undefined,
    });
    await journal.finish(legacy.id, "failed");
    await assert.rejects(
      journal.begin({ ...metadata, purpose: "operator_approval" }),
      (error) => error.code === "invalid_input",
    );
    await assert.rejects(
      journal.begin({ ...metadata, requestId: "../outside" }),
      (error) => error.code === "invalid_input",
    );
    journal.close();
    journal = new WorkerRunJournal(directory);
    await journal.init();
    assert.equal(journal.get(run.id).purpose, "gate_review");
    assert.equal(journal.get(run.id).requestId, "request-1");
    assert.equal(journal.get(run.id).before.resources.scope, "worker_process");
    assert.equal(journal.get(legacy.id).purpose, undefined);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real request journal checkpoints advisory context and keeps candidate acceptance guarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "werk-review-gates-"));
  const gates = new WorkerRequestJournal(directory),
    runs = new WorkerRunJournal(directory);
  let manager;
  try {
    await gates.init();
    await runs.init();
    const policy = defaultGatePolicy();
    policy.ready.patch.push({
      id: "specific-message",
      fact: "input.messageLength",
      op: "gte",
      value: 20,
    });
    const original = gates.ensure({
      owner: { sessionId: "session-1", rootTurnId: "turn-1", taskId: "task-1" },
      input,
      provider: { id: "fixture", model: "pinned-model", instruction: "" },
      policy,
    });
    gates.evaluate(original.id, "ready");
    let calls = 0;
    manager = new RequestReviewManager({
      gates,
      runs,
      executor: new SerialExecutor(),
      model: () => ({
        reply: async () => valid,
        async execute(_request, _signal, onUsage) {
          calls++;
          onUsage(usage);
          return { type: "completed", text: valid };
        },
      }),
    });
    manager.tick();
    await wait(() => !manager.snapshot().active);
    const reviewed = gates.get(original.id);
    assert.equal(calls, 1);
    assert.equal(reviewed.reviews.length, 1);
    assert.equal(reviewed.reviews[0].status, "completed");
    assert.ok(reviewed.reviews[0].dispatch);
    assert.equal(reviewed.reviews[0].usage.inputTokens, 12);
    assert.deepEqual(reviewed.input, input);
    assert.equal(reviewed.inputRevision, 1);
    assert.equal(reviewed.candidates.length, 1);
    assert.throws(
      () =>
        gates.command({
          action: "accept_candidate",
          requestId: reviewed.id,
          expectedRevision: reviewed.revision - 1,
          operationId: "stale-accept",
          candidateId: reviewed.candidates[0].id,
        }),
      (error) => error.code === "conflict",
    );
    const accepted = gates.command({
      action: "accept_candidate",
      requestId: reviewed.id,
      expectedRevision: reviewed.revision,
      operationId: "accept-current",
      candidateId: reviewed.candidates[0].id,
    }).request;
    assert.equal(accepted.inputRevision, 2);
    assert.equal(accepted.input.message, "Revised request text");
    assert.deepEqual(accepted.input.files, input.files);
    assert.notEqual(accepted.inputHash, reviewed.inputHash);
    assert.equal(runs.list().rows[0].purpose, "gate_review");
    assert.equal(runs.list().rows[0].requestId, reviewed.id);
  } finally {
    await manager?.close();
    gates.close();
    runs.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("purpose-filtered pages and analysis separate primary, advisory and explicit rework usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "werk-purpose-filter-")),
    journal = new WorkerRunJournal(directory);
  try {
    await journal.init();
    const metadata = {
      sessionId: "session-1",
      taskId: "task-1",
      kind: "chat",
      title: "Fixture",
      provider: "fixture",
      model: "m",
    };
    const ids = [];
    for (const [purpose, tokens] of [
      [undefined, 1],
      ["execution", 2],
      ["gate_review", 10],
      ["rework", 20],
      ["gate_review", 30],
    ]) {
      const row = await journal.begin({
        ...metadata,
        ...(purpose ? { purpose } : {}),
      });
      await journal.start(row.id);
      await journal.finish(row.id, "completed", {
        ...usage,
        inputTokens: tokens,
      });
      ids.push(row.id);
    }
    const execution = journal.list({ purpose: "execution" });
    assert.deepEqual(
      execution.rows.map((r) => r.id),
      ids.slice(0, 2),
    );
    assert.equal(
      journal.analyze({ purpose: "execution" }).consumption.inputTokens,
      3,
    );
    const first = journal.list({ purpose: "gate_review", limit: 1 }),
      second = journal.list({
        purpose: "gate_review",
        limit: 1,
        cursor: first.nextCursor,
      });
    assert.equal(first.total, 2);
    assert.equal(second.rows[0].id, ids[4]);
    assert.equal(
      journal.analyze({ purpose: "gate_review" }).consumption.inputTokens,
      40,
    );
    assert.equal(
      journal.analyze({ purpose: "rework" }).consumption.inputTokens,
      20,
    );
    assert.equal(journal.analyze().total, 5);
    assert.throws(
      () => journal.list({ purpose: "execution", cursor: first.nextCursor }),
      (error) => error.code === "invalid_input",
    );
    assert.throws(
      () => journal.list({ purpose: "unknown" }),
      (error) => error.code === "invalid_input",
    );
    assert.throws(
      () => journal.analyze({ purpose: "unknown" }),
      (error) => error.code === "invalid_input",
    );
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session-specific drain respects another session and releases the matching review before deletion", async () => {
  const f = fixture({
    model: async (_request, signal, onUsage) => {
      onUsage(usage);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  f.manager.tick();
  await wait(() => f.calls === 1);
  assert.equal(f.executor.current, "session-1");
  await f.manager.cancelSessionAndDrain("other-session");
  assert.ok(f.manager.snapshot().active);
  await f.manager.cancelSessionAndDrain("session-1");
  assert.equal(f.manager.snapshot().active, null);
  assert.equal(f.intent.status, "interrupted");
  assert.equal(f.executor.current, null);
  assert.equal(f.records[0].usage.inputTokens, 12);
  await f.manager.close();
});
test("injected advisory deadline is distinct from operator interruption and retains consumption without retry", async () => {
  const f = fixture({
    runtimeMs: 20,
    model: async (_request, signal, onUsage) => {
      onUsage(usage);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  f.manager.tick();
  await wait(() => !f.manager.snapshot().active);
  assert.equal(f.intent.status, "failed");
  assert.equal(f.intent.errorCode, "timeout");
  assert.equal(f.records[0].usage.outputTokens, 4);
  assert.equal(f.executor.current, null);
  f.manager.tick();
  assert.equal(f.calls, 1);
  await f.manager.close();
});
