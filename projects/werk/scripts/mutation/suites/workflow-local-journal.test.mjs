import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLocalMergeCommand, requestLocalMergeUpdate } from '../../../.mutation-build/worker/infrastructure/journal/requests/local-merge.js';
import { localRequest, localCommand, preparation } from './workflow-local-fixture.mjs';
function fixture() {
  const request = localRequest(), events = [];
  const store = /** @type {import('../../../src/worker/infrastructure/journal/requests/store.ts').RequestStore} */ (/** @type {unknown} */ ({ save(_request, event) { events.push(event); } }));
  const command = localCommand(request); requestLocalMergeCommand(store, request, command);
  const prepared = value => requestLocalMergeUpdate(store, request, { action: 'local_merge_prepared', deliveryRunId: request.delivery.id, operationId: 'local-one', preparation: value });
  const receipt = { ...preparation, branch: 'main', previousHead: '1'.repeat(40), candidateCommit: request.delivery.review.candidate.candidateCommit, mergedAt: request.createdAt };
  const result = value => requestLocalMergeUpdate(store, request, { action: 'local_merge_result', deliveryRunId: request.delivery.id, operationId: 'local-one', result: value });
  return { request, store, command, events, prepared, receipt, result };
}

test('local journal independently rejects unsafe approval identities and exact history limits', () => {
  const initial = fixture(); assert.deepEqual(initial.events, ['local_merge_requested']); assert.equal(initial.request.delivery.localMerge.operations.length, 1);
  for (const change of [{ deliveryRunId: 'wrong' }, { inputRevision: 2 }, { candidateCommit: 'f'.repeat(40) }, { candidateDigest: 'f'.repeat(64) }]) { const h = fixture(); assert.throws(() => requestLocalMergeCommand(h.store, localRequest(), { ...h.command, ...change }), { code: 'conflict' }); }
  for (const change of [{ mainCheckout: 'relative' }, { mainCheckout: '/bad\npath' }, { mainBranch: '@' }, { mainBranch: 'branch..bad' }, { mainBranch: 'bad.lock' }, { mainHead: 'f'.repeat(39) }, { mainHead: 'g'.repeat(40) }]) { const h = fixture(); assert.throws(() => requestLocalMergeCommand(h.store, localRequest(), { ...h.command, ...change }), { code: 'invalid_input' }); }
  const max = fixture(); max.request.delivery.localMerge.operations = Array.from({ length: 32 }, (_, index) => ({ ...max.request.delivery.localMerge.operations[0], operationId: 'past-' + index, status: 'failed' }));
  assert.throws(() => requestLocalMergeCommand(max.store, max.request, max.command), /bounded/);
  const previous = fixture(); previous.request.delivery.localMerge.operations[0].status = 'unknown'; requestLocalMergeCommand(previous.store, previous.request, localCommand(previous.request, 'reconcile_local_merge')); assert.equal(previous.request.delivery.localMerge.operations[0].status, 'pending');
  const wrong = fixture(); wrong.request.delivery.localMerge.operations[0].candidate = { ...wrong.request.delivery.review.candidate, candidateDigest: 'f'.repeat(64) }; assert.throws(() => requestLocalMergeCommand(wrong.store, wrong.request, localCommand(wrong.request, 'reconcile_local_merge')));
});

test('prepared commit and bounded metadata exceptions are immutable, and uncertain outcomes never carry success receipts', () => {
  for (const value of [{ ...preparation, mergeCommit: 'g'.repeat(40) }, { ...preparation, tree: '' }, { ...preparation, metadataPaths: ['../unsafe'] }, { ...preparation, metadataPaths: Array.from({ length: 513 }, () => 'features/one.md') }]) { const h = fixture(); assert.throws(() => h.prepared(value)); }
  const h = fixture(), value = { ...preparation, metadataPaths: ['features/one.md'] }; h.prepared(value); value.metadataPaths[0] = 'changed'; assert.deepEqual(h.request.delivery.localMerge.operations[0].preparation.metadataPaths, ['features/one.md']);
  assert.throws(() => h.prepared({ ...preparation, tree: 'f'.repeat(40) }), /immutable/);
  for (const status of ['failed', 'unknown', 'not_observed']) { const next = fixture(); assert.throws(() => next.result({ status, detail: 'Unconfirmed cannot carry receipt.', receipt: next.receipt })); }
  for (const detail of ['', ' ', 'x'.repeat(4001)]) { const next = fixture(); assert.throws(() => next.result({ status: 'unknown', detail })); }
  const known = fixture(); known.prepared(preparation); known.result({ status: 'confirmed', detail: 'Known exact main checkout.', receipt: known.receipt }); assert.throws(() => known.prepared(preparation));
});
