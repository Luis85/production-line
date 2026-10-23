import { parseFeature, featureInput } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { markdownCommands } from '../../src/worker/dist/worker/infrastructure/features/markdown-contract.js';
import { reconcileFeatureSource } from '../../src/worker/dist/worker/application/feature-source.js';
import { featureInputHash } from '../../src/worker/dist/worker/application/feature-markdown.js';
import { featureRecord } from './feature-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, provider } from './request-gate-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { deliveryBlackboard, evaluateDeliveryBehavior } from '../../src/worker/dist/worker/application/delivery-behavior.js';

/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal */
function prepared(journal) {
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  const request = journal.ensure({
    owner: { sessionId: 'delivery-session', rootTurnId: 'first-turn', taskId: 'delivery-task' }, provider, policy,
    input: { kind: 'patch', title: 'Deliver a bounded change', message: 'Implement the accepted value change and preserve unrelated work.', criteria: ['The visible value is two.'], context: { implementation: { mode: 'development' } }, files: [{ path: 'value.txt', bytes: 2 }] },
  });
  assert.equal(journal.evaluate(request.id, 'ready').passed, true);
  journal.bindTurn(request.id, 'first-turn');
  return journal.prepareExecution(request.id, 'first-turn', 'invocation-one');
}
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request @param {import('../../src/worker/application/delivery-contracts.ts').DeliveryControl} action @param {string} operationId */
function control(request, action, operationId = 'operator-' + action) {
  return { action, operationId, requestId: request.id, expectedRevision: request.revision, deliveryRunId: request.delivery.id, inputRevision: request.inputRevision };
}
/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request @param {string} stepId @param {import('../../src/worker/application/delivery-contracts.ts').DeliveryPhase} [phase] */
function start(journal, request, stepId, phase = 'implementing') {
  return journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: request.delivery.id, stepId, phase, turnId: 'first-turn', invocationRunId: 'invocation-one' });
}
/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request @param {string} stepId */
function finish(journal, request, stepId) {
  return journal.deliveryUpdate(request.id, { action: 'finish', deliveryRunId: request.delivery.id, stepId, status: 'completed', detail: 'Observed bounded step completion.' });
}
/** A trusted-runtime package fixture tests journal authority, not real Git/check execution.
 * @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request
 * @returns {import('../../src/worker/application/delivery-review-contracts.ts').DeliveryReviewPackage} */
function packageFixture(request) {
  return { schemaVersion: 1, publication: 'local_only', markdown: 'Fixture review, not a real execution.', checks: [],
    candidate: { requestId: request.id, inputRevision: request.inputRevision, inputHash: request.inputHash, runId: request.delivery.id,
      baseline: '1'.repeat(40), branch: 'werk/delivery/fixture', candidateCommit: '2'.repeat(40), tree: '3'.repeat(40),
      candidateDigest: '4'.repeat(64), patchDigest: '5'.repeat(64), policyDigest: request.policyDigest, checkDefinitionDigest: '6'.repeat(64), createdAt: new Date().toISOString() },
    criteria: [{ id: 'check:unit', description: 'Required check', mandatory: true, evaluator: 'check', checkId: 'unit' },
      { id: 'human:1:0123456789ab', description: 'The visible value is two.', mandatory: true, evaluator: 'human' }],
    results: [{ criterionId: 'check:unit', status: 'passed', evidenceRefs: ['fixture-receipt'] }, { criterionId: 'human:1:0123456789ab', status: 'pending_human', evidenceRefs: [] }],
  };
}
/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request */
function completeResult(journal, request) {
  journal.startExecution(request.id, 'first-turn', 'invocation-one');
  return journal.recordResult(request.id, 'first-turn', 'invocation-one', { type: 'completed', text: 'Known implementation result.' },
    { 'output.nonEmpty': true, 'output.protocolValid': true, 'output.patchPresent': true, 'output.verificationPassed': true, 'output.requiredCheckCount': 1, 'output.candidateDigest': '4'.repeat(64) });
}

const clear = { cancelRequested: false, outcomeUnknown: false, inputChanged: false, held: false, paused: false, activeStep: false,
  ready: true, planned: true, prepared: true, implemented: false, verified: false, verificationFailed: false, repairAvailable: true, packaged: false };
