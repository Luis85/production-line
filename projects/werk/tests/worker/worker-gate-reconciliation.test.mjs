import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import { defaultGatePolicy } from "../../src/worker/dist/worker/application/request-gates.js";
import { RemoteGateReconciler } from "../../src/worker/dist/worker/application/reconcile-request-gates.js";
import { verifyReviewArtifact } from "../../src/worker/dist/worker/infrastructure/review-artifact.js";
import { HttpWorkerGateway } from "../../src/worker/dist/worker/infrastructure/orchestrator-client.js";
const identity = {
  id: "worker-1",
  project: "demo",
  url: "http://line.test",
  token: "fixture",
  configHash: "default",
};
const patch =
  "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
async function fixture(t) {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "werk-release-artifact-")),
    ),
    requests = new WorkerRequestJournal(directory);
  await requests.init();
  t.after(async () => {
    requests.close();
    await rm(directory, { recursive: true, force: true });
  });
  const policy = defaultGatePolicy();
  policy.done.patch.push({
    id: "operator",
    fact: "operator.accepted",
    op: "eq",
    value: true,
  });
  const request = requests.ensure({
    owner: {
      sessionId: "remote-task-1",
      rootTurnId: "root",
      remote: {
        origin: identity.url,
        taskId: "task-1",
        lease: "lease-1",
        attempt: 1,
      },
    },
    input: {
      kind: "patch",
      title: "Change one file",
      message: "Make the approved edit",
      files: [{ path: "file.txt", bytes: 4 }],
    },
    provider: { id: "fixture", model: "fixture", instruction: "" },
    policy,
  });
  requests.evaluate(request.id, "ready");
  requests.bindTurn(request.id, "lease-1");
  requests.prepareExecution(request.id, "lease-1", "run");
  requests.startExecution(request.id, "lease-1", "run");
  const review = {
    artifactPath: "review/lease-1/change.patch",
    patchBytes: Buffer.byteLength(patch),
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    baseCommit: "a".repeat(40),
  };
  const held = requests.recordResult(
    request.id,
    "lease-1",
    "run",
    {
      type: "completed",
      text: JSON.stringify({
        kind: "change-set",
        summary: "Ready for review",
        review,
      }),
    },
    { "output.protocolValid": true, "output.patchPresent": true },
  );
  const evaluation = held.evaluations.at(-1);
  const blocked = {
    schemaVersion: 1,
    requestId: request.id,
    revision: held.revision,
    inputDigest: held.inputHash,
    policyDigest: held.policyDigest,
    evaluationId: evaluation.id,
    stage: "done",
    status: "blocked",
    failedRules: 1,
    unknownRules: 0,
  };
  const snapshot = {
    pairId: "lease-1",
    taskId: "task-1",
    attempt: 1,
    workerId: identity.id,
    execution: { outcome: "change-set" },
    requestGate: blocked,
    review,
  };
  const journal = {
    async read() {
      return structuredClone(snapshot);
    },
  };
  requests.command({
    action: "attest",
    requestId: request.id,
    expectedRevision: held.revision,
    operationId: "accepted",
    inputHash: held.inputHash,
    outputDigest: held.execution.outputDigest,
    note: "Operator reviewed this result",
  });
  await mkdir(join(directory, "review", "lease-1"), { recursive: true });
  return {
    directory,
    requests,
    requestId: request.id,
    journal,
    snapshot,
    review,
    path: join(directory, review.artifactPath),
  };
}

test("missing and tampered patches block hold release; restored exact evidence permits one acknowledgement", async (t) => {
  const f = await fixture(t),
    calls = [];
  const client = {
    async resolveHold(...args) {
      calls.push(args);
    },
  };
  const reconciler = new RemoteGateReconciler(f.requests, f.journal, (s) =>
    verifyReviewArtifact(f.directory, s.pairId, s.review),
  );
  assert.deepEqual(await reconciler.tick(client, identity, 1000), {
    failed: 1,
  });
  assert.equal(calls.length, 0);
  await writeFile(f.path, patch.replace("+new", "+bad"));
  assert.deepEqual(await reconciler.tick(client, identity, 12000), {
    failed: 1,
  });
  assert.equal(calls.length, 0);
  await writeFile(f.path, patch);
  assert.deepEqual(await reconciler.tick(client, identity, 23000), {
    failed: 0,
  });
  assert.equal(calls.length, 1);
  await reconciler.tick(client, identity, 34000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], f.snapshot.requestGate.evaluationId);
});

