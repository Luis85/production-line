import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialExecutor } from '../../src/worker/dist/worker/application/serial-executor.js';
import { effectiveProjectConcurrency, validateDeliveryCoordinationPolicy } from '../../src/worker/dist/worker/application/delivery-coordination.js';
import { planDeliveryDependencies } from '../../src/worker/dist/worker/application/delivery-dependency-plan.js';
import { workerCapacitySnapshot } from '../../src/worker/dist/worker/application/worker-capacity.js';
// A permit expected to start must settle within a test deadline; missing wake-ups fail rather than hanging the mutation runner.
const signal = () => AbortSignal.timeout(1000);
const turn = () => new Promise(resolve => setImmediate(resolve));

test('shared permits enforce machine and project ceilings without starving another project', async () => {
  const executor = new SerialExecutor(() => false, () => 3), events = [];
  const a1 = await executor.acquire('a1', signal(), { projectId: 'alpha', projectLimit: 1 });
  const waitingA = executor.acquire('a2', signal(), { projectId: 'alpha', projectLimit: 2 }).then(release => { events.push('a2'); return release; });
  const b1 = await executor.acquire('b1', signal(), { projectId: 'beta', projectLimit: 2 });
  const b2 = await executor.acquire('b2', signal(), { projectId: 'beta', projectLimit: 2 });
  assert.equal(executor.executions.length, 3); assert.deepEqual(events, []);
  assert.deepEqual(executor.executions.map(item => item.sessionId), ['a1', 'b1', 'b2']);
  const b3 = executor.acquire('b3', signal(), { projectId: 'beta', projectLimit: 2 });
  a1(); const a2 = await waitingA; assert.deepEqual(events, ['a2']);
  b1(); const releaseB3 = await b3;
  assert.equal(executor.executions.length, 3); b2(); releaseB3(); a2(); assert.equal(executor.busy, false);
});

test('same session cannot overlap, unscoped work remains exclusive and duplicate release is harmless', async () => {
  const executor = new SerialExecutor(() => false, () => 3), events = [];
  const first = await executor.acquire('same', signal(), { projectId: 'alpha', projectLimit: 3 });
  const second = executor.acquire('same', signal(), { projectId: 'alpha', projectLimit: 3 }).then(release => { events.push('same'); return release; });
  const legacy = executor.acquire('legacy', signal()).then(release => { events.push('legacy'); return release; });
  const next = executor.acquire('next', signal(), { projectId: 'beta' }).then(release => { events.push('next'); return release; });
  assert.equal(executor.waiting, 3); first(); first(); const releaseSecond = await second;
  assert.deepEqual(events, ['same']); assert.equal(executor.has('same'), true);
  releaseSecond(); const releaseLegacy = await legacy; assert.deepEqual(events, ['same', 'legacy']);
  assert.equal(executor.executions.length, 1); releaseLegacy(); const releaseNext = await next; releaseNext(); assert.equal(executor.busy, false);
});

test('lowering capacity drains existing work and paused workers only admit continuations', async () => {
  let limit = 3, paused = false; const executor = new SerialExecutor(() => paused, () => limit);
  const first = await executor.acquire('a', signal(), { projectId: 'a' });
  const second = await executor.acquire('b', signal(), { projectId: 'b' });
  limit = 1; paused = true;
  let entered = false;
  const queued = executor.acquire('c', signal(), { projectId: 'c' }).then(release => { entered = true; return release; });
  const continuation = executor.acquire('d', signal(), { projectId: 'd', continuation: true });
  first(); await turn(); assert.equal(executor.has('b'), true); assert.equal(executor.has('d'), false);
  second(); const releaseContinuation = await continuation; assert.equal(entered, false);
  releaseContinuation(); paused = false; executor.wake(); const releaseQueued = await queued; releaseQueued();
  assert.equal(executor.busy, false);
});

test('aborting queued exclusive work wakes eligible projects and failed actions release their permit', async () => {
  const executor = new SerialExecutor(() => false, () => 2);
  const first = await executor.acquire('a', signal(), { projectId: 'a' }), cancelled = new AbortController();
  const blocked = executor.acquire('exclusive', cancelled.signal);
  const rejected = assert.rejects(blocked, /cancelled/);
  const later = executor.acquire('b', signal(), { projectId: 'b' });
  cancelled.abort(new Error('cancelled')); await rejected;
  const second = await later; assert.equal(executor.executions.length, 2); first(); second();
  await assert.rejects(executor.run('failed', signal(), async () => { throw Error('fixture'); }, { projectId: 'a' }), /fixture/);
  assert.equal(executor.busy, false);
  for (const projectLimit of [0, 9, 1.5, NaN]) await assert.rejects(executor.acquire('bad', signal(), { projectId: 'a', projectLimit }), /limit/);
});

