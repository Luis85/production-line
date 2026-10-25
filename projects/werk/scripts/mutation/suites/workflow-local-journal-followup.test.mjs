import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLocalMergeCommand, requestLocalMergeUpdate } from '../../../.mutation-build/worker/infrastructure/journal/requests/local-merge.js';
import { localRequest, localCommand, preparation } from './workflow-local-fixture.mjs';

function fixture(approved = true) {
  const request = localRequest(), events = [];
  const store = /** @type {import('../../../src/worker/infrastructure/journal/requests/store.ts').RequestStore} */ (/** @type {unknown} */ ({ save(_request, event) { events.push(event); } }));
  const command = localCommand(request);
  if (approved) requestLocalMergeCommand(store, request, command);
  const update = value => requestLocalMergeUpdate(store, request, value);
  const prepared = value => update({ action: 'local_merge_prepared', deliveryRunId: request.delivery.id, operationId: command.operationId, preparation: value });
  const receipt = { ...preparation, branch: command.mainBranch, previousHead: command.mainHead, candidateCommit: command.candidateCommit, mergedAt: '2026-10-25T00:00:00.000Z' };
  const result = value => update({ action: 'local_merge_result', deliveryRunId: request.delivery.id, operationId: command.operationId, result: value });
  return { request, store, command, events, update, prepared, receipt, result };
}
/** Refusals must have a typed reason and a useful operator explanation, rather than an incidental runtime error. */
function rejects(operation, code = 'conflict') {
  assert.throws(operation, error => error instanceof Error && 'code' in error && error.code === code && error.message.trim().length > 0);
}

for (const [name, changes] of /** @type {[string, Record<string, string>[]][]} */ ([
  ['portable absolute destinations', [{ mainCheckout: '/' + 'p'.repeat(4095) }, { mainCheckout: 'C:/project' }, { mainCheckout: 'C:\\project' }, { mainCheckout: '\\\\server\\project' }]],
  ['complete SHA-1 and SHA-256 heads', [{ mainHead: '1'.repeat(40) }, { mainHead: 'a'.repeat(64) }]],
  ['ordinary nested branches and the inclusive branch-name bound', [{ mainBranch: 'release/main' }, { mainBranch: 'release/v1.2' }, { mainBranch: 'a'.repeat(200) }]],
])) test('approval accepts ' + name + ' and retains its exact reviewed destination', () => {
  for (const change of changes) {
    const h = fixture(false), command = { ...h.command, ...change };
    requestLocalMergeCommand(h.store, h.request, command);
    const operation = h.request.delivery.localMerge.operations[0];
    assert.equal(operation.checkoutPath, command.mainCheckout); assert.equal(operation.mainBranch, command.mainBranch); assert.equal(operation.mainHead, command.mainHead);
    assert.ok(operation.detail.trim()); assert.equal(operation.repositoryId, 'repo-one'); assert.equal(operation.operationId, command.operationId); assert.equal(operation.status, 'pending');
    assert.deepEqual(operation.candidate, h.request.delivery.review.candidate);
    assert.deepEqual(h.events, ['local_merge_requested']);
  }
});

