import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, validateDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { resolveDeliveryExecutionProfile } from '../../src/worker/dist/worker/application/delivery-execution-policy.js';

function configuredPolicy() {
  const base = defaultDeliveryProjectPolicy();
  /** @type {import('../../src/worker/application/delivery-execution-policy.ts').DeliveryExecutionPolicy} */
  const execution = {
    profiles: [
      { id: 'primary', provider: 'codex-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: 'worker_grants' },
      { id: 'reviewer', provider: 'claude-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: 'worker_grants' },
    ],
    defaultProfile: 'primary', allowedOverrides: [], fallbackProfiles: [], fallbackOn: [], maxHandoffs: 0,
    routing: [{ id: 'custom-work', qualityProfiles: ['careful'], profile: 'reviewer' }],
  };
  return { ...base, execution, profiles: [...base.profiles, { ...base.profiles[0], id: 'careful' }] };
}

test('project policy rejects every unknown routing quality profile before it can silently choose the default provider', () => {
  const policy = configuredPolicy();
  for (const qualityProfiles of [['misspelled'], ['careful', 'misspelled']]) {
    const malformed = { ...policy, execution: { ...policy.execution, routing: [{ id: 'custom-work', qualityProfiles, profile: 'reviewer' }] } };
    assert.throws(() => validateDeliveryProjectPolicy(malformed), { code: 'invalid_input', message: /custom-work.*misspelled/ });
    assert.throws(() => deliveryPolicySnapshot(malformed, 'a'.repeat(40)), { code: 'invalid_input' });
  }
});

test('custom quality profiles remain routable and snapshots detach valid ordered rules', () => {
  const original = configuredPolicy();
  original.execution.routing.push({ id: 'patch-work', modes: ['patch'], profile: 'primary' });
  const snapshot = deliveryPolicySnapshot(original, 'a'.repeat(40), 'careful');
  assert.equal(resolveDeliveryExecutionProfile(snapshot.configuration.execution, undefined, { qualityProfile: 'careful', mode: 'patch' }).profile.id, 'reviewer');
  assert.equal(resolveDeliveryExecutionProfile(snapshot.configuration.execution, undefined, { qualityProfile: 'feature', mode: 'patch' }).ruleId, 'patch-work');
  assert.equal(resolveDeliveryExecutionProfile(snapshot.configuration.execution, undefined, { qualityProfile: 'lightweight', mode: 'chat' }).source, 'default');
  original.execution.routing[0].qualityProfiles[0] = 'later-edit';
  assert.deepEqual(snapshot.configuration.execution.routing[0].qualityProfiles, ['careful']);
  assert.deepEqual(validateDeliveryProjectPolicy(snapshot.configuration), snapshot.configuration);
});
