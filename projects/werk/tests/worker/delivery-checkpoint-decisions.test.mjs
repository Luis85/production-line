import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeliveryCheckpoint } from '../../src/worker/dist/worker/application/delivery-task-review.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, deliveryGatePolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { freezeDevelopmentScope, developmentScopeView } from '../../src/worker/dist/worker/application/development.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { deliveryCheckDefinitionDigest } from '../../src/worker/dist/worker/application/delivery-review.js';
import { fixture, provider } from './request-gate-fixtures.mjs';
const at = '2026-10-20T12:00:00.000Z';
async function checkpoint(t) {
  const { journal } = await fixture(t), tools = defaultToolPolicy(); tools.builtins.files = true;
  tools.builtins.commands = [{ id: 'unit', name: 'Unit', executable: 'node', args: ['test.mjs'], enabled: true, verification: true }];
  const scope = freezeDevelopmentScope('1'.repeat(40), ['src/'], tools), configuration = defaultDeliveryProjectPolicy();
  configuration.profiles[0].exceptions = { exemptibleCriteria: ['check:unit'], notApplicableCriteria: ['check:unit'] };
  const snapshot = deliveryPolicySnapshot(configuration, scope.baseCommit), policy = deliveryGatePolicy(defaultGatePolicy(), snapshot); policy.reviewer.enabled = false;
  let request = journal.ensure({ owner: { sessionId: 'session', rootTurnId: 'turn', taskId: 'task' }, provider, policy, input: { kind: 'patch', title: 'Known failed check', message: 'Implement this bounded candidate and keep its check evidence.', files: [{ path: 'src/value.mjs', bytes: 4 }], criteria: ['Value remains readable.'], context: { deliveryPolicy: snapshot, implementation: developmentScopeView(scope) } } });
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn'); request = journal.prepareExecution(request.id, 'turn', 'invocation');
  /** @type {import('../../src/worker/application/delivery-review-contracts.js').DeliveryCandidate} */
  const candidate = { requestId: request.id, inputRevision: request.inputRevision, inputHash: request.inputHash, runId: request.delivery.id, baseline: scope.baseCommit, branch: 'werk/delivery/fixture', candidateCommit: '2'.repeat(40), tree: '3'.repeat(40), candidateDigest: 'a'.repeat(64), patchDigest: 'b'.repeat(64), policyDigest: request.policyDigest, checkDefinitionDigest: deliveryCheckDefinitionDigest(scope), createdAt: at };
  journal.startExecution(request.id, 'turn', 'invocation');
  journal.deliveryUpdate(request.id, { action: 'checkpoint', deliveryRunId: request.delivery.id, candidate });
  journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: request.delivery.id, stepId: 'verify', phase: 'verifying' });
  journal.deliveryUpdate(request.id, { action: 'finish', deliveryRunId: request.delivery.id, stepId: 'verify', status: 'failed', detail: 'Known failed check.', evidence: { schemaVersion: 1, updatedAt: at, candidateDigest: candidate.candidateDigest, changedPaths: ['src/value.mjs'], checks: [{ presetId: 'unit', presetFingerprint: scope.checks[0].fingerprint, candidateDigest: candidate.candidateDigest, status: 'failed', exitCode: 1, stdout: '', stderr: '', startedAt: at, finishedAt: at }] } });
  journal.recordResult(request.id, 'turn', 'invocation', { type: 'completed', text: 'Retained implementation summary.' }, { 'output.protocolValid': false, 'output.verificationPassed': false });
  request = journal.deliveryUpdate(request.id, { action: 'hold', code: 'verification_unavailable', reason: 'Known failed check needs a decision.' });
  const task = { id: 'task', sessionId: 'session', requestId: request.id, repository: '/fixture', implementation: scope };
  const running = new Map(); let captured = candidate.candidateDigest, captures = 0, verifications = 0, identities = 0;
  let onCapture = () => {}, onVerify = () => {};
  const host = /** @type {Parameters<typeof verifyDeliveryCheckpoint>[0]} */ (/** @type {unknown} */ ({
    sessions: { requests: journal }, tasks: [task], running, workspaceController: new AbortController(),
    async assertToolWorkspace(_task, _signal, verifyOnly) { assert.equal(verifyOnly, true); identities++; },
    developmentRuntime() { return { async capture() { captures++; onCapture(); return { digest: captured }; } }; },
    delivery() { return { async verify(value) { assert.equal(value.candidateCommit, candidate.candidateCommit); verifications++; onVerify(); } }; },
  }));
  const command = () => ({ action: /** @type {const} */ ('criterion_decision'), requestId: request.id, expectedRevision: journal.get(request.id).revision, operationId: 'criterion', deliveryRunId: candidate.runId, inputRevision: candidate.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, criterionDecision: { criterionId: 'check:unit', kind: /** @type {const} */ ('exempted'), reason: 'Team accepts this exact known failure.' } });
  return { journal, request, candidate, host, running, command, get captures() { return captures; }, get verifications() { return verifications; }, get identities() { return identities; },
    inspect: (revision = journal.get(request.id).revision) => verifyDeliveryCheckpoint(host, request.id, revision),
    digest: value => { captured = value; }, onCapture: action => { onCapture = action; }, onVerify: action => { onVerify = action; } };
}
test('fresh checkpoint inspection binds workspace, candidate and immutable ref without requiring a passing package', async t => {
  const f = await checkpoint(t), before = f.journal.events(f.request.id).events;
  assert.equal(await f.inspect(), f.candidate.candidateDigest);
  assert.equal(f.identities, 1); assert.equal(f.captures, 1); assert.equal(f.verifications, 1);
  assert.deepEqual(f.journal.events(f.request.id).events, before);
});
test('stale revisions and active/unknown work refuse criterion preflight before observing source', async t => {
  const f = await checkpoint(t);
  await assert.rejects(f.inspect(f.request.revision - 1), /request changed/i);
  f.running.set('task', {}); await assert.rejects(f.inspect(), /inactive checkpoint/); f.running.clear();
  f.journal.deliveryUpdate(f.request.id, { action: 'clear_hold', code: 'verification_unavailable' });
  f.journal.deliveryUpdate(f.request.id, { action: 'start', deliveryRunId: f.candidate.runId, stepId: 'unknown', phase: 'repairing' });
  await assert.rejects(f.inspect(), /inactive checkpoint/);
  f.journal.deliveryUpdate(f.request.id, { action: 'stopped', deliveryRunId: f.candidate.runId, confirmed: false });
  await assert.rejects(f.inspect(), /inactive checkpoint/); assert.equal(f.captures, 0);
});
test('changed source, changed authority during capture and new runtime activity after ref inspection all refuse decisions', async t => {
  const changed = await checkpoint(t); changed.digest('f'.repeat(64));
  await assert.rejects(changed.inspect(), /candidate or its requirements changed/); assert.equal(changed.verifications, 0);
  const raced = await checkpoint(t); raced.onCapture(() => raced.journal.deliveryUpdate(raced.request.id, { action: 'hold', code: 'source', reason: 'Concurrent source reconciliation.' }));
  await assert.rejects(raced.inspect(), /changed during verification/);
  const active = await checkpoint(t); active.onVerify(() => active.running.set('task', {}));
  await assert.rejects(active.inspect(), /changed during verification/);
});
test('journal criterion receipt clears only verified eligibility holds, retains failed evidence and replays exactly', async t => {
  const f = await checkpoint(t), command = f.command();
  const decided = f.journal.command(command);
  assert.equal(decided.request.phase, 'ready'); assert.equal(decided.request.delivery.status, 'queued');
  assert.equal(decided.request.delivery.steps[0].evidence.checks[0].status, 'failed');
  assert.equal(decided.request.delivery.criterionDecisions[0].actor, 'operator');
  const events = f.journal.events(f.request.id).events;
  assert.equal(f.journal.command(command).duplicate, true); assert.deepEqual(f.journal.events(f.request.id).events, events);
  assert.throws(() => f.journal.command({ ...f.command(), operationId: 'wrong-candidate', candidateDigest: 'f'.repeat(64) }), /exact current/);
});
test('criterion decisions do not bypass unrelated holds or an active uncertain operation', async t => {
  const f = await checkpoint(t);
  f.journal.deliveryUpdate(f.request.id, { action: 'hold', code: 'source', reason: 'The source is missing.' });
  const decided = f.journal.command(f.command()).request;
  assert.ok(decided.delivery.holds.some(item => item.code === 'source'));
  assert.notEqual(decided.phase, 'ready');
  assert.throws(() => f.journal.deliveryUpdate(f.request.id, { action: 'start', deliveryRunId: f.candidate.runId, stepId: 'forbidden', phase: 'packaging' }), /held/);
});
