import { testErrorCode } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { OrchestratorApplication } from '../../../src/orchestrator/dist/orchestrator/application.js';
import { validateLineCapabilities } from '../../../src/orchestrator/dist/shared/capabilities.js';
import { repositoryScope } from '../../../src/orchestrator/dist/shared/validation.js';
const task = extra => ({ project: 'line', title: 'Repository work', criteria: ['Keep repository identity'], provider: 'codex', executionMode: 'cli', ...extra });
function worker(store, repositoryIds, legacyRepository = false, mode = 'cli') {
  const registration = store.register('line', [{ id: 'profile', provider: 'codex', mode }], { maxParallel: 1, order: 'fifo', maxAttempts: 1, configHash: 'immutable-policy', ...(repositoryIds === undefined ? {} : { repositoryIds, legacyRepository }) });
  return { ...registration, record: store.worker(registration.token) };
}
function fixture(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }

test('automatic and fixed routing leave incompatible repository tasks queued for capable workers', t => {
  const store = fixture(t), frontend = worker(store, ['frontend']), backend = worker(store, ['backend']);
  const backTask = store.submit(task({ repository: 'backend', priority: 2 }), 'backend');
  const frontTask = store.submit(task({ repository: 'frontend' }), 'frontend');
  store.routeTask('line', backTask.id, { workerId: frontend.id });
  assert.equal(store.claim(frontend.record, 'front').id, frontTask.id);
  assert.equal(store.claim(backend.record, 'wrong-fixed'), null); assert.equal(store.get(backTask.id).status, 'queued');
  store.routeTask('line', backTask.id, { workerId: null });
  assert.equal(store.claim(backend.record, 'back').id, backTask.id);
  assert.equal(store.get(backTask.id).attempt, 1);
});

test('dynamic assignment changes persist independently of execution policy and stale worker objects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-affinity-')), database = join(directory, 'store.sqlite');
  let store = new Store(database); t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const registered = worker(store, ['frontend']);
  assert.equal(store.claim(registered.record, 'advertise-removal', 0, [], false), null);
  const item = store.submit(task({ repository: 'frontend' }), 'front');
  assert.equal(store.claim(registered.record, 'stale-object-omission'), null);
  assert.equal(store.worker(registered.token).config.configHash, 'immutable-policy');
  store.close(); store = new Store(database);
  assert.deepEqual(store.worker(registered.token).config.repositoryIds, []);
  assert.equal(store.claim(store.worker(registered.token), 'after-restart'), null);
  const claimed = store.claim(store.worker(registered.token), 'advertise-addition', 0, ['frontend'], false);
  assert.equal(claimed.id, item.id);
  assert.equal(store.claim(registered.record, 'advertise-addition', 0, ['backend'], false).lease, claimed.lease);
  assert.deepEqual(store.worker(registered.token).config.repositoryIds, ['frontend']);
  assert.equal(store.worker(registered.token).config.configHash, 'immutable-policy');
});

test('legacy checkout capability accepts implicit CLI tasks but never an explicit repository selector', t => {
  const store = fixture(t), legacy = worker(store, [], true);
  const explicit = store.submit(task({ repository: 'line', priority: 2 }), 'explicit');
  const implicit = store.submit(task(), 'implicit');
  const first = store.claim(legacy.record, 'legacy'); assert.equal(first.id, implicit.id);
  store.abandon(legacy.record, first.id, first.lease, first.attempt);
  assert.equal(store.claim(legacy.record, 'explicit-is-not-legacy'), null); assert.equal(store.get(explicit.id).attempt, 0);
  assert.equal(store.claim(legacy.record, 'assigned-line', 0, ['line'], false).id, explicit.id);
});

test('empty scope preserves unscoped simulations while older unadvertised clients retain compatibility', t => {
  const store = fixture(t), simulation = worker(store, [], false, 'mock');
  const scoped = store.submit(task({ repository: 'unknown', executionMode: 'mock', priority: 2 }), 'scoped');
  const plain = store.submit(task({ executionMode: 'mock' }), 'plain');
  assert.equal(store.claim(simulation.record, 'sim').id, plain.id); assert.equal(store.get(scoped.id).attempt, 0);
  const old = worker(store, undefined, false, 'mock'); assert.equal(store.claim(old.record, 'old').id, scoped.id);
});

test('worker claim application validates bounded repository announcements before changing persisted scope', t => {
  const store = fixture(t), registered = worker(store, ['frontend']), app = new OrchestratorApplication(store, 'line');
  const operations = app.worker(registered.token);
  for (const body of [{ repositoryIds: null }, { repositoryIds: ['../bad'] }, { repositoryIds: ['same', 'same'] }, { repositoryIds: Array.from({ length: 65 }, (_, i) => 'repo-' + i) }, { repositoryIds: [], legacyRepository: ['true'] }, { legacyRepository: true }]) {
    assert.throws(() => operations.claim({ requestId: 'invalid', ...body }), error => testErrorCode(error) === 'invalid_input');
    assert.deepEqual(store.worker(registered.token).config.repositoryIds, ['frontend']);
  }
  const item = store.submit(task({ repository: 'backend' }), 'back');
  assert.equal(operations.claim({ requestId: 'valid', repositoryIds: ['backend'], legacyRepository: false }).task.id, item.id);
  assert.deepEqual(repositoryScope([], undefined), { repositoryIds: [], legacyRepository: false });
});

test('observed repository capacity is scoped, includes safe legacy fallback and remains bounded', t => {
  const store = fixture(t); worker(store, ['frontend']); worker(store, [], true); worker(store, undefined);
  const app = new OrchestratorApplication(store, 'line'), capability = app.capabilities();
  assert.deepEqual(validateLineCapabilities(capability), capability);
  assert.ok(capability.repositoryCapacity.some(row => row.repositoryId === 'frontend' && !row.implicitOnly));
  assert.ok(capability.repositoryCapacity.some(row => row.repositoryId === 'line' && row.implicitOnly));
  assert.ok(capability.repositoryCapacity.some(row => row.repositoryId === null));
  for (let batch = 0; batch < 5; batch++) worker(store, Array.from({ length: 64 }, (_, i) => `batch-${batch}-repository-${i}`));
  const bounded = app.capabilities(); assert.equal(bounded.repositoryCapacity.length, 260); assert.equal(bounded.repositoryCapacityTruncated, true);
  validateLineCapabilities(bounded);
  assert.throws(() => validateLineCapabilities({ ...capability, repositoryCapacity: [{ repositoryId: null, implicitOnly: true, provider: 'codex', mode: 'cli', slotsAvailable: 1 }] }), /implicit/);
  assert.throws(() => validateLineCapabilities({ ...capability, repositoryCapacity: [...capability.repositoryCapacity, capability.repositoryCapacity[0]] }), /Inconsistent/);
});
