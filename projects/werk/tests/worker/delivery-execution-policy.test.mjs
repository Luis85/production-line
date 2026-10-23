import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeliveryExecutionPolicy, resolveDeliveryExecutionProfile, deliveryExecutionProfileSelection } from '../../src/worker/dist/worker/application/delivery-execution-policy.js';

/** @returns {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionProfile} */
const primary = () => ({ id: 'primary', provider: 'claude-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: 'worker_grants' });
/** @returns {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionProfile} */
const alternate = () => ({ id: 'alternate', provider: 'codex-cli', model: '', effort: 'high', authenticationMode: 'api-key', boundary: 'worker_grants' });
/** @returns {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionPolicy} */
const policy = () => ({ profiles: [primary(), alternate()], defaultProfile: 'primary', allowedOverrides: ['alternate'], fallbackProfiles: ['alternate'], fallbackOn: ['quota_exhausted'], maxHandoffs: 1 });

test('profile selection preserves explicit billing and detached copies without introducing credential fields', () => {
  const input = policy();
  const selected = resolveDeliveryExecutionProfile(input, 'alternate').profile;
  assert.deepEqual(deliveryExecutionProfileSelection(selected), { provider: 'codex-cli', model: '', effort: 'high', authenticationMode: 'api-key' });
  selected.model = 'a-later-model';
  assert.equal(input.profiles[1].model, '');
  assert.equal(resolveDeliveryExecutionProfile(input).source, 'default');
  assert.throws(() => validateDeliveryExecutionPolicy({ ...input, profiles: [{ ...primary(), apiKey: 'must-not-enter-policy' }] }), /unexpected|unknown|field/i);
});

test('request overrides cannot select review-only, unknown or disallowed profiles', () => {
  const input = { ...policy(), allowedOverrides: [], reviewProfile: 'alternate' };
  assert.equal(resolveDeliveryExecutionProfile(input, 'primary').profile.id, 'primary');
  assert.throws(() => resolveDeliveryExecutionProfile(input, 'alternate'), /not allowed/);
  assert.throws(() => resolveDeliveryExecutionProfile(input, 'unknown'), /not allowed/);
  assert.throws(() => validateDeliveryExecutionPolicy({ ...input, reviewProfile: 'missing' }), /not configured/);
});

test('routing records the first fully matching rule and explicit allowed override takes precedence', () => {
  /** @type {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionPolicy} */
  const input = { ...policy(), routing: [
    { id: 'urgent-patch', qualityProfiles: ['feature'], modes: ['patch'], priorities: [3], profile: 'alternate' },
    { id: 'patch', modes: ['patch'], profile: 'primary' },
  ] };
  assert.deepEqual(resolveDeliveryExecutionProfile(input, undefined, { qualityProfile: 'feature', mode: 'patch', priority: 3 }), { profile: alternate(), source: 'rule', ruleId: 'urgent-patch' });
  assert.equal(resolveDeliveryExecutionProfile(input, undefined, { qualityProfile: 'lightweight', mode: 'patch', priority: 3 }).ruleId, 'patch');
  assert.equal(resolveDeliveryExecutionProfile(input, undefined, { mode: 'chat', priority: 3 }).source, 'default');
  assert.deepEqual(resolveDeliveryExecutionProfile(input, 'primary', { qualityProfile: 'feature', mode: 'patch', priority: 3 }), { profile: primary(), source: 'override' });
  assert.equal(Object.hasOwn(validateDeliveryExecutionPolicy(policy()), 'routing'), false);
});

test('profiles disclose Cursor native permissions and reject invented isolation or billing combinations', () => {
  /** @type {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionProfile} */
  const cursor = { ...primary(), id: 'cursor', provider: 'cursor-cli', boundary: 'provider_native' };
  /** @type {import('../../src/worker/application/delivery-execution-policy.js').DeliveryExecutionPolicy} */
  const input = { profiles: [cursor], defaultProfile: 'cursor', allowedOverrides: [], fallbackProfiles: [], fallbackOn: [], maxHandoffs: 0 };
  assert.equal(resolveDeliveryExecutionProfile(input).profile.boundary, 'provider_native');
  assert.throws(() => validateDeliveryExecutionPolicy({ ...input, profiles: [{ ...cursor, boundary: 'worker_grants' }] }), /boundary/);
  assert.throws(() => validateDeliveryExecutionPolicy({ ...input, profiles: [{ ...cursor, effort: 'high' }] }), /effort/);
  for (const authenticationMode of ['legacy', 'automatic', undefined])
    assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), profiles: [{ ...primary(), authenticationMode }] }), /authentication|billing/);
  assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), profiles: [{ ...primary(), provider: 'openai-api', authenticationMode: 'cli-account' }] }), /authentication/);
});

test('fallback is bounded, explicit and never triggered by unknown, auth, approval or operator-stop outcomes', () => {
  for (const trigger of ['authentication_required', 'approval_required', 'outcome_unknown', 'interrupted', 'cancelled'])
    assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), fallbackOn: [trigger] }), /Fallback/);
  for (const maxHandoffs of [-1, 4, 0.5, '1'])
    assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), maxHandoffs }), /handoff limit/);
  assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), maxHandoffs: 0 }), /nonzero/);
  assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), fallbackProfiles: ['missing'] }), /not configured/);
  assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), fallbackProfiles: ['alternate', 'alternate'] }), /duplicate/);
});

test('definition references remain declarative and routing rejects ambiguous or empty conditions', () => {
  const defined = { ...primary(), definitionRef: 'team-review', agent: 'reviewer', useInstructionsOnly: true };
  assert.equal(validateDeliveryExecutionPolicy({ ...policy(), profiles: [defined, alternate()] }).profiles[0].definitionRef, 'team-review');
  assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), profiles: [{ ...primary(), agent: 'reviewer' }, alternate()] }), /definitionRef/);
  for (const rule of [{ id: 'empty', profile: 'primary' }, { id: 'empty', profile: 'primary', modes: [] }, { id: 'invalid', profile: 'primary', priorities: [4] }, { id: 'invalid', profile: 'missing', modes: ['patch'] }])
    assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), routing: [rule] }), /routing|Routing|condition/);
  const duplicate = { id: 'same', profile: 'primary', modes: ['patch'] };
  assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), routing: [duplicate, duplicate] }), /unique/);
  assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), profiles: [primary(), primary()] }), /unique/);
});

test('routing modes reject coercible objects and nested arrays before freezing authority', () => {
  for (const mode of [['chat'], ['patch'], { toString: () => 'chat' }, 0, true, null]) assert.throws(() => validateDeliveryExecutionPolicy({ ...policy(), routing: [{ id: 'strict', profile: 'primary', modes: [mode] }] }), /Routing modes/);
});
