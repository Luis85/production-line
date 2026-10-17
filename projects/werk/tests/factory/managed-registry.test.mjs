import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';
import { managedRegistry, managedRegistryEnvironment } from '../../src/factory/dist/factory/application/managed-registry.js';

const adminToken = 'managed-factory-admin-'.repeat(3), tokenEnv = 'WERK_LINE_TEST_TOKEN';
const config = { host: '127.0.0.1', port: 0, adminToken, credentials: { [tokenEnv]: 'line-test-secret-'.repeat(3) } };
const factory = { id: 'root', name: 'Root' };
const line = { id: 'alpha', name: 'Alpha', factoryId: 'root', orchestratorUrl: 'http://127.0.0.1:39871', webviewUrl: 'http://127.0.0.1:39871/', tokenEnv };
const managed = () => ({ factories: ['root'], lines: ['alpha'] });
const request = app => async (path, method = 'GET', body, key) => {
  const response = await fetch('http://127.0.0.1:' + app.server.address().port + path, { method,
    headers: { Authorization: 'Bearer ' + adminToken, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
};

test('managed registry validates immutable ownership and rejects malformed deployment configuration', async () => {
  assert.equal(managedRegistry(undefined), undefined); assert.equal(managedRegistryEnvironment(undefined), undefined);
  const source = managed(), result = managedRegistry(source); source.factories.length = 0;
  assert.deepEqual(result, managed()); assert.ok(Object.isFrozen(result.factories));
  assert.deepEqual(managedRegistryEnvironment(JSON.stringify(managed())), managed());
  for (const value of [null, [], {}, { factories: ['root'], lines: [], extra: true }, { factories: ['root', 'root'], lines: [] }, { factories: [1], lines: [] }, { factories: [' root'], lines: [] }]) {
    assert.throws(() => managedRegistry(value), error => testErrorCode(error) === 'invalid_input' && /managed registry/.test(testErrorMessage(error)));
    // @ts-expect-error Deliberately validate malformed deployment configuration at the runtime boundary.
    await assert.rejects(startFactoryServer({ ...config, db: ':memory:', managedRegistry: value }), error => testErrorCode(error) === 'invalid_input');
  }
  assert.throws(() => managedRegistryEnvironment('{'), /WERK_FACTORY_MANAGED_REGISTRY/);
});

test('managed resources reject HTTP edits and deletion before durable replay while extra CRUD survives restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-managed-registry-')), db = join(root, 'registry.sqlite');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await startFactoryServer({ ...config, db }); let call = request(app);
  assert.equal((await call('/v1/factories')).body.managedRegistry, undefined, 'standalone registry remains editable');
  assert.equal((await call('/v1/factories', 'POST', factory)).status, 201);
  assert.equal((await call('/v1/lines', 'POST', line)).status, 201);
  assert.equal((await call('/v1/factories/root', 'PATCH', { name: 'Root' }, 'old-factory-update')).status, 200);
  assert.equal((await call('/v1/lines/alpha', 'PATCH', { name: 'Alpha' }, 'old-line-update')).status, 200);
  assert.equal((await call('/v1/lines/alpha', 'DELETE', undefined, 'old-line-delete')).status, 200);
  assert.equal((await call('/v1/factories/root', 'DELETE', undefined, 'old-factory-delete')).status, 200);
  assert.equal((await call('/v1/factories', 'POST', factory)).status, 201);
  assert.equal((await call('/v1/lines', 'POST', line)).status, 201);
  await app.close();
  const ownership = managed(); app = await startFactoryServer({ ...config, db, managedRegistry: ownership }); call = request(app);
  ownership.factories.length = 0; ownership.lines.length = 0;
  assert.deepEqual((await call('/v1/factories')).body.managedRegistry, managed());
  for (const [path, name, key] of [['/v1/factories/root', 'Root', 'old-factory-update'], ['/v1/lines/alpha', 'Alpha', 'old-line-update']]) {
    /** @type {[string, { name: string } | undefined, string][]} */
    const mutations = [['PATCH', { name }, key], ['PATCH', { name: 'Would break restart' }, 'new-edit'], ['DELETE', undefined, key.replace('update', 'delete')], ['DELETE', undefined, 'new-delete']];
    for (const [method, body, receipt] of mutations) {
      const result = await call(path, method, body, receipt); assert.equal(result.status, 409); assert.match(result.body.error, /managed by the saved system YAML/);
    }
  }
  assert.equal((await call('/v1/factories', 'POST', { id: 'extra', name: 'Extra', parentId: 'root' })).status, 201);
  assert.equal((await call('/v1/factories/extra', 'PATCH', { name: 'Kept extra' })).status, 200);
  const extraLine = { ...line, id: 'extra-line', name: 'Extra line', factoryId: 'extra', orchestratorUrl: 'http://127.0.0.1:39872' };
  assert.equal((await call('/v1/lines', 'POST', extraLine)).status, 201);
  assert.equal((await call('/v1/lines/extra-line', 'PATCH', { name: 'Kept line' })).status, 200);
  await app.close(); app = await startFactoryServer({ ...config, db, managedRegistry: managed() }); call = request(app);
  assert.equal((await call('/v1/factories/root')).body.name, 'Root'); assert.equal((await call('/v1/lines/alpha')).body.name, 'Alpha');
  assert.equal((await call('/v1/factories/extra')).body.name, 'Kept extra'); assert.equal((await call('/v1/lines/extra-line')).body.name, 'Kept line');
  assert.equal((await call('/v1/lines/extra-line', 'DELETE')).status, 200); assert.equal((await call('/v1/factories/extra', 'DELETE')).status, 200);
});
