import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { SerialExecutor } from '../../src/worker/dist/worker/application/serial-executor.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { deliveryOwnsRun } from '../../src/worker/dist/worker/application/execution-recovery.js';
import { cleanup } from './fixture-cleanup.mjs';
const metadata = (sessionId = 'review-session') => ({ sessionId, taskId: 'review-task', kind: /** @type {const} */ ('chat'), purpose: /** @type {const} */ ('gate_review'), provider: 'claude-cli', model: 'fixture', title: 'Readiness review' });
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-execution-recovery-')); let journal = new WorkerRunJournal(directory); await journal.init();
  cleanup(t, async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  const executor = new SerialExecutor(() => false, () => 4, () => journal.uncertainExecutions().map(run => ({ sessionId: run.parentSessionId ?? run.sessionId, projectId: null, projectLimit: 1 })));
  return { directory, executor, get journal() { return journal; }, async restart() { journal.close(); journal = new WorkerRunJournal(directory); await journal.init(); } };
}
/** @param {import('../../src/worker/application/run-evidence.ts').WorkerRun} run */
function confirmation(run) {
  const command = { action: 'confirm_execution_stopped', runId: run.id, expectedRevision: run.executionRecovery.revision, operationId: 'operator-inspection', note: 'Inspected the prior provider execution and confirmed all owned work stopped.' };
  const observation = { runId: run.id, sessionId: run.sessionId, expectedRevision: command.expectedRevision, controllerAbsent: /** @type {const} */ (true), ownedProcessesAbsent: /** @type {const} */ (true), managedServicesAbsent: /** @type {const} */ (true), observedAt: new Date().toISOString() };
  return { command, observation };
}
test('unknown auxiliary run reserves capacity once and only grounded exact attestation releases it without replay', async t => {
  const f = await fixture(t), run = await f.journal.begin(metadata());
  const release = await f.executor.acquire(run.sessionId, new AbortController().signal); await f.journal.start(run.id);
  f.journal.reserveUnknown(run.id, 'process_stop_unconfirmed');
  assert.equal(f.executor.executions.length, 1); assert.equal(f.executor.reservedExecutions.length, 0, 'A live permit and its durable receipt must not count twice.');
  await f.journal.finish(run.id, 'failed'); release();
  const unknown = f.journal.get(run.id); assert.equal(unknown.executionRecovery.reason, 'process_stop_unconfirmed');
  assert.equal(f.executor.reservedExecutions.length, 1); assert.equal(f.executor.canStart('other', { projectId: 'other-project' }), false);
  await assert.rejects(f.executor.acquire('other', new AbortController().signal), /Reconcile/); assert.equal(f.executor.waiting, 0);
  const { command, observation } = confirmation(unknown);
  assert.throws(() => f.journal.confirmExecutionStopped(command, undefined), /Inspect/);
  for (const field of ['controllerAbsent', 'ownedProcessesAbsent', 'managedServicesAbsent'])
    assert.throws(() => f.journal.confirmExecutionStopped(command, { ...observation, [field]: false }), /Inspect/);
  assert.throws(() => f.journal.confirmExecutionStopped(command, { ...observation, sessionId: 'another-session' }), /Inspect/);
  assert.throws(() => f.journal.confirmExecutionStopped({ ...command, expectedRevision: 2 }, observation), /changed/);
  const confirmed = f.journal.confirmExecutionStopped(command, observation);
  assert.equal(confirmed.outcome, 'failed'); assert.deepEqual(confirmed.after, unknown.after);
  assert.equal(confirmed.executionRecovery.state, 'operator_confirmed_stopped'); assert.equal(confirmed.executionRecovery.confirmation.basis, 'operator_attested');
  assert.equal(confirmed.executionRecovery.confirmation.note, command.note); assert.equal(f.executor.reservedExecutions.length, 0);
  assert.deepEqual(f.journal.recoveryReplay(command), confirmed);
  assert.deepEqual(f.journal.confirmExecutionStopped(command, undefined), confirmed, 'Exact replay precedes fresh inspection.');
  assert.throws(() => f.journal.recoveryReplay({ ...command, note: 'Changed assertion' }), /different attestation/);
  await f.restart(); assert.deepEqual(f.journal.recoveryReplay(command), confirmed); assert.deepEqual(f.journal.uncertainExecutions(), []);
  assert.equal(f.journal.list().total, 1, 'Reconciliation creates no second attempt.');
});
test('restart reserves only started missing-result attempts and preserves known results and never-dispatched work', async t => {
  const f = await fixture(t), queued = await f.journal.begin(metadata('queued')), running = await f.journal.begin(metadata('running'));
  const saved = await f.journal.begin(metadata('known-result')), delivered = await f.journal.begin(metadata('delivery-owned'));
  await f.journal.start(running.id); await f.journal.start(saved.id); await f.journal.start(delivered.id);
  f.journal.close(); const recovered = new WorkerRunJournal(f.directory); cleanup(t, () => recovered.close());
  await recovered.init(id => id === saved.id ? { outcome: 'completed', usage: unknownUsage() } : undefined, run => run.id === delivered.id);
  assert.deepEqual(recovered.uncertainExecutions().map(run => run.id), [running.id]);
  assert.equal(recovered.get(running.id).executionRecovery.reason, 'worker_restarted'); assert.equal(recovered.get(queued.id).executionRecovery, undefined);
  assert.equal(recovered.get(saved.id).outcome, 'completed'); assert.equal(recovered.get(delivered.id).executionRecovery, undefined);
  const before = recovered.get(running.id), { command, observation } = confirmation(before);
  assert.equal(recovered.confirmExecutionStopped(command, observation).outcome, 'interrupted');
});
test('recovery rejects malformed primitives and cannot create uncertainty for queued or finished evidence', async t => {
  const f = await fixture(t), run = await f.journal.begin(metadata());
  assert.throws(() => f.journal.reserveUnknown(run.id, 'outcome_unknown'), /started/);
  await f.journal.start(run.id); f.journal.reserveUnknown(run.id, 'outcome_unknown');
  const { command, observation } = confirmation(f.journal.get(run.id));
  for (const value of [{ ...command, action: ['confirm_execution_stopped'] }, { ...command, expectedRevision: '1' }, { ...command, expectedRevision: 0 }, { ...command, runId: [run.id] }, { ...command, operationId: [] }, { ...command, note: ' ' }, { ...command, note: 'x'.repeat(4001) }])
    assert.throws(() => f.journal.confirmExecutionStopped(value, observation), { code: 'invalid_input' });
  const confirmed = f.journal.confirmExecutionStopped(command, observation); assert.equal(confirmed.outcome, 'interrupted');
  assert.equal(confirmed.after.measurement, 'recovery'); assert.throws(() => f.journal.reserveUnknown(run.id, 'outcome_unknown'), /started/);
});
test('all unresolved rows contribute capacity beyond evidence pagination and preserve detached receipts', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 105; i++) { const run = await f.journal.begin(metadata('unknown-' + i)); await f.journal.start(run.id); f.journal.reserveUnknown(run.id, 'outcome_unknown'); await f.journal.finish(run.id, 'failed'); }
  const rows = f.journal.uncertainExecutions(); assert.equal(rows.length, 105); assert.equal(f.executor.reservedExecutions.length, 105);
  rows[0].executionRecovery.state = 'operator_confirmed_stopped'; assert.equal(f.journal.uncertainExecutions()[0].executionRecovery.state, 'unknown');
});
test('an uncertainty write failure retains the live permit until restart rather than releasing through finally', async () => {
  const executor = new SerialExecutor();
  await executor.run('uncertain', new AbortController().signal, async () => { executor.retainUncertain('uncertain'); });
  assert.equal(executor.has('uncertain'), true); assert.equal(executor.canStart('other'), false); assert.equal(executor.busy, true);
});
test('canonical delivery owns only its exact provider invocation or delegated parent identity', () => {
  const request = /** @type {import('../../src/worker/application/request-gate-contracts.ts').WorkerRequest} */ (/** @type {unknown} */ ({ delivery: { steps: [{ invocationRunId: 'owned-run' }] }, deliveryHistory: [] }));
  const run = /** @type {import('../../src/worker/application/run-evidence.ts').WorkerRun} */ (/** @type {unknown} */ ({ id: 'owned-run' }));
  assert.equal(deliveryOwnsRun(run, request), true); assert.equal(deliveryOwnsRun({ ...run, id: 'other' }, request), false);
  assert.equal(deliveryOwnsRun({ ...run, id: 'child', parentRunId: run.id }, request), true); assert.equal(deliveryOwnsRun(run, undefined), false);
});

