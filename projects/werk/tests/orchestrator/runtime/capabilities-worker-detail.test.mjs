import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { OrchestratorApplication } from '../../../src/orchestrator/dist/orchestrator/application.js';
import { validateLineCapabilities } from '../../../src/orchestrator/dist/shared/capabilities.js';
const admin = 'capabilities-admin-'.repeat(3), enrollment = 'capabilities-enrollment-'.repeat(3);
const profile = (id = 'default', provider = 'claude', maxParallel = 1) => ({ id, provider, mode: 'mock', maxParallel });
async function fixture(t, project = 'alpha') {
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, adminToken: admin, enrollmentToken: enrollment, project });
  t.after(() => app.close());
  const url = 'http://127.0.0.1:' + app.server.address().port;
  const request = async (path, token = admin, body) => {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': 'http-test-' + crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json() };
  };
  return { ...app, request };
}
test('authenticated capability endpoint reports actual registered mock profiles and observed capacity', async t => {
  const app = await fixture(t);
  const empty = await app.request('/v1/capabilities');
  assert.equal(empty.status, 200); assert.equal(empty.value.execution, 'mock');
  assert.deepEqual(empty.value.intake, ['structured_task', 'requirement_ref']); assert.equal(empty.value.context, 'unbound');
  assert.deepEqual(empty.value.providers, []); assert.equal(empty.value.capacity.workers.total, 0);
  app.store.register('alpha', [profile('claude-slot', 'claude', 2), profile('codex-slot', 'codex')], { maxParallel: 2, order: 'priority', configHash: 'capabilities-test' });
  const foreign = app.store.register('foreign', [profile('foreign-only', 'codex')]);
  app.store.submit({ project: 'foreign', title: 'Not this production line', criteria: ['Remain isolated'] }, 'foreign-task');
  const result = await app.request('/v1/capabilities');
  assert.deepEqual(result.value.providers, ['claude', 'codex']);
  assert.equal(result.value.profiles.length, 2); assert.ok(!JSON.stringify(result.value).includes('foreign-only'));
  assert.equal(result.value.capacity.kind, 'observed'); assert.equal(result.value.capacity.workers.total, 1);
  assert.equal(result.value.capacity.workers.slotsTotal, 2);
  const overview = (await app.request('/v1/overview')).value;
  assert.equal(overview.tasks.total, 0); assert.equal(overview.workers.total, 1);
  assert.deepEqual(overview.capabilities.profiles, result.value.profiles);
  assert.equal((await app.request('/v1/workers/' + foreign.id)).status, 404);
  assert.deepEqual(validateLineCapabilities(result.value, 'alpha'), result.value);
});
test('capability and worker detail routes reject anonymous, enrollment and worker credentials', async t => {
  const app = await fixture(t);
  const worker = app.store.register('alpha', [profile()]);
  for (const token of ['', 'wrong-admin', enrollment, worker.token]) {
    assert.equal((await app.request('/v1/capabilities', token)).status, 401);
    assert.equal((await app.request('/v1/workers/' + worker.id, token)).status, 401);
  }
  assert.equal((await app.request('/v1/capabilities?project=foreign')).status, 400);
  assert.equal((await app.request('/v1/workers/' + worker.id + '?token=hidden')).status, 400);
  assert.equal((await app.request('/v1/workers/unknown-worker')).status, 404);
});
test('worker detail exposes bounded operational fields but excludes tokens, config hashes and lease authority', async t => {
  const app = await fixture(t);
  const registered = app.store.register('alpha', [profile('parallel', 'claude', 8)], { maxParallel: 8, order: 'fifo', maxAttempts: 2, configHash: 'CONFIG_SECRET_NOT_FOR_DETAILS' });
  const identity = app.store.worker(registered.token);
  const leases = [];
  for (let i = 0; i < 8; i++) {
    app.store.submit({ project: 'alpha', title: 'Private task title ' + i, criteria: ['Private task payload'] }, 'task-' + i);
    leases.push(app.store.claim(identity, 'claim-' + i).lease);
  }
  const response = await app.request('/v1/workers/' + registered.id);
  assert.equal(response.status, 200); const detail = response.value;
  assert.equal(detail.project, 'alpha'); assert.equal(detail.online, true);
  assert.deepEqual(detail.config, { maxParallel: 8, order: 'fifo', maxAttempts: 2 });
  assert.equal(detail.activeTasks.length, 8); assert.equal(detail.activeTasksTruncated, false);
  assert.ok(detail.activeTasks.every(task => task.status === 'running' && task.attempt === 1 && task.expiresAt > detail.seen));
  const serialized = JSON.stringify(detail);
  for (const secret of [registered.token, 'CONFIG_SECRET_NOT_FOR_DETAILS', 'Private task', ...leases]) assert.ok(!serialized.includes(secret));
  assert.ok(!('token_hash' in detail));
  app.store.clock = () => Date.now() + 120000;
  const offline = (await app.request('/v1/workers/' + registered.id)).value;
  assert.equal(offline.online, false); assert.deepEqual(offline.activeTasks, []);
});
test('bound intake capabilities match configured policy without claiming live provider execution', async t => {
  const app = await fixture(t);
  const application = new OrchestratorApplication(app.store, 'alpha', { assertOpen() {}, async resolve() { throw Error('No resolver call expected'); } });
  const capability = application.capabilities();
  assert.equal(capability.context, 'pinned'); assert.equal(capability.execution, 'mock');
  assert.deepEqual(capability.intake, ['requirement_ref', 'pinned_iteration']);
});
test('profile discovery stays bounded and advertises truncation independently of observed capacity', async t => {
  const app = await fixture(t);
  for (let worker = 0; worker < 9; worker++) app.store.register('alpha', Array.from({ length: 8 }, (_, index) => profile(`worker-${worker}-profile-${index}`, index % 2 ? 'codex' : 'claude')));
  const capability = (await app.request('/v1/capabilities')).value;
  assert.equal(capability.profiles.length, 64); assert.equal(capability.profilesTruncated, true);
  assert.deepEqual(capability.providers, ['claude', 'codex']); assert.equal(capability.capacity.workers.total, 9);
  assert.ok(Buffer.byteLength(JSON.stringify(capability)) < 16384);
});
test('unbound task intake enforces configured project while preserving unresolved Wikilink intake', async t => {
  const app = await fixture(t);
  const foreign = await app.request('/v1/tasks', admin, { project: 'beta', title: 'Wrong line', criteria: ['Rejected'] });
  assert.equal(foreign.status, 403); assert.equal(app.store.list().length, 0);
  const own = await app.request('/v1/tasks', admin, { project: 'alpha', requirementRef: '[[Feature]]' });
  assert.equal(own.status, 201); assert.equal(own.value.project, 'alpha'); assert.equal(own.value.context, undefined);
});
