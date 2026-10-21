import test from 'node:test';
import assert from 'node:assert/strict';
import { testErrorCode } from '../../../tests/helpers/typed-boundaries.mjs';
import { defaultDeliveryProjectPolicy, deliveryGatePolicy, deliveryPolicySnapshot, validateDeliveryPolicySnapshot, validateDeliveryProjectPolicy, verificationInputs } from '../../../.mutation-build/worker/application/delivery-policy.js';

const baseline = 'a'.repeat(40), reserved = '.werk/delivery-policy.json';
const profile = () => defaultDeliveryProjectPolicy();
const rejects = value => assert.throws(() => validateDeliveryProjectPolicy(value), error => testErrorCode(error) === 'invalid_input');
const configured = change => { const value = profile(); change(value); return value; };
/** Independent trusted policy fixture; the mutation target must preserve these mandatory rules. */
/** @returns {import('../../../src/worker/application/request-gate-contracts.js').GatePolicy} */
const defaultGatePolicy = () => ({ schemaVersion: 1, id: 'trusted-project', version: 4,
  ready: { chat: [{ id: 'message', fact: 'input.messageLength', op: 'gte', value: 1 }], patch: [{ id: 'files', fact: 'input.approvedFileCount', op: 'gte', value: 1 }] },
  done: { chat: [{ id: 'output', fact: 'output.nonEmpty', op: 'eq', value: true }], patch: [{ id: 'verified', fact: 'output.verificationPassed', op: 'eq', value: true }] },
  reviewer: { enabled: false, provider: 'same', maxAttempts: 1 }, rework: { maxAttempts: 0 },
});

