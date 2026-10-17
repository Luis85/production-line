import { testErrorCode, testErrorMessage } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { OrchestratorApplication } from '../../../src/orchestrator/dist/orchestrator/application.js';
import { validateRequestGateEvidence } from '../../../src/orchestrator/dist/shared/request-gate.js';
import { SnapshotJournal } from '../../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
const receipt = (stage = 'done', status = 'blocked') => validateRequestGateEvidence({ schemaVersion: 1, requestId: 'request', revision: 2, inputDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), evaluationId: 'evaluation', stage, status, failedRules: status === 'blocked' ? 1 : 0, unknownRules: 0 });
function fixture(t, mode, gate) {
  const store = new Store(':memory:'), profile = /** @type {import('../../../src/orchestrator/dist/shared/contracts.js').Profile} */ ({ id: 'codex', provider: 'codex', mode }), registration = store.register('demo', [profile]), worker = store.worker(registration.token);
  store.submit({ project: 'demo', title: 'Review gates', criteria: ['Respect completion evidence'], provider: 'codex', executionMode: mode }, 'task');
  const task = store.claim(worker, 'claim');
  const journal = new SnapshotJournal('/tmp', worker.config.configHash, 'fixture'); t.after(() => { journal.close(); store.close(); });
  const status = { lastContact: null, heartbeatErrors: 0 }, before = journal.capture(task, worker.id, profile, status, 'before'); store.snapshot(worker, before);
  const after = journal.capture(task, worker.id, profile, status, 'after', before, mode === 'cli' ? 'change-set' : 'simulated');
  if (mode === 'cli') after.review = { baseCommit: 'c'.repeat(40), patchSha256: 'd'.repeat(64), patchBytes: 32, artifactPath: `review/${task.lease}/change.patch` };
  if (gate) after.requestGate = gate;
  store.snapshot(worker, after);
  return { store, worker, task, operations: new OrchestratorApplication(store, 'demo').worker(registration.token) };
}
for (const mode of ['mock', 'cli']) for (const [stage, status] of [['ready', 'blocked'], ['ready', 'passed'], ['done', 'blocked']]) test(`${mode} completion cannot bypass ${stage}/${status} gate evidence`, t => {
  const f = fixture(t, mode, receipt(stage, status));
  assert.throws(() => f.operations.execute('complete', f.task.id, { lease: f.task.lease, attempt: f.task.attempt }), error => testErrorCode(error) === 'conflict' && /completion gate/.test(testErrorMessage(error)));
  assert.equal(f.store.get(f.task.id).status, 'running');
  assert.equal(f.store.events(f.task.id).some(event => ['simulation_finished', 'review_ready'].includes(event.kind)), false);
  if (status === 'blocked') assert.equal(f.store.hold(f.worker, f.task.id, f.task.lease, f.task.attempt, receipt(stage, status)).status, 'blocked');
});
for (const gate of [undefined, receipt('done', 'passed')]) test(`completion preserves ${gate ? 'passed completion gate' : 'legacy ungated'} compatibility and replay`, t => {
  const f = fixture(t, 'mock', gate);
  assert.equal(f.store.finish(f.worker, f.task.id, f.task.lease, f.task.attempt).status, 'simulated');
  assert.equal(f.store.finish(f.worker, f.task.id, f.task.lease, f.task.attempt).status, 'simulated');
  assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'simulation_finished').length, 1);
});
test('gate enums reject coerced containers before terminal evidence is persisted', () => {
  for (const key of ['stage', 'status']) for (const value of [['done'], ['blocked'], { toString: () => key === 'stage' ? 'done' : 'blocked' }, null, 1]) assert.throws(() => validateRequestGateEvidence({ ...receipt(), [key]: value }), error => testErrorCode(error) === 'invalid_input');
});
