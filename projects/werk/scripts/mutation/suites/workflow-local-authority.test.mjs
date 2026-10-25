import test from 'node:test';
import assert from 'node:assert/strict';
import { localMergeSubject, localMergeView } from '../../../.mutation-build/worker/application/local-merge-view.js';
import { localMergePending } from '../../../.mutation-build/worker/application/local-merge-contracts.js';
import { localMergeBaselineHold } from '../../../.mutation-build/worker/application/local-merge-baseline.js';
import { deliveryCompletion, deliveryCompletionPending, localMergeUnsettled, localMergeRetentionReason } from '../../../.mutation-build/worker/application/delivery-completion.js';
import { validateDeliveryProjectPolicy, defaultDeliveryProjectPolicy } from '../../../.mutation-build/worker/application/delivery-policy.js';
import { localRequest } from './workflow-local-fixture.mjs';
const target = { repositoryId: 'repo-one', checkoutPath: '/assigned/project', branch: 'main', head: '1'.repeat(40) };
function state(status) { return /** @type {import('../../../src/worker/application/local-merge-contracts.ts').LocalMergeState} */ (/** @type {unknown} */ ({ operations: [{ operationId: 'local-one', status, detail: 'Retained operation.' }] })); }

test('main checkout merge is a strict explicit accepted-policy choice and every candidate identity is current', () => {
  const original = localRequest(); assert.equal(localMergeSubject(original).repositoryId, 'repo-one'); assert.deepEqual(localMergeSubject(original).candidate, original.delivery.review.candidate);
  assert.equal(Object.hasOwn(defaultDeliveryProjectPolicy(), 'localMerge'), false);
  for (const flag of /** @type {const} */ ([false, 'absent'])) { const legacy = localRequest(flag); assert.throws(() => localMergeSubject(legacy), /disabled/); assert.equal(localMergeView(legacy, target).canMerge, false); }
  assert.throws(() => localMergeSubject(localRequest(true, true)), /configured GitHub release/);
  for (const flag of [true, false]) assert.equal(validateDeliveryProjectPolicy({ ...defaultDeliveryProjectPolicy(), localMerge: flag }).localMerge, flag);
  for (const flag of [null, 0, 1, 'true', [], {}]) assert.throws(() => validateDeliveryProjectPolicy({ ...defaultDeliveryProjectPolicy(), localMerge: flag }));
  for (const mutate of [value => { delete value.input.context; }, value => { value.input.context.repositoryId = 42; }, value => { delete value.owner.taskId; }, value => { delete value.delivery; }, value => { delete value.delivery.review; },
    value => { value.delivery.review.candidate.requestId = 'different'; }, value => { value.delivery.review.candidate.runId = 'different'; }, value => { value.delivery.review.candidate.inputRevision++; }, value => { value.delivery.review.candidate.inputHash = 'bad'; }, value => { value.delivery.review.candidate.policyDigest = 'bad'; }, value => { value.delivery.inputRevision++; }, value => { value.delivery.inputHash = 'bad'; }, value => { value.delivery.policyDigest = 'bad'; },
    value => { delete value.input.context.deliveryPolicy; }, value => { value.input.context.deliveryPolicy.configuration.localMerge = false; }, value => { delete value.input.context.deliveryPolicy.configuration.localMerge; },
  ]) { const changed = localRequest(); mutate(changed); assert.throws(() => localMergeSubject(changed)); assert.equal(localMergeView(changed, target).canMerge, false); }
});

test('local merge view separates approval, busy/pending state, recovery and immutable evidence', () => {
  const request = localRequest(); assert.equal(localMergeView(request, target).configured, true); assert.equal(localMergeView(request, target).canMerge, true); assert.equal(localMergeView(request, target).canReconcile, false);
  for (const mutate of [value => { value.attestation = null; }, value => { value.phase = 'review'; }, value => { value.deliveryHolds = [{ code: 'source', reason: 'Changed' }]; }, value => { value.delivery.holds = [{ code: 'source', reason: 'Changed' }]; }]) {
    const changed = localRequest(); mutate(changed); assert.equal(localMergeView(changed, target).canMerge, false);
  }
  assert.equal(localMergeView(request, null).canMerge, false); assert.equal(localMergeView(request, target, 'Approval revoked').canMerge, false); assert.equal(localMergeView(request, target, null, true).canMerge, false);
  for (const status of ['pending', 'unknown', 'failed', 'not_observed', 'confirmed']) {
    request.delivery.localMerge = state(status); assert.equal(localMergePending(request.delivery.localMerge), ['pending', 'unknown'].includes(status));
    const view = localMergeView(request, target); assert.equal(view.canMerge, !['pending', 'unknown'].includes(status)); assert.equal(view.canReconcile, ['pending', 'unknown'].includes(status));
    assert.equal(localMergeView(request, target, null, true).canReconcile, false); assert.equal(localMergeView(request, null).canReconcile, false);
  }
  request.delivery.localMerge = /** @type {any} */ ({ operations: [], merged: { mergeCommit: 'b'.repeat(40) } }); assert.equal(localMergeView(request, target).canMerge, false);
  request.delivery.localMerge = state('unknown'); request.attestation = null; assert.equal(localMergeView(request, target, 'Dirty checkout').canReconcile, true);
  const view = localMergeView(request, target); view.state.operations[0].detail = 'Changed copy'; view.candidate.candidateCommit = 'changed'; view.target.head = 'changed';
  assert.equal(request.delivery.localMerge.operations[0].detail, 'Retained operation.'); assert.equal(request.delivery.review.candidate.candidateCommit, '2'.repeat(40)); assert.equal(target.head, '1'.repeat(40));
});

