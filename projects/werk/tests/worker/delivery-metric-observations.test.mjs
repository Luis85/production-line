import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, admit } from './request-gate-fixtures.mjs';

test('an immutable execution question emits one clarification round and no question text in metrics', async t => {
  const { journal } = await fixture(t), request = admit(journal);
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn');
  journal.prepareExecution(request.id, 'turn', 'run'); journal.startExecution(request.id, 'turn', 'run');
  const result = { type: /** @type {const} */ ('needs_input'), request: { schemaVersion: /** @type {const} */ (1), kind: /** @type {const} */ ('question'), message: 'Choose the intended behavior.' } };
  journal.recordResult(request.id, 'turn', 'run', result);
  const events = journal.events(request.id).events;
  const event = events.find(value => value.type === 'input_requested');
  assert.deepEqual(event.measurement.observations, [{ kind: 'clarification', questionId: 'turn', cycleId: 'execution:turn', cause: 'implementation', answerTracking: true }]);
  assert.doesNotMatch(JSON.stringify(event.measurement), /Choose the intended behavior/);
  journal.recordResult(request.id, 'turn', 'run', result);
  assert.deepEqual(journal.events(request.id).events, events);
});

test('an execution escalation remains an operator blocker rather than a fabricated question round', async t => {
  const { journal } = await fixture(t), request = admit(journal);
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn');
  journal.prepareExecution(request.id, 'turn', 'run'); journal.startExecution(request.id, 'turn', 'run');
  journal.recordResult(request.id, 'turn', 'run', { type: 'needs_input', request: { schemaVersion: 1, kind: 'escalation', message: 'The deployment decision needs the operator.' } });
  const event = journal.events(request.id).events.find(value => value.type === 'input_requested');
  assert.equal(event.measurement.observations, undefined);
  assert.ok(event.measurement.blockers.some(blocker => blocker.category === 'operator'));
});
