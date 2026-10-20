import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planDeliveryDependencies } from '../../src/worker/dist/worker/application/delivery-dependency-plan.js';
import { defaultDeliveryProjectPolicy, validateDeliveryProjectPolicy, deliveryGatePolicy, deliveryPolicySnapshot, validateDeliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultGatePolicy, evaluateGate, inputGateFacts } from '../../src/worker/dist/worker/application/request-gates.js';
import { readDeliveryPolicy, deliveryCommitInBaseline } from '../../src/worker/dist/worker/infrastructure/delivery-policy.js';
import { cleanup } from './fixture-cleanup.mjs';

prepareNativeProcessFixture();

const git = (repository, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const baseline = 'a'.repeat(40);
test('named profiles add proportional readiness without dropping trusted mandatory gates', () => {
  const config = validateDeliveryProjectPolicy(defaultDeliveryProjectPolicy());
  const base = defaultGatePolicy();
  const input = { kind: /** @type {const} */ ('patch'), title: 'Small fix', message: 'Fix the visible typo.', files: [{ path: 'src/value.ts', bytes: 1 }] };
  const feature = deliveryGatePolicy(base, deliveryPolicySnapshot(config, baseline, 'feature'));
  const lightweight = deliveryGatePolicy(base, deliveryPolicySnapshot(config, baseline, 'lightweight'));
  assert.equal(evaluateGate(feature, 'ready', 'patch', inputGateFacts(input)).passed, false);
  assert.equal(evaluateGate(lightweight, 'ready', 'patch', inputGateFacts(input)).passed, true);
  assert.equal(evaluateGate(feature, 'ready', 'patch', inputGateFacts({ ...input, criteria: ['The typo is corrected.'] })).passed, true);
  assert.deepEqual(lightweight.done, base.done);
  for (const rule of base.ready.patch) assert.ok(feature.ready.patch.some(item => item.id === rule.id));
  assert.throws(() => deliveryPolicySnapshot(config, baseline, 'untrusted'), /configured project profile/);
  const unsafe = structuredClone(config); unsafe.profiles[0].verificationInputs = ['../tests'];
  assert.throws(() => validateDeliveryProjectPolicy(unsafe), /safe repository-relative/);
  assert.ok(config.profiles.every(profile => profile.verificationInputs.includes('.werk/delivery-policy.json')));
});

test('dependency graph reports unknown, cyclic, ambiguous and accepted-but-unintegrated predecessors', async () => {
  const accepted = id => ({ id, requestId: 'request-' + id, inputRevision: 2, candidateCommit: 'b'.repeat(40), includesCode: true });
  const ports = { accepted, incorporated: async () => true };
  /** @type {Array<[import('../../src/worker/application/delivery-dependencies.js').DeliveryDependencyNode[], string]>} */
  const cases = [
    [[{ id: 'child', dependsOn: ['missing'] }], 'unknown'],
    [[{ id: 'child', dependsOn: ['parent'] }, { id: 'parent', dependsOn: ['child'] }], 'cycle'],
    [[{ id: 'child', dependsOn: [] }, { id: 'child', dependsOn: [] }], 'duplicate'],
  ];
  for (const [nodes, code] of cases) { const plan = await planDeliveryDependencies('child', nodes, baseline, ports); assert.equal(plan.ready, false); assert.equal(plan.blockers[0].code, code); }
  const graph = [{ id: 'child', dependsOn: ['parent'] }, { id: 'parent', dependsOn: [] }];
  const unaccepted = await planDeliveryDependencies('child', graph, baseline, { ...ports, accepted: () => undefined });
  assert.equal(unaccepted.ready, false); assert.equal(unaccepted.blockers[0].code, 'unaccepted');
  const unintegrated = await planDeliveryDependencies('child', graph, baseline, { ...ports, incorporated: async () => false });
  assert.equal(unintegrated.ready, false); assert.equal(unintegrated.blockers[0].code, 'not_integrated');
  const result = await planDeliveryDependencies('child', graph, baseline, ports);
  assert.equal(result.ready, true); assert.deepEqual(result.nodes.flatMap(node => node.receipt ? [node.receipt] : []), [{ ...accepted('parent'), baseline }]);
  const noCode = await planDeliveryDependencies('child', graph, baseline, { accepted: id => ({ id, requestId: id, inputRevision: 1, includesCode: false }), incorporated: async () => { throw Error('Non-code acceptance must not invent a commit.'); } });
  assert.equal(noCode.ready, true); assert.equal(noCode.nodes[0].receipt.includesCode, false);
});

test('project policy and dependency proofs read only committed baseline; dirty checkout is preserved', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-delivery-policy-'));
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  git(directory, 'init', '-b', 'main'); git(directory, 'config', 'user.name', 'Fixture'); git(directory, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(directory, 'source.txt'), 'baseline'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'Baseline');
  const first = git(directory, 'rev-parse', 'HEAD'), signal = new AbortController().signal;
  await mkdir(join(directory, '.werk'));
  await writeFile(join(directory, '.werk/delivery-policy.json'), '{ invalid private work');
  assert.equal((await readDeliveryPolicy(directory, signal)).configuration.defaultProfile, 'feature');
  const config = defaultDeliveryProjectPolicy(); config.profiles[0].maxRepairAttempts = 0;
  await writeFile(join(directory, '.werk/delivery-policy.json'), JSON.stringify(config)); git(directory, 'add', '.werk/delivery-policy.json'); git(directory, 'commit', '-m', 'Configure project');
  const second = git(directory, 'rev-parse', 'HEAD'), status = git(directory, 'status', '--porcelain=v1');
  assert.equal((await readDeliveryPolicy(directory, signal)).profile.maxRepairAttempts, 0);
  assert.equal((await readDeliveryPolicy(directory, signal, 'feature', first)).profile.maxRepairAttempts, 2);
  assert.equal(await deliveryCommitInBaseline(directory, first, second, signal), true);
  assert.equal(await deliveryCommitInBaseline(directory, second, first, signal), false);
  assert.equal(await deliveryCommitInBaseline(directory, 'bad-ref', first, signal), false);
  assert.equal(git(directory, 'status', '--porcelain=v1'), status);
  assert.equal(git(directory, 'rev-parse', 'HEAD'), second);
});

test('policy snapshots retain canonical protected paths and reject a changed selected profile', () => {
  const config = defaultDeliveryProjectPolicy();
  config.profiles[0].verificationInputs = Array.from({ length: 64 }, (_, index) => 'checks/case-' + index);
  const snapshot = deliveryPolicySnapshot(config, baseline);
  assert.equal(snapshot.profile.verificationInputs.length, 65);
  assert.deepEqual(validateDeliveryPolicySnapshot(snapshot), snapshot);
  const tampered = structuredClone(snapshot); tampered.profile.maxRepairAttempts = 0;
  assert.throws(() => validateDeliveryPolicySnapshot(tampered), /accepted snapshot/);
  const forged = structuredClone(snapshot); forged.configuration.defaultProfile = 'lightweight';
  assert.throws(() => validateDeliveryPolicySnapshot(forged), /accepted snapshot/);
  config.profiles[0].verificationInputs = ['.WERK/DELIVERY-POLICY.JSON'];
  assert.deepEqual(validateDeliveryProjectPolicy(config).profiles[0].verificationInputs, ['.werk/delivery-policy.json']);
  config.profiles[0].verificationInputs = ['tests/', 'TESTS/'];
  assert.throws(() => validateDeliveryProjectPolicy(config), /unique/);
});
