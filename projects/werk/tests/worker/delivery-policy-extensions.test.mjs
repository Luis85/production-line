import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDeliveryProjectPolicy, validateDeliveryProjectPolicy, deliveryPolicySnapshot, validateDeliveryPolicySnapshot, deliveryGatePolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultDeliveryProfile } from '../../src/worker/dist/worker/application/delivery-behavior.js';
import { validateDeliveryBehaviorLibrary, selectedDeliveryBehavior } from '../../src/worker/dist/worker/application/delivery-behavior-policy.js';
import { validateDeliveryExecutionSnapshot } from '../../src/worker/dist/worker/application/delivery-execution-snapshot.js';
import { resolveDeliveryExecutionProfile, deliveryExecutionProfileSelection } from '../../src/worker/dist/worker/application/delivery-execution-policy.js';
import { freezeSubmission } from '../../src/worker/dist/worker/application/local-task-contracts.js';
import { defaultGatePolicy, gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
const baseline = 'a'.repeat(40);

function executionFixture() {
  /** @type {import('../../src/worker/application/delivery-execution-policy.ts').DeliveryExecutionPolicy} */
  const policy = { profiles: [{ id: 'implementer', provider: 'codex-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: 'worker_grants' }, { id: 'reviewer', provider: 'claude-cli', model: '', effort: 'default', authenticationMode: 'cli-account', boundary: 'worker_grants' }], defaultProfile: 'implementer', allowedOverrides: [], reviewProfile: 'reviewer', fallbackProfiles: [], fallbackOn: [], maxHandoffs: 0 };
  const resolution = resolveDeliveryExecutionProfile(policy), selection = deliveryExecutionProfileSelection(resolution.profile);
  return { policy, resolution, selection, profileSnapshots: policy.profiles.map(profile => ({ profileId: profile.id, selection: deliveryExecutionProfileSelection(profile) })) };
}

test('optional policy sections preserve byte-equivalent legacy snapshots and are frozen independently', () => {
  const old = defaultDeliveryProjectPolicy();
  for (const profile of old.profiles) profile.verificationInputs = [...profile.verificationInputs.filter(path => path !== '.werk/delivery-policy.json'), '.werk/delivery-policy.json'];
  const digest = gateDigest(old);
  assert.deepEqual(validateDeliveryProjectPolicy(old), old);
  assert.equal(gateDigest(validateDeliveryProjectPolicy(JSON.parse(JSON.stringify(old)))), digest);
  const snapshot = deliveryPolicySnapshot(old, baseline);
  assert.deepEqual(validateDeliveryPolicySnapshot(snapshot), snapshot);
  assert.equal(Object.hasOwn(snapshot.configuration, 'coordination'), false);
  const configured = { ...old, coordination: { maxActiveRequests: 3, dependencyPlanning: /** @type {const} */ ('topological') }, execution: executionFixture().policy, behaviors: { defaultProfile: 'team', profiles: [{ ...structuredClone(defaultDeliveryProfile), id: 'team' }] } };
  const pinned = deliveryPolicySnapshot(configured, baseline);
  configured.coordination.maxActiveRequests = 8;
  assert.equal(pinned.configuration.coordination.maxActiveRequests, 3);
  assert.deepEqual(validateDeliveryPolicySnapshot(pinned), pinned);
  const altered = structuredClone(pinned); altered.configuration.coordination.maxActiveRequests = 4;
  assert.throws(() => validateDeliveryPolicySnapshot(altered), /accepted snapshot/);
});

test('reusable authored profiles retain safety precedence and cannot substitute executable conditions', () => {
  const authored = structuredClone(defaultDeliveryProfile); authored.id = 'team-delivery'; authored.version = 2;
  assert.equal(authored.root.type, 'selector');
  if (authored.root.type !== 'selector') throw Error('Expected selector');
  const first = authored.root.children[0]; if (first.type !== 'sequence' || first.children[1].type !== 'action') throw Error('Expected branch');
  first.children[1].reason = 'Wait until every owned process is confirmed stopped.';
  const library = validateDeliveryBehaviorLibrary({ defaultProfile: authored.id, profiles: [authored] });
  assert.equal(selectedDeliveryBehavior(library).id, 'team-delivery');
  authored.root.children.reverse(); assert.throws(() => validateDeliveryBehaviorLibrary({ defaultProfile: authored.id, profiles: [authored] }), /precedence/);
  const missing = structuredClone(defaultDeliveryProfile); if (missing.root.type !== 'selector') throw Error('Expected selector'); missing.root.children.splice(3, 1);
  assert.throws(() => validateDeliveryBehaviorLibrary({ defaultProfile: missing.id, profiles: [missing] }), /complete supported/);
  const custom = structuredClone(defaultDeliveryProfile); if (custom.root.type !== 'selector') throw Error('Expected selector');
  const root = custom.root;
  const branch = root.children[0]; if (branch.type !== 'sequence' || branch.children[0].type !== 'condition') throw Error('Expected condition');
  assert.throws(() => validateDeliveryBehaviorLibrary({ defaultProfile: custom.id, profiles: [{ ...custom, root: { ...root, children: [{ ...branch, children: [{ ...branch.children[0], evaluate: 'process.exit()' }, branch.children[1]] }, ...root.children.slice(1)] } }] }), /unknown|unsupported|field/i);
});

test('snapshot validation freezes every authorized provider and rejects forged route, billing or definition substitutions', () => {
  const snapshot = executionFixture(); assert.deepEqual(validateDeliveryExecutionSnapshot(snapshot), snapshot);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...snapshot, profileSnapshots: snapshot.profileSnapshots.slice(0, 1) }), /every configured/);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...snapshot, selection: { ...snapshot.selection, authenticationMode: 'api-key' } }), /authorized profile/);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...snapshot, resolution: { profile: snapshot.policy.profiles[1], source: 'override' } }), /not authorized/);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...snapshot, resolution: { ...snapshot.resolution, source: 'rule', ruleId: 'invented' } }), /receipt/);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...snapshot, profileSnapshots: [snapshot.profileSnapshots[0], snapshot.profileSnapshots[0]] }), /complete and unique/);
  const configured = executionFixture(); configured.policy.profiles[0].definitionRef = 'shared-agent';
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...configured, resolution: resolveDeliveryExecutionProfile(configured.policy) }), /instructions/);
});

