import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDeliveryPolicyApprovals, changeDeliveryPolicyApproval, validateDeliveryPolicyApprovals, deliveryPolicyRequiresApproval, deliveryPolicyApproved, assertDeliveryPolicyApproved } from '../../../.mutation-build/worker/application/delivery-policy-approval.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../../.mutation-build/worker/application/delivery-policy.js';
import { defaultDeliveryRetention, validateDeliveryRetention } from '../../../.mutation-build/worker/application/delivery-retention.js';
const at = '2026-10-20T10:00:00.000Z', digest = 'a'.repeat(64), other = 'b'.repeat(64);
const command = (action = 'approve', expectedRevision = 1) => ({ action, repositoryId: 'project-a', configurationDigest: digest, expectedRevision });
const state = () => changeDeliveryPolicyApproval(emptyDeliveryPolicyApprovals(), command(), at);

test('approvals bind exact repository, configuration and revision without mutating callers or granting remote text authority', () => {
  const old = emptyDeliveryPolicyApprovals(); assert.deepEqual(old, { schemaVersion: 1, revision: 1, approvals: [], history: [] });
  const approved = changeDeliveryPolicyApproval(old, command(), at);
  assert.deepEqual(old, emptyDeliveryPolicyApprovals());
  assert.deepEqual(approved, { schemaVersion: 1, revision: 2, approvals: [{ repositoryId: 'project-a', configurationDigest: digest, approvedAt: at }], history: [{ action: 'approve', repositoryId: 'project-a', configurationDigest: digest, at, revision: 2 }] });
  assert.deepEqual(changeDeliveryPolicyApproval(approved, command('approve', 2), at), approved);
  const revoked = changeDeliveryPolicyApproval(approved, command('revoke', 2), at);
  assert.equal(revoked.revision, 3); assert.deepEqual(revoked.approvals, []); assert.deepEqual(revoked.history[1], { action: 'revoke', repositoryId: 'project-a', configurationDigest: digest, at, revision: 3 });
  assert.deepEqual(changeDeliveryPolicyApproval(revoked, command('revoke', 3), at), revoked);
  const second = changeDeliveryPolicyApproval(approved, { ...command('approve', 2), configurationDigest: other }, at);
  assert.equal(second.approvals.length, 2); assert.equal(changeDeliveryPolicyApproval(second, command('revoke', 3), at).approvals[0].configurationDigest, other);
  for (const revision of [1, 3]) assert.throws(() => changeDeliveryPolicyApproval(approved, command('approve', revision), at), /Reload/);
  assert.throws(() => changeDeliveryPolicyApproval(old, command(), 'invalid'), /observation time/);
  const legacy = deliveryPolicySnapshot(defaultDeliveryProjectPolicy(), 'a'.repeat(40));
  assert.equal(deliveryPolicyRequiresApproval(legacy.configuration), false); assert.equal(deliveryPolicyApproved(old, 'unknown', legacy), true);
  const expanded = structuredClone(legacy.configuration); expanded.coordination = { maxActiveRequests: 2, dependencyPlanning: 'topological' };
  const pinned = deliveryPolicySnapshot(expanded, 'a'.repeat(40));
  const exact = changeDeliveryPolicyApproval(old, { ...command(), configurationDigest: pinned.configurationDigest }, at);
  assert.equal(deliveryPolicyRequiresApproval(expanded), true); assert.equal(deliveryPolicyApproved(exact, 'project-a', pinned), true);
  assert.doesNotThrow(() => assertDeliveryPolicyApproved(exact, 'project-a', pinned));
  assert.equal(deliveryPolicyApproved(exact, 'project-b', pinned), false); assert.throws(() => assertDeliveryPolicyApproved(old, 'project-a', pinned), /local operator approval/);
  assert.equal(deliveryPolicyApproved(exact, 'project-a', { ...pinned, configurationDigest: other }), false);
  const quality = structuredClone(legacy.configuration); quality.profiles[0].checkPacks = [];
  assert.equal(deliveryPolicyRequiresApproval(quality), true);
});

