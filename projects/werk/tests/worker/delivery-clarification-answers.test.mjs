import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, admit, provider, dispatch } from './request-gate-fixtures.mjs';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, deliveryGatePolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
const observations = (journal, id) => journal.events(id).events.flatMap(event => event.measurement?.observations ?? []);

test('accepted answer binding records one matching cycle before scheduling; replay and a plain turn never invent answers', async t => {
  const { journal } = await fixture(t), request = admit(journal);
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'question'); journal.prepareExecution(request.id, 'question', 'invocation'); journal.startExecution(request.id, 'question', 'invocation');
  journal.recordResult(request.id, 'question', 'invocation', { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Choose the behavior.' } });
  journal.bindTurn(request.id, 'unrelated');
  assert.equal(observations(journal, request.id).filter(item => item.kind === 'clarification_answer').length, 0);
  assert.throws(() => journal.bindTurn(request.id, 'invalid', request.inputRevision, 'missing'), /known question/);
  journal.bindTurn(request.id, 'answer', request.inputRevision, 'question');
  assert.deepEqual(observations(journal, request.id).filter(item => item.kind === 'clarification_answer'), [{ kind: 'clarification_answer', questionId: 'question', cycleId: 'execution:question', cause: 'implementation' }]);
  const retained = journal.events(request.id).events;
  journal.bindTurn(request.id, 'answer', request.inputRevision, 'question');
  assert.deepEqual(journal.events(request.id).events, retained);
  assert.equal(journal.get(request.id).execution.result.type, 'needs_input', 'recording an answer never implies a new model result');
  journal.reviseInput(request.id, { ...request.input, message: 'A genuinely new requirement.' });
  assert.throws(() => journal.bindTurn(request.id, 'stale-answer', 2, 'question'), /known question/);
  assert.equal(observations(journal, request.id).filter(item => item.kind === 'clarification_answer').length, 1);
});

test('explicit reviewer resolutions pair each question without counting replays or arbitrary source revisions', async t => {
  const { journal } = await fixture(t), configuration = defaultDeliveryProjectPolicy();
  configuration.profiles[0].readiness = { assessment: 'required', assumptions: 'explicit', requiredReferences: [], maxEstimatedMinutes: 60 };
  const snapshot = deliveryPolicySnapshot(configuration, '1'.repeat(40));
  const request = journal.ensure({ owner: { sessionId: 'semantic', rootTurnId: 'root' }, provider, policy: deliveryGatePolicy(defaultGatePolicy(), snapshot), input: { kind: 'chat', title: 'Clarify the request', message: 'Explain the approved bounded implementation.', criteria: ['All mandatory gates are shown.'], context: { deliveryPolicy: snapshot } } });
  journal.evaluate(request.id, 'ready'); const intent = journal.queuedReviews()[0]; journal.startReview(request.id, intent.id, 'review-run', dispatch());
  const waiting = journal.completeReview(request.id, intent.id, { summary: 'Two explicit choices are missing.', findings: [{ kind: 'question', blocking: true, message: 'Include archived records?' }, { kind: 'question', blocking: true, message: 'Preserve the prior sort order?' }], readiness: { conditions: ['outcome', 'criteria', 'scope'].map(id => ({ id: /** @type {'outcome'|'criteria'|'scope'} */ (id), outcome: /** @type {const} */ ('pass'), reason: 'Current bounded intent.' })), estimatedMinutes: 20, proposals: [] } }, unknownUsage());
  const questions = waiting.findings.filter(item => item.source === 'reviewer');
  const command = { action: /** @type {const} */ ('resolve_finding'), requestId: request.id, expectedRevision: waiting.revision, operationId: 'answer-one', findingId: questions[0].id, note: 'Exclude archived records.' };
  const resolved = journal.command(command).request;
  const answer = observations(journal, request.id).filter(item => item.kind === 'clarification_answer');
  assert.deepEqual(answer, [{ kind: 'clarification_answer', questionId: questions[0].id, cycleId: intent.id, cause: 'readiness' }]);
  journal.command(command); assert.deepEqual(observations(journal, request.id).filter(item => item.kind === 'clarification_answer'), answer);
  journal.reviseInput(request.id, { ...request.input, message: 'Rephrased scope without answering the remaining question.' });
  assert.deepEqual(observations(journal, request.id).filter(item => item.kind === 'clarification_answer'), answer);
  assert.equal(resolved.findings.find(item => item.id === questions[1].id).status, 'open');
});

test('an explicit escalation answer binds normally without inventing a clarification question', async t => {
  const { journal } = await fixture(t), request = admit(journal);
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'escalation'); journal.prepareExecution(request.id, 'escalation', 'invocation'); journal.startExecution(request.id, 'escalation', 'invocation');
  journal.recordResult(request.id, 'escalation', 'invocation', { type: 'needs_input', request: { schemaVersion: 1, kind: 'escalation', message: 'The operator must authorize the next action.' } });
  journal.bindTurn(request.id, 'decision', request.inputRevision, 'escalation');
  assert.equal(journal.forTurn(request.owner.sessionId, 'decision').id, request.id);
  assert.deepEqual(observations(journal, request.id).filter(item => ['clarification', 'clarification_answer'].includes(item.kind)), []);
});
