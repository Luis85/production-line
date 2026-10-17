import { createHash } from "node:crypto";
import { Store } from "../../../src/orchestrator/dist/orchestrator/persistence/store.js";
import { SnapshotJournal } from "../../../src/worker/dist/worker/infrastructure/journal/snapshots.js";

const input = {
  project: "demo",
  title: "Accepted original",
  criteria: ["Observable result"],
  wikilinks: [],
  provider: "codex",
};
/** @type {import('../../../src/orchestrator/dist/shared/contracts.js').Profile[]} */
const profiles = [{ id: "codex-1", provider: "codex", mode: "mock" }];
/** @type {import('../../../src/orchestrator/dist/shared/request-gate.js').RequestGateEvidence} */
const gate = {
  schemaVersion: 1,
  requestId: "request-1",
  revision: 2,
  inputDigest: "a".repeat(64),
  policyDigest: "b".repeat(64),
  evaluationId: "evaluation-1",
  stage: "ready",
  status: "blocked",
  failedRules: 1,
  unknownRules: 0,
};
function setup(t, ttl = 60000, clock = Date.now) {
  const store = new Store(":memory:", ttl, clock);
  t.after(() => store.close());
  const registration = store.register("demo", profiles);
  const worker = store.worker(registration.token);
  return { store, worker, workerToken: registration.token };
}
/** @param {import('../../../src/worker/dist/shared/snapshots.js').Snapshot['execution']['outcome']} [outcome] */
function paired(store, worker, task, receipt = gate, outcome = "failed") {
  const journal = new SnapshotJournal(
    "/tmp",
    worker.config.configHash ?? "default",
    "fixture",
  );
  try {
    const status = { lastContact: null, heartbeatErrors: 0 };
    const before = journal.capture(
      task,
      worker.id,
      profiles[0],
      status,
      "before",
    );
    store.snapshot(worker, before);
    const after = journal.capture(
      task,
      worker.id,
      profiles[0],
      status,
      "after",
      before,
      outcome,
    );
    store.snapshot(worker, { ...after, requestGate: receipt });
  } finally {
    journal.close();
  }
}
function held(store, worker, taskInput = input) {
  store.submit(taskInput, "parent");
  const task = store.claim(worker, "claim");
  paired(store, worker, task);
  store.hold(worker, task.id, task.lease, task.attempt, gate);
  return task;
}
const command = (task, extra = {}) => ({
  expectedAttempt: task.attempt,
  evaluationId: gate.evaluationId,
  operationId: "revision-one",
  input: { ...input, title: "Explicit revision" },
  ...extra,
});

/** @returns {import('../../../src/orchestrator/dist/shared/context.js').ContextManifest} */
function manifest(ref, title, commit = "c".repeat(40)) {
  /** @type {Omit<import('../../../src/orchestrator/dist/shared/context.js').ContextManifest, 'sha256'>} */
  const unsigned = {
    schemaVersion: 1,
    resolverVersion: "fixture-1",
    repository: "/fixture",
    vaultRoot: "features",
    policy: { dependencies: "factory_context_only", contentTrust: "untrusted_source", limits: { files: 32, depth: 8, fileBytes: 1048576, totalBytes: 4194304, manifestBytes: 4194304 } },
    project: "demo",
    commit,
    requirement: {
      wikilink: ref,
      title,
      acceptance: ["Pinned acceptance"],
      featureId: "feature",
      path: "features/new.md",
    },
    files: [],
  };
  return {
    ...unsigned,
    sha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
}

export { input, profiles, gate, setup, paired, held, command, manifest };
