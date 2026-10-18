import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceContext } from '../../src/worker/dist/worker/status/workspace-context.js';
import { continueFeatureInteraction } from '../../src/worker/dist/worker/status/workspace-features.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { workerStatus } from '../helpers/worker-status.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-feature-continuation-'));
  const snapshots = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64));
  const context = new WorkspaceContext({ stateDir: directory, pollMs: 1000, timeoutMs: 1000 }, snapshots, workerStatus);
  await context.sessions.interactions.init();
  context.settings.value.board.paused = true;
  t.after(async () => { context.sessions.interactions.close(); snapshots.close(); await rm(directory, { recursive: true, force: true }); });
  const sessionId = 'feature-session', journal = context.sessions.interactions;
  const initial = journal.accept({ sessionId, kind: 'message', operationId: 'initial', input: 'Implement the feature.' });
  return { context, journal, sessionId, initial };
}

/** @param {import('../../src/worker/application/interactions.js').InteractionCommand} command */
function admission(command) {
  return { sessionId: command.sessionId, kind: command.action, operationId: command.operationId, expectedRevision: command.expectedRevision, pendingId: command.pendingId, priorTurnId: command.turnId, input: command.answer ?? command.message ?? '' };
}

test('Feature note answer replay verifies the full saved operation while the worker is paused', async t => {
  const { context, journal, sessionId, initial } = await fixture(t);
  const dispatch = prepareModelRequest({ async reply() { return 'unused'; } }, [{ id: 'message-1', role: 'user', text: initial.turn.input, at: '2026-10-17T00:00:00.000Z', state: 'complete' }]);
  journal.prepare(sessionId, initial.turn.id, dispatch, 'run-1'); journal.start(sessionId, initial.turn.id);
  journal.complete(sessionId, initial.turn.id, { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which target?' } }, unknownUsage());
  const waiting = journal.view(sessionId); assert.ok(waiting.pending);
  /** @type {import('../../src/worker/application/interactions.js').InteractionCommand} */
  const command = { action: 'answer', sessionId, operationId: 'saved-answer', expectedRevision: waiting.revision, pendingId: waiting.pending.id, answer: 'Linux' };
  const accepted = journal.accept(admission(command));
  const before = journal.view(sessionId);
  assert.deepEqual(await continueFeatureInteraction(context, sessionId, command), before);
  assert.equal(journal.view(sessionId).totalTurns, 2);
  for (const changed of [
    { ...command, expectedRevision: command.expectedRevision + 1 },
    { ...command, pendingId: 'another-question' },
    { ...command, turnId: 'unrelated-turn' },
    { ...command, answer: 'Browser' },
  ]) await assert.rejects(continueFeatureInteraction(context, sessionId, changed), /operation ID.*different input/);
  assert.deepEqual(journal.view(sessionId), before);
  assert.equal(journal.operation(sessionId, command.operationId).id, accepted.turn.id);
  await assert.rejects(continueFeatureInteraction(context, 'another-session', command), /another worker interaction/);
});

test('Feature note resume replay cannot substitute a turn or revision after acknowledgement', async t => {
  const { context, journal, sessionId, initial } = await fixture(t);
  journal.fail(sessionId, initial.turn.id, 'failed', 'unavailable');
  /** @type {import('../../src/worker/application/interactions.js').InteractionCommand} */
  const command = { action: 'resume', sessionId, operationId: 'saved-resume', expectedRevision: journal.view(sessionId).revision, turnId: initial.turn.id, message: 'Connection restored. Continue.' };
  journal.accept(admission(command));
  const before = journal.view(sessionId);
  assert.deepEqual(await continueFeatureInteraction(context, sessionId, command), before);
  for (const changed of [
    { ...command, expectedRevision: command.expectedRevision + 1 },
    { ...command, turnId: 'another-stopped-turn' },
    { ...command, pendingId: 'unrelated-question' },
  ]) await assert.rejects(continueFeatureInteraction(context, sessionId, changed), /operation ID.*different input/);
  assert.deepEqual(journal.view(sessionId), before);
  assert.equal(before.totalTurns, 2);
});