test('restart retains child accounting under one exact parent recovery boundary', async t => {
  for (const state of ['unknown', 'confirmed', 'unfinished-parent', 'no-parent-recovery']) await t.test(state, async childTest => {
    const f = await fixture(childTest), parent = await f.journal.begin(metadata('delegating-parent'));
    await f.journal.start(parent.id);
    const child = await f.journal.begin({ ...metadata('delegated-child'), parentRunId: parent.id, parentSessionId: parent.sessionId, delegationId: 'research' });
    await f.journal.start(child.id);
    if (state === 'unknown' || state === 'confirmed') f.journal.reserveUnknown(parent.id, 'process_stop_unconfirmed');
    if (state !== 'unfinished-parent') await f.journal.finish(parent.id, 'failed');
    if (state === 'confirmed') {
      const { command, observation } = confirmation(f.journal.get(parent.id)); f.journal.confirmExecutionStopped(command, observation);
    }
    await f.restart();
    const expected = state === 'confirmed' ? [] : [state === 'no-parent-recovery' ? child.id : parent.id];
    assert.deepEqual(f.journal.uncertainExecutions().map(run => run.id), expected);
    assert.equal(f.journal.get(child.id).outcome, 'interrupted');
    assert.equal(f.journal.get(child.id).after.measurement, 'recovery');
    if (state !== 'no-parent-recovery') assert.equal(f.journal.get(child.id).executionRecovery, undefined, 'A child accounting write failure does not create a second stop attestation.');
    assert.equal(f.journal.list().total, 2);
    await f.restart(); assert.deepEqual(f.journal.uncertainExecutions().map(run => run.id), expected);
  });
});
