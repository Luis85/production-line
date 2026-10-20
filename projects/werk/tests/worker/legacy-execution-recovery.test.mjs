import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { ProviderModelError } from '../../src/worker/dist/worker/application/model-contract.js';
import { WorkerSessions, LocalTaskboard } from './application-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';
async function until(predicate) { for (let i = 0; i < 500; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Execution did not settle.'); }
/** @param {import('node:test').TestContext} t
 * @param {'outcome_unknown'|'process_stop_unconfirmed'} reason */
async function fixture(t, reason) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-legacy-unknown-')), repository = join(directory, 'project'); await mkdir(repository);
  const settings = new WorkerSettings(directory); await settings.init(); let calls = 0;
  const model = () => ({ async reply() { calls++; throw new ProviderModelError(reason); } });
  const sessions = WorkerSessions(directory, settings, model); await sessions.init();
  const board = LocalTaskboard(directory, settings, sessions, model); await board.init();
  cleanup(t, async () => { await board.close(); await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  return { sessions, board, repository, get calls() { return calls; } };
}
/** @param {import('../../src/worker/application/journal-ports.ts').RunJournal} journal */
function confirm(journal) {
  const run = journal.uncertainExecutions()[0]; assert.ok(run);
  const command = { runId: run.id, expectedRevision: run.executionRecovery.revision, operationId: 'legacy-inspection', note: 'Inspected the old provider execution and confirmed cessation.' };
  journal.confirmExecutionStopped(command, { runId: run.id, sessionId: run.sessionId, expectedRevision: command.expectedRevision,
    controllerAbsent: true, ownedProcessesAbsent: true, managedServicesAbsent: true, observedAt: new Date().toISOString() });
}
/** @type {Array<'outcome_unknown'|'process_stop_unconfirmed'>} */
const reasons = ['outcome_unknown', 'process_stop_unconfirmed'];
for (const reason of reasons) test(`legacy chat ${reason} retains central capacity and requires explicit continuation after confirmation`, async t => {
  const f = await fixture(t, reason); await f.sessions.start('Describe the project implementation plan.'); await until(() => !f.sessions.chat.snapshot().busy);
  assert.equal(f.calls, 1); assert.equal(f.sessions.executor.reservedExecutions.length, 1); assert.equal(f.sessions.executor.executions.length, 0);
  const original = f.sessions.runs.uncertainExecutions()[0]; assert.equal(original.executionRecovery.reason, reason); assert.equal(original.outcome, 'failed');
  await assert.rejects(f.sessions.start('Explicit retry before confirmation must be refused.'), /Reconcile/);
  assert.equal(f.calls, 1); confirm(f.sessions.runs); f.sessions.executor.wake(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls, 1); assert.equal(f.sessions.executor.waiting, 0);
  await f.sessions.start('Continue after the explicit inspection.'); await until(() => !f.sessions.chat.snapshot().busy);
  assert.equal(f.calls, 2); assert.notEqual(f.sessions.runs.uncertainExecutions()[0].id, original.id);
});
test('legacy approved-file proposal unknown outcome cannot silently queue a retry before reconciliation', async t => {
  const f = await fixture(t, 'outcome_unknown');
  await f.board.create({ title: 'Legacy proposal', instruction: 'Update the approved file.', repository: f.repository, paths: ['value.txt'] });
  const task = f.board.view().tasks[0];
  const settled = () => f.board.detail(task.id).status === 'failed' && !f.sessions.executor.has(task.sessionId) && !!f.sessions.runs.latest(task.sessionId)?.after;
  await f.board.tick(); await until(settled);
  assert.equal(f.calls, 1); assert.equal(f.sessions.runs.uncertainExecutions().length, 1);
  await assert.rejects(f.board.action({ id: task.id, action: 'retry' }), /Reconcile/);
  confirm(f.sessions.runs); await f.board.tick(); assert.equal(f.calls, 1);
  await f.board.action({ id: task.id, action: 'retry' }); await f.board.tick(); await until(() => f.calls === 2 && settled());
});
test('legacy unknown receipt persistence failure retains live permit and unfinished evidence', async t => {
  const f = await fixture(t, 'process_stop_unconfirmed');
  f.sessions.runs.reserveUnknown = () => { throw Error('Fixture evidence storage failure.'); };
  await f.sessions.start('Describe the approved plan.'); await until(() => !f.sessions.chat.snapshot().busy);
  assert.equal(f.sessions.executor.has(f.sessions.current.id), true); assert.equal(f.sessions.chat.snapshot().persistenceError, true);
  const run = f.sessions.runs.list().rows[0]; assert.equal(run.after, null); assert.equal(run.outcome, 'running'); assert.equal(f.calls, 1);
});