test('delivery selection prioritizes safety, observes active work and waits without mutating its inputs', () => {
  const scenarios = [
    { facts: { cancelRequested: true, outcomeUnknown: true, activeStep: true }, action: 'cancel' },
    { facts: { outcomeUnknown: true, activeStep: true }, action: 'reconcile' },
    { facts: { inputChanged: true, activeStep: true }, action: 'wait' },
    { facts: { held: true, activeStep: true }, action: 'wait' },
    { facts: { paused: true }, action: 'wait' },
    { facts: { activeStep: true }, action: 'observe' },
    { facts: { implemented: true, verificationFailed: true, repairAvailable: false }, action: 'wait' },
    { facts: { implemented: true, verificationFailed: true }, action: 'repair' },
    { facts: { implemented: true, verified: true }, action: 'package' },
    { facts: { implemented: true, verified: true, packaged: true }, action: 'review' },
  ];
  for (const scenario of scenarios) {
    const board = Object.freeze({ ...clear, ...scenario.facts }), before = JSON.stringify(board);
    const first = evaluateDeliveryBehavior(board);
    assert.equal(first.selectedAction, scenario.action); assert.ok(first.reason);
    assert.deepEqual(evaluateDeliveryBehavior(board), first);
    assert.equal(JSON.stringify(board), before);
  }
});

test('observing or replaying a started step never records another consequential operation', async t => {
  const { journal } = await fixture(t), request = prepared(journal);
  const running = start(journal, request, 'implement-once');
  const events = journal.events(request.id).events;
  const started = events.findLast(event => event.type === 'delivery_step_started');
  assert.equal(started.deliveryRunId, running.delivery.id); assert.equal(started.deliveryStepId, 'implement-once');
  assert.equal(started.runId, 'invocation-one', 'Provider invocation identity keeps its existing meaning.');
  for (let i = 0; i < 20; i++) {
    const observed = journal.get(request.id);
    assert.equal(evaluateDeliveryBehavior(deliveryBlackboard(observed)).selectedAction, 'observe');
    assert.equal(start(journal, observed, 'implement-once').delivery.steps.length, 1);
  }
  assert.deepEqual(journal.events(request.id).events, events);
  assert.throws(() => start(journal, running, 'second-implementation'), /existing step/);
  assert.throws(() => start(journal, running, 'implement-once', 'verifying'), /another operation/);
});

test('pause after step remains pending during execution and prevents verification until explicit resume', async t => {
  const { journal } = await fixture(t), request = prepared(journal);
  journal.startExecution(request.id, 'first-turn', 'invocation-one');
  const running = start(journal, journal.get(request.id), 'implementation');
  const paused = journal.command(control(running, 'pause_after_step')).request;
  assert.equal(paused.delivery.status, 'pause_pending');
  assert.equal(paused.delivery.steps[0].status, 'running');
  assert.throws(() => start(journal, paused, 'verification', 'verifying'), /held/);
  const boundary = finish(journal, paused, 'implementation');
  assert.equal(boundary.delivery.status, 'paused');
  const completed = journal.events(request.id).events.findLast(event => event.type === 'delivery_step_completed');
  assert.equal(completed.deliveryRunId, boundary.delivery.id); assert.equal(completed.deliveryStepId, 'implementation');
  assert.equal(completed.runId, 'invocation-one');
  assert.equal(boundary.delivery.decision.selectedAction, 'wait');
  assert.throws(() => start(journal, boundary, 'verification', 'verifying'), /held/);
  const resumed = journal.command(control(boundary, 'resume')).request;
  assert.equal(resumed.delivery.status, 'queued');
  assert.equal(start(journal, resumed, 'verification', 'verifying').delivery.steps.length, 2);
});

