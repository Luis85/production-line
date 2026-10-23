import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { ExecutionRecoveryController } = await frontend('src/worker/webview/execution-recovery-controller.ts');
const at = '2026-10-20T10:00:00.000Z';
const run = () => /** @type {import('../../../src/worker/application/run-evidence').WorkerRun} */ ({ id: 'review-call', sessionId: 'ready-review', executionRecovery: { schemaVersion: 1, revision: 3, state: 'unknown', reason: 'process_stop_unconfirmed', detectedAt: at } });
const access = { unlocked: true, fresh: true, acknowledged: true };
function receipt(command) { const value = run(); value.executionRecovery = { schemaVersion: 1, revision: 4, state: 'operator_confirmed_stopped', reason: 'process_stop_unconfirmed', detectedAt: at, confirmation: { operationId: command.operationId, note: command.note, observedAt: at, confirmedAt: at, basis: 'operator_attested' } }; return { schemaVersion: /** @type {const} */ (1), run: value, duplicate: false }; }
test('an auxiliary recovery requires fresh exact evidence, explicit inspection and a nonempty observation', async () => {
  const calls = [], controller = new ExecutionRecoveryController(async command => { calls.push(command); return receipt(command); }, () => 'operation-1');
  for (const invalid of [{ ...access, fresh: false }, { ...access, acknowledged: false }, { ...access, unlocked: false }]) assert.equal(await controller.confirm(run(), 'Inspected', invalid), null);
  assert.equal(await controller.confirm(run(), '  ', access), null); assert.equal(await controller.confirm(run(), 'x'.repeat(4001), access), null); assert.equal(await controller.confirm(null, 'Inspected', access), null); assert.equal(calls.length, 0);
  const value = await controller.confirm(run(), '  Inspected and stopped provider work.  ', access); assert.equal(value.executionRecovery.state, 'operator_confirmed_stopped');
  assert.deepEqual(calls[0], { action: 'confirm_execution_stopped', runId: 'review-call', expectedRevision: 3, operationId: 'operation-1', note: 'Inspected and stopped provider work.' }); assert.equal(controller.pending, null);
});
test('lost acknowledgement keeps exactly the original confirmation despite changed evidence or drafts', async () => {
  const calls = []; let fail = true, ids = 0;
  const controller = new ExecutionRecoveryController(async command => { calls.push({ ...command }); if (fail) throw Error('Lost acknowledgement'); return { ...receipt(command), duplicate: true }; }, () => 'operation-' + ++ids);
  await assert.rejects(controller.confirm(run(), 'Original inspected stop', access), /Lost acknowledgement/); const saved = { ...controller.pending };
  fail = false; const other = run(); other.id = 'different-run'; other.executionRecovery.revision = 12;
  await controller.confirm(other, 'Different draft', { unlocked: true, fresh: false, acknowledged: false }); assert.deepEqual(calls, [saved, saved]); assert.equal(ids, 1); assert.equal(controller.pending, null);
});
test('unrelated receipts cannot clear pending intent and concurrent sends do not duplicate it', async () => {
  const { promise: sent, resolve: release } = Promise.withResolvers(); let calls = 0;
  const controller = new ExecutionRecoveryController(async command => { calls++; await sent; const value = receipt(command); value.run.id = 'other-run'; return value; }, () => 'operation');
  const attempt = controller.confirm(run(), 'Checked stopped', access); assert.equal(await controller.confirm(run(), 'Checked stopped', access), null); assert.equal(calls, 1); release(undefined);
  await assert.rejects(attempt, /exact recovery operation/); assert.equal(controller.pending.runId, 'review-call'); assert.equal(controller.busy, false);
});
test('locking clears private recovery intent and fences a late acknowledgement', async () => {
  const { promise: sent, resolve: release } = Promise.withResolvers();
  const controller = new ExecutionRecoveryController(async command => { await sent; return receipt(command); }, () => 'operation');
  const attempt = controller.confirm(run(), 'Private observation', access); controller.reset(); release(undefined); assert.equal(await attempt, null); assert.equal(controller.pending, null); assert.equal(controller.busy, false);
});