test('project defaults and snapshots preserve explicit profile authority and isolate caller mutation', () => {
  const configuration = validateDeliveryProjectPolicy(profile());
  assert.equal(configuration.defaultProfile, 'feature'); assert.equal(configuration.reviewDirectory, 'feature-reviews');
  assert.deepEqual(configuration.profiles.map(item => item.id), ['feature', 'lightweight']);
  assert.deepEqual(configuration.profiles.map(item => [item.minimumCriteria, item.minimumMessageLength, item.maxRepairAttempts]), [[1, 20, 2], [0, 1, 1]]);
  for (const item of configuration.profiles) assert.deepEqual(item.verificationInputs, ['tests/', 'test/', 'scripts/', 'package.json', 'package-lock.json', 'tsconfig.json', reserved]);
  const selected = deliveryPolicySnapshot(configuration, baseline);
  assert.equal(selected.schemaVersion, 1); assert.equal(selected.baseline, baseline); assert.equal(selected.profile.id, 'feature');
  assert.match(selected.configurationDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateDeliveryPolicySnapshot(selected), selected);
  configuration.profiles[0].minimumCriteria = 20;
  assert.equal(selected.profile.minimumCriteria, 1); assert.equal(selected.configuration.profiles[0].minimumCriteria, 1);
  selected.configuration.profiles[0].minimumCriteria = 10;
  assert.equal(selected.profile.minimumCriteria, 1);
  assert.equal(deliveryPolicySnapshot(profile(), baseline, 'lightweight').profile.id, 'lightweight');
  assert.equal(deliveryPolicySnapshot(profile(), 'b'.repeat(64)).baseline.length, 64);
  for (const ref of ['', 'main', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) assert.throws(() => deliveryPolicySnapshot(profile(), ref), /immutable baseline/);
  assert.throws(() => deliveryPolicySnapshot(profile(), baseline, 'missing'), /configured project profile/);
});

test('profile schema rejects hidden fields, unknown defaults, duplicates and unsafe destinations', () => {
  for (const raw of [null, [], false, 'policy', { ...profile(), hidden: true }, { ...profile(), schemaVersion: 2 }]) rejects(raw);
  for (const version of [0, -1, 0.5, '1', NaN, Infinity]) rejects({ ...profile(), version });
  for (const profiles of [[], [profile().profiles[0]], Array.from({ length: 17 }, () => profile().profiles[0]), null]) rejects({ ...profile(), profiles });
  rejects(configured(value => { value.profiles[1].id = 'feature'; }));
  rejects(configured(value => { value.profiles[1].id = 'other'; }));
  rejects(configured(value => { value.profiles.push({ ...value.profiles[0] }); }));
  const maximumProfiles = configured(value => { value.profiles.push(...Array.from({ length: 14 }, (_, index) => ({ ...value.profiles[0], id: 'custom-' + index }))); });
  assert.equal(validateDeliveryProjectPolicy(maximumProfiles).profiles.length, 16);
  rejects({ ...maximumProfiles, profiles: [...maximumProfiles.profiles, { ...maximumProfiles.profiles[0], id: 'one-too-many' }] });
  for (const id of ['', 'Feature', 'with space', 'a'.repeat(65), 'custom!', '!custom', null, 1]) rejects(configured(value => { value.profiles.push({ ...value.profiles[0], id }); }));
  for (const id of ['a', 'a'.repeat(64)]) assert.equal(validateDeliveryProjectPolicy(configured(value => { value.profiles.push({ ...value.profiles[0], id }); })).profiles.at(-1).id, id);
  for (const defaultProfile of ['', 'other', 1, null]) rejects({ ...profile(), defaultProfile });
  for (const reviewDirectory of ['', '.', '../outside', '/absolute', '.werk/reviews', '.WERK/reviews', 'team/.werk/reviews', 'team/.WERK/reviews', 'a/../b']) rejects({ ...profile(), reviewDirectory });
  assert.equal(validateDeliveryProjectPolicy({ ...profile(), reviewDirectory: 'team/reviews' }).reviewDirectory, 'team/reviews');
  rejects(configured(value => { value.profiles[0] = { ...value.profiles[0], authority: true }; }));
});

test('profile numeric limits and protected verification inputs enforce bounded canonical values', () => {
  for (const [key, maximum] of /** @type {const} */ ([['minimumCriteria', 64], ['minimumMessageLength', 8000], ['maxRepairAttempts', 3]])) {
    for (const value of [0, maximum]) assert.equal(validateDeliveryProjectPolicy(configured(config => { config.profiles[0][key] = value; })).profiles[0][key], value);
    for (const value of [-1, maximum + 1, 0.5, '1', null, NaN, Infinity]) rejects(configured(config => { config.profiles[0][key] = value; }));
  }
  assert.deepEqual(verificationInputs([]), [reserved]);
  assert.deepEqual(verificationInputs(['tests/', 'package.json']), ['tests/', 'package.json', reserved]);
  assert.deepEqual(verificationInputs([reserved]), [reserved]);
  for (const inputs of [null, 'tests/', [1], ['../tests'], ['test', 'TEST'], ['.git/config'], Array.from({ length: 65 }, (_, index) => `file-${index}`)]) assert.throws(() => verificationInputs(inputs), error => testErrorCode(error) === 'invalid_input');
  const maximum = [reserved, ...Array.from({ length: 63 }, (_, index) => `file-${index}`)];
  assert.deepEqual(verificationInputs(maximum), [...maximum.slice(1), reserved]);
  const configuredMaximum = Array.from({ length: 64 }, (_, index) => `file-${index}`);
  const canonicalMaximum = verificationInputs(configuredMaximum);
  assert.equal(canonicalMaximum.length, 65); assert.deepEqual(verificationInputs(canonicalMaximum), canonicalMaximum);
});

test('snapshot rehydration rejects changed profile, configuration, identity and digest', () => {
  const snapshot = deliveryPolicySnapshot(profile(), baseline);
  assert.throws(() => validateDeliveryPolicySnapshot({ ...snapshot, schemaVersion: 2 }));
  assert.throws(() => validateDeliveryPolicySnapshot({ ...snapshot, configurationDigest: 'c'.repeat(64) }), /no longer matches/);
  assert.throws(() => validateDeliveryPolicySnapshot({ ...snapshot, profile: { ...snapshot.profile, minimumCriteria: 0 } }), /no longer matches/);
  assert.throws(() => validateDeliveryPolicySnapshot({ ...snapshot, configuration: { ...snapshot.configuration, version: 2 } }), /no longer matches/);
  assert.throws(() => validateDeliveryPolicySnapshot({ ...snapshot, profile: { ...snapshot.profile, id: 'missing' } }), /configured project profile/);
  assert.throws(() => validateDeliveryPolicySnapshot({ ...snapshot, profile: { ...snapshot.profile, injected: true } }));
});

test('named readiness gates retain mandatory source checks and enforce profile thresholds', () => {
  const base = defaultGatePolicy(), original = structuredClone(base);
  const feature = deliveryGatePolicy(base, deliveryPolicySnapshot(profile(), baseline, 'feature'));
  const light = deliveryGatePolicy(base, deliveryPolicySnapshot(profile(), baseline, 'lightweight'));
  assert.deepEqual(base, original); assert.deepEqual(feature.done, base.done); assert.deepEqual(feature.reviewer, base.reviewer);
  assert.equal(feature.id, 'delivery-feature'); assert.equal(light.id, 'delivery-lightweight'); assert.equal(feature.version, 1);
  for (const kind of ['chat', 'patch']) {
    assert.deepEqual(feature.ready[kind].slice(0, base.ready[kind].length), base.ready[kind]);
    assert.deepEqual(feature.ready[kind].slice(-2), [
      { id: 'delivery-profile-message', fact: 'input.messageLength', op: 'gte', value: 20 },
      { id: 'delivery-profile-criteria', fact: 'input.criteriaCount', op: 'gte', value: 1 },
    ]);
  }
  for (const kind of ['chat', 'patch']) assert.deepEqual(light.ready[kind].slice(-2), [
    { id: 'delivery-profile-message', fact: 'input.messageLength', op: 'gte', value: 1 },
    { id: 'delivery-profile-criteria', fact: 'input.criteriaCount', op: 'gte', value: 0 },
  ]);
  assert.deepEqual(light.rework, base.rework, 'Implementation repair limits do not grant advisory requirement rework authority.');
  const collision = defaultGatePolicy(); collision.ready.patch.push({ ...collision.ready.patch[0], id: 'another-mandatory-rule' }); collision.ready.patch[0].id = 'delivery-profile-message';
  assert.throws(() => deliveryGatePolicy(collision, deliveryPolicySnapshot(profile(), baseline)), /reserved/);
});


test('remote publication authority and retention survive policy validation and detached snapshots', () => {
  const remoteDelivery = { remote: 'origin', repository: 'team/project', base: 'main', push: true, pullRequest: true, draft: true };
  const retention = { temporaryLogHours: 24, acceptedEvidence: /** @type {const} */ ('preserve'), unacceptedWork: /** @type {const} */ ('preserve') };
  const configured = { ...profile(), remoteDelivery, retention };
  const snapshot = deliveryPolicySnapshot(configured, baseline);
  assert.deepEqual(snapshot.configuration.remoteDelivery, remoteDelivery);
  assert.deepEqual(snapshot.configuration.retention, retention);
  assert.deepEqual(validateDeliveryPolicySnapshot(snapshot), snapshot);
  remoteDelivery.push = false; retention.temporaryLogHours = 0;
  assert.equal(snapshot.configuration.remoteDelivery.push, true);
  assert.equal(snapshot.configuration.retention.temporaryLogHours, 24);
  rejects({ ...profile(), remoteDelivery });
  rejects({ ...profile(), retention: { ...retention, acceptedEvidence: 'delete' } });
  const changed = structuredClone(snapshot); changed.configuration.remoteDelivery.draft = false;
  assert.throws(() => validateDeliveryPolicySnapshot(changed), /accepted snapshot/);
});