test('control receipts replay after restart while changed payloads and stale targets fail without new events', async t => {
  const { journal, directory } = await fixture(t), request = prepared(journal);
  const body = control(request, 'pause_after_step', 'same-pause');
  assert.equal(journal.command(body).duplicate, false);
  const savedRevision = journal.get(request.id).revision;
  assert.equal(journal.command(body).duplicate, true);
  assert.equal(journal.get(request.id).revision, savedRevision);
  assert.throws(() => journal.command({ ...body, note: 'A different intended action.' }), /different input/);
  journal.close(); const reopened = new WorkerRequestJournal(directory); await reopened.init(); cleanup(t, () => reopened.close());
  const before = reopened.events(request.id).events;
  assert.equal(reopened.command(body).duplicate, true);
  const current = reopened.get(request.id);
  assert.throws(() => reopened.command({ ...control(current, 'resume', 'wrong-run'), deliveryRunId: 'other-run' }), /current delivery/);
  assert.throws(() => reopened.command({ ...control(current, 'resume', 'old-input'), inputRevision: current.inputRevision + 1 }), /current delivery/);
  assert.deepEqual(reopened.events(request.id).events, before);
});

test('interrupt distinguishes requested, uncertain and confirmed cessation before another step can start', async t => {
  const { journal } = await fixture(t), request = prepared(journal), running = start(journal, request, 'active-provider');
  const pending = journal.command(control(running, 'interrupt')).request;
  assert.equal(pending.delivery.status, 'interrupting'); assert.notEqual(pending.lifecycle, 'cancelled');
  const uncertain = journal.deliveryUpdate(request.id, { action: 'stopped', deliveryRunId: pending.delivery.id, confirmed: false, detail: 'Provider cessation could not be confirmed.' });
  assert.equal(uncertain.delivery.status, 'outcome_unknown'); assert.equal(uncertain.delivery.steps[0].status, 'outcome_unknown');
  assert.throws(() => journal.command(control(uncertain, 'resume')), /not available/);
  assert.throws(() => start(journal, uncertain, 'blind-retry'), /held/);
  const stopped = journal.deliveryUpdate(request.id, { action: 'stopped', deliveryRunId: pending.delivery.id, confirmed: true, detail: 'Provider process was observed stopped.' });
  assert.equal(stopped.delivery.status, 'interrupted'); assert.equal(stopped.delivery.steps[0].status, 'interrupted');
  assert.equal(journal.command(control(stopped, 'resume')).request.delivery.status, 'queued');
});

test('cancellation does not close unknown execution and terminal work requires a new explicit reopen', async t => {
  const { journal } = await fixture(t), request = prepared(journal), running = start(journal, request, 'partial-edit');
  const pending = journal.command(control(running, 'cancel')).request;
  assert.equal(pending.delivery.status, 'interrupting'); assert.notEqual(pending.phase, 'cancelled');
  const unknown = journal.deliveryUpdate(request.id, { action: 'stopped', deliveryRunId: pending.delivery.id, confirmed: false });
  assert.notEqual(unknown.lifecycle, 'cancelled');
  const stopped = journal.deliveryUpdate(request.id, { action: 'stopped', deliveryRunId: pending.delivery.id, confirmed: true, detail: 'Partial worktree retained.' });
  assert.equal(stopped.lifecycle, 'cancelled'); assert.equal(stopped.delivery.steps[0].detail, 'Partial worktree retained.');
  assert.throws(() => journal.reviseInput(request.id, { ...request.input, message: 'Changed terminal content.' }), /Reopen|Stop the active operation/);
  assert.throws(() => journal.command({ action: 'execute', requestId: request.id, expectedRevision: stopped.revision, operationId: 'implicit-reopen' }), /reopen|Stop or finish/);
  const reopened = journal.command(control(stopped, 'reopen', 'explicit-reopen')).request;
  assert.notEqual(reopened.delivery.id, stopped.delivery.id);
  assert.equal(reopened.deliveryHistory.at(-1).id, stopped.delivery.id);
  assert.equal(reopened.attestation, null); assert.equal(reopened.execution, null);
});

test('restart preserves unknown step identity and blocks blind replay until reconciliation', async t => {
  const { journal, directory } = await fixture(t), request = prepared(journal), running = start(journal, request, 'commit-boundary', 'packaging');
  journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(t, () => recovered.close());
  const current = recovered.get(request.id);
  assert.equal(current.delivery.id, running.delivery.id); assert.equal(current.delivery.status, 'outcome_unknown');
  assert.equal(current.delivery.steps.length, 1); assert.equal(current.delivery.steps[0].id, 'commit-boundary');
  assert.equal(current.delivery.steps[0].status, 'outcome_unknown');
  assert.equal(current.delivery.decision.selectedAction, 'reconcile');
  assert.throws(() => start(recovered, current, 'second-commit', 'packaging'), /held/);
  assert.equal(recovered.events(request.id).events.filter(event => event.type === 'delivery_step_started').length, 1);
});