test('saved grants and guarded commands reject malformed, duplicate, unordered and excessive authority', () => {
  for (const value of [null, [], false, { ...command(), hidden: true }, { ...command(), action: 'anything' }, { ...command(), repositoryId: '' }, { ...command(), configurationDigest: other.slice(1) }, { ...command(), configurationDigest: 'g'.repeat(64) }]) assert.throws(() => changeDeliveryPolicyApproval(emptyDeliveryPolicyApprovals(), value, at));
  for (const revision of [0, -1, 1.5, '1', NaN, Infinity]) assert.throws(() => changeDeliveryPolicyApproval(emptyDeliveryPolicyApprovals(), { ...command(), expectedRevision: revision }, at));
  assert.equal(changeDeliveryPolicyApproval(emptyDeliveryPolicyApprovals(), command(), at).revision, 2);
  for (const change of [
    value => { value.schemaVersion = 2; }, value => { value.revision = 0; }, value => { value.approvals = null; }, value => { value.history = null; },
    value => { value.approvals[0].approvedAt = 'invalid'; }, value => { value.approvals[0].configurationDigest = 'bad'; },
    value => { value.approvals.push(value.approvals[0]); }, value => { value.history[0].action = 'grant'; },
    value => { value.history[0].at = 'invalid'; }, value => { value.history[0].configurationDigest = ''; },
    value => { value.history[0].revision = value.revision + 1; }, value => { value.history.push(value.history[0]); },
  ]) { const changed = structuredClone(state()); change(changed); assert.throws(() => validateDeliveryPolicyApprovals(changed)); }
  /** @type {import('../../../src/worker/application/delivery-policy-approval.js').DeliveryPolicyApprovalState} */
  const full = { schemaVersion: 1, revision: 513, approvals: Array.from({ length: 512 }, (_, i) => ({ repositoryId: 'project-' + i, configurationDigest: digest, approvedAt: at })), history: Array.from({ length: 512 }, (_, i) => ({ action: 'approve', repositoryId: 'project-' + i, configurationDigest: digest, at, revision: i + 2 })) };
  assert.equal(validateDeliveryPolicyApprovals(full).approvals.length, 512);
  assert.throws(() => changeDeliveryPolicyApproval(full, { ...command('approve', 513), repositoryId: 'new-project' }, at), /512/);
  const rotated = changeDeliveryPolicyApproval(full, { ...command('revoke', 513), repositoryId: 'project-0' }, at);
  assert.equal(rotated.approvals.length, 511); assert.equal(rotated.history.length, 512); assert.equal(rotated.history[0].revision, 3); assert.equal(rotated.history.at(-1).revision, 514);
  assert.throws(() => validateDeliveryPolicyApprovals({ ...full, approvals: [...full.approvals, { repositoryId: 'last', configurationDigest: digest, approvedAt: at }] }));
  assert.throws(() => validateDeliveryPolicyApprovals({ ...full, history: [...full.history, full.history[0]] }));
});

test('temporary log retention has exact bounds and cannot expire accepted receipts or unfinished work', () => {
  assert.deepEqual(defaultDeliveryRetention(), { temporaryLogHours: 168, acceptedEvidence: 'preserve', unacceptedWork: 'preserve' });
  for (const hours of [0, 1, 720]) assert.deepEqual(validateDeliveryRetention({ ...defaultDeliveryRetention(), temporaryLogHours: hours }), { temporaryLogHours: hours, acceptedEvidence: 'preserve', unacceptedWork: 'preserve' });
  for (const hours of [-1, 721, 1.5, '24', NaN, Infinity, null]) assert.throws(() => validateDeliveryRetention({ ...defaultDeliveryRetention(), temporaryLogHours: hours }));
  for (const key of ['acceptedEvidence', 'unacceptedWork']) for (const action of ['expire', '', null]) assert.throws(() => validateDeliveryRetention({ ...defaultDeliveryRetention(), [key]: action }));
  assert.throws(() => validateDeliveryRetention({ ...defaultDeliveryRetention(), deleteWorktrees: true }));
});


test('approval action enums reject arrays and coercible objects without mutating private authority', () => {
  const original = emptyDeliveryPolicyApprovals(), digest = 'a'.repeat(64);
  const accepted = changeDeliveryPolicyApproval(original, { action: 'approve', repositoryId: 'project-one', configurationDigest: digest, expectedRevision: 1 }, at);
  for (const action of [['approve'], ['revoke'], { toString: () => 'approve' }, null, true]) {
    assert.throws(() => changeDeliveryPolicyApproval(original, { action, repositoryId: 'project-one', configurationDigest: digest, expectedRevision: 1 }, at), /approve or revoke/);
    assert.throws(() => validateDeliveryPolicyApprovals({ ...accepted, history: [{ ...accepted.history[0], action }] }), /history is invalid/);
  }
  assert.deepEqual(original, emptyDeliveryPolicyApprovals());
  assert.equal(accepted.history[0].action, 'approve'); assert.equal(accepted.approvals.length, 1);
});