test('approval independently rejects malformed branch components, anchored object IDs and bounded absolute paths', () => {
  const changes = [
    ...['', 'a'.repeat(201), 'team/.private', 'team/protected.lock', 'team//main', 'team/main.', '-main', 'bad branch', 'bad\\branch', 'refs@{bad}'].map(mainBranch => ({ mainBranch })),
    ...['prefix' + 'a'.repeat(40), 'a'.repeat(40) + 'suffix', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'].map(mainHead => ({ mainHead })),
    ...['/' + 'p'.repeat(4096), 'relative/project', '9:/project', 'C:|project', 'C:project', '/private\tpath', '/private\u007fpath'].map(mainCheckout => ({ mainCheckout })),
    { mainBranch: null }, { mainBranch: 1 }, { mainHead: null }, { mainHead: 1 }, { mainCheckout: null }, { mainCheckout: 1 },
  ];
  for (const change of changes) {
    const h = fixture(false); rejects(() => requestLocalMergeCommand(h.store, h.request, /** @type {import('../../../src/worker/application/request-gates.ts').RequestCommand} */ (/** @type {unknown} */ ({ ...h.command, ...change }))), 'invalid_input');
    assert.deepEqual(h.events, []); assert.equal(h.request.delivery.localMerge.operations.length, 0);
  }
});

test('the last available history slot works, while a full history preserves all previous operations', () => {
  const h = fixture(), original = structuredClone(h.request.delivery.localMerge.operations[0]);
  h.request.delivery.localMerge.operations = Array.from({ length: 31 }, (_, index) => ({ ...structuredClone(original), operationId: 'previous-' + index, status: 'failed' }));
  requestLocalMergeCommand(h.store, h.request, h.command); assert.equal(h.request.delivery.localMerge.operations.length, 32);
  const retained = structuredClone(h.request.delivery.localMerge.operations); h.request.delivery.localMerge.operations.at(-1).status = 'failed'; retained.at(-1).status = 'failed';
  rejects(() => requestLocalMergeCommand(h.store, h.request, { ...h.command, operationId: 'one-too-many' }));
  assert.deepEqual(h.request.delivery.localMerge.operations, retained);
});

test('reconciliation only reopens the named unresolved operation of the same candidate', () => {
  for (const status of /** @type {const} */ (['pending', 'unknown'])) {
    const h = fixture(); h.request.delivery.localMerge.operations[0].status = status;
    const before = structuredClone(h.request.delivery.localMerge.operations[0]);
    requestLocalMergeCommand(h.store, h.request, localCommand(h.request, 'reconcile_local_merge'));
    const saved = h.request.delivery.localMerge.operations[0];
    assert.ok(saved.detail.trim()); assert.equal(saved.status, 'pending'); assert.deepEqual(saved.candidate, before.candidate); assert.equal(saved.checkoutPath, before.checkoutPath); assert.equal(saved.mainHead, before.mainHead);
    assert.equal(h.events.at(-1), 'local_merge_reconciliation_requested');
  }
  for (const status of /** @type {const} */ (['confirmed', 'failed', 'not_observed'])) {
    const h = fixture(); h.request.delivery.localMerge.operations[0].status = status; const before = structuredClone(h.request);
    rejects(() => requestLocalMergeCommand(h.store, h.request, localCommand(h.request, 'reconcile_local_merge'))); assert.deepEqual(h.request, before);
  }
  for (const operationId of ['absent-operation', '', null]) {
    const h = fixture(); rejects(() => requestLocalMergeCommand(h.store, h.request, { ...localCommand(h.request, 'reconcile_local_merge'), localMergeOperationId: operationId }), operationId ? 'conflict' : 'invalid_input');
  }
});

test('updates require the retained run, state and operation before either preparation or result can mutate it', () => {
  for (const action of ['local_merge_prepared', 'local_merge_result']) for (const kind of ['missing-run', 'wrong-run', 'missing-state', 'missing-operation']) {
    const h = fixture();
    const update = { action, deliveryRunId: h.request.delivery.id, operationId: h.command.operationId, preparation, result: { status: 'unknown', detail: 'Observe retained checkout.' } };
    if (kind === 'missing-run') delete h.request.delivery;
    if (kind === 'wrong-run') update.deliveryRunId = 'another-run';
    if (kind === 'missing-state') delete h.request.delivery.localMerge;
    if (kind === 'missing-operation') update.operationId = 'another-operation';
    const before = structuredClone(h.request); rejects(() => h.update(update)); assert.deepEqual(h.request, before); assert.equal(h.events.length, 1);
  }
});

test('preparations accept both complete object formats and the inclusive metadata inventory bound', () => {
  const empty = fixture(); empty.prepared({ ...preparation, metadataPaths: [] }); assert.deepEqual(empty.request.delivery.localMerge.operations[0].preparation.metadataPaths, []);
  for (const length of [40, 64]) {
    const h = fixture(), value = { mergeCommit: 'b'.repeat(length), tree: 'c'.repeat(length), metadataPaths: Array.from({ length: 512 }, (_, index) => 'features/request-' + index + '.md') };
    h.prepared(value); assert.deepEqual(h.request.delivery.localMerge.operations[0].preparation, value);
    h.prepared(structuredClone(value)); assert.equal(h.events.at(-1), 'local_merge_prepared');
    value.metadataPaths[0] = 'external-mutation.md'; assert.equal(h.request.delivery.localMerge.operations[0].preparation.metadataPaths[0], 'features/request-0.md');
  }
});

test('preparation rejects malformed inventories and mixed safe/unsafe paths without replacing saved authority', () => {
  const values = [
    ...[null, 'features/one.md', 1, ['features/safe.md', '../unsafe'], ['features/safe.md', '/absolute'], ['features/safe.md', 'bad\\path']].map(metadataPaths => ({ ...preparation, metadataPaths })),
    { ...preparation, mergeCommit: 'prefix' + preparation.mergeCommit }, { ...preparation, tree: preparation.tree + 'suffix' },
  ];
  for (const value of values) { const h = fixture(); assert.throws(() => h.prepared(value), error => error instanceof Error && !!error.message.trim()); assert.equal(h.request.delivery.localMerge.operations[0].preparation, undefined); }
  for (const change of [{ metadataPaths: ['features/other.md'] }, { mergeCommit: 'e'.repeat(40) }, { tree: 'd'.repeat(40) }]) {
    const h = fixture(), value = { ...preparation, metadataPaths: ['features/one.md'] }; h.prepared(value);
    rejects(() => h.prepared({ ...value, ...change })); assert.deepEqual(h.request.delivery.localMerge.operations[0].preparation, value);
  }
  for (const status of /** @type {const} */ (['confirmed', 'failed', 'not_observed'])) { const h = fixture(); h.request.delivery.localMerge.operations[0].status = status; rejects(() => h.prepared(preparation)); }
});

test('bounded outcome details and every unconfirmed status are retained without inventing a successful receipt', () => {
  for (const status of ['unknown', 'not_observed', 'failed']) {
    const h = fixture(), value = { status, detail: 'x'.repeat(4000) };
    rejects(() => h.result({ ...value, receipt: h.receipt }), 'invalid_input'); h.result(value);
    const saved = h.request.delivery.localMerge.operations[0]; assert.equal(saved.status, status); assert.equal(saved.detail, value.detail); assert.equal(saved.receipt, undefined); assert.equal(h.request.delivery.localMerge.merged, undefined);
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt))); assert.equal(h.events.at(-1), 'local_merge_' + status);
  }
  for (const value of [{ status: 'pending', detail: 'Not an outcome.' }, { status: 'invented', detail: 'Not an outcome.' }, { status: null, detail: 'Not an outcome.' }, { status: 'unknown', detail: null }, { status: 'unknown', detail: 1 }, { status: 'unknown', detail: '' }, { status: 'unknown', detail: '  ' }, { status: 'unknown', detail: 'x'.repeat(4001) }]) {
    const h = fixture(); rejects(() => h.result(value), 'invalid_input'); assert.equal(h.request.delivery.localMerge.operations[0].status, 'pending');
  }
});

