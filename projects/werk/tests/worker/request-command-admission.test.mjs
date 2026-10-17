import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerWorkspace } from "../../src/worker/dist/worker/status/workspace.js";
import { WorkerRequestJournal } from "../../src/worker/dist/worker/infrastructure/journal/requests.js";
import { DomainError } from "../../src/worker/dist/shared/errors.js";

test("a saved command with failed owner admission returns a receipt on retry and needs a fresh guarded execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "werk-command-admission-")),
    gates = new WorkerRequestJournal(directory);
  let failed = true,
    admissions = 0;
  try {
    await gates.init();
    const request = gates.ensure({
      owner: { sessionId: "session-1", rootTurnId: "root-1" },
      input: {
        kind: "chat",
        title: "Fixture",
        message: "Explain the next step.",
      },
      provider: { id: "fixture", model: "pinned", instruction: "" },
    });
    const ready = gates.get(request.id);
    const session = { id: "session-1" };
    const workspace = Object.assign(Object.create(WorkerWorkspace.prototype), {
      acceptingTasks: true,
      board: { view: () => ({ tasks: [] }) },
      reviews: { tick() {}, cancel() {} },
      sessions: {
        requests: gates,
        view: () => ({ records: [session] }),
        async executeRequest(id) {
          if (failed) {
            failed = false;
            throw new DomainError("unavailable", "Fixture admission failed.");
          }
          admissions++;
          const current = gates.get(id),
            turnId = "primary-" + current.inputRevision,
            runId = "run-" + current.inputRevision;
          gates.bindTurn(id, turnId);
          gates.prepareExecution(id, turnId, runId);
          gates.startExecution(id, turnId, runId);
          return current;
        },
      },
    });
    const execute = (body) =>
      WorkerWorkspace.prototype.requestCommand.call(workspace, body);
    const original = {
      action: "execute",
      requestId: request.id,
      expectedRevision: ready.revision,
      operationId: "original-execute",
    };
    session.continuationBlockedReason = "Interrupted admission has no accepted snapshots.";
    await assert.rejects(execute(original), error => error.code === "conflict" && error.message === session.continuationBlockedReason);
    assert.equal(gates.get(request.id).revision, ready.revision, "The real continuation guard rejects before saving a request command.");
    assert.equal(admissions, 0);
    delete session.continuationBlockedReason;
    await assert.rejects(
      execute(original),
      (error) =>
        error.code === "unavailable" &&
        /command was saved/.test(error.message) &&
        /new operation ID/.test(error.message),
    );
    assert.equal(admissions, 0);
    const replay = await execute(original);
    assert.equal(replay.duplicate, true);
    assert.equal(admissions, 0);
    assert.equal(replay.dispatch.state, "not_admitted");
    assert.equal(replay.dispatch.scope, "current_input_generation");
    assert.match(replay.dispatch.note, /new guarded execute/);
    assert.equal(replay.request.phase, "ready");
    const fresh = await execute({
      ...original,
      operationId: "fresh-execute",
      expectedRevision: gates.get(request.id).revision,
    });
    assert.equal(admissions, 1);
    assert.equal(fresh.dispatch.state, "admitted");
    assert.equal(fresh.request.execution.inputRevision, 1);
    const knownReplay = await execute(original);
    assert.equal(knownReplay.duplicate, true);
    assert.equal(knownReplay.dispatch.state, "admitted");
    assert.equal(admissions, 1);
  } finally {
    gates.close();
    await rm(directory, { recursive: true, force: true });
  }
});
