import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceFixture, resultWith } from './contract-fixtures.mjs';
import { workspaceContext } from './runtime-fixtures.mjs';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-execution-recovery-'));
  const worker = await workspaceFixture(t, directory);
  await worker.init();
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  const context = workspaceContext(worker), runs = worker.sessions.runs;
  const run = await runs.begin({ sessionId: 'ready-review-uncertain', taskId: 'review-task', kind: 'local',
    title: 'Readiness assessment', provider: 'claude-cli', model: 'fixture', purpose: 'gate_review' });
  await runs.start(run.id);
  runs.reserveUnknown(run.id, 'process_stop_unconfirmed');
  await runs.finish(run.id, 'failed');
  const command = { action: 'confirm_execution_stopped', runId: run.id, expectedRevision: 1,
    operationId: 'confirm-review-stop', note: 'Inspected and stopped the prior provider process and its descendants.' };
  let controller = false, observations = 0, afterObservation = () => {};
  /** @type {import('../../src/worker/application/process-observation.js').ObservedProcessRecord[]} */ let observed = [];
  /** @type {import('../../src/worker/application/process-supervision.js').ServiceRecord[]} */ let services = [];
  const processes = await context.processObservations.status(), serviceStatus = context.processes.status();
  t.mock.method(context.executor, 'has', sessionId => sessionId === run.sessionId && controller);
  t.mock.method(context.processObservations, 'status', async () => {
    observations++; afterObservation();
    return { ...processes, processes: observed };
  });
  t.mock.method(context.processes, 'status', () => ({ ...serviceStatus, services }));
  /** @param {import('../../src/worker/application/process-supervision.js').ServiceState} state @param {string} [sessionId] */
  function service(state, sessionId = run.sessionId) {
    services = [{ id: 'review-service', revision: 1, presetId: 'server', name: 'Review service', featureRequestKey: 'fr-' + 'b'.repeat(64),
      sessionId, state, generation: 1, restartCount: 0, restartLimit: 0, createdAt: run.acceptedAt, startedAt: null, endedAt: null,
      expiresAt: new Date(Date.now() + 60000).toISOString(), readiness: 'not_configured', readyAt: null, lastExit: null, error: null, measurement: null }];
  }
  /** @param {import('../../src/worker/application/process-observation.js').ObservedProcessRecord['state']} state @param {string | null} [sessionId] @param {string | null} [runId] */
  function process(state, sessionId = run.sessionId, runId = sessionId === run.sessionId ? run.id : 'unrelated-run') {
    observed = [{ id: 'observed-review', kind: 'provider', label: 'Reviewer', featureRequestKey: null, taskId: run.taskId, state, sessionId,
      runId, startedAt: run.acceptedAt, endedAt: null, exitCode: null, measurement: null }];
  }
  return { worker, context, runs, run, command, service, process, get observations() { return observations; },
    controller: (/** @type {boolean} */ value) => { controller = value; }, afterObservation: (/** @type {() => void} */ value) => { afterObservation = value; } };
}

test('uncertain reviewer recovery releases only capacity and exact lost acknowledgements replay once', async t => {
  const f = await fixture(t), before = f.runs.get(f.run.id);
  const listed = resultWith(await f.worker.requestCommand({ action: 'execution_recovery' }), 'runs');
  assert.equal(listed.runs[0].id, f.run.id);
  assert.equal(f.context.executor.canStart('new-work'), false);
  const result = resultWith(await f.worker.requestCommand(f.command), 'run');
  assert.equal(result.duplicate, false);
  assert.ok(result.run.executionRecovery?.confirmation);
  assert.equal(result.run.executionRecovery.state, 'operator_confirmed_stopped');
  assert.equal(result.run.executionRecovery.confirmation.basis, 'operator_attested');
  assert.equal(result.run.outcome, before.outcome);
  assert.deepEqual(result.run.usage, before.usage);
  assert.deepEqual(result.run.after, before.after, 'Cessation cannot manufacture a new provider result.');
  assert.equal(f.context.executor.canStart('new-work'), true);
  assert.equal(f.context.executor.executions.length, 0, 'Confirmation does not start another attempt.');
  f.controller(true); f.process('running'); f.service('running');
  const replay = resultWith(await f.worker.requestCommand(f.command), 'run');
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.run, result.run);
  assert.equal(f.observations, 1, 'Receipt replay does not make another stop observation.');
  await assert.rejects(f.worker.requestCommand({ ...f.command, note: 'Changed recovery intent.' }), /conflict|different|changed|operation/i);
});

test('live controllers, processes and services prevent an operator cessation receipt', async t => {
  const f = await fixture(t);
  f.controller(true);
  await assert.rejects(f.worker.requestCommand(f.command), /live controller/);
  assert.equal(f.observations, 0);
  f.controller(false);
  for (const state of /** @type {const} */ (['starting', 'running', 'restarting', 'stopping'])) {
    f.service(state);
    await assert.rejects(f.worker.requestCommand(f.command), /managed development services/);
  }
  assert.equal(f.observations, 0);
  f.service('stopped'); f.process('running');
  await assert.rejects(f.worker.requestCommand(f.command), /owned process/);
  assert.equal(f.runs.get(f.run.id).executionRecovery?.state, 'unknown');
  f.process('running', 'another-request');
  const confirmed = resultWith(await f.worker.requestCommand(f.command), 'run');
  assert.equal(confirmed.run.executionRecovery?.state, 'operator_confirmed_stopped');
});