test("a cancelled decision while artifact verification is pending cannot release the remote hold", async (t) => {
  const f = await fixture(t);
  let entered, release;
  const waiting = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  let calls = 0;
  const reconciler = new RemoteGateReconciler(
    f.requests,
    f.journal,
    async () => {
      entered();
      await gate;
    },
  );
  const pending = reconciler.tick(
    {
      async resolveHold() {
        calls++;
      },
    },
    identity,
    1000,
  );
  await waiting;
  try {
    const current = f.requests.get(f.requestId);
    f.requests.command({
      action: "cancel",
      requestId: current.id,
      expectedRevision: current.revision,
      operationId: "cancel",
      note: "Stop release",
    });
  } finally {
    release();
  }
  assert.deepEqual(await pending, { failed: 0 });
  assert.equal(calls, 0);
});

test("review evidence refuses direct and parent-directory symlinks and mismatched metadata", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, patch);
  await verifyReviewArtifact(f.directory, "lease-1", f.review);
  await assert.rejects(
    verifyReviewArtifact(f.directory, "other", f.review),
    /identity/,
  );
  await assert.rejects(
    verifyReviewArtifact(f.directory, "lease-1", {
      ...f.review,
      patchBytes: 0,
    }),
    /metadata/,
  );
  if (process.platform === "win32") return;
  const external = join(f.directory, "external");
  await mkdir(external);
  await writeFile(join(external, "change.patch"), patch);
  await rm(join(f.directory, "review", "lease-1"), { recursive: true });
  await symlink(external, join(f.directory, "review", "lease-1"));
  await assert.rejects(
    verifyReviewArtifact(f.directory, "lease-1", f.review),
    /symlink/,
  );
  await rm(join(f.directory, "review", "lease-1"));
  await mkdir(join(f.directory, "review", "lease-1"));
  await symlink(join(external, "change.patch"), f.path);
  await assert.rejects(
    verifyReviewArtifact(f.directory, "lease-1", f.review),
    /symlink/,
  );
});

test("HTTP gate resolution acknowledgement must match the exact passed decision", async (t) => {
  const f = await fixture(t),
    current = f.requests.get(f.requestId),
    evaluation = current.evaluations.at(-1),
    receipt = {
      ...f.snapshot.requestGate,
      status: "passed",
      revision: current.revision,
      evaluationId: evaluation.id,
      failedRules: 0,
    };
  let response = {
      id: "task-1",
      attempt: 1,
      status: "review",
      requestGate: receipt,
    },
    sent;
  const gateway = new HttpWorkerGateway(
    identity.url,
    "enroll",
    async (base, path, token, method, body) => {
      sent = { base, path, token, method, body };
      return response;
    },
  );
  const client = gateway.connect(identity),
    task = { id: "task-1", attempt: 1, lease: "lease-1" };
  await client.resolveHold(task, f.snapshot.requestGate.evaluationId, receipt);
  assert.equal(sent.path, "/v1/worker/tasks/task-1/resolve-hold");
  assert.equal(sent.token, identity.token);
  assert.deepEqual(sent.body, {
    lease: "lease-1",
    attempt: 1,
    heldEvaluationId: f.snapshot.requestGate.evaluationId,
    gate: receipt,
  });
  response = {
    ...response,
    requestGate: { ...receipt, evaluationId: "wrong" },
  };
  await assert.rejects(
    client.resolveHold(task, f.snapshot.requestGate.evaluationId, receipt),
    /differs/,
  );
  response = { ...response, requestGate: undefined };
  await assert.rejects(
    client.resolveHold(task, f.snapshot.requestGate.evaluationId, receipt),
  );
});
