import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, validateDeliveryPolicySnapshot, validateDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { selectedDeliveryCheckPacks, validateDeliveryCheckPacks, validateDeliveryCheckPackReferences } from '../../src/worker/dist/worker/application/delivery-check-packs.js';
import { assertDevelopmentPolicy, developmentScopeView, freezeDevelopmentScope, validateDevelopmentState } from '../../src/worker/dist/worker/application/development.js';
import { deliveryCheckDefinitionDigest } from '../../src/worker/dist/worker/application/delivery-review.js';
import { baselineCheckDigest } from '../../src/worker/dist/worker/application/development-baseline.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { deliveryPolicyRequiresApproval } from '../../src/worker/dist/worker/application/delivery-policy-approval.js';
const baseline = 'a'.repeat(40);
const pack = () => ({ id: 'frontend', version: 2, checks: ['lint', 'test'] });
function fixture() {
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  policy.builtins.commands = [
    { id: 'test', name: 'Unit tests', executable: process.execPath, args: ['tests.mjs'], enabled: true, verification: true },
    { id: 'lint', name: 'Static analysis', executable: process.execPath, args: ['lint.mjs'], enabled: true, verification: false },
    { id: 'extra', name: 'Unselected', executable: process.execPath, args: ['extra.mjs'], enabled: true, verification: false },
  ];
  const configuration = defaultDeliveryProjectPolicy(); configuration.checkPacks = [pack()]; configuration.profiles[0].checkPacks = ['frontend'];
  const snapshot = deliveryPolicySnapshot(configuration, baseline);
  const checkPacks = selectedDeliveryCheckPacks(snapshot.configuration, snapshot.profile);
  const scope = freezeDevelopmentScope(baseline, ['source.ts'], policy, { checkPacks }); assert.ok(scope);
  return { policy, configuration, snapshot, checkPacks, scope };
}

test('selected versioned packs add checks without removing machine requirements or mutating the accepted catalog', () => {
  const { policy, configuration, snapshot, checkPacks, scope } = fixture();
  assert.deepEqual(scope.checks.map(check => check.id), ['lint', 'test']);
  assert.deepEqual(scope.checkPacks, [pack()]); assert.deepEqual(developmentScopeView(scope).checkPacks, [pack()]);
  assert.equal(deliveryPolicyRequiresApproval(configuration), true);
  assert.deepEqual(validateDeliveryPolicySnapshot(snapshot), snapshot);
  configuration.checkPacks[0].version = 99; checkPacks[0].checks.length = 0;
  assert.equal(snapshot.configuration.checkPacks[0].version, 2); assert.deepEqual(scope.checkPacks[0].checks, ['lint', 'test']);
  assert.doesNotThrow(() => assertDevelopmentPolicy(scope, policy));
  assert.equal(Object.hasOwn(freezeDevelopmentScope(baseline, ['source.ts'], policy), 'checkPacks'), false);
});

test('pack configuration cannot create executable grants, enable disabled commands or bypass file access', () => {
  const { policy } = fixture();
  for (const id of ['missing', 'lint']) {
    const changed = structuredClone(policy); if (id === 'lint') changed.builtins.commands.find(item => item.id === id).enabled = false;
    assert.throws(() => freezeDevelopmentScope(baseline, ['source.ts'], changed, { checkPacks: [{ id: 'requested', version: 1, checks: [id] }] }), /requires enabled command preset.*Settings.*retry/);
  }
  assert.throws(() => validateDeliveryCheckPacks([{ ...pack(), executable: 'ungranted-program' }]), /unknown|unsupported|field/i);
  policy.builtins.files = false; assert.equal(freezeDevelopmentScope(baseline, ['source.ts'], policy, { checkPacks: [pack()] }), undefined);
});

test('every selected preset remains frozen through tool revocation, command changes and new mandatory checks', () => {
  const { policy, scope } = fixture();
  for (const change of [
    value => { value.builtins.commands.find(item => item.id === 'lint').enabled = false; },
    value => { value.builtins.commands.find(item => item.id === 'lint').args = ['changed.mjs']; },
    value => { value.builtins.commands.find(item => item.id === 'extra').verification = true; },
    value => { value.builtins.files = false; },
  ]) {
    const changed = structuredClone(policy); change(changed); assert.throws(() => assertDevelopmentPolicy(scope, changed), /verification commands changed/);
  }
  const invalid = structuredClone(scope); invalid.checkPacks[0].checks.push('missing');
  assert.throws(() => validateDevelopmentState(invalid), /Saved implementation authority/);
});