test('capacity shows each occupied project and its effective ceiling', async () => {
  const executor = new SerialExecutor(() => false, () => 3);
  const a = await executor.acquire('a', signal(), { projectId: 'project-a', projectLimit: 2 });
  const b = await executor.acquire('b', signal(), { projectId: 'project-b' });
  const snapshot = workerCapacitySnapshot({ capturedAt: new Date().toISOString(), currentSessionId: executor.current, activeSessions: executor.executions, localUsed: 4, settings: { maxParallel: 3, paused: false, queueCapacity: 8, orchestratorQueue: 2 }, remote: { waiting: 0, running: 0 }, consumption: null });
  assert.equal(snapshot.execution.limit, 3); assert.equal(snapshot.execution.inUse, 2);
  assert.deepEqual(snapshot.execution.projects, [{ projectId: 'project-a', limit: 2, inUse: 1 }, { projectId: 'project-b', limit: 1, inUse: 1 }]);
  assert.deepEqual(snapshot.execution.sessions.map(item => item.sessionId), ['a', 'b']); a(); b();
  assert.equal(effectiveProjectConcurrency(undefined, 8), 1);
  assert.equal(effectiveProjectConcurrency({ maxActiveRequests: 4, dependencyPlanning: 'topological' }, 2), 2);
  assert.throws(() => validateDeliveryCoordinationPolicy({ maxActiveRequests: 9, dependencyPlanning: 'topological' }), /1 to 8/);
});

const base = 'a'.repeat(40), integrated = 'b'.repeat(40);
const accepted = id => ({ id, requestId: 'request-' + id, inputRevision: 3, candidateCommit: 'c'.repeat(40), includesCode: true });
test('dependency plan retains topological waves and distinct acceptance versus integration proof', async () => {
  const graph = [{ id: 'a:root', dependsOn: ['a:left', 'b:right'] }, { id: 'a:left', dependsOn: ['a:base'] }, { id: 'b:right', dependsOn: [] }, { id: 'a:base', dependsOn: [] }];
  const observations = [];
  const plan = await planDeliveryDependencies('a:root', graph, base, { accepted: id => ({ ...accepted(id), ...(id === 'b:right' ? { repositoryId: 'b', integrationBaseline: integrated } : {}) }), incorporated: async (commit, baseline, predecessor) => { observations.push([commit, baseline, predecessor.id]); return predecessor.id !== 'a:left'; } });
  assert.equal(plan.ready, false); assert.deepEqual(plan.waves, [['a:base', 'b:right'], ['a:left'], ['a:root']]);
  const left = plan.nodes.find(node => node.id === 'a:left'); assert.equal(left.state, 'waiting_integration'); assert.equal(left.accepted.inputRevision, 3); assert.equal(left.receipt, undefined);
  const right = plan.nodes.find(node => node.id === 'b:right'); assert.equal(right.receipt.integrationBaseline, integrated); assert.equal(right.receipt.baseline, base);
  assert.ok(observations.some(([, baseline, id]) => id === 'b:right' && baseline === integrated));
  assert.equal(plan.nodes.find(node => node.id === 'a:root').state, 'blocked');
});

test('structural dependency failures never inspect repositories and unavailable evidence stays blocked', async () => {
  let inspections = 0;
  const ports = { accepted, incorporated: async () => { inspections++; return true; } };
  const cycle = await planDeliveryDependencies('a', [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }], base, ports);
  assert.equal(cycle.ready, false); assert.equal(cycle.blockers[0].code, 'cycle'); assert.equal(inspections, 0); assert.deepEqual(cycle.waves, []);
  const unknown = await planDeliveryDependencies('a', [{ id: 'a', dependsOn: ['missing'] }], base, ports);
  assert.equal(unknown.blockers[0].code, 'unknown'); assert.equal(inspections, 0);
  const unavailable = await planDeliveryDependencies('a', [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: [] }], base, { accepted, incorporated: async () => { throw Error('offline'); } });
  assert.equal(unavailable.blockers[0].code, 'inspection_unavailable'); assert.equal(unavailable.ready, false);
});