test('confirmed receipts retain all prepared authority and settled replays cannot rewrite any outcome', () => {
  const h = fixture(); h.prepared(preparation);
  const value = { status: 'confirmed', detail: 'Confirmed the exact approved checkout.', receipt: structuredClone(h.receipt) }; h.result(value);
  const saved = structuredClone(h.request), count = h.events.length;
  assert.deepEqual(h.request.delivery.localMerge.merged, h.receipt); assert.deepEqual(h.request.delivery.localMerge.operations[0].receipt, h.receipt);
  assert.equal(h.request.delivery.localMerge.operations[0].status, 'confirmed'); assert.equal(h.request.delivery.localMerge.operations[0].detail, value.detail);
  assert.equal(h.result(structuredClone(value)), h.request); assert.deepEqual(h.request, saved); assert.equal(h.events.length, count);
  for (const change of [{ status: 'unknown' }, { detail: 'Different outcome.' }, { receipt: { ...h.receipt, mergeCommit: 'd'.repeat(40) } }]) { rejects(() => h.result({ ...value, ...change })); assert.deepEqual(h.request, saved); }
  value.receipt.branch = 'external-mutation'; assert.equal(h.request.delivery.localMerge.merged.branch, 'main'); assert.equal(h.request.delivery.localMerge.operations[0].receipt.branch, 'main');
});
