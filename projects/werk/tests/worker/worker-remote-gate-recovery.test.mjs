import { workerClient } from './contract-fixtures.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/orchestrator/dist/orchestrator/persistence/store.js";
import { SnapshotJournal } from "../../src/worker/dist/worker/infrastructure/journal/snapshots.js";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import { RemoteRequestGates } from "../../src/worker/dist/worker/application/remote-request-gates.js";
import { executeAttempt } from "../../src/worker/dist/worker/application/execute-attempt.js";
import { defaultGatePolicy } from "../../src/worker/dist/worker/application/request-gates.js";

for (const scenario of ["completed", "ready-held", "done-held", "unknown"])
  test(
    "real startup journal recovery preserves " +
      scenario +
      " without model replay",
    async (t) => {
      const directory = await realpath(
          await mkdtemp(join(tmpdir(), "werk-gate-recovery-")),
        ),
        store = new Store(":memory:");
      let requests, journal;
      t.after(async () => {
        journal?.close();
        requests?.close();
        store.close();
        await rm(directory, { recursive: true, force: true });
      });
      /** @type {import('../../src/shared/contracts.js').Profile[]} */
      const profiles = [{ id: "codex-mock", provider: "codex", mode: "mock" }];
      const registration = store.register("demo", profiles),
        worker = store.worker(registration.token);
      store.submit(
        {
          project: "demo",
          title: "A bounded task",
          criteria: ["Result"],
          wikilinks: [],
          provider: "codex",
        },
        "parent",
      );
      const task = store.claim(worker, "claim");
      requests = new WorkerRequestJournal(directory);
      await requests.init();
      const policy = defaultGatePolicy();
      if (scenario === "ready-held")
        policy.ready.chat.push({
          id: "long",
          fact: "input.messageLength",
          op: "gte",
          value: 100,
        });
      if (scenario === "done-held")
        policy.done.chat.push({
          id: "accept",
          fact: "operator.accepted",
          op: "eq",
          value: true,
        });
      requests.setPolicy({
        policy,
        expectedRevision: 0,
        operationId: "policy",
      });
      const makeGates = () =>
        new RemoteRequestGates(requests, "http://localhost:4300", () => ({
          id: "fixture",
          model: "fixture",
          instruction: "",
        }));
      let gates = makeGates();
      journal = new SnapshotJournal(
        directory,
        worker.config.configHash ?? "default",
        "prompt",
      );
      await journal.init();
      const state = {
        lastError: null, lastSnapshot: null,
        lastContact: null,
        heartbeatErrors: 0,
        completedSimulations: 0,
      };
      const before = await journal.persist(
        journal.capture(task, worker.id, profiles[0], state, "before"),
      );
      const ready = await gates.ready(task);
      if (ready.status === "passed") {
        await gates.start(task);
        if (scenario !== "unknown")
          await gates.completed(task, {
            kind: "simulated",
            summary: "Known durable result",
          });
      }
      journal.close();
      requests.close();
      requests = new WorkerRequestJournal(directory);
      await requests.init();
      gates = makeGates();
      journal = new SnapshotJournal(
        directory,
        worker.config.configHash ?? "default",
        "prompt",
      );
      await journal.init();
      await journal.recover(worker.id, profiles, state, (snapshot) =>
        gates.recoverSnapshot(snapshot),
      );
      const recovered = await journal.read(task.lease, "after");
      assert.deepEqual(await journal.read(task.lease, "before"), before);
      assert.equal(recovered.health.recoveredAfterCrash, true);
      assert.equal(recovered.execution.durationMs, null);
      assert.equal(
        recovered.execution.timingSource,
        "unavailable_after_restart",
      );
      assert.equal(recovered.resources.cpuDeltaMicros, null);
      assert.equal(recovered.quality.gate, "not_evaluated");
      assert.equal(
        recovered.execution.outcome,
        scenario === "unknown"
          ? "interrupted"
          : scenario === "ready-held"
            ? "gate_blocked"
            : "simulated",
      );
      let invocations = 0;
      const actions = [];
      const client = workerClient({
        heartbeat: async (assigned) =>
          store.heartbeat(
            worker,
            assigned.id,
            assigned.lease,
            assigned.attempt,
          ),
        publishSnapshot: async (snapshot) => { store.snapshot(worker, snapshot); },
        complete: async (assigned) => {
          actions.push("complete");
          store.finish(
            worker,
            assigned.id,
            assigned.lease,
            assigned.attempt,
          );
        },
        hold: async (assigned, receipt) => {
          actions.push("hold");
          store.hold(
            worker,
            assigned.id,
            assigned.lease,
            assigned.attempt,
            receipt,
          );
        },
        abandon: async (assigned) => {
          actions.push("abandon");
          store.abandon(
            worker,
            assigned.id,
            assigned.lease,
            assigned.attempt,
          );
        },
      });
      await executeAttempt(task, new AbortController().signal, {
        gates,
        client,
        journal,
        adapter: {
          mode: "mock",
          async run() {
            invocations++;
            throw Error("Paid replay prohibited");
          },
        },
        identity: { id: worker.id, project: "demo" },
        profiles,
        state,
        saveState: async () => {},
        timeoutMs: 1000,
      });
      assert.equal(invocations, 0);
      assert.deepEqual(actions, [
        scenario === "completed"
          ? "complete"
          : scenario === "unknown"
            ? "abandon"
            : "hold",
      ]);
      assert.equal(store.snapshots().length, 2);
      await journal.recover(worker.id, profiles, state, (snapshot) =>
        gates.recoverSnapshot(snapshot),
      );
      assert.deepEqual(await journal.read(task.lease, "after"), recovered);
    },
  );