test('accepted policy completion preserves legacy defaults, requires local receipt and gives release target precedence', () => {
  const request = localRequest(); assert.equal(deliveryCompletion(request), 'local_merge'); assert.equal(deliveryCompletionPending(request), true); assert.equal(localMergeUnsettled(request), true);
  request.phase = 'review'; assert.equal(localMergeUnsettled(request), false); assert.equal(localMergeRetentionReason(request), null); request.delivery.localMerge = state('unknown'); assert.equal(localMergeUnsettled(request), true); assert.match(localMergeRetentionReason(request), /Finish or reconcile/);
  request.delivery.localMerge = /** @type {any} */ ({ operations: [], merged: { mergeCommit: 'b'.repeat(40) } }); assert.equal(deliveryCompletionPending(request), false); assert.equal(localMergeUnsettled(request), false); assert.match(localMergeRetentionReason(request), /Confirmed main checkout merge history/);
  request.input.context = {}; assert.equal(deliveryCompletion(request), undefined); assert.equal(deliveryCompletionPending(request), false);
  for (const flag of [false, undefined]) { const value = localRequest(); value.input.context = { deliveryPolicy: { configuration: { localMerge: flag } } }; assert.equal(deliveryCompletion(value), undefined); }
  const release = localRequest(); release.input.context = { deliveryPolicy: { configuration: { localMerge: true, release: {} } } }; assert.equal(deliveryCompletion(release), 'release'); assert.equal(deliveryCompletionPending(release), true);
  release.delivery.release = /** @type {any} */ ({ operations: [], published: { tag: 'v1.0.0' } }); assert.equal(deliveryCompletionPending(release), false);
  assert.equal(localMergePending(undefined), false); assert.equal(localMergePending({ operations: [] }), false);
});

test('every local merge history must be in the next project baseline, with no inferred publication or hidden lookup failures', async () => {
  const first = localRequest(), second = localRequest(), other = localRequest(), calls = [];
  first.delivery.localMerge = /** @type {any} */ ({ operations: [], merged: { mergeCommit: 'a'.repeat(40) } });
  second.delivery.localMerge = /** @type {any} */ ({ operations: [], merged: { mergeCommit: 'b'.repeat(40) } });
  other.input.context = { repositoryId: 'other-project' }; other.delivery.localMerge = state('unknown');
  const contains = async (commit, baseline) => { calls.push([commit, baseline]); return true; };
  assert.equal(await localMergeBaselineHold([first, second, first, other], 'repo-one', 'c'.repeat(40), contains), null); assert.deepEqual(calls, [['a'.repeat(40), 'c'.repeat(40)], ['b'.repeat(40), 'c'.repeat(40)]]);
  assert.match(await localMergeBaselineHold([first, second], 'repo-one', 'c'.repeat(40), async commit => commit === 'a'.repeat(40)), /Publish or synchronize/);
  for (const status of ['unknown', 'pending']) { const pending = localRequest(); pending.delivery.localMerge = state(status); const events = []; assert.match(await localMergeBaselineHold([first, pending], 'repo-one', 'c'.repeat(40), async () => { events.push('lookup'); return true; }), /Reconcile/); assert.deepEqual(events, []); }
  for (const status of ['failed', 'not_observed', 'confirmed']) { const settled = localRequest(); settled.delivery.localMerge = state(status); assert.equal(await localMergeBaselineHold([settled], 'repo-one', 'c'.repeat(40), contains), null); }
  await assert.rejects(localMergeBaselineHold([first], 'repo-one', 'c'.repeat(40), async () => { throw Error('Ancestry unavailable'); }), /Ancestry unavailable/);
});
