import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerWorkspace } from "../../src/worker/dist/worker/status/workspace.js";
import { SnapshotJournal } from "../../src/worker/dist/worker/infrastructure/journal/snapshots.js";
import { workerStatus } from "../helpers/worker-status.mjs";
import { DomainError } from "../../src/worker/dist/shared/errors.js";

test("a saved command with failed owner admission returns a receipt on retry and needs a fresh guarded execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "werk-command-admission-")),
    journal = new SnapshotJournal(directory, "a".repeat(64), "b".repeat(64)),
    workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 1000 }, journal, workerStatus),
    gates = workspace.sessions.requests;
  let failed = true,
    admissions = 0;
  try {
    await journal.init();
    await workspace.init();
    const request = gates.ensure({
      owner: { sessionId: "default", rootTurnId: "root-1" },
      input: {
        kind: "chat",
        title: "Fixture",
        message: "Explain the next step.",
      },
      provider: { id: "fixture", model: "pinned", instruction: "" },
    });
    const ready = gates.get(request.id);
    const view = workspace.sessions.view.bind(workspace.sessions);
    const session = view().records.find(item => item.id === 'default');
    assert.ok(session);
    workspace.sessions.view = () => ({ ...view(), records: [session] });
    workspace.reviews.tick = () => {};
    workspace.sessions.executeRequest = async id => {
      if (failed) {
        failed = false;
        throw new DomainError('unavailable', 'Fixture admission failed.');
      }
      admissions++;
      const current = gates.get(id), turnId = 'primary-' + current.inputRevision, runId = 'run-' + current.inputRevision;
      gates.bindTurn(id, turnId);
      gates.prepareExecution(id, turnId, runId);
      gates.startExecution(id, turnId, runId);
      return workspace.sessions.detail('default').chat;
    };
    const execute = async body => {
      const result = await workspace.requestCommand(body);
      assert.ok('dispatch' in result && 'request' in result);
      return result;
    };
    const original = {
      action: "execute",
      requestId: request.id,
      expectedRevision: ready.revision,
      operationId: "original-execute",
    };
    session.continuationBlockedReason = "Interrupted admission has no accepted snapshots.";
    await assert.rejects(execute(original), error => testErrorCode(error) === "conflict" && testErrorMessage(error) === session.continuationBlockedReason);
    assert.equal(gates.get(request.id).revision, ready.revision, "The real continuation guard rejects before saving a request command.");
    assert.equal(admissions, 0);
    delete session.continuationBlockedReason;
    await assert.rejects(
      execute(original),
      (error) =>
        testErrorCode(error) === "unavailable" &&
        /command was saved/.test(testErrorMessage(error)) &&
        /new operation ID/.test(testErrorMessage(error)),
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
    await workspace.close();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
