import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, provider } from './request-gate-fixtures.mjs';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { inspectStopped } from '../../src/worker/dist/worker/application/delivery-task-review.js';

async function recovery(t) {
  const { journal } = await fixture(t);
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  let request = journal.ensure({ owner: { sessionId: 'recovery-session', rootTurnId: 'recovery-turn', taskId: 'recovery-task' }, provider, policy,
    input: { kind: 'patch', title: 'Retain this candidate', message: 'Retain the current implementation safely.', files: [{ path: 'source.txt', bytes: 4 }], context: { implementation: { mode: 'development' } } } });
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'recovery-turn');
  request = journal.prepareExecution(request.id, 'recovery-turn', 'recovery-invocation');
  journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: request.delivery.id, stepId: 'provider-step', phase: 'implementing' });
  request = journal.deliveryUpdate(request.id, { action: 'stopped', deliveryRunId: request.delivery.id, confirmed: false });
  const task = { id: 'recovery-task', sessionId: 'recovery-session', requestId: request.id, worktree: '/owned/worktree', worktreeIdentity: { dev: 1, ino: 2, birthtimeMs: 3 }, implementation: { mode: 'development' } };
  const running = new Map(); let identityCalls = 0, captures = 0;
  let processes = [];
  let afterCapture = () => {};
  let verifyWorkspace = () => {};
  const host = /** @type {Parameters<typeof inspectStopped>[0]} */ (/** @type {unknown} */ ({
    sessions: { requests: journal }, tasks: [task], running, workspaceController: new AbortController(),
    observations: { async status() { return { processes }; } },
    async assertToolWorkspace(observed, _signal, verifyOnly) { assert.equal(observed.worktree, task.worktree); assert.equal(verifyOnly, true); identityCalls++; verifyWorkspace(); },
    developmentRuntime() { return { async capture() { captures++; afterCapture(); return { digest: 'a'.repeat(64) }; } }; },
  }));
  return { journal, request, running, get identityCalls() { return identityCalls; }, get captures() { return captures; },
    inspect: (expectedRevision = journal.get(request.id).revision) => inspectStopped(host, request.id, expectedRevision),
    processes: value => { processes = value; }, afterCapture: action => { afterCapture = action; }, verifyWorkspace: action => { verifyWorkspace = action; } };
}

test('recovery inspection observes the owned candidate without settling its unknown operation', async t => {
  const f = await recovery(t), before = f.journal.events(f.request.id).events;
  const observation = await f.inspect();
  assert.deepEqual(observation, { requestRevision: f.request.revision, deliveryRunId: f.request.delivery.id,
    inputRevision: f.request.inputRevision, candidateDigest: 'a'.repeat(64), observedAt: observation.observedAt });
  assert.ok(Number.isFinite(Date.parse(observation.observedAt)));
  assert.equal(f.identityCalls, 1); assert.equal(f.captures, 1);
  assert.equal(f.journal.get(f.request.id).delivery.status, 'outcome_unknown');
  assert.deepEqual(f.journal.events(f.request.id).events, before);
});

test('recovery inspection refuses active managed controllers and processes before observing files', async t => {
  const f = await recovery(t);
  f.running.set('recovery-task', {});
  await assert.rejects(f.inspect(), /active managed execution/); assert.equal(f.identityCalls, 0);
  f.running.clear(); f.processes([{ state: 'running', taskId: 'recovery-task', sessionId: null }]);
  await assert.rejects(f.inspect(), /active managed execution/); assert.equal(f.captures, 0);
  f.processes([{ state: 'running', taskId: 'another-task', sessionId: 'another-session' }]);
  assert.equal((await f.inspect()).candidateDigest, 'a'.repeat(64));
});

test('recovery inspection rejects replaced worktrees, stale request revisions and concurrent changes', async t => {
  const f = await recovery(t);
  await assert.rejects(f.inspect(f.request.revision - 1), /request changed/i);
  f.verifyWorkspace(() => { throw Error('Owned worktree identity changed.'); });
  await assert.rejects(f.inspect(), /identity changed/); assert.equal(f.captures, 0);
  f.verifyWorkspace(() => {});
  f.afterCapture(() => f.journal.deliveryUpdate(f.request.id, { action: 'hold', code: 'source', reason: 'The source changed while inspecting.' }));
  await assert.rejects(f.inspect(), /changed during recovery/);
  assert.equal(f.journal.get(f.request.id).delivery.status, 'outcome_unknown');
});

test('a managed process appearing during inspection prevents the recovery receipt', async t => {
  const f = await recovery(t);
  f.afterCapture(() => f.processes([{ state: 'running', taskId: 'recovery-task' }]));
  await assert.rejects(f.inspect(), /active managed execution/);
  assert.equal(f.journal.get(f.request.id).delivery.recoveries, undefined);
});
