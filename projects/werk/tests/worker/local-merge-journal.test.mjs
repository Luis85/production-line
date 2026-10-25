import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { localMergeSubject, localMergeView } from '../../src/worker/dist/worker/application/local-merge-view.js';
import { deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { fixture } from './request-gate-fixtures.mjs';
import { readyPublication } from './remote-delivery-fixtures.mjs';
import { acceptRelease } from './release-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import { WorkerConversation } from '../../src/worker/dist/worker/application/conversation.js';
import { sessionAction } from '../../src/worker/dist/worker/application/session-actions.js';

function ready(journal, required = true) {
  const proxy = new Proxy(journal, { get(target, key) {
    if (key !== 'ensure') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; }
    return input => { const context = input.input.context, configuration = context.deliveryPolicy.configuration; delete configuration.remoteDelivery; if (required) configuration.localMerge = true; context.deliveryPolicy = deliveryPolicySnapshot(configuration, context.deliveryPolicy.baseline); return target.ensure(input); };
  } });
  return readyPublication(proxy);
}
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request
 * @param {'merge_local_candidate'|'reconcile_local_merge'} [action]
 * @returns {import('../../src/worker/application/request-gates.ts').RequestCommand} */
function command(request, action = 'merge_local_candidate', operationId = 'merge-local-one') {
  const candidate = request.delivery.review.candidate;
  return { action, requestId: request.id, expectedRevision: request.revision, operationId, deliveryRunId: candidate.runId, inputRevision: request.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest,
    ...(action === 'merge_local_candidate' ? { mainCheckout: '/assigned/project', mainBranch: 'main', mainHead: '1'.repeat(40) } : { localMergeOperationId: 'merge-local-one' }) };
}
const preparation = { mergeCommit: 'b'.repeat(40), tree: 'c'.repeat(40) };
function prepared(journal, request, operationId = 'merge-local-one') { return journal.deliveryUpdate(request.id, { action: 'local_merge_prepared', deliveryRunId: request.delivery.id, operationId, preparation }); }
function receipt(request) { return { ...preparation, branch: 'main', previousHead: '1'.repeat(40), candidateCommit: request.delivery.review.candidate.candidateCommit, mergedAt: '2026-10-25T00:00:00.000Z' }; }
function outcome(journal, request, result) { return journal.deliveryUpdate(request.id, { action: 'local_merge_result', deliveryRunId: request.delivery.id, operationId: 'merge-local-one', result }); }

test('plain Git requires separate exact candidate acceptance and explicit main checkout approval', async t => {
  const { journal } = await fixture(t); let request = ready(journal);
  const target = { repositoryId: 'repo-one', checkoutPath: '/assigned/project', branch: 'main', head: '1'.repeat(40) };
  assert.equal(localMergeView(request, target).canMerge, false); assert.throws(() => journal.command(command(request)), /human acceptance/);
  request = acceptRelease(journal, request); assert.equal(request.phase, 'done'); assert.equal(request.lifecycle, 'in_progress'); assert.equal(localMergeView(request, target).canMerge, true);
  for (const change of [{ mainCheckout: 'relative' }, { mainBranch: '-unsafe' }, { mainHead: 'short' }]) assert.throws(() => journal.command({ ...command(request), ...change }), { code: 'invalid_input' });
  const action = command(request); request = journal.command(action).request; assert.equal(request.delivery.localMerge.operations[0].status, 'pending'); assert.deepEqual(request.delivery.allowedControls, []); assert.equal(request.delivery.localMerge.operations[0].preparation, undefined);
  assert.equal(journal.command(action).duplicate, true); assert.throws(() => journal.command({ ...action, mainHead: '9'.repeat(40) }), /different input/);
  assert.throws(() => journal.command(command(request, 'merge_local_candidate', 'duplicate-merge')), /Reconcile/);
  assert.throws(() => journal.command({ action: 'reopen', requestId: request.id, expectedRevision: request.revision, operationId: 'reopen', deliveryRunId: request.delivery.id, inputRevision: request.inputRevision }), /Reconcile/);
});

test('accepted main checkout merge preparation and confirmed receipt are immutable and only confirmation completes the increment', async t => {
  const { journal } = await fixture(t); let request = acceptRelease(journal, ready(journal)); request = journal.command(command(request)).request;
  assert.throws(() => outcome(journal, request, { status: 'confirmed', detail: 'No prepared commit.', receipt: receipt(request) }), /prepared commit/);
  request = prepared(journal, request); assert.equal(request.lifecycle, 'in_progress');
  assert.throws(() => journal.deliveryUpdate(request.id, { action: 'local_merge_prepared', deliveryRunId: request.delivery.id, operationId: 'merge-local-one', preparation: { ...preparation, mergeCommit: 'd'.repeat(40) } }), /immutable/);
  for (const change of [{ branch: 'other' }, { previousHead: 'd'.repeat(40) }, { candidateCommit: 'd'.repeat(40) }, { mergeCommit: 'd'.repeat(40) }, { tree: 'd'.repeat(40) }, { mergedAt: 'invalid' }]) assert.throws(() => outcome(journal, request, { status: 'confirmed', detail: 'Wrong destination.', receipt: { ...receipt(request), ...change } }), /confirmation/);
  const result = { status: 'confirmed', detail: 'Exact assigned checkout confirmed.', receipt: receipt(request) }; request = outcome(journal, request, result);
  assert.equal(request.lifecycle, 'done'); assert.deepEqual(request.delivery.allowedControls, []); assert.deepEqual(request.delivery.localMerge.merged, result.receipt); assert.deepEqual(outcome(journal, request, result).delivery.localMerge.merged, result.receipt);
  assert.throws(() => outcome(journal, request, { status: 'failed', detail: 'Rewrite settled merge.' }), /immutable/);
  assert.throws(() => journal.command({ action: 'reopen', requestId: request.id, expectedRevision: request.revision, operationId: 'reopen-merged', deliveryRunId: request.delivery.id, inputRevision: request.inputRevision }), /merged/);
});

