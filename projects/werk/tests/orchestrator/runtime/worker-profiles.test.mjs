import { testErrorCode, testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { workerProfilesUpdate } from '../../../src/orchestrator/dist/shared/contracts.js';
import { SnapshotJournal } from '../../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

/** @type {import('../../../src/orchestrator/dist/shared/contracts.js').Profile[]} */
const oldProfiles = [{ id: 'old-claude', provider: 'claude', mode: 'mock', maxParallel: 1 }];
/** @type {import('../../../src/orchestrator/dist/shared/contracts.js').Profile[]} */
const nextProfiles = [{ id: 'new-codex', provider: 'codex', mode: 'mock', maxParallel: 1 }];
const configurationHash = 'b'.repeat(64);
const update = { profiles: nextProfiles, expectedConfigurationHash: 'default', configurationHash };
const input = { project: 'demo', title: 'Profile authority', criteria: ['Preserve accepted attempt identity'], provider: 'auto' };
const conflict = error => error.code === 'conflict';
function fixture(t, policy) {
  const store = new Store(':memory:'), auth = store.register('demo', oldProfiles, policy), worker = store.worker(auth.token);
  t.after(() => store.close());
  return { store, auth, worker };
}

test('profile update preserves worker identity, routing policy and history, then rejects stale claims', t => {
  const policy = { configHash: 'default', maxParallel: 1, queueCapacity: 2, order: 'fifo', maxAttempts: 2, repositoryIds: ['app'], legacyRepository: false };
  const { store, auth, worker } = fixture(t, policy);
  const beforeSeen = worker.seen;
  assert.deepEqual(store.updateProfiles(worker, update), { profiles: nextProfiles, configurationHash });
  const current = store.worker(auth.token);
  assert.equal(current.id, auth.id); assert.equal(current.seen, beforeSeen);
  assert.deepEqual(current.config, { ...policy, configHash: configurationHash });
  assert.equal(store.workers().length, 1);
  const task = store.submit(input, 'new');
  assert.throws(() => store.claim(worker, 'stale'), conflict);
  assert.equal(store.get(task.id).status, 'queued');
  const assigned = store.claim(current, 'fresh');
  assert.equal(assigned.profile, 'new-codex');
  assert.deepEqual({ ...store.db.prepare('SELECT config_hash,provider,mode FROM attempts').get() }, { config_hash: configurationHash, provider: 'codex', mode: 'mock' });
  assert.deepEqual(store.updateProfiles(worker, update), { profiles: nextProfiles, configurationHash });
  assert.equal(store.get(task.id).lease, assigned.lease, 'lost update response can be retried without altering an active assignment');
  assert.throws(() => store.updateProfiles(current, { ...update, profiles: oldProfiles }), conflict);
  assert.throws(() => store.updateProfiles(current, { ...update, expectedConfigurationHash: 'stale', configurationHash: 'c'.repeat(64) }), conflict);
});

test('accepted queued assignments block profile edits and transaction failures leave both profiles and hash unchanged', t => {
  const { store, worker } = fixture(t, { maxParallel: 1, queueCapacity: 1, order: 'fifo', maxAttempts: 3, configHash: 'default' });
  store.submit(input, 'first'); store.submit(input, 'second');
  const first = store.claim(worker, 'first'), queued = store.claim(worker, 'second');
  assert.ok(first); assert.ok(queued);
  assert.throws(() => store.updateProfiles(worker, update), conflict);
  store.abandon(worker, first.id, first.lease, first.attempt);
  assert.throws(() => store.updateProfiles(worker, update), conflict);
  store.abandon(worker, queued.id, queued.lease, queued.attempt);
  const original = store.db.prepare('SELECT profiles,config FROM workers WHERE id=?').get(worker.id);
  store.db.exec("CREATE TRIGGER refuse_profiles BEFORE UPDATE OF profiles ON workers BEGIN SELECT RAISE(ABORT,'controlled update failure'); END;");
  assert.throws(() => store.updateProfiles(worker, update), /controlled update failure/);
  assert.deepEqual(store.db.prepare('SELECT profiles,config FROM workers WHERE id=?').get(worker.id), original);
  store.db.exec('DROP TRIGGER refuse_profiles');
  store.updateProfiles(worker, update);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count, 2);
});

test('removed and repurposed profiles cannot change late snapshot authority or historical configuration hashes', t => {
  const { store, auth, worker } = fixture(t);
  store.submit(input, 'historical'); const task = store.claim(worker, 'original');
  const journal = new SnapshotJournal(tmpdir(), 'default', 'fixture'); t.after(() => journal.close());
  const status = { lastContact: null, heartbeatErrors: 0 };
  const before = journal.capture(task, worker.id, oldProfiles[0], status, 'before');
  const after = journal.capture(task, worker.id, oldProfiles[0], status, 'after', before, 'interrupted');
  const attempt = store.db.prepare('SELECT * FROM attempts').get();
  store.abandon(worker, task.id, task.lease, task.attempt);
  store.updateProfiles(worker, update);
  let current = store.worker(auth.token);
  assert.equal(store.snapshot(current, before).id, before.id);
  assert.equal(store.snapshot(current, after).id, after.id);
  assert.throws(() => store.snapshot(current, { ...before, provider: 'codex' }), error => testErrorCode(error) === 'forbidden');
  assert.throws(() => store.snapshot(current, { ...before, provenance: { ...before.provenance, configurationHash } }), error => testErrorCode(error) === 'forbidden');
  store.updateProfiles(current, { expectedConfigurationHash: configurationHash, configurationHash: 'c'.repeat(64), profiles: [{ ...nextProfiles[0], id: oldProfiles[0].id }] });
  current = store.worker(auth.token);
  assert.equal(store.snapshot(current, before).id, before.id);
  assert.throws(() => store.snapshot(current, { ...before, provider: 'codex' }), error => testErrorCode(error) === 'forbidden');
  assert.deepEqual(store.db.prepare('SELECT * FROM attempts').get(), attempt);
  assert.throws(() => store.finish(current, task.id, task.lease, task.attempt), conflict);
});