test('source holds prevent new actions and accepted material revisions retain history without old evidence', async t => {
  const { journal } = await fixture(t), request = prepared(journal);
  const held = journal.deliveryUpdate(request.id, { action: 'hold', code: 'missing_source', reason: 'Restore the canonical request file.' });
  assert.equal(held.delivery.decision.selectedAction, 'wait');
  assert.throws(() => start(journal, held, 'blocked-implementation'), /held/);
  assert.throws(() => journal.reviseInput(request.id, { ...request.input, message: 'Changed while prepared.' }), /active operation/);
  journal.failExecution(request.id, 'first-turn', 'interrupted');
  journal.deliveryUpdate(request.id, { action: 'clear_hold', code: 'missing_source' });
  const revised = journal.reviseInput(request.id, { ...request.input, message: 'Implement the revised accepted outcome instead.' });
  assert.equal(revised.id, request.id); assert.equal(revised.inputRevision, request.inputRevision + 1);
  assert.notEqual(revised.inputHash, request.inputHash); assert.equal(revised.execution, null); assert.equal(revised.attestation, null);
  assert.equal(revised.deliveryHistory.at(-1).id, request.delivery.id);
});

test('automatic completion remains in review and cannot be accepted without a candidate package', async t => {
  const { journal } = await fixture(t), request = prepared(journal), reviewed = completeResult(journal, request);
  assert.equal(reviewed.phase, 'review'); assert.equal(reviewed.lifecycle, 'in_review'); assert.equal(reviewed.attestation, null);
  assert.throws(() => journal.command({ action: 'attest', requestId: request.id, expectedRevision: reviewed.revision, operationId: 'missing-package',
    inputHash: reviewed.inputHash, outputDigest: reviewed.execution.outputDigest, note: 'General approval is insufficient.' }), /review package|candidate/i);
});

test('journal acceptance requires current candidate and each manual criterion; rejected decisions leave no success receipt', async t => {
  const { journal } = await fixture(t), request = prepared(journal), review = packageFixture(request);
  journal.deliveryUpdate(request.id, { action: 'review', deliveryRunId: request.delivery.id, review });
  const reviewed = completeResult(journal, journal.get(request.id));
  /** @type {import('../../src/worker/application/request-gates.ts').RequestCommand} */
  const decision = { action: 'attest', requestId: request.id, expectedRevision: reviewed.revision, operationId: 'human-accept', inputHash: reviewed.inputHash,
    outputDigest: reviewed.execution.outputDigest, inputRevision: reviewed.inputRevision, candidateCommit: review.candidate.candidateCommit,
    candidateDigest: review.candidate.candidateDigest, note: 'Inspected the exact proposed candidate.', humanOutcomes: [] };
  const events = journal.events(request.id).events;
  assert.throws(() => journal.command(decision), /mandatory human/);
  const humanOutcomes = [{ criterionId: review.criteria.find(item => item.evaluator === 'human').id, outcome: /** @type {const} */ ('passed'), reason: 'Observed the expected value in the candidate.' }];
  assert.throws(() => journal.command({ ...decision, candidateCommit: '9'.repeat(40), humanOutcomes }), /candidate commit/);
  assert.throws(() => journal.command({ ...decision, candidateCommit: undefined, humanOutcomes }), /candidate|commit|current/i);
  assert.throws(() => journal.command({ ...decision, humanOutcomes: [{ ...humanOutcomes[0], outcome: 'exempted' }] }), /mandatory human/);
  assert.deepEqual(journal.events(request.id).events, events);
  const accepted = journal.command({ ...decision, humanOutcomes });
  assert.equal(accepted.request.phase, 'done'); assert.equal(accepted.request.lifecycle, 'done');
  assert.equal(accepted.request.delivery.humanOutcomes[0].actor, 'operator');
  assert.ok(accepted.request.delivery.humanOutcomes[0].at); assert.equal(accepted.duplicate, false);
  assert.equal(journal.command({ ...decision, humanOutcomes }).duplicate, true);
});


