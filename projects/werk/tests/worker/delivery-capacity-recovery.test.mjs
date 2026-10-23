import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSessions } from './application-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { workerCapacitySnapshot } from '../../src/worker/dist/worker/application/worker-capacity.js';

// This fixture exercises persisted coordinator evidence, not a real provider process.
test('restart reserves unknown delivery capacity for all admissions until explicit stopped reconciliation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-capacity-recovery-'));
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const settings = new WorkerSettings(directory); await settings.init(); await settings.update({ board: { maxParallel: 2 } });
  let providerCalls = 0, auxiliaryCalls = 0;
  const model = () => ({ async reply() { providerCalls++; return 'Unexpected replay'; } });
  const first = WorkerSessions(directory, settings, model); await first.init(); cleanup(t, () => first.close());
  const sessionId = first.current.id, policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  const initial = first.requests.ensure({ owner: { sessionId, taskId: 'recovered-task', rootTurnId: 'delivery-turn' }, policy,
    provider: { id: 'claude-cli', model: 'fixture', instruction: '' },
    input: { kind: 'patch', title: 'Recover an uncertain implementation', message: 'Implement the accepted change without replaying interrupted work.', criteria: ['The value is updated.'],
      context: { repositoryId: 'project-a', implementation: { mode: 'development' } }, files: [{ path: 'value.txt', bytes: 2 }] } });
  assert.equal(first.requests.evaluate(initial.id, 'ready').passed, true);
  first.requests.bindTurn(initial.id, 'delivery-turn');
  const prepared = first.requests.prepareExecution(initial.id, 'delivery-turn', 'invocation-one');
  first.requests.deliveryUpdate(initial.id, { action: 'start', deliveryRunId: prepared.delivery.id, stepId: 'active-provider', phase: 'implementing', turnId: 'delivery-turn', invocationRunId: 'invocation-one' });
  await first.close();
  const recovered = WorkerSessions(directory, settings, model); await recovered.init(); cleanup(t, () => recovered.close());
  const current = recovered.requests.get(initial.id), executor = recovered.executor;
  assert.equal(current.delivery.status, 'outcome_unknown');
  assert.deepEqual(executor.reservedExecutions, [{ sessionId, projectId: 'project-a', projectLimit: 1 }]);
  assert.equal(executor.busy, true); assert.deepEqual(executor.executions, []);
  assert.equal(executor.canStart(sessionId, { projectId: 'different-project' }), false);
  assert.equal(executor.canStart('same-project', { projectId: 'project-a', projectLimit: 2 }), false);
  assert.equal(executor.canStart('other-project', { projectId: 'project-b' }), true);
  const capacity = workerCapacitySnapshot({ capturedAt: new Date().toISOString(), currentSessionId: null,
    activeSessions: executor.executions, reservedExecutions: executor.reservedExecutions, localUsed: 1,
    settings: settings.value.board, remote: { waiting: 0, running: 0 }, consumption: null });
  assert.equal(capacity.execution.inUse, 1); assert.deepEqual(capacity.execution.sessions, []);
  assert.deepEqual(capacity.execution.unresolved, [{ sessionId, projectId: 'project-a' }]);
  const release = await executor.acquire('other-project', new AbortController().signal, { projectId: 'project-b' });
  assert.equal(executor.canStart('third-project', { projectId: 'project-c' }), false); release();
  const abort = new AbortController(); cleanup(t, () => abort.abort());
  await assert.rejects(executor.run('readiness-review', abort.signal, async () => { auxiliaryCalls++; }), /Reconcile the unresolved/);
  assert.equal(auxiliaryCalls, 0); assert.equal(executor.waiting, 0); assert.equal(providerCalls, 0);
  const command = { action: /** @type {const} */ ('confirm_stopped'), operationId: 'inspected-stopped', requestId: current.id,
    expectedRevision: current.revision, inputRevision: current.inputRevision, deliveryRunId: current.delivery.id,
    note: 'Inspected the original owned processes and confirmed that they have stopped.' };
  assert.throws(() => recovered.requests.command(command), /Inspect the inactive owned worktree/);
  const stopped = recovered.requests.command(command, { requestRevision: current.revision, inputRevision: current.inputRevision,
    deliveryRunId: current.delivery.id, candidateDigest: 'a'.repeat(64), observedAt: new Date().toISOString() }).request;
  assert.equal(stopped.delivery.status, 'interrupted'); assert.equal(stopped.delivery.steps[0].status, 'interrupted');
  assert.deepEqual(executor.reservedExecutions, []); executor.wake(); assert.equal(auxiliaryCalls, 0);
  await executor.run('readiness-review', abort.signal, async () => { auxiliaryCalls++; });
  assert.equal(auxiliaryCalls, 1); assert.equal(providerCalls, 0);
  assert.equal(recovered.requests.get(initial.id).delivery.status, 'interrupted', 'Reconciliation never resumes implementation implicitly.');
});
