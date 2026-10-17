import { testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicWorkerPolicy } from '../../../src/orchestrator/dist/shared/protocol.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';

/** @satisfies {import('../../../src/orchestrator/dist/shared/protocol.js').PublicWorkerPolicy} */
const publicPolicy = { maxParallel: 1, order: 'fifo', maxAttempts: 2, queueCapacity: 3, repositoryIds: ['backend'], legacyRepository: false };
const hash = 'PRIVATE_CONFIGURATION_IDENTITY';
/** @returns {import('../../../src/orchestrator/dist/shared/contracts.js').WorkerPolicy & {futurePrivateField: {token: string}}} */
const privatePolicy = () => ({ ...publicPolicy, repositoryIds: [...publicPolicy.repositoryIds], configHash: hash, futurePrivateField: { token: 'FUTURE_PRIVATE_SENTINEL' } });

test('public worker policy projection allowlists operational fields without sharing mutable repository scope', () => {
  const privateValue = privatePolicy(), view = publicWorkerPolicy(privateValue);
  assert.deepEqual(view, publicPolicy);
  view.repositoryIds.push('frontend');
  assert.deepEqual(privateValue.repositoryIds, ['backend']);
  assert.deepEqual(publicWorkerPolicy({ maxParallel: 1, order: 'priority', maxAttempts: 3, configHash: hash }), { maxParallel: 1, order: 'priority', maxAttempts: 3 });
});

test('both worker list routes redact private policy while detail and authenticated scheduling retain their contracts', async t => {
  const adminToken = 'worker-summary-admin-'.repeat(3), enrollmentToken = 'worker-summary-enrollment-'.repeat(3);
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken, enrollmentToken });
  t.after(() => app.close());
  const workerProfiles = [{ id: 'codex-slot', provider: 'codex', mode: 'mock' }];
  const workers = Array.from({ length: 2 }, () => app.store.register('demo', workerProfiles, { ...publicPolicy, configHash: hash }));
  // Model a future private policy field already stored by a newer deployment.
  for (const worker of workers) app.store.db.prepare('UPDATE workers SET config=? WHERE id=?').run(JSON.stringify(privatePolicy()), worker.id);
  const base = 'http://127.0.0.1:' + testListeningAddress(app.server).port;
  const get = async path => {
    const response = await fetch(base + path, { headers: { Authorization: 'Bearer ' + adminToken } });
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const secret of [hash, 'configHash', 'futurePrivateField', 'FUTURE_PRIVATE_SENTINEL', ...workers.map(worker => worker.token)]) assert.ok(!text.includes(secret), secret);
    return JSON.parse(text);
  };
  const all = await get('/v1/workers');
  assert.equal(all.workers.length, 2);
  const first = await get('/v1/workers?limit=1');
  assert.equal(first.hasMore, true);
  const second = await get('/v1/workers?limit=1&cursor=' + first.nextCursor);
  assert.equal(second.hasMore, false); assert.equal(second.nextCursor, null);
  const paged = [...first.workers, ...second.workers];
  assert.deepEqual(paged.map(worker => worker.id).sort(), workers.map(worker => worker.id).sort());
  for (const worker of [...all.workers, ...paged]) {
    assert.deepEqual(worker.config, publicPolicy);
    assert.equal(worker.online, true);
    assert.equal(worker.project, 'demo');
    assert.equal(worker.profiles[0].id, 'codex-slot');
  }
  assert.deepEqual(app.store.worker(workers[0].token).config, privatePolicy(), 'public reads must not rewrite private persisted policy');
  // Scheduling/detail still validate the supported policy schema; restore that
  // schema after the forward-field redaction probe, retaining its private hash.
  const supported = { ...publicPolicy, configHash: hash };
  app.store.db.prepare('UPDATE workers SET config=? WHERE id=?').run(JSON.stringify(supported), workers[0].id);
  const detail = await get('/v1/workers/' + workers[0].id);
  assert.deepEqual(detail.config, { maxParallel: 1, order: 'fifo', maxAttempts: 2 });
  const authenticated = app.store.worker(workers[0].token);
  assert.deepEqual(authenticated.config, supported);
  const submitted = app.store.submit({ project: 'demo', repository: 'backend', title: 'Assigned feature', criteria: ['Ready'], provider: 'codex' }, 'summary-contract');
  const assigned = app.store.claim(authenticated, 'summary-claim');
  assert.equal(assigned.id, submitted.id);
  assert.equal(assigned.workerId, authenticated.id);
  assert.equal(app.store.db.prepare('SELECT config_hash FROM attempts WHERE task=?').get(assigned.id).config_hash, hash);
});
