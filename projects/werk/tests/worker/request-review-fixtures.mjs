import assert from 'node:assert/strict';
import { RequestReviewManager } from '../../src/worker/dist/worker/application/request-review.js';
import { SerialExecutor } from '../../src/worker/dist/worker/application/serial-executor.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';

/** @type {import('../../src/worker/application/run-evidence.js').ProviderUsage} */
export const requestReviewUsage = {
  ...unknownUsage(),
  inputTokens: 12,
  outputTokens: 4,
  source: "provider_reported",
  reason: null,
};
/** @type {import('../../src/worker/application/request-gates.js').GateInput} */
export const reviewerInput = {
  kind: "patch",
  title: "Improve clarity",
  message: "Original request",
  criteria: ["Keep the layout"],
  files: [{ path: "approved.txt", bytes: 4 }],
  context: { approved: ["approved.txt"], sourceText: "data only" },
};
export const valid = JSON.stringify({
  schemaVersion: 1,
  findings: [{ kind: "gap", message: "Specify the target.", blocking: true }],
  candidate: { message: "Revised request text" },
});
export const waitForRequestReview = async (check) => {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("Fixture did not settle.");
};
/** @param {{kind?: 'review' | 'rework'; model?: import('../../src/worker/application/model-contract.js').StructuredModel['execute'] | null; startFailure?: boolean; completeFailure?: boolean; finishFailure?: boolean; runtimeMs?: number}} [options] */
export function reviewerFixture({
  kind = "review",
  model,
  startFailure = false,
  completeFailure = false,
  finishFailure = false,
  runtimeMs = 1000,
} = {}) {
  /** @type {import('../../src/worker/application/request-gates.js').GateReviewIntent} */
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
  /** @type {import('../../src/worker/application/request-gates.js').WorkerRequest} */
  const request = {
    schemaVersion: 1, revision: 1, policy: defaultGatePolicy(), provider: intent.provider,
    assignee: "operator", createdAt: intent.createdAt, updatedAt: intent.createdAt,
    reworkCount: 0, candidates: [], execution: null, attestation: null,
    id: "request-1",
    owner: { sessionId: "session-1", rootTurnId: "turn-1", taskId: "task-1" },
    input: structuredClone(reviewerInput),
    inputRevision: 1,
    inputHash: "input-1",
    policyDigest: "policy-1",
    phase: "needs_rework",
    evaluations: [{ id: "eval-1", stage: "ready", passed: false, rules: [], inputRevision: 1, inputHash: "input-1", policyDigest: "policy-1", outputDigest: null, at: intent.createdAt, facts: {} }],
    findings: [],
    reviews: [intent],
  };
  const events = [];
  /** @type {import('../../src/worker/application/run-evidence.js').WorkerRun[]} */
  const records = [];
  let calls = 0;
  /** @type {import('../../src/worker/application/request-review.js').RequestReviewPort} */
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
  /** @type {import('../../src/worker/application/run-evidence.js').RunEvidence} */
  const runs = {
    reserveUnknown() { throw Error('This fixture has no durable unknown-outcome storage.'); },
    async begin(metadata) {
      records.push({ ...metadata, schemaVersion: 1, id: "run-1", outcome: "queued",
        sequence: 1, attempt: 1, acceptedAt: intent.createdAt, before: null, after: null,
        startedAt: null, durationMs: null, queueDurationMs: null, usage: unknownUsage(),
        resourceDelta: { scope: "worker_process_between_snapshots", cpuUserMicros: null, cpuSystemMicros: null },
      });
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
  /** @type {import('../../src/worker/application/model-contract.js').StructuredModel | undefined} */
  const configured =
    model === null
      ? undefined
      : {
          reply: async () => {
            throw Error("legacy reply must not run");
          },
          capabilities: modelCapabilities,
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