test('profile endpoint authenticates its own worker and rejects authority, capacity and hash overrides', async t => {
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken: 'a'.repeat(32), enrollmentToken: 'e'.repeat(32) });
  t.after(() => app.close());
  const auth = app.store.register('demo', oldProfiles), other = app.store.register('demo', oldProfiles);
  const post = (token, body) => fetch('http://127.0.0.1:' + testListeningAddress(app.server).port + '/v1/worker/profiles', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const token of ['invalid', 'a'.repeat(32), 'e'.repeat(32)]) assert.equal((await post(token, update)).status, 401);
  for (const body of [{ ...update, workerId: other.id }, { ...update, policy: { maxParallel: 8 } }, { ...update, configurationHash: 'not-a-hash' }, { ...update, profiles: [] }, { ...update, profiles: [{ ...nextProfiles[0], mode: 'cli' }] }, { ...update, profiles: [{ ...nextProfiles[0], maxParallel: 2 }] }]) assert.equal((await post(auth.token, body)).status, 400);
  const result = await post(auth.token, update); assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { profiles: nextProfiles, configurationHash });
  assert.deepEqual(app.store.worker(other.token).profiles, oldProfiles);
  assert.equal((await post(auth.token, { ...update, profiles: oldProfiles })).status, 409);
  assert.equal((await post(auth.token, update)).status, 200);
});

test('profile edits cannot switch a configured execution mode or reinterpret a legacy mixed registration', t => {
  const { store, worker } = fixture(t);
  assert.throws(() => store.updateProfiles(worker, { ...update, profiles: [{ ...nextProfiles[0], mode: 'cli' }] }), error => testErrorCode(error) === 'invalid_input');
  const mixed = store.worker(store.register('demo', [oldProfiles[0], { ...nextProfiles[0], mode: 'cli' }]).token);
  assert.throws(() => store.updateProfiles(mixed, update), error => testErrorCode(error) === 'invalid_input');
  assert.deepEqual(store.workers().find(item => item.id === mixed.id).profiles, mixed.profiles);
});

test('profile validation enforces bounded IDs, unique profiles and the supported serial modes', () => {
  const invalid = [[], Array.from({ length: 9 }, (_, id) => ({ ...nextProfiles[0], id: 'p' + id })), [nextProfiles[0], nextProfiles[0]], [{ ...nextProfiles[0], id: '../escape' }], [{ ...nextProfiles[0], mode: ['mock'] }], [{ ...nextProfiles[0], mode: 'cli', provider: 'claude' }], [nextProfiles[0], { id: 'live', provider: 'codex', mode: 'cli' }], [{ ...nextProfiles[0], mode: 'cli' }, { id: 'second', provider: 'codex', mode: 'cli' }]];
  for (const profiles of invalid) assert.throws(() => workerProfilesUpdate({ ...update, profiles }), error => testErrorCode(error) === 'invalid_input');
  assert.equal(workerProfilesUpdate({ ...update, profiles: [{ id: 'live', provider: 'codex', mode: 'cli' }] }).profiles[0].maxParallel, 1);
});

for (const missing of [false, true]) test(`schema 6 migration ${missing ? 'keeps missing legacy authority fail-closed' : 'pins historical authority across later edits and reopen'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-profile-migration-'));
  const path = join(directory, 'state.sqlite'); let store = new Store(path);
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  const auth = store.register('demo', oldProfiles), worker = store.worker(auth.token);
  store.submit(input, 'legacy'); const task = store.claim(worker, 'legacy'); store.abandon(worker, task.id, task.lease, task.attempt);
  const journal = new SnapshotJournal(tmpdir(), 'default', 'fixture'); t.after(() => journal.close());
  const before = journal.capture(task, worker.id, oldProfiles[0], { lastContact: null, heartbeatErrors: 0 }, 'before');
  if (missing) store.db.prepare('UPDATE attempts SET profile=?').run('missing-profile');
  store.db.exec('ALTER TABLE attempts DROP COLUMN provider; ALTER TABLE attempts DROP COLUMN mode; PRAGMA user_version=6');
  store.close(); store = new Store(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
  const pins = store.db.prepare('SELECT provider,mode FROM attempts').get();
  if (missing) {
    assert.deepEqual({ ...pins }, { provider: null, mode: null });
    assert.throws(() => store.updateProfiles(store.worker(auth.token), update), conflict);
    assert.throws(() => store.snapshot(store.worker(auth.token), before), error => testErrorCode(error) === 'forbidden');
  } else {
    assert.deepEqual({ ...pins }, { provider: 'claude', mode: 'mock' });
    store.updateProfiles(store.worker(auth.token), update);
    assert.equal(store.snapshot(store.worker(auth.token), before).id, before.id);
  }
  store.close(); store = new Store(path);
  assert.deepEqual(store.db.prepare('SELECT provider,mode FROM attempts').get(), pins);
  assert.equal(store.worker(auth.token).id, auth.id);
});