test('persisted unknown permits share global and project limits with live and auxiliary work', async () => {
  /** @type {import('../../src/worker/application/serial-executor.ts').ReservedExecutionPermit[]} */
  let unresolved = [{ sessionId: 'old', projectId: 'alpha', projectLimit: 1 }];
  const executor = new SerialExecutor(() => false, () => 2, () => unresolved);
  assert.equal(executor.busy, true); assert.equal(executor.current, null); assert.deepEqual(executor.executions, []);
  assert.equal(executor.canStart('old', { projectId: 'beta' }), false);
  assert.equal(executor.canStart('next', { projectId: 'alpha', projectLimit: 2 }), false);
  assert.equal(executor.canStart('legacy'), false);
  assert.equal(executor.canStart('beta', { projectId: 'beta' }), true);
  const release = await executor.acquire('beta', signal(), { projectId: 'beta' });
  unresolved.push({ sessionId: 'beta', projectId: 'beta', projectLimit: 1 });
  assert.deepEqual(executor.reservedExecutions, [{ sessionId: 'old', projectId: 'alpha', projectLimit: 1 }]);
  assert.equal(executor.canStart('gamma', { projectId: 'gamma' }), false);
  let calls = 0; await assert.rejects(executor.run('legacy', signal(), async () => { calls++; }), /Reconcile the unresolved/);
  assert.equal(calls, 0); assert.equal(executor.waiting, 0);
  unresolved = []; release(); assert.equal(calls, 0);
  await executor.run('legacy', signal(), async () => { calls++; }); assert.equal(calls, 1); assert.equal(executor.busy, false);
  unresolved = [{ sessionId: 'unbound', projectId: null, projectLimit: 1 }];
  assert.equal(executor.canStart('any-project', { projectId: 'gamma' }), false);
});


test('coordination accepts exact bounds and rejects malformed project authority without coercion', () => {
  for (const maxActiveRequests of [1, 8]) for (const dependencyPlanning of ['accepted_baseline', 'topological'])
    assert.deepEqual(validateDeliveryCoordinationPolicy({ maxActiveRequests, dependencyPlanning }), { maxActiveRequests, dependencyPlanning });
  for (const maxActiveRequests of [0, -1, 9, 1.5, NaN, Infinity, '2', null])
    assert.throws(() => validateDeliveryCoordinationPolicy({ maxActiveRequests, dependencyPlanning: 'topological' }), { code: 'invalid_input' });
  for (const dependencyPlanning of ['', 'unknown', ['topological'], null])
    assert.throws(() => validateDeliveryCoordinationPolicy({ maxActiveRequests: 1, dependencyPlanning }), { code: 'invalid_input' });
});

test('executor bounds queue admission, rejects already-aborted work and preserves actual start clocks', async () => {
  const executor = new SerialExecutor(); assert.equal(executor.limit, 1); assert.equal(executor.startedAt, null); assert.equal(executor.startedMonotonicAt, null);
  const aborted = new AbortController(); aborted.abort(new Error('Already cancelled'));
  await assert.rejects(executor.acquire('aborted', aborted.signal), /Already cancelled/); assert.equal(executor.busy, false);
  for (const projectId of ['', ' ', 'a'.repeat(4097)]) await assert.rejects(executor.acquire('invalid', signal(), { projectId }), { code: 'invalid_input' });
  const before = Date.now(), beforeMonotonic = performance.now();
  const release = await executor.acquire('active', signal(), { projectId: 'a'.repeat(4096), projectLimit: 8 });
  assert.ok(executor.startedAt >= before && executor.startedAt <= Date.now());
  assert.ok(executor.startedMonotonicAt >= beforeMonotonic && executor.startedMonotonicAt <= performance.now());
  const cancellations = Array.from({ length: 64 }, () => new AbortController()), entries = cancellations.map((controller, i) => executor.acquire('waiting-' + i, controller.signal));
  const rejected = entries.map(entry => assert.rejects(entry, /Queue cancelled/));
  assert.equal(executor.waiting, 64); await assert.rejects(executor.acquire('overflow', signal()), /queue is full/);
  for (const controller of cancellations) controller.abort(new Error('Queue cancelled')); await Promise.all(rejected); assert.equal(executor.waiting, 0); release();
  assert.equal(executor.startedAt, null); assert.equal(executor.startedMonotonicAt, null); assert.equal(executor.busy, false);
});

test('paused scheduling and exclusive queues use the same admission decision as permit acquisition', async () => {
  let paused = true; const executor = new SerialExecutor(() => paused, () => 2);
  assert.equal(executor.canStart('new', { projectId: 'alpha' }), false);
  assert.equal(executor.canStart('continuation', { projectId: 'alpha', continuation: true }), true);
  const release = await executor.acquire('continuation', signal(), { projectId: 'alpha', continuation: true });
  paused = false; const exclusive = executor.acquire('legacy', signal());
  assert.equal(executor.canStart('later', { projectId: 'beta' }), false);
  assert.equal(executor.busy, true); release(); const finish = await exclusive; finish();
  const abort = new AbortController(); let calls = 0;
  const action = executor.run('race', abort.signal, async () => { calls++; }); abort.abort(new Error('Cancelled before action'));
  await assert.rejects(action, /Cancelled before action/); assert.equal(calls, 0); assert.equal(executor.busy, false);
});
