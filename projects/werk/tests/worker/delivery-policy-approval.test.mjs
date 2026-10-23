import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { emptyDeliveryPolicyApprovals, changeDeliveryPolicyApproval, validateDeliveryPolicyApprovals, deliveryPolicyRequiresApproval, deliveryPolicyApproved, assertDeliveryPolicyApproved } from '../../src/worker/dist/worker/application/delivery-policy-approval.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { DeliveryPolicyApprovals } from '../../src/worker/dist/worker/infrastructure/delivery-policy-approvals.js';
import { readDeliveryPolicyDraft, saveDeliveryPolicyDraft } from '../../src/worker/dist/worker/infrastructure/delivery-policy-draft.js';
import { readDeliveryPolicy } from '../../src/worker/dist/worker/infrastructure/delivery-policy.js';
import { cleanup } from './fixture-cleanup.mjs';

prepareNativeProcessFixture();

const at = '2026-10-20T10:00:00.000Z';
const expanded = () => ({ ...defaultDeliveryProjectPolicy(), coordination: { maxActiveRequests: 2, dependencyPlanning: /** @type {const} */ ('topological') } });
const approve = (digest, revision = 1, repositoryId = 'project-one') => ({ action: 'approve', repositoryId, configurationDigest: digest, expectedRevision: revision });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const signal = () => new AbortController().signal;
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-policy-authority-'));
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('expanded policy requires exact local repository grant; legacy snapshots retain their original authority', () => {
  const state = emptyDeliveryPolicyApprovals(), snapshot = deliveryPolicySnapshot(expanded(), 'a'.repeat(40));
  assert.equal(deliveryPolicyRequiresApproval(defaultDeliveryProjectPolicy()), false);
  assert.equal(deliveryPolicyApproved(state, 'project-one', deliveryPolicySnapshot(defaultDeliveryProjectPolicy(), 'a'.repeat(40))), true);
  assert.throws(() => assertDeliveryPolicyApproved(state, 'project-one', snapshot), /local operator approval/);
  const authorized = changeDeliveryPolicyApproval(state, approve(snapshot.configurationDigest), at);
  assert.equal(authorized.revision, 2);
  assert.equal(deliveryPolicyApproved(authorized, 'project-one', snapshot), true);
  assert.equal(deliveryPolicyApproved(authorized, 'project-two', snapshot), false);
  const revised = expanded(); revised.coordination.maxActiveRequests = 3;
  assert.equal(deliveryPolicyApproved(authorized, 'project-one', deliveryPolicySnapshot(revised, 'b'.repeat(40))), false);
  assert.equal(deliveryPolicyApproved(authorized, 'project-one', deliveryPolicySnapshot(expanded(), 'b'.repeat(40))), true);
  assert.deepEqual(state, emptyDeliveryPolicyApprovals());
});

test('approval commands enforce optimistic revision and exact revocation without granting other pinned versions', () => {
  const digest = 'a'.repeat(64), second = 'b'.repeat(64);
  const state = changeDeliveryPolicyApproval(emptyDeliveryPolicyApprovals(), approve(digest), at);
  assert.throws(() => changeDeliveryPolicyApproval(state, approve(second), at), /changed/);
  assert.deepEqual(changeDeliveryPolicyApproval(state, approve(digest, 2), at), state);
  const both = changeDeliveryPolicyApproval(state, approve(second, 2), at);
  const revoked = changeDeliveryPolicyApproval(both, { ...approve(digest, 3), action: 'revoke' }, at);
  assert.deepEqual(revoked.approvals.map(item => item.configurationDigest), [second]);
  assert.equal(revoked.history.at(-1).action, 'revoke');
  for (const input of [{ ...approve(digest), action: 'trust-all' }, { ...approve(digest), configurationDigest: '*' }, { ...approve(digest), expectedRevision: 0 }, { ...approve(digest), providerToken: 'not-policy' }])
    assert.throws(() => changeDeliveryPolicyApproval(emptyDeliveryPolicyApprovals(), input, at));
  assert.throws(() => validateDeliveryPolicyApprovals({ ...both, approvals: [...both.approvals, both.approvals[0]] }), /duplicate/);
  assert.throws(() => validateDeliveryPolicyApprovals({ ...both, history: [...both.history].reverse() }), /ordered/);
});

