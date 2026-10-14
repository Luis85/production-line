import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import { WorkerRunJournal } from "../../src/worker/dist/worker/infrastructure/journal/local-runs.js";
import { RequestReviewManager } from "../../src/worker/dist/worker/application/request-review.js";
import { SerialExecutor } from "../../src/worker/dist/worker/application/serial-executor.js";
import { unknownUsage } from "../../src/worker/dist/worker/application/run-evidence.js";
const usage = {
  ...unknownUsage(),
  inputTokens: 12,
  outputTokens: 4,
  source: "provider_reported",
  reason: null,
};
const wait = async (predicate) => {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw Error("Review did not settle");
};

test("operator cancellation retains final provider usage without disabling subsequent advisory reviews", async (t) => {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "werk-review-cancel-")),
    ),
    requests = new WorkerRequestJournal(directory),
    runs = new WorkerRunJournal(directory),
    executor = new SerialExecutor();
  let manager;
  await requests.init();
  await runs.init();
  t.after(async () => {
    await manager?.close();
    runs.close();
    requests.close();
    await rm(directory, { recursive: true, force: true });
  });
  const admit = (id) => {
    const request = requests.ensure({
      owner: { sessionId: id, rootTurnId: "root" },
      provider: { id: "fixture", model: "fixture", instruction: "" },
      input: { kind: "chat", title: "Incomplete requirement", message: "" },
    });
    requests.evaluate(request.id, "ready");
    return requests.get(request.id);
  };
  const first = admit("one");
  let invocations = 0;
  const model = {
    async reply() {
      throw Error("Use typed contract");
    },
    async execute(_request, signal, onUsage) {
      invocations++;
      if (invocations === 1)
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              onUsage(usage);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      return {
        type: "completed",
        text: JSON.stringify({ schemaVersion: 1, findings: [] }),
      };
    },
  };
  manager = new RequestReviewManager({
    gates: requests,
    runs,
    executor,
    model: () => model,
  });
  manager.tick();
  await wait(() => invocations === 1);
  const running = requests.get(first.id);
  requests.command({
    action: "cancel",
    requestId: first.id,
    expectedRevision: running.revision,
    operationId: "cancel",
  });
  manager.cancel(first.id);
  await wait(() => !manager.snapshot().active);
  assert.equal(requests.get(first.id).phase, "cancelled");
  const interrupted = requests.get(first.id).reviews[0];
  assert.equal(interrupted.result, null);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.errorCode, "operator_cancelled");
  assert.equal(interrupted.usage.inputTokens, 12);
  assert.equal(interrupted.usage.outputTokens, 4);
  assert.equal(manager.snapshot().persistenceError, false);
  assert.equal(runs.get(interrupted.runId).usage.inputTokens, 12);
  const second = admit("two");
  manager.tick();
  await wait(() => !manager.snapshot().active);
  assert.equal(invocations, 2);
  assert.equal(requests.get(second.id).reviews[0].status, "completed");
  assert.equal(executor.busy, false);
});
