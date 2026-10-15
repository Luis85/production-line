import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { OrchestratorApplication } from '../../../src/orchestrator/dist/orchestrator/application.js';
import { resolveContext } from '../../../src/orchestrator/dist/orchestrator/context/resolver.js';
import { taskInput } from '../../../src/orchestrator/dist/shared/validation.js';
import { ToolCatalog, validateArguments } from '../../../src/orchestrator/dist/shared/mcp/catalog.js';

const admin = 'repository-selector-admin-'.repeat(2), enrollment = 'repository-selector-enrollment-'.repeat(2);
const input = { project: 'production-line', title: 'Change approved file', criteria: ['Reviewable change'], provider: 'codex', executionMode: 'cli' };

test('one production line retains independent repository selectors through HTTP intake, leasing and SQLite restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-task-repositories-'));
  const options = { db: join(directory, 'orchestrator.sqlite'), host: '127.0.0.1', port: 0, project: input.project, adminToken: admin, enrollmentToken: enrollment };
  let app = await startServer(options);
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, body, token = admin, key) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const created = [];
  for (const repository of ['frontend', 'backend']) {
    const response = await request('/v1/tasks', { ...input, repository }, admin, repository);
    assert.equal(response.status, 201); assert.equal(response.body.project, input.project); assert.equal(response.body.repository, repository); created.push(response.body);
  }
  assert.equal((await request('/v1/tasks', { ...input, repository: 'backend' }, admin, 'frontend')).status, 409);
  assert.equal((await request('/v1/tasks', { ...input, repository: '../outside' }, admin, 'invalid')).status, 400);
  const registration = await request('/v1/workers/register', { profiles: [{ id: 'codex', provider: 'codex', mode: 'cli' }], policy: { maxParallel: 1, queueCapacity: 1, maxAttempts: 1, order: 'fifo', configHash: 'repository-selector-fixture' } }, enrollment);
  assert.equal(registration.status, 201);
  const token = registration.body.token, claims = [];
  for (const requestId of ['claim-one', 'claim-two']) {
    const response = await request('/v1/worker/assignments/next', { requestId, queueCapacity: 1 }, token);
    assert.equal(response.status, 200); assert.ok(response.body.task); claims.push(response.body.task);
    const replay = await request('/v1/worker/assignments/next', { requestId, queueCapacity: 1 }, token);
    assert.deepEqual(replay.body.task, response.body.task);
  }
  assert.deepEqual(new Set(claims.map(task => task.repository)), new Set(['frontend', 'backend']));
  assert.ok(claims.every(task => task.project === input.project));
  for (const task of claims) assert.equal(task.repository, created.find(item => item.id === task.id).repository);
  const legacy = await request('/v1/tasks', input, admin, 'legacy'); assert.equal(legacy.status, 201); assert.equal(Object.hasOwn(legacy.body, 'repository'), false);
  const beforeVersion = app.store.db.prepare('PRAGMA user_version').get().user_version;
  await app.close(); app = await startServer(options);
  assert.equal(app.store.db.prepare('PRAGMA user_version').get().user_version, beforeVersion);
  const retained = (await request('/v1/worker/assignments/current', undefined, token)).body.tasks;
  assert.equal(retained.length, 2);
  for (const task of retained) {
    const claim = claims.find(item => item.id === task.id);
    assert.equal(task.repository, claim.repository); assert.equal(task.lease, claim.lease);
  }
  assert.equal(Object.hasOwn(app.store.get(legacy.body.id), 'repository'), false);
  for (const task of created) assert.equal((await request(`/v1/tasks/${task.id}`)).body.repository, task.repository);
});

test('bound requirement intake preserves repository selection without retargeting pinned context', async () => {
  const store = new Store(':memory:');
  try {
    const content = Buffer.from('---\nfactory_id: feature\ntitle: Pinned feature\nfactory_status: ready_for_implementation\nfactory_acceptance: [Reviewable change]\n---\nPinned source.\n');
    const manifest = await resolveContext({ repository: '/configured/context-repository', commit: 'a'.repeat(40), files: [{ path: 'docs/Feature.md', objectId: 'b'.repeat(40), mode: '100644' }], read: async () => content }, { project: input.project, vaultRoot: 'docs', wikilink: '[[Feature]]' });
    let resolutions = 0;
    const app = new OrchestratorApplication(store, input.project, { assertOpen() {}, async resolve(reference) { resolutions++; assert.equal(reference, '[[Feature]]'); return manifest; } });
    const bound = { project: input.project, repository: 'backend', requirementRef: '[[Feature]]', provider: 'codex', executionMode: 'cli' };
    const task = await app.createTask(bound, 'bound');
    assert.equal(task.repository, 'backend'); assert.equal(task.context.commit, manifest.commit); assert.equal(store.context(task.id).repository, '/configured/context-repository');
    assert.deepEqual(await app.createTask(bound, 'bound'), task); assert.equal(resolutions, 1);
    await assert.rejects(app.createTask({ ...bound, repository: 'frontend' }, 'bound'), error => error.code === 'conflict');
    const second = await app.createTask({ ...bound, repository: 'frontend' }, 'second'); assert.equal(second.repository, 'frontend'); assert.equal(second.context.sha256, task.context.sha256);
  } finally { store.close(); }
});

test('task validation and MCP discovery accept only bounded repository assignment identities', () => {
  const catalog = new ToolCatalog('orchestrator', 'http://127.0.0.1:3000', admin, true);
  const schema = catalog.definitions.find(item => item.name === 'werk_task_create').inputSchema;
  const repository = 'a'.repeat(100);
  assert.equal(taskInput({ ...input, repository }).repository, repository);
  validateArguments({ task: { ...input, repository }, idempotencyKey: 'valid' }, schema);
  for (const repository of ['', null, 1, '../outside', '/checkout', 'https://remote.invalid/repo', 'a'.repeat(101)]) {
    assert.throws(() => taskInput({ ...input, repository }));
    assert.throws(() => validateArguments({ task: { ...input, repository }, idempotencyKey: 'invalid' }, schema));
  }
  assert.equal(Object.hasOwn(taskInput(input), 'repository'), false);
});