test('canonical admission binds execution policy, selection and snapshot into one reservation', () => {
  const execution = executionFixture(), policy = { ...defaultDeliveryProjectPolicy(), execution: execution.policy };
  const input = { id: 'feature-snapshot', hash: 'b'.repeat(64), deliveryPolicy: deliveryPolicySnapshot(policy, baseline), deliveryExecution: execution, selection: execution.selection };
  assert.deepEqual(freezeSubmission(input).deliveryExecution, execution);
  const { deliveryExecution: _execution, ...missing } = input;
  assert.throws(() => freezeSubmission(missing), /frozen profile catalog/);
  assert.throws(() => freezeSubmission({ ...input, selection: { ...execution.selection, model: 'changed' } }), /reserved execution profile/);
  const other = executionFixture(); other.policy.maxHandoffs = 1;
  assert.throws(() => freezeSubmission({ ...input, deliveryExecution: other }), /reserved execution profile/);
});

test('configured semantic readiness enables its bounded reviewer without weakening deterministic gates', () => {
  const config = defaultDeliveryProjectPolicy(); config.profiles[0].readiness = { assessment: 'required', assumptions: 'explicit', requiredReferences: ['docs/design.md'], maxEstimatedMinutes: 240 };
  config.profiles[0].exceptions = { exemptibleCriteria: ['check:test'], notApplicableCriteria: [] };
  const snapshot = deliveryPolicySnapshot(config, baseline), policy = deliveryGatePolicy(defaultGatePolicy(), snapshot);
  assert.equal(policy.reviewer.enabled, true); assert.deepEqual(policy.done, defaultGatePolicy().done);
  assert.deepEqual(validateDeliveryPolicySnapshot(snapshot), snapshot);
  assert.throws(() => validateDeliveryProjectPolicy({ ...config, profiles: config.profiles.map(profile => ({ ...profile, exceptions: { exemptibleCriteria: ['*'], notApplicableCriteria: [] } })) }), /wildcards/);
});


