import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deliveryGatePolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { newDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy-template.js';
import { sharedFeaturePolicy } from '../../src/worker/dist/worker/application/shared-feature-policy.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { fixture } from './shared-feature-fixture.mjs';

async function prepared(t) {
  const configuration = { ...newDeliveryProjectPolicy(), localMerge: true };
  const f = await fixture(t, { prepare: async (_input, _binding, baseline) => ({ deliveryPolicy: deliveryPolicySnapshot(configuration, baseline) }) });
  await f.intake.sync();
  const state = await f.state(), record = state.records[0];
  return { f, state, record };
}

test('shared reservations freeze the effective delivery gates separately from their committed workflow identity', async t => {
  const { f, record } = await prepared(t), sourceDigest = record.workflow.policyDigest;
  assert.ok(record.executionPolicy);
  const expected = deliveryGatePolicy(record.workflow.policy, record.deliveryPolicy), observed = sharedFeaturePolicy(record);
  assert.deepEqual(record.executionPolicy, expected); assert.deepEqual(observed.policy, expected);
  assert.equal(observed.digest, gateDigest(expected)); assert.notEqual(observed.digest, sourceDigest);
  assert.equal(record.workflow.policyDigest, gateDigest(record.workflow.policy));
  assert.equal(observed.policy.reviewer.enabled, true); assert.ok(observed.policy.ready.patch.some(rule => rule.id === 'delivery-profile-criteria'));
  observed.policy.ready.patch.length = 0;
  assert.deepEqual(sharedFeaturePolicy(record).policy, expected, 'A caller cannot mutate the frozen reservation through the selector.');
  await f.restart(); assert.deepEqual((await f.state()).records[0].executionPolicy, expected);
});

test('legacy delivery reservations derive the exact effective gates without changing their existing claim hash', async t => {
  const { f, state, record } = await prepared(t), inputHash = record.inputHash, expected = sharedFeaturePolicy(record);
  delete record.executionPolicy;
  assert.deepEqual(sharedFeaturePolicy(record), expected);
  await writeFile(join(f.directory, 'shared-intake.json'), JSON.stringify(state)); await f.restart();
  const recovered = (await f.state()).records[0];
  assert.equal(recovered.inputHash, inputHash); assert.deepEqual(sharedFeaturePolicy(recovered), expected);
  assert.equal(f.submits.length, 1, 'Recovering a derived legacy snapshot does not readmit its paid execution.');
});

for (const change of ['gate', 'profile', 'null']) test('recovery rejects a changed frozen shared execution ' + change, async t => {
  const { f, state, record } = await prepared(t);
  if (change === 'gate') record.executionPolicy.ready.patch.pop();
  if (change === 'profile') record.deliveryPolicy.profile.minimumMessageLength++;
  if (change === 'null') record.executionPolicy = null;
  await writeFile(join(f.directory, 'shared-intake.json'), JSON.stringify(state));
  await assert.rejects(f.restart(), /frozen shared execution policy|retained quality policy|Invalid gate policy/);
});
