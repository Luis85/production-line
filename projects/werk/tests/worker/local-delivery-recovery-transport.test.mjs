import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceFixture, resultWith } from './contract-fixtures.mjs';
import { workspaceContext } from './runtime-fixtures.mjs';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-recovery-transport-')), worker = await workspaceFixture(t, root);
  await worker.init(); t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  const context = workspaceContext(worker), journal = worker.sessions.requests;
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  let request = journal.ensure({ owner: { sessionId: 'unknown-session', rootTurnId: 'unknown-turn', taskId: 'unknown-task' }, policy,
    provider: { id: 'fixture', model: 'fixture', instruction: 'No model invocation.' },
    input: { kind: 'patch', title: 'Retain the worktree', message: 'Preserve and inspect the retained candidate.',
      files: [{ path: 'source.txt', bytes: 10 }], context: { implementation: { mode: 'development' } } } });
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'unknown-turn');
  request = journal.prepareExecution(request.id, 'unknown-turn', 'unknown-invocation');
  journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: request.delivery.id, stepId: 'unknown-step', phase: 'implementing' });
  request = journal.deliveryUpdate(request.id, { action: 'stopped', deliveryRunId: request.delivery.id, confirmed: false });
  const baseline = context.processes.status();
  /** @type {import('../../src/worker/application/process-supervision.js').ServiceRecord[]} */ let services = [];
  t.mock.method(context.processes, 'status', () => ({ ...baseline, services }));
  let inspections = 0, afterInspection = () => {};
  t.mock.method(worker.board, 'inspectStopped', async (requestId, expectedRevision) => {
    assert.equal(requestId, request.id); assert.equal(expectedRevision, request.revision); inspections++; afterInspection();
    return { requestRevision: request.revision, deliveryRunId: request.delivery.id, inputRevision: request.inputRevision,
      candidateDigest: 'a'.repeat(64), observedAt: new Date().toISOString() };
  });
  const command = { action: 'confirm_stopped', operationId: 'operator-stop-receipt', requestId: request.id, expectedRevision: request.revision,
    deliveryRunId: request.delivery.id, inputRevision: request.inputRevision, note: 'Inspected and stopped all prior provider and service processes.' };
  /** @param {import('../../src/worker/application/process-supervision.js').ServiceState} state @param {string} [sessionId] */
  function service(state, sessionId = request.owner.sessionId) {
    services = [{ id: 'service-1', revision: 1, presetId: 'dev-server', name: 'Development server', featureRequestKey: 'fr-' + 'b'.repeat(64),
      sessionId, state, generation: 1, restartCount: 0, restartLimit: 0, createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
      expiresAt: new Date(Date.now() + 60000).toISOString(), readiness: 'not_configured', readyAt: null, lastExit: null, error: null, measurement: null }];
  }
  return { worker, journal, request, command, service, get inspections() { return inspections; }, afterInspection: callback => { afterInspection = callback; } };
}

test('stop confirmation refuses live development services before inspecting the retained candidate', async t => {
  const f = await fixture(t), events = f.journal.events(f.request.id).events;
  for (const state of /** @type {const} */ (['starting', 'running', 'restarting', 'stopping'])) {
    f.service(state);
    await assert.rejects(f.worker.requestCommand(f.command), /Stop this request’s managed development services/);
    assert.equal(f.inspections, 0); assert.deepEqual(f.journal.events(f.request.id).events, events);
  }
  f.service('stopped');
  const accepted = resultWith(await f.worker.requestCommand(f.command), 'request');
  assert.equal(accepted.request.delivery.status, 'interrupted'); assert.equal(f.inspections, 1);
  assert.equal(accepted.request.delivery.recoveries[0].source, 'operator_attestation');
  assert.equal(accepted.request.delivery.recoveries[0].candidateDigest, 'a'.repeat(64));
  assert.notEqual(accepted.request.delivery.status, 'queued', 'A cessation attestation must not start execution.');
});

test('a service starting during candidate inspection rejects confirmation without consuming its operation ID', async t => {
  const f = await fixture(t), events = f.journal.events(f.request.id).events;
  f.afterInspection(() => f.service('running'));
  await assert.rejects(f.worker.requestCommand(f.command), /Stop this request’s managed development services/);
  assert.equal(f.inspections, 1); assert.deepEqual(f.journal.events(f.request.id).events, events);
  f.afterInspection(() => {}); f.service('running', 'another-request-session');
  const accepted = resultWith(await f.worker.requestCommand(f.command), 'request');
  assert.equal(accepted.duplicate, false); assert.equal(accepted.request.delivery.status, 'interrupted');
  const saved = f.journal.events(f.request.id).events;
  f.service('running');
  const replay = resultWith(await f.worker.requestCommand(f.command), 'request');
  assert.equal(replay.duplicate, true); assert.equal(f.inspections, 2);
  assert.deepEqual(f.journal.events(f.request.id).events, saved, 'A lost acknowledgement replays its receipt without another stop action.');
});