test('pack versions bind candidate and baseline verification identities while legacy digests stay stable', () => {
  const { policy, scope } = fixture(), next = structuredClone(scope); next.checkPacks[0].version++;
  assert.notEqual(deliveryCheckDefinitionDigest(scope), deliveryCheckDefinitionDigest(next));
  assert.notEqual(baselineCheckDigest(scope), baselineCheckDigest(next));
  const legacy = freezeDevelopmentScope(baseline, ['source.ts'], policy); assert.ok(legacy);
  assert.equal(deliveryCheckDefinitionDigest(legacy), gateDigest({ checks: legacy.checks, verificationInputs: [] }));
  assert.equal(baselineCheckDigest(legacy), gateDigest(legacy.checks.map(check => ({ id: check.id, fingerprint: check.fingerprint }))));
});

test('project catalogs reject ambiguous names, unknown selections and unbounded or executable definitions', () => {
  const { configuration } = fixture();
  for (const packs of [[pack(), pack()], [{ ...pack(), version: 0 }], [{ ...pack(), checks: ['test', 'test'] }], [{ ...pack(), checks: ['shell; arbitrary'] }], [{ ...pack(), checks: [] }]])
    assert.throws(() => validateDeliveryProjectPolicy({ ...configuration, checkPacks: packs }), /Check pack|check pack/);
  const unknown = structuredClone(configuration); unknown.profiles[0].checkPacks = ['not-configured'];
  assert.throws(() => validateDeliveryProjectPolicy(unknown), /unknown check pack/);
  const repeated = structuredClone(configuration); repeated.profiles[0].checkPacks = ['frontend', 'frontend'];
  assert.throws(() => validateDeliveryProjectPolicy(repeated), /unique named check packs/);
});


test('check pack catalogs and selections validate independent count, identity and preset boundaries', () => {
  const names = Array.from({ length: 32 }, (_, i) => 'pack-' + i), presets = Array.from({ length: 32 }, (_, i) => 'check_' + i);
  const maximum = names.map(id => ({ id, version: 1, checks: presets }));
  assert.deepEqual(validateDeliveryCheckPacks(maximum), maximum);
  assert.deepEqual(validateDeliveryCheckPackReferences(names.slice(0, 16)), names.slice(0, 16));
  for (const value of [null, {}, 'packs', [...maximum, { ...pack(), id: 'another' }]]) assert.throws(() => validateDeliveryCheckPacks(value), { code: 'invalid_input' });
  for (const value of [null, {}, ['valid', 'Invalid'], ['valid', ['nested']], ['$prefix'], ['suffix$'], ['a'.repeat(65)], names.slice(0, 17)])
    assert.throws(() => validateDeliveryCheckPackReferences(value), { code: 'invalid_input' });
  for (const id of ['', '$prefix', 'suffix$', 'Uppercase', 'a'.repeat(65), ['nested']]) assert.throws(() => validateDeliveryCheckPacks([{ ...pack(), id }]), { code: 'invalid_input' });
  for (const version of [0, -1, 1.5, '1', null]) assert.throws(() => validateDeliveryCheckPacks([{ ...pack(), version }]), { code: 'invalid_input' });
  for (const checks of [null, {}, ['valid', ['nested']], ['valid', 'invalid;command'], [...presets, 'check_33']]) assert.throws(() => validateDeliveryCheckPacks([{ ...pack(), checks }]), { code: 'invalid_input' });
  const distinct = [{ id: 'a', version: 1, checks: ['A'] }, { id: 'b', version: 1, checks: ['b'] }]; assert.deepEqual(validateDeliveryCheckPacks(distinct), distinct);
  const configuration = defaultDeliveryProjectPolicy(); configuration.profiles[0].checkPacks = ['missing'];
  assert.throws(() => selectedDeliveryCheckPacks(configuration, configuration.profiles[0]), { code: 'invalid_input' });
});
