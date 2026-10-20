import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, provider } from './request-gate-fixtures.mjs';
import { runDeliverySteps, DeliverySuspended } from '../../src/worker/dist/worker/application/delivery-task-steps.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { developmentCheckFingerprint } from '../../src/worker/dist/worker/application/development.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';

/** A real request journal with deterministic provider/check ports: the test observes dispatches and durable receipts. */
async function runtime(t, modelAction, maxRepairAttempts = 1, beforeCheck = (_attempt) => {}, checkpointFailure = false) {
  const { journal } = await fixture(t);
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false; policy.rework.maxAttempts = maxRepairAttempts;
  const check = { id: 'check-source', name: 'Check source', executable: 'fixture', args: [], enabled: true };
  const scope = { schemaVersion: 1, mode: 'worktree', baseCommit: 'a'.repeat(40), approvedPaths: ['source.txt'], checks: [{ ...check, fingerprint: developmentCheckFingerprint(check) }] };
  const request = journal.ensure({ owner: { sessionId: 'session', rootTurnId: 'root', taskId: 'task' }, provider, policy,
    input: { kind: 'patch', title: 'Deliver source', message: 'Implement the source change', files: [{ path: 'source.txt', bytes: 7 }], context: { implementation: scope } } });
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn'); journal.prepareExecution(request.id, 'turn', 'invocation'); journal.startExecution(request.id, 'turn', 'invocation');
  const task = /** @type {import('../../src/worker/application/local-task-contracts.js').LocalTask} */ (/** @type {unknown} */ ({
    id: 'task', sessionId: 'session', requestId: request.id, runId: 'invocation', currentTurnId: 'turn', title: 'Deliver source', provider: 'openai-api', model: 'fixture', repository: '/fixture', implementation: scope,
  }));
  let calls = 0, checks = 0, content = 'broken', evidence, runNumber = 0;
  const metrics = [];
  const capture = () => ({ digest: (content === 'after' ? 'b' : 'c').repeat(64), patch: 'diff --git a/source.txt b/source.txt\n-before\n+' + content, changedPaths: ['source.txt'] });
  const development = {
    async capture() { return capture(); },
    evidence() { return structuredClone(evidence ?? { schemaVersion: 1, candidateDigest: null, changedPaths: [], checks: [], updatedAt: new Date().toISOString() }); },
    async check() {
      checks++; beforeCheck(checks);
      /** @type {import('../../src/worker/application/development.js').DevelopmentCheckEvidence} */
      const receipt = { presetId: check.id, presetFingerprint: scope.checks[0].fingerprint, candidateDigest: capture().digest,
        status: content === 'after' ? 'passed' : 'failed', exitCode: content === 'after' ? 0 : 1, stdout: '', stderr: content === 'after' ? '' : 'Expected after', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
      evidence = { schemaVersion: 1, candidateDigest: capture().digest, changedPaths: ['source.txt'], checks: [receipt], updatedAt: new Date().toISOString() };
      return receipt;
    },
    async apply() { throw Error('The model fixture owns its deterministic source port.'); },
  };
  const model = {
    configuration: provider,
    async reply() { throw Error('Typed execution required.'); },
    async execute(dispatch) {
      calls++;
      return modelAction({ invocation: calls, dispatch, setContent: value => { content = value; evidence = undefined; }, control, request: () => journal.get(request.id) });
    },
  };
  const dispatch = prepareModelRequest(model, [{ id: 'source', at: new Date().toISOString(), state: 'complete', role: 'user', text: 'Implement the accepted request.' }], 'patch');
  const host = /** @type {Parameters<typeof runDeliverySteps>[0]} */ (/** @type {unknown} */ ({
    sessions: { requests: journal, runs: { async begin() { return { id: 'repair-' + ++runNumber }; }, async start() {}, observeUsage() {}, async finish(id, outcome, usage) { metrics.push({ id, outcome, usage }); } }, interactions: { observeUsage() {}, observeToolBudget() {} } },
    ...(checkpointFailure ? { delivery: () => ({ async checkpoint() { throw Error('Git checkpoint fixture failed.'); } }) } : {}),
    async change(action) { await action([task]); }, async writePatch() {}, validatedPatch() { throw Error('Implementation must use captured candidate evidence.'); }, evidencePersistenceError: false,
  }));
  function control(action) {
    const current = journal.get(request.id);
    return journal.command({ action, requestId: current.id, expectedRevision: current.revision, operationId: action + '-' + current.revision, deliveryRunId: current.delivery.id, inputRevision: current.inputRevision });
  }
  return { task, journal, metrics, control, get calls() { return calls; }, get checks() { return checks; }, request: () => journal.get(request.id),
    execute: () => runDeliverySteps(host, task, model, dispatch, development, new AbortController().signal) };
}

test('a failed observed check dispatches bounded repair and preserves both candidate receipts', async t => {
  const f = await runtime(t, async ({ invocation, dispatch, setContent }) => {
    if (invocation === 2) { assert.match(dispatch.renderedPrompt, /Observed check evidence/); assert.match(dispatch.renderedPrompt, /Expected after/); setContent('after'); }
    return { type: 'completed', text: invocation === 1 ? 'Initial implementation' : 'Repaired implementation' };
  });
  const result = await f.execute();
  assert.equal(result.valid.summary, 'Repaired implementation'); assert.equal(f.calls, 2); assert.equal(f.checks, 2);
  const run = f.request().delivery;
  assert.equal(run.repairAttempts, 1); assert.equal(run.status, 'completed');
  const verification = run.steps.filter(step => step.phase === 'verifying');
  assert.deepEqual(verification.map(step => step.status), ['failed', 'completed']);
  assert.deepEqual(verification.map(step => step.evidence.checks[0].exitCode), [1, 0]);
  assert.notEqual(verification[0].evidence.candidateDigest, verification[1].evidence.candidateDigest);
  assert.equal(run.steps.find(step => step.phase === 'repairing').dispatch.messages.at(-1).role, 'user');
  await f.execute(); assert.equal(f.calls, 2, 'Reevaluation observes the durable result without another model call.');
  assert.equal(f.checks, 2); assert.deepEqual(f.metrics.map(run => run.id), ['invocation', 'repair-1']);
});

test('pause after the model step releases the boundary and resumes verification without redispatch', async t => {
  const f = await runtime(t, async ({ control, setContent }) => { setContent('after'); control('pause_after_step'); return { type: 'completed', text: 'Saved implementation' }; });
  await assert.rejects(f.execute(), DeliverySuspended);
  assert.equal(f.request().delivery.status, 'paused'); assert.equal(f.calls, 1); assert.equal(f.checks, 0);
  const saved = f.request().delivery.steps.at(-1).result; assert.equal(saved.type, 'completed');
  assert.equal(saved.type === 'completed' && saved.text, 'Saved implementation');
  f.control('resume');
  assert.equal((await f.execute()).valid.summary, 'Saved implementation');
  assert.equal(f.calls, 1); assert.equal(f.checks, 1);
});

test('repair exhaustion stops deterministically and unchanged reevaluation spends no further calls', async t => {
  const f = await runtime(t, async () => ({ type: 'completed', text: 'Still broken' }), 1);
  assert.equal((await f.execute()).valid, null); assert.equal(f.calls, 2); assert.equal(f.checks, 2);
  assert.equal(f.request().delivery.status, 'failed'); assert.equal(f.request().delivery.decision.selectedAction, 'wait');
  assert.match(f.request().delivery.decision.reason, /exhausted/);
  assert.equal((await f.execute()).valid, null); assert.equal(f.calls, 2);
  assert.equal(f.request().delivery.steps.some(step => step.phase === 'packaging'), false);
});

test('a model question preserves its durable result and does not run checks or enter repair', async t => {
  const f = await runtime(t, async () => ({ type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which behavior is required?' } }));
  const result = await f.execute();
  assert.equal(result.result.type, 'needs_input'); assert.equal(f.calls, 1); assert.equal(f.checks, 0);
  assert.equal(f.request().delivery.status, 'waiting'); assert.equal(f.request().delivery.repairAttempts, 0);
  const saved = f.request().delivery.steps.at(-1).result; assert.equal(saved.type, 'needs_input');
  assert.equal(saved.type === 'needs_input' && saved.request.message, 'Which behavior is required?');
  assert.deepEqual(result.usage, unknownUsage());
});


test('explicit recovery resumes interrupted verification without replaying a known model result', async t => {
  const f = await runtime(t, async ({ setContent }) => { setContent('after'); return { type: 'completed', text: 'Retained implementation' }; }, 1,
    attempt => { if (attempt === 1) throw Error('Fixture verification process lost before a durable result.'); });
  await assert.rejects(f.execute(), /process lost/);
  const uncertain = f.journal.deliveryUpdate(f.request().id, { action: 'stopped', deliveryRunId: f.request().delivery.id, confirmed: false });
  assert.equal(uncertain.delivery.steps.at(-1).status, 'outcome_unknown');
  const recovery = { action: /** @type {const} */ ('confirm_stopped'), operationId: 'inspected-stopped', requestId: uncertain.id,
    expectedRevision: uncertain.revision, deliveryRunId: uncertain.delivery.id, inputRevision: uncertain.inputRevision,
    note: 'Inspected the retained worktree and stopped the previous check process.' };
  f.journal.command(recovery, { requestRevision: uncertain.revision, deliveryRunId: uncertain.delivery.id, inputRevision: uncertain.inputRevision,
    candidateDigest: 'b'.repeat(64), observedAt: new Date().toISOString() });
  await assert.rejects(f.execute(), DeliverySuspended); assert.equal(f.calls, 1); assert.equal(f.checks, 1);
  f.control('resume');
  assert.equal((await f.execute()).valid.summary, 'Retained implementation');
  assert.equal(f.calls, 1, 'The known implementation result is never redispatched.'); assert.equal(f.checks, 2);
  const verification = f.request().delivery.steps.filter(step => step.phase === 'verifying');
  assert.deepEqual(verification.map(step => step.status), ['interrupted', 'completed']);
  assert.notEqual(verification[0].id, verification[1].id);
});


test('a failed checkpoint after a paused model result preserves its completed receipt and permits explicit retry', async t => {
  const f = await runtime(t, async ({ control, setContent }) => { setContent('after'); control('pause_after_step'); return { type: 'completed', text: 'Retained implementation' }; }, 1, () => {}, true);
  await assert.rejects(f.execute(), /Git checkpoint fixture failed/);
  const run = f.request().delivery;
  assert.equal(f.calls, 1); assert.equal(f.checks, 0); assert.equal(run.status, 'failed');
  assert.equal(run.steps.at(-1).status, 'completed');
  const saved = run.steps.at(-1).result; assert.ok(saved?.type === 'completed'); assert.equal(saved.text, 'Retained implementation');
  assert.ok(run.holds.some(hold => hold.code === 'checkpoint_unavailable')); assert.ok(run.allowedControls.includes('retry'));
  assert.deepEqual(f.metrics.map(item => item.outcome), ['completed'], 'A Git failure cannot relabel a completed model invocation.');
  f.control('retry'); assert.equal(f.request().delivery.holds.length, 0);
});