test('restart retains preparation and uncertain checkout identity, blocking new work and history deletion until read-only reconciliation', async t => {
  const { journal, directory } = await fixture(t); let request = acceptRelease(journal, ready(journal)); request = journal.command(command(request)).request; request = prepared(journal, request);
  journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(t, () => recovered.close()); request = recovered.get(request.id);
  assert.equal(request.delivery.localMerge.operations[0].status, 'unknown'); assert.deepEqual(request.delivery.localMerge.operations[0].preparation, preparation); assert.equal(recovered.hasActiveReview(request.owner.sessionId), true);
  assert.throws(() => recovered.deleteSession(request.owner.sessionId), /main checkout merge/); assert.throws(() => recovered.command(command(request, 'merge_local_candidate', 'retry-without-observation')), /Reconcile/);
  request = recovered.command(command(request, 'reconcile_local_merge', 'observe-after-restart')).request;
  request = outcome(recovered, request, { status: 'confirmed', detail: 'Retained checkout observed.', receipt: receipt(request) }); assert.equal(request.lifecycle, 'done'); assert.equal(request.delivery.localMerge.operations.length, 1);
});

test('all current request/candidate identities independently fence local merge and rejected source holds remove permission', async t => {
  const { journal } = await fixture(t), request = acceptRelease(journal, ready(journal));
  for (const mutate of [value => { value.delivery.review.candidate.requestId = 'other'; }, value => { value.delivery.review.candidate.runId = 'other'; }, value => { value.delivery.review.candidate.inputRevision++; }, value => { value.delivery.review.candidate.inputHash = 'f'.repeat(64); }, value => { value.delivery.review.candidate.policyDigest = 'f'.repeat(64); }, value => { value.delivery.inputRevision++; }, value => { value.delivery.inputHash = 'f'.repeat(64); }, value => { value.delivery.policyDigest = 'f'.repeat(64); }]) { const changed = structuredClone(request); mutate(changed); assert.throws(() => localMergeSubject(changed), /current verified/); }
  const held = journal.deliveryUpdate(request.id, { action: 'hold', code: 'source_missing', reason: 'The canonical source was deleted.' });
  assert.throws(() => journal.command(command(held)), /human acceptance/);
  const legacy = structuredClone(request), context = /** @type {{deliveryPolicy: import('../../src/worker/application/delivery-policy.ts').DeliveryPolicySnapshot}} */ (legacy.input.context); delete context.deliveryPolicy.configuration.localMerge; context.deliveryPolicy = deliveryPolicySnapshot(context.deliveryPolicy.configuration, context.deliveryPolicy.baseline); assert.throws(() => localMergeSubject(legacy), /disabled/); const disabledTarget = { repositoryId: 'repo-one', checkoutPath: '/assigned/project', branch: 'main', head: '1'.repeat(40) }; assert.equal(localMergeView(legacy, disabledTarget).canMerge, false);
  context.deliveryPolicy.configuration.localMerge = false; context.deliveryPolicy = deliveryPolicySnapshot(context.deliveryPolicy.configuration, context.deliveryPolicy.baseline); assert.throws(() => localMergeSubject(legacy), /disabled/);
});


test('confirmed merge evidence survives restart and refuses destructive cleanup before catalog or transcript writes', async t => {
  const { journal, directory } = await fixture(t); let request = acceptRelease(journal, ready(journal)); request = journal.command(command(request)).request; request = prepared(journal, request);
  request = outcome(journal, request, { status: 'confirmed', detail: 'Exact assigned checkout confirmed.', receipt: receipt(request) });
  journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(t, () => recovered.close());
  request = recovered.get(request.id); assert.equal(request.lifecycle, 'done'); assert.equal(recovered.hasActiveReview(request.owner.sessionId), false, 'Retention must not block all later provider settings changes.');
  assert.match(recovered.retainedHistoryReason(request.owner.sessionId), /Confirmed main checkout merge history/);
  assert.throws(() => recovered.deleteSession(request.owner.sessionId), /receipt cannot be deleted/);
  let writes = 0;
  const chat = new WorkerConversation({ async read() { return { messages: [] }; }, async write() { writes++; } }, undefined, undefined, undefined, request.owner.sessionId,
    /** @type {import('../../src/worker/application/conversation-contracts.ts').ConversationEvidence} */ (/** @type {unknown} */ ({ requests: recovered })));
  await assert.rejects(chat.clear(), /receipt cannot be deleted/); assert.equal(writes, 0);
  const catalog = { changing: false, selected: request.owner.sessionId, records: [{ id: request.owner.sessionId, title: 'Merged increment', archived: false }, { id: 'another-session', title: 'Other', archived: false }] };
  const context = /** @type {Parameters<typeof sessionAction>[0]} */ (/** @type {unknown} */ ({ catalog, requests: recovered, instances: new Map(), executor: { has: () => false }, protectedTasks: new Set(), async persist() { writes++; }, view: () => catalog }));
  await assert.rejects(sessionAction(context, { action: 'delete', id: request.owner.sessionId }), /receipt cannot be deleted/); assert.equal(catalog.records.length, 2); assert.equal(catalog.selected, request.owner.sessionId); assert.equal(writes, 0);
  await sessionAction(context, { action: 'archive', id: request.owner.sessionId }); assert.equal(catalog.records[0].archived, true); assert.equal(recovered.get(request.id).delivery.localMerge.merged.mergeCommit, preparation.mergeCommit);
});
