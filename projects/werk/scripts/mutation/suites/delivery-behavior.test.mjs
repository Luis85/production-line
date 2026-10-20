import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeliveryBehaviorLibrary, selectedDeliveryBehavior } from '../../../.mutation-build/worker/application/delivery-behavior-policy.js';
const validateDeliveryBehaviorProfile = value => validateDeliveryBehaviorLibrary({ defaultProfile: value.id, profiles: [value] }).profiles[0];
const authored = () => { const profile = selectedDeliveryBehavior(); assert.equal(profile.root.type, 'selector'); if (profile.root.type !== 'selector') throw Error('Expected delivery selector'); return { ...profile, root: profile.root }; };
const changed = mutate => { const value = authored(); mutate(value); return value; };
const reject = mutate => assert.throws(() => validateDeliveryBehaviorProfile(changed(mutate)), { code: 'invalid_input' });
const branch = value => value.root.children[0];

test('authored behavior profiles preserve every safety condition and action while allowing bounded explanatory text', () => {
  const defaultDeliveryProfile = selectedDeliveryBehavior();
  const input = authored(); input.id = 'team-profile'; input.version = 5;
  branch(input).children[1].reason = '  Wait for the current invocation to stop.  ';
  branch(input).children[1].waitingFor = '  Confirmed process exit  ';
  const actual = validateDeliveryBehaviorProfile(input);
  assert.equal(actual.schemaVersion, 1); assert.equal(actual.id, 'team-profile'); assert.equal(actual.version, 5);
  assert.equal(branch(actual).children[1].reason, 'Wait for the current invocation to stop.');
  assert.equal(branch(actual).children[1].waitingFor, 'Confirmed process exit');
  assert.notEqual(actual.root, input.root);
  const fallback = selectedDeliveryBehavior(); assert.deepEqual(fallback, defaultDeliveryProfile); assert.notEqual(fallback.root, defaultDeliveryProfile.root);
  assert.deepEqual(selectedDeliveryBehavior({ defaultProfile: input.id, profiles: [input] }), actual);
  for (let i = 0; i < input.root.children.length; i++) {
    reject(value => { value.root.children[i].children[0].condition = 'unsupported'; });
    reject(value => { value.root.children[i].children[1].action = 'unsupported'; });
  }
});

test('behavior grammar rejects injected execution, ambiguous identities and wrong branch structure', () => {
  for (const id of ['', 'Uppercase', 'with space', 'a'.repeat(65), null, 1]) reject(value => { value.id = id; });
  for (const version of [0, -1, 1.5, '1', Infinity]) reject(value => { value.version = version; });
  reject(value => { value.schemaVersion = 2; });
  reject(value => { value.root.id = value.root.children[0].id; });
  reject(value => { value.root.type = 'sequence'; });
  reject(value => { value.root.children = []; });
  reject(value => { value.root.children.pop(); });
  reject(value => { value.root.children.reverse(); });
  reject(value => { branch(value).type = 'selector'; });
  reject(value => { branch(value).children.push({ id: 'extra', type: 'action', action: 'wait', reason: 'Extra work' }); });
  reject(value => { branch(value).children.reverse(); });
  reject(value => { branch(value).children[0].type = 'function'; });
  reject(value => { branch(value).children[0].condition = null; });
  reject(value => { branch(value).children[0].evaluate = 'arbitrary code'; });
  reject(value => { branch(value).children[1].execute = 'arbitrary code'; });
  reject(value => { value.root.reason = 'injected'; });
  for (const reason of ['', ' ', null, 'x'.repeat(1001)]) reject(value => { branch(value).children[1].reason = reason; });
  for (const waitingFor of ['', ' ', false, 'x'.repeat(301)]) reject(value => { branch(value).children[1].waitingFor = waitingFor; });
  for (const [field, maximum] of /** @type {const} */ ([['reason', 1000], ['waitingFor', 300]])) {
    const value = authored(); branch(value).children[1][field] = 'x'.repeat(maximum);
    assert.equal(branch(validateDeliveryBehaviorProfile(value)).children[1][field].length, maximum);
  }
});

test('behavior libraries bind a configured default and isolate every returned reusable profile', () => {
  const first = authored(), second = authored(); second.id = 'second'; second.version = 2;
  const library = { defaultProfile: second.id, profiles: [first, second] };
  const result = validateDeliveryBehaviorLibrary(library); assert.deepEqual(result, library);
  assert.equal(selectedDeliveryBehavior(library).id, 'second');
  second.version = 3; assert.equal(result.profiles[1].version, 2);
  for (const value of [null, { ...library, profiles: [] }, { ...library, profiles: [first, first] }, { ...library, defaultProfile: 'unknown' }, { ...library, profiles: Array.from({ length: 17 }, (_, i) => ({ ...first, id: 'profile-' + i })) }]) assert.throws(() => validateDeliveryBehaviorLibrary(value));
  const maximum = { defaultProfile: 'profile-15', profiles: Array.from({ length: 16 }, (_, i) => ({ ...first, id: 'profile-' + i })) };
  assert.equal(validateDeliveryBehaviorLibrary(maximum).profiles.length, 16);
});


test('behavior node IDs and fields reject malformed identities within the otherwise valid grammar', () => {
  for (const id of ['$node', 'node$', 'Uppercase', 'node space', 'a'.repeat(65)]) reject(value => { value.root.id = id; });
  reject(value => { value.id = 'profile_name'; });
  reject(value => { branch(value).children[0].reason = 'Condition cannot carry action metadata.'; });
  reject(value => { branch(value).children[0].children = []; });
  reject(value => { branch(value).children[1].condition = 'needs_review'; });
  reject(value => { branch(value).children[1].children = []; });
  const deep = { ...authored(), root: { id: 'deep-root', type: 'selector', children: [] } }; let nested = deep.root;
  for (let i = 0; i < 10; i++) { const child = { id: 'nested-' + i, type: 'sequence', children: [] }; nested.children = [child]; nested = child; }
  assert.throws(() => validateDeliveryBehaviorProfile(deep), /eight levels/);
});