test('private approval writes serialize stale clients and survive restart with detached views', async t => {
  const directory = await temporary(t), store = new DeliveryPolicyApprovals(directory);
  assert.throws(() => store.view(), /loading/);
  await store.init();
  const outcomes = await Promise.allSettled([store.change(approve('a'.repeat(64)), at), store.change(approve('b'.repeat(64)), at)]);
  assert.deepEqual(outcomes.map(item => item.status), ['fulfilled', 'rejected']);
  const view = store.view(); view.approvals.length = 0;
  assert.equal(store.view().approvals.length, 1);
  await store.close();
  const restored = new DeliveryPolicyApprovals(directory); await restored.init();
  assert.deepEqual(restored.view(), store.view()); await restored.close();
  await writeFile(join(directory, 'delivery-policy-approvals.json'), '{private-secret-invalid');
  await assert.rejects(new DeliveryPolicyApprovals(directory).init(), error => error instanceof Error && !error.message.includes('private-secret') && /not valid JSON/.test(error.message));
});

test('draft edits preserve HEAD and unrelated work; stale writes cannot overwrite a newer edit or become committed authority', async t => {
  const directory = await temporary(t);
  git(directory, 'init', '-b', 'main'); git(directory, 'config', 'user.name', 'Fixture'); git(directory, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(directory, 'source.txt'), 'base\n'); git(directory, 'add', '.'); git(directory, 'commit', '-m', 'Baseline');
  const head = git(directory, 'rev-parse', 'HEAD');
  await writeFile(join(directory, 'source.txt'), 'developer dirty work\n');
  const first = await readDeliveryPolicyDraft(directory, signal());
  assert.equal(first.exists, false); assert.equal(first.fileDigest, null);
  const saved = await saveDeliveryPolicyDraft(directory, null, expanded(), signal());
  assert.equal(saved.isCommitted, false); assert.equal(saved.configuration.coordination.maxActiveRequests, 2);
  assert.equal((await readDeliveryPolicy(directory, signal())).configuration.coordination, undefined);
  await assert.rejects(saveDeliveryPolicyDraft(directory, null, defaultDeliveryProjectPolicy(), signal()), /changed|EEXIST/);
  assert.equal(git(directory, 'rev-parse', 'HEAD'), head); assert.equal(git(directory, 'diff', '--cached'), '');
  assert.equal(await readFile(join(directory, 'source.txt'), 'utf8'), 'developer dirty work\n');
  await writeFile(join(directory, '.werk/delivery-policy.json'), '{ malformed draft');
  const malformed = await readDeliveryPolicyDraft(directory, signal());
  assert.equal(malformed.configuration, null); assert.match(malformed.validationError, /valid JSON/);
  const repaired = await saveDeliveryPolicyDraft(directory, malformed.fileDigest, defaultDeliveryProjectPolicy(), signal());
  assert.equal(repaired.isCommitted, true);
});

test('policy draft refuses linked paths rather than writing outside the assigned checkout', { skip: process.platform === 'win32' ? 'Creating symlinks requires an elevated Windows token.' : false }, async t => {
  const directory = await temporary(t), external = join(directory, 'outside'), repository = join(directory, 'repo');
  await mkdir(external); await mkdir(repository);
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'source.txt'), 'base'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  await symlink(external, join(repository, '.werk'));
  await assert.rejects(saveDeliveryPolicyDraft(repository, null, expanded(), signal()), /directory|symbolic|changed/i);
  await assert.rejects(readFile(join(external, 'delivery-policy.json')), { code: 'ENOENT' });
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
