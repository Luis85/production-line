import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RequestReviewManager,
} from "../../src/worker/dist/worker/application/request-review.js";
import { SerialExecutor } from "../../src/worker/dist/worker/application/serial-executor.js";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import { defaultGatePolicy } from "../../src/worker/dist/worker/application/request-gates.js";
import { WorkerRunJournal } from "../../src/worker/dist/worker/infrastructure/journal/local-runs.js";
import { usage, input, valid, wait, fixture } from './request-review-fixtures.mjs';

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
      throw Error("The abort-only fixture must never complete successfully.");
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
    /** @type {import('../../src/worker/application/run-evidence.js').RunMetadata} */
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
      // @ts-expect-error Deliberately invalid purpose exercises runtime validation.
      journal.begin({ ...metadata, purpose: "operator_approval" }),
      (error) => testErrorCode(error) === "invalid_input",
    );
    await assert.rejects(
      journal.begin({ ...metadata, requestId: "../outside" }),
      (error) => testErrorCode(error) === "invalid_input",
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
      (error) => testErrorCode(error) === "conflict",
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
    /** @type {import('../../src/worker/application/run-evidence.js').RunMetadata} */
    const metadata = {
      sessionId: "session-1",
      taskId: "task-1",
      kind: "chat",
      title: "Fixture",
      provider: "fixture",
      model: "m",
    };
    const ids = [];
    /** @type {[import('../../src/worker/application/run-evidence.js').RunMetadata['purpose'], number][]} */
    const usages = [
      [undefined, 1],
      ["execution", 2],
      ["gate_review", 10],
      ["rework", 20],
      ["gate_review", 30],
    ];
    for (const [purpose, tokens] of usages) {
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
      (error) => testErrorCode(error) === "invalid_input",
    );
    assert.throws(
      // @ts-expect-error Deliberately invalid query purpose must be rejected.
      () => journal.list({ purpose: "unknown" }),
      (error) => testErrorCode(error) === "invalid_input",
    );
    assert.throws(
      // @ts-expect-error Deliberately invalid query purpose must be rejected.
      () => journal.analyze({ purpose: "unknown" }),
      (error) => testErrorCode(error) === "invalid_input",
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
      throw Error("The abort-only fixture must never complete successfully.");
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
      throw Error("The abort-only fixture must never complete successfully.");
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
