import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sharedFeaturePolicy } from '../../../.mutation-build/worker/application/shared-feature-policy.js';
import { sharedLocalMergePhase, localMergeConfigured, sameLocalMerge } from '../../../.mutation-build/worker/application/shared-local-merge-projection.js';
import { localRequest } from './workflow-local-fixture.mjs';
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

function policies() {
  const request = localRequest(), base = structuredClone(request.policy); base.reviewer.provider = 'same';
  const deliveryPolicy = /** @type {{deliveryPolicy: import('../../../src/worker/application/delivery-policy.ts').DeliveryPolicySnapshot}} */ (request.input.context).deliveryPolicy;
  const expected = { ...structuredClone(base), id: 'delivery-feature', version: 1 };
  const additions = [{ id: 'delivery-profile-message', fact: 'input.messageLength', op: 'gte', value: 20 }, { id: 'delivery-profile-criteria', fact: 'input.criteriaCount', op: 'gte', value: 1 }];
  for (const kind of ['chat', 'patch']) expected.ready[kind].push(...structuredClone(additions));
  const record = /** @type {Parameters<typeof sharedFeaturePolicy>[0]} */ (/** @type {unknown} */ ({ workflow: { policy: base, policyDigest: digest(base) }, deliveryPolicy }));
  return { record, expected, base };
}

test('shared Done evidence uses independently expected composed frozen policy and rejects stale serialized execution authority', () => {
  const h = policies(), effective = sharedFeaturePolicy(h.record);
  assert.deepEqual(effective.policy, h.expected); assert.equal(effective.digest, digest(h.expected)); assert.notEqual(effective.digest, h.record.workflow.policyDigest);
  effective.policy.ready.patch[0].value = 99; assert.equal(h.record.workflow.policy.ready.patch.length, 0); assert.equal(h.record.deliveryPolicy.profile.minimumMessageLength, 20);
  const matching = policies(); matching.record.executionPolicy = structuredClone(matching.expected); assert.deepEqual(sharedFeaturePolicy(matching.record).policy, matching.expected);
  const stale = policies(); stale.record.executionPolicy = structuredClone(stale.base); assert.throws(() => sharedFeaturePolicy(stale.record), /frozen shared execution policy/);
  const tampered = policies(); tampered.record.deliveryPolicy.profile.minimumMessageLength = 21; assert.throws(() => sharedFeaturePolicy(tampered.record));
  const legacy = policies(); delete legacy.record.deliveryPolicy; assert.deepEqual(sharedFeaturePolicy(legacy.record), { policy: legacy.base, digest: legacy.record.workflow.policyDigest });
  legacy.record.executionPolicy = structuredClone(legacy.base); assert.deepEqual(sharedFeaturePolicy(legacy.record).policy, legacy.base);
  legacy.record.executionPolicy.version++; assert.throws(() => sharedFeaturePolicy(legacy.record));
});

test('shared local merge phase preserves pre-acceptance work, every hold, operation recovery and actual integration completion', () => {
  assert.equal(localMergeConfigured(null), false); assert.equal(sharedLocalMergePhase(null), null); assert.equal(sharedLocalMergePhase(undefined), null); assert.equal(sameLocalMerge(undefined, { operations: [] }), true);
  assert.equal(localMergeConfigured(localRequest(false)), false); assert.equal(sharedLocalMergePhase(localRequest(false)), null);
  const before = localRequest(); before.phase = 'running'; before.attestation = null; before.delivery.holds = [{ code: 'provider', reason: 'Authentication required' }]; assert.equal(sharedLocalMergePhase(before), null);
  const accepted = localRequest(); assert.equal(sharedLocalMergePhase(accepted), 'accepted'); assert.equal(localMergeConfigured(accepted), true);
  for (const mutate of [value => { value.recoveryHold = { code: 'unknown', at: value.createdAt }; }, value => { value.deliveryHolds = [{ code: 'source', reason: 'Changed' }]; }, value => { value.delivery.holds = [{ code: 'source', reason: 'Changed' }]; }, value => { value.delivery.control = { action: 'cancel', operationId: 'stop', at: value.createdAt }; }]) { const held = localRequest(); mutate(held); assert.equal(sharedLocalMergePhase(held), 'merge_blocked'); }
  for (const [status, phase] of [['pending', 'merging'], ['unknown', 'merge_outcome_unknown'], ['failed', 'merge_failed'], ['not_observed', 'merge_failed']]) {
    const request = localRequest(); request.delivery.localMerge = /** @type {any} */ ({ operations: [{ operationId: 'local-one', status, detail: 'Saved outcome' }] }); assert.equal(sharedLocalMergePhase(request), phase);
  }
  accepted.delivery.localMerge = /** @type {any} */ ({ operations: [], merged: { mergeCommit: 'b'.repeat(40) } }); assert.equal(sharedLocalMergePhase(accepted), 'done');
  assert.equal(sameLocalMerge({ operations: [] }, { operations: [{ operationId: 'local-one', status: 'failed', detail: 'Saved' }] }), false);
});