test('a completed delivery awaiting human review cannot use terminal reopen to bypass the candidate decision', async t => {
  const { journal } = await fixture(t), request = prepared(journal), review = packageFixture(request);
  const packaging = start(journal, request, 'package-known-result', 'packaging');
  finish(journal, packaging, 'package-known-result');
  journal.deliveryUpdate(request.id, { action: 'review', deliveryRunId: request.delivery.id, review });
  const awaiting = completeResult(journal, journal.get(request.id));
  assert.equal(awaiting.delivery.status, 'completed'); assert.equal(awaiting.lifecycle, 'in_review');
  assert.equal(awaiting.delivery.allowedControls.includes('reopen'), false);
  assert.throws(() => journal.command(control(awaiting, 'reopen', 'review-is-not-terminal')), /not available|closed|terminal/);
  assert.equal(journal.get(request.id).phase, 'review');
});

test('parsed Markdown review commands use the same manual criterion and once-consumed journal acceptance rules', async t => {
  const { journal } = await fixture(t), request = prepared(journal), review = packageFixture(request);
  journal.deliveryUpdate(request.id, { action: 'review', deliveryRunId: request.delivery.id, review });
  completeResult(journal, journal.get(request.id));
  const note = (commandId, checks) => `---
schema: worker.request/v1
id: FR-0042
title: Deliver a bounded change
intent: submit
mode: patch
paths: [value.txt]
review:
  command_id: ${commandId}
  decision: accept
  request_revision: ${request.inputRevision}
  candidate_commit: "${review.candidate.candidateCommit}"
  human_checks: ${checks}
---
## Outcome
Deliver the accepted value change.

## Acceptance criteria
- The visible value is two.
`;
  const parsed = parseFeature(note('CMD-no-manual', '[]')), sourceInput = featureInput(parsed, 'claude-cli');
  const record = featureRecord({ id: 'FR-0042', input: sourceInput, inputHash: featureInputHash(sourceInput), submitted: true, sessionId: request.owner.sessionId });
  let calls = 0;
  const queue = { async submit() { throw Error('Acceptance must not dispatch a new request.'); },
    inspect() { const current = journal.get(request.id); return { status: current.phase, request: current }; },
    async request(_record, command) { calls++; return journal.command(command); } };
  const consume = async raw => {
    const document = parseFeature(raw);
    await reconcileFeatureSource(record, { name: record.name, revision: 'source-observation', id: record.id, input: featureInput(document, 'claude-cli'), commands: markdownCommands(document) }, undefined, queue, async () => {}, true);
  };
  await consume(parsed.raw);
  assert.equal(record.commandReceipts[0].outcome, 'rejected'); assert.equal(journal.get(request.id).phase, 'review');
  const successful = note('CMD-human-accept', '[{criterion_id: "human:1:0123456789ab", outcome: pass, note: "Inspected the current candidate."}]');
  await consume(successful);
  assert.equal(record.commandReceipts[1].outcome, 'accepted'); assert.equal(journal.get(request.id).phase, 'done');
  assert.equal(journal.get(request.id).delivery.humanOutcomes[0].criterionId, 'human:1:0123456789ab');
  const events = journal.events(request.id).events;
  await consume(successful); assert.equal(calls, 2); assert.deepEqual(journal.events(request.id).events, events);
  await assert.rejects(consume(successful.replace('outcome: pass', 'outcome: fail')), /different content/);
  assert.equal(journal.get(request.id).phase, 'done');
});

/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request */
function stoppedObservation(request) {
  return { requestRevision: request.revision, deliveryRunId: request.delivery.id, inputRevision: request.inputRevision,
    candidateDigest: 'a'.repeat(64), observedAt: new Date().toISOString() };
}