for (const owner of ['controller', 'service', 'shutdown']) test(`a ${owner} change during observation cannot clear uncertain capacity`, async t => {
  const f = await fixture(t);
  f.afterObservation(() => {
    if (owner === 'controller') f.controller(true);
    else if (owner === 'service') f.service('running');
    else f.context.acceptingTasks = false;
  });
  await assert.rejects(f.worker.requestCommand(f.command), /live controller|managed development services|stopping/);
  assert.equal(f.runs.get(f.run.id).executionRecovery?.state, 'unknown');
  assert.equal(f.context.executor.canStart('new-work'), false);
  f.afterObservation(() => {}); f.controller(false); f.service('stopped'); f.context.acceptingTasks = true;
  assert.equal(resultWith(await f.worker.requestCommand(f.command), 'run').duplicate, false);
});

test('malformed, stale and public observation fields cannot authorize execution recovery', async t => {
  const f = await fixture(t);
  for (const malformed of [
    { ...f.command, action: ['confirm_execution_stopped'] },
    { ...f.command, expectedRevision: 0 },
    { ...f.command, note: '' },
    { ...f.command, ownedProcessesAbsent: true },
    { action: 'execution_recovery', runId: f.run.id },
  ]) await assert.rejects(f.worker.requestCommand(malformed));
  assert.equal(f.observations, 0);
  assert.equal(f.runs.get(f.run.id).executionRecovery?.state, 'unknown');
  assert.equal(resultWith(await f.worker.requestCommand(f.command), 'run').duplicate, false);
});


test('a delegated execution cannot be confirmed while its parent still owns a controller or process', async t => {
  const f = await fixture(t);
  const metadata = { taskId: 'delegated-task', kind: /** @type {const} */ ('chat'), title: 'Delegated assessment', provider: 'claude-cli', model: 'fixture' };
  const parent = await f.runs.begin({ ...metadata, sessionId: 'parent-session' }); await f.runs.start(parent.id);
  const child = await f.runs.begin({ ...metadata, sessionId: 'child-session', parentRunId: parent.id, parentSessionId: parent.sessionId, delegationId: 'delegation-one' });
  await f.runs.start(child.id); f.runs.reserveUnknown(child.id, 'process_stop_unconfirmed');
  await f.runs.finish(child.id, 'failed'); await f.runs.finish(parent.id, 'failed');
  const command = { ...f.command, runId: child.id, operationId: 'confirm-child-stop' };
  t.mock.method(f.context.executor, 'has', sessionId => sessionId === parent.sessionId);
  await assert.rejects(f.worker.requestCommand(command), /live controller/);
  t.mock.method(f.context.executor, 'has', () => false);
  f.service('running', parent.sessionId);
  await assert.rejects(f.worker.requestCommand(command), /managed development services/);
  f.service('stopped', parent.sessionId); f.process('running', parent.sessionId);
  await assert.rejects(f.worker.requestCommand(command), /owned process/);
  assert.equal(f.runs.get(child.id).executionRecovery?.state, 'unknown');
  f.process('exited', parent.sessionId);
  const confirmed = resultWith(await f.worker.requestCommand(command), 'run');
  assert.equal(confirmed.run.executionRecovery?.state, 'operator_confirmed_stopped');
  assert.equal(confirmed.run.outcome, 'failed');
});


test('parent cessation requires delegated child controllers, processes and services to stop', async t => {
  const f = await fixture(t);
  const parent = await f.runs.begin({ sessionId: 'delegation-owner', taskId: f.run.taskId, kind: f.run.kind,
    title: 'Implementation owner', provider: f.run.provider, model: f.run.model, purpose: f.run.purpose });
  await f.runs.start(parent.id);
  const command = { ...f.command, runId: parent.id, operationId: 'confirm-delegation-owner' };
  const child = await f.runs.begin({ sessionId: 'delegated-live-child', taskId: f.run.taskId, kind: f.run.kind,
    title: 'Delegated assessment', provider: f.run.provider, model: f.run.model, purpose: f.run.purpose,
    parentRunId: parent.id, parentSessionId: parent.sessionId, delegationId: 'child-one' });
  await f.runs.start(child.id); await f.runs.finish(child.id, 'failed');
  f.runs.reserveUnknown(parent.id, 'process_stop_unconfirmed'); await f.runs.finish(parent.id, 'failed');
  const controller = t.mock.getter(f.context.executor, 'executions', () => [{ sessionId: child.sessionId,
    projectId: null, projectLimit: 1, startedAt: Date.now(), monotonicStartedAt: performance.now() }]);
  await assert.rejects(f.worker.requestCommand(command), /live controller/);
  controller.mock.restore();
  f.service('running', child.sessionId);
  await assert.rejects(f.worker.requestCommand(command), /managed development services/);
  f.service('stopped', child.sessionId); f.process('running', null, child.id);
  await assert.rejects(f.worker.requestCommand(command), /owned process/);
  f.process('running', child.sessionId);
  await assert.rejects(f.worker.requestCommand(command), /owned process/);
  f.process('exited', child.sessionId);
  f.afterObservation(() => f.service('running', child.sessionId));
  await assert.rejects(f.worker.requestCommand(command), /managed development services/);
  assert.equal(f.runs.get(parent.id).executionRecovery?.state, 'unknown');
  f.afterObservation(() => {}); f.service('stopped', child.sessionId);
  assert.equal(resultWith(await f.worker.requestCommand(command), 'run').run.executionRecovery?.state, 'operator_confirmed_stopped');
  assert.equal(f.runs.get(child.id).outcome, 'failed', 'Parent cessation does not rewrite the child accounting outcome.');
});
