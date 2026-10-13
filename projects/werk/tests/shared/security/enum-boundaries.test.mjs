import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { validateOverview } from '../../../src/factory/dist/shared/factory.js';
import { validateLineCapabilities } from '../../../src/factory/dist/shared/capabilities.js';

const admin = 'enum-test-admin-'.repeat(3), enrollment = 'enum-test-enrollment-'.repeat(3);
const invalidModes = [['mock'], ['cli'], [['mock']], {}, null, true, 1];

test('HTTP rejects non-string execution modes before persistence and valid modes remain claimable', async () => {
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken: admin, enrollmentToken: enrollment });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, token, body, key) => fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
  const input = { project: 'demo', title: 'Strict execution mode', criteria: ['Use a supported mode'], provider: 'codex' };
  try {
    for (const mode of invalidModes) {
      const task = await post('/v1/tasks', admin, { ...input, executionMode: mode }, 'reusable-invalid-mode');
      assert.equal(task.status, 400); await task.json();
      const worker = await post('/v1/workers/register', enrollment, { profiles: [{ id: 'default', provider: 'codex', mode }] });
      assert.equal(worker.status, 400); await worker.json();
    }
    assert.deepEqual(app.store.list(), []);
    assert.deepEqual(app.store.workers(), []);
    for (const [index, mode] of ['mock', 'cli'].entries()) {
      const created = await post('/v1/tasks', admin, { ...input, executionMode: mode }, index ? 'valid-live-mode' : 'reusable-invalid-mode');
      assert.equal(created.status, 201);
      const task = await created.json(); assert.equal(task.executionMode, mode);
      const registered = await post('/v1/workers/register', enrollment, { profiles: [{ id: mode, provider: 'codex', mode }] });
      assert.equal(registered.status, 201);
      const worker = await registered.json();
      const claimed = await post('/v1/worker/assignments/next', worker.token, { requestId: 'valid-mode-' + mode });
      assert.equal(claimed.status, 200);
      const assignment = (await claimed.json()).task;
      assert.equal(assignment.id, task.id); assert.equal(assignment.executionMode, mode);
    }
    assert.equal(app.store.list().length, 2);
  } finally { await app.close(); }
});

const counts = () => ({ total: 1, online: 1, offline: 0, slotsTotal: 1, slotsBusy: 0, slotsAvailable: 1 });
const capabilities = () => ({ schemaVersion: 1, project: 'demo', execution: 'mock', context: 'unbound', intake: ['structured_task', 'requirement_ref'], providers: ['codex'], profiles: [{ id: 'default', provider: 'codex', mode: 'mock' }], profilesTruncated: false, capacity: { kind: 'observed', observedAt: '2026-10-13T10:00:00.000Z', workers: counts() } });
const overview = () => ({ schemaVersion: 1, observedAt: '2026-10-13T10:00:00.000Z', mode: 'mock', project: 'demo', tasks: { total: 0, queued: 0, running: 0, simulated: 0, blocked: 0 }, workers: counts(), snapshots: { total: 0, before: 0, after: 0 } });

test('remote overview and capability enums reject array coercion without losing supported strings', () => {
  assert.equal(validateOverview(overview()).mode, 'mock');
  assert.deepEqual(validateLineCapabilities(capabilities()), capabilities());
  for (const mode of invalidModes) {
    assert.throws(() => validateOverview({ ...overview(), mode }), error => error.code === 'invalid_input');
    assert.throws(() => validateLineCapabilities({ ...capabilities(), execution: mode }), error => error.code === 'invalid_input');
    assert.throws(() => validateLineCapabilities({ ...capabilities(), profiles: [{ id: 'default', provider: 'codex', mode }] }), error => error.code === 'invalid_input');
  }
  for (const context of [['unbound'], ['pinned'], {}, null]) assert.throws(() => validateLineCapabilities({ ...capabilities(), context }), error => error.code === 'invalid_input');
  assert.throws(() => validateLineCapabilities({ ...capabilities(), profiles: [{ id: 'default', provider: ['codex'], mode: 'mock' }] }), error => error.code === 'invalid_input');
});