test('operator stop confirmation requires an exact trusted observation and never automatically resumes', async t => {
  const { journal } = await fixture(t), initial = prepared(journal), running = start(journal, initial, 'uncertain-provider');
  const unknown = journal.deliveryUpdate(initial.id, { action: 'stopped', deliveryRunId: running.delivery.id, confirmed: false });
  const decision = { ...control(unknown, 'confirm_stopped'), note: 'I inspected the host and stopped the prior provider and owned services.' };
  const observation = stoppedObservation(unknown), events = journal.events(initial.id).events;
  assert.ok(unknown.delivery.allowedControls.includes('confirm_stopped'));
  assert.throws(() => journal.command(decision), /Inspect the inactive owned worktree/);
  assert.throws(() => journal.command({ ...decision, note: ' ' }, observation), /operator inspection note/);
  for (const change of [{ requestRevision: observation.requestRevision - 1 }, { deliveryRunId: 'other-run' },
    { inputRevision: observation.inputRevision + 1 }, { candidateDigest: 'invalid' }, { observedAt: 'not-a-date' }]) {
    assert.throws(() => journal.command(decision, { ...observation, ...change }), /Inspect the inactive owned worktree/);
  }
  assert.deepEqual(journal.events(initial.id).events, events);
  const confirmed = journal.command(decision, observation).request;
  assert.equal(confirmed.delivery.status, 'interrupted'); assert.equal(confirmed.phase, 'interrupted');
  assert.equal(confirmed.delivery.steps.length, 1); assert.equal(confirmed.delivery.steps[0].status, 'interrupted');
  assert.match(confirmed.delivery.steps[0].detail, /unrecorded outcome remains unknown/);
  assert.equal(confirmed.delivery.recoveries[0].source, 'operator_attestation');
  assert.equal(confirmed.delivery.recoveries[0].note, decision.note);
  assert.equal(confirmed.delivery.recoveries[0].candidateDigest, observation.candidateDigest);
  const recoveryEvent = journal.events(initial.id).events.findLast(event => event.type === 'delivery_confirm_stopped');
  assert.equal(recoveryEvent.deliveryRunId, confirmed.delivery.id); assert.equal(recoveryEvent.deliveryStepId, 'uncertain-provider');
  assert.throws(() => start(journal, confirmed, 'automatic-resume'), /held/);
  assert.equal(journal.command(control(confirmed, 'resume', 'separate-resume')).request.delivery.status, 'queued');
});

test('stop confirmations replay without new observations after restart and retain exactly one recovery receipt', async t => {
  const { journal, directory } = await fixture(t), initial = prepared(journal), running = start(journal, initial, 'lost-stop-ack');
  const unknown = journal.deliveryUpdate(initial.id, { action: 'stopped', deliveryRunId: running.delivery.id, confirmed: false });
  const command = { ...control(unknown, 'confirm_stopped', 'stable-stop-confirmation'), note: 'Inspected all prior processes and stopped them.' };
  const accepted = journal.command(command, stoppedObservation(unknown));
  assert.equal(accepted.duplicate, false);
  journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(t, () => recovered.close());
  const events = recovered.events(initial.id).events;
  assert.equal(recovered.command(command).duplicate, true);
  assert.equal(recovered.get(initial.id).delivery.recoveries.length, 1);
  assert.throws(() => recovered.command({ ...command, note: 'A different inspection claim.' }), /different input/);
  assert.deepEqual(recovered.events(initial.id).events, events);
});

test('an attested stop resolves pending cancellation without discarding the partial-work identity', async t => {
  const { journal } = await fixture(t), initial = prepared(journal), running = start(journal, initial, 'partial-work');
  const cancelling = journal.command(control(running, 'cancel')).request;
  const unknown = journal.deliveryUpdate(initial.id, { action: 'stopped', deliveryRunId: cancelling.delivery.id, confirmed: false });
  assert.ok(unknown.delivery.allowedControls.includes('confirm_stopped'));
  const cancelled = journal.command({ ...control(unknown, 'confirm_stopped'), note: 'Prior processes stopped; partial work inspected and retained.' }, stoppedObservation(unknown)).request;
  assert.equal(cancelled.lifecycle, 'cancelled'); assert.equal(cancelled.delivery.status, 'cancelled');
  assert.equal(cancelled.delivery.id, initial.delivery.id); assert.equal(cancelled.delivery.steps[0].id, 'partial-work');
  assert.equal(cancelled.delivery.recoveries[0].candidateDigest, 'a'.repeat(64));
  assert.throws(() => journal.command(control(cancelled, 'resume')), /not available/);
});