test('frozen routing source must be an exact enum and cannot bypass override authorization by coercion', () => {
  const snapshot = executionFixture(), unauthorized = snapshot.policy.profiles[1];
  for (const source of [['default'], ['override'], ['rule'], { toString: () => 'override' }, null, true]) {
    assert.throws(() => validateDeliveryExecutionSnapshot({ ...snapshot, resolution: { ...snapshot.resolution, source } }), /authorized frozen profile/);
    assert.throws(() => validateDeliveryExecutionSnapshot({ ...snapshot,
      resolution: { profile: unauthorized, source }, selection: deliveryExecutionProfileSelection(unauthorized) }), /authorized frozen profile/);
  }
});


test('execution snapshots detach imported instructions and bind agent, adaptation and catalog identity', () => {
  const configured = executionFixture(); configured.policy.profiles[0].definitionRef = 'team-agent';
  /** @type {import('../../src/worker/application/definitions.ts').DefinitionSnapshot} */
  const definition = { definitionId: 'imported', ref: 'team-agent', name: 'Team agent', agent: 'root', instruction: 'Accepted instructions.', digest: 'c'.repeat(64), model: 'profile-model', provider: '', adapted: false, unsupported: [] };
  const selection = { ...configured.selection, model: definition.model };
  /** @type {import('../../src/worker/application/delivery-execution-snapshot.ts').DeliveryExecutionSnapshot} */
  const input = { ...configured, resolution: resolveDeliveryExecutionProfile(configured.policy), selection, definition,
    profileSnapshots: configured.profileSnapshots.map((entry, i) => i === 0 ? { ...entry, selection, definition } : entry) };
  const accepted = validateDeliveryExecutionSnapshot(input); assert.deepEqual(accepted, input);
  definition.instruction = 'Later mutable import'; assert.equal(accepted.definition.instruction, 'Accepted instructions.');
  assert.equal(accepted.profileSnapshots[0].definition.instruction, 'Accepted instructions.');
  for (const change of [{ ref: 'another' }, { agent: 'other' }, { adapted: true }])
    assert.throws(() => validateDeliveryExecutionSnapshot({ ...accepted, definition: { ...accepted.definition, ...change } }), /instructions/);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...accepted, profileSnapshots: accepted.profileSnapshots.map((entry, i) => i === 0 ? { ...entry, definition: { ...entry.definition, instruction: 'Different catalog instructions.' } } : entry) }), /frozen catalog/);
  const adapted = structuredClone(accepted); adapted.policy.profiles[0].useInstructionsOnly = true;
  adapted.resolution = resolveDeliveryExecutionProfile(adapted.policy); adapted.definition.adapted = true; adapted.profileSnapshots[0].definition.adapted = true;
  assert.deepEqual(validateDeliveryExecutionSnapshot(adapted), adapted);
});

test('execution snapshot routing binds valid rules and authorized overrides without optional receipt leakage', () => {
  const configured = executionFixture(); configured.policy.routing = [{ id: 'patches', profile: 'reviewer', modes: ['patch'] }];
  const resolution = resolveDeliveryExecutionProfile(configured.policy, undefined, { mode: 'patch' });
  const routed = { ...configured, resolution, selection: deliveryExecutionProfileSelection(resolution.profile) };
  assert.deepEqual(validateDeliveryExecutionSnapshot(routed), routed);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...routed, resolution: { ...resolution, ruleId: ['patches'] } }), /receipt/);
  assert.throws(() => validateDeliveryExecutionSnapshot({ ...configured, resolution: { ...configured.resolution, ruleId: 'patches' } }), /receipt/);
  configured.policy.allowedOverrides = ['reviewer'];
  const overridden = { ...configured, resolution: resolveDeliveryExecutionProfile(configured.policy, 'reviewer'), selection: routed.selection };
  assert.deepEqual(validateDeliveryExecutionSnapshot(overridden), overridden);
});