test('a restart preserves uncertain operation identity across every delivery phase', async t => {
  /** @type {import('../../src/worker/application/delivery-contracts.ts').DeliveryPhase[]} */
  const phases = ['assessing', 'planning', 'preparing', 'implementing', 'verifying', 'repairing', 'packaging'];
  for (const phase of phases) await t.test(phase, async child => {
    const { journal, directory } = await fixture(child), initial = prepared(journal);
    const running = start(journal, initial, 'phase-' + phase, phase);
    journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(child, () => recovered.close());
    const uncertain = recovered.get(initial.id);
    assert.equal(uncertain.delivery.id, running.delivery.id); assert.equal(uncertain.delivery.status, 'outcome_unknown');
    assert.equal(uncertain.delivery.steps.length, 1); assert.equal(uncertain.delivery.steps[0].id, 'phase-' + phase);
    assert.equal(uncertain.delivery.steps[0].status, 'outcome_unknown');
    assert.throws(() => start(recovered, uncertain, 'replay-' + phase, phase), /held/);
    assert.equal(recovered.events(initial.id).events.filter(event => event.type === 'delivery_step_started').length, 1);
  });
});

test('checkpoint receipts bind exact delivery inputs and replay without duplicating durable events', async t => {
  const { journal } = await fixture(t), request = prepared(journal), candidate = packageFixture(request).candidate;
  const checkpoint = { action: /** @type {const} */ ('checkpoint'), deliveryRunId: request.delivery.id, candidate };
  const retained = journal.deliveryUpdate(request.id, checkpoint);
  assert.deepEqual(retained.delivery.checkpoints, [candidate]);
  const events = journal.events(request.id).events;
  assert.deepEqual(journal.deliveryUpdate(request.id, checkpoint), retained);
  for (const change of [{ requestId: 'other-request' }, { runId: 'other-run' }, { inputRevision: request.inputRevision + 1 },
    { inputHash: 'b'.repeat(64) }, { policyDigest: 'c'.repeat(64) }]) {
    assert.throws(() => journal.deliveryUpdate(request.id, { ...checkpoint, candidate: { ...candidate, ...change } }), /does not match/);
  }
  assert.throws(() => journal.deliveryUpdate(request.id, { ...checkpoint, candidate: { ...candidate, tree: '9'.repeat(40) } }), /different recorded evidence/);
  assert.throws(() => journal.deliveryUpdate(request.id, { ...checkpoint, candidate: { ...candidate, candidateCommit: 'unknown' } }), /known Git commit/);
  assert.deepEqual(journal.events(request.id).events, events);
});

test('stale reviews withdraw review eligibility while preserving the exact historical candidate', async t => {
  const { journal } = await fixture(t), request = prepared(journal), review = packageFixture(request);
  journal.deliveryUpdate(request.id, { action: 'review', deliveryRunId: request.delivery.id, review });
  const awaiting = completeResult(journal, journal.get(request.id));
  const stale = journal.deliveryUpdate(request.id, { action: 'stale_review', deliveryRunId: request.delivery.id, reason: 'The candidate branch changed after verification.' });
  assert.equal(stale.phase, 'needs_rework'); assert.notEqual(stale.lifecycle, 'in_review');
  assert.equal(stale.delivery.status, 'failed'); assert.deepEqual(stale.delivery.review, review);
  assert.equal(stale.delivery.holds.find(hold => hold.code === 'candidate_changed').reason, 'The candidate branch changed after verification.');
  assert.throws(() => journal.command({ action: 'attest', requestId: request.id, expectedRevision: stale.revision, operationId: 'accept-stale-review',
    inputHash: stale.inputHash, outputDigest: awaiting.execution.outputDigest, inputRevision: stale.inputRevision,
    candidateCommit: review.candidate.candidateCommit, candidateDigest: review.candidate.candidateDigest, note: 'Attempted acceptance of old checks.',
    humanOutcomes: [{ criterionId: 'human:1:0123456789ab', outcome: 'passed', reason: 'Previously inspected.' }] }), /review-ready candidate/);
  const retried = journal.command(control(stale, 'retry', 'retry-stale-review')).request;
  assert.notEqual(retried.delivery.id, stale.delivery.id); assert.equal(retried.execution, null); assert.equal(retried.attestation, null);
  assert.equal(retried.delivery.holds.some(hold => hold.code === 'candidate_changed'), false);
  assert.deepEqual(retried.deliveryHistory.at(-1).review, review);
});
