import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { SqliteFactoryRegistry } from '../../src/factory/dist/factory/infrastructure/registry.js';
import { FactoryApplication } from '../../src/factory/dist/factory/application/service.js';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';

const reference = 'WERK_LINE_ALPHA_TOKEN', admin = 'factory-retry-admin-'.repeat(3), secret = 'private-line-credential-'.repeat(3);
const noReads = { read() { throw Error('Registry changes cannot poll a line'); } };
const appFor = (registry, configured = [reference]) => new FactoryApplication(registry, noReads, new Set(configured));
const line = (extra = {}) => ({ name: 'Alpha', factoryId: 'root', orchestratorUrl: 'https://line.example', webviewUrl: 'https://line.example/', tokenEnv: reference, ...extra });
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'werk-factory-receipts-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const conflict = fn => assert.throws(fn, error => error.code === 'conflict');
function child(args, env = {}, input = '') {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    processChild.stdout.on('data', data => stdout += data); processChild.stderr.on('data', data => stderr += data);
    processChild.once('error', reject); processChild.once('close', code => resolve({ code, stdout, stderr })); processChild.stdin.end(input);
  });
}

// Receipt identities use normalized intent, never generated IDs or live record state.
test('Factory create receipts normalize defaults, field order and URLs while preserving generated IDs', () => {
  const registry = new SqliteFactoryRegistry(':memory:'), app = appFor(registry);
  try {
    const factory = app.createFactory({ name: ' Root ', id: 'root' }, 'root-create');
    assert.deepEqual(app.createFactory({ parentId: null, id: 'root', name: 'Root' }, 'root-create'), factory);
    const generated = app.createFactory({ name: 'Generated' }, 'generated-create');
    assert.deepEqual(app.createFactory({ name: 'Generated' }, 'generated-create'), generated);
    const createdLine = app.createLine(line({ orchestratorUrl: 'HTTPS://LINE.EXAMPLE:443/', webviewUrl: 'https://line.example' }), 'line-create');
    assert.deepEqual(app.createLine({ tokenEnv: reference, ...line() }, 'line-create'), createdLine);
    assert.equal(registry.factories().length, 2); assert.equal(registry.lines().length, 1);
  } finally { registry.close(); }
});

test('all six mutation receipts replay their original responses after later edits, deletion and ID reuse', () => {
  const registry = new SqliteFactoryRegistry(':memory:'), app = appFor(registry);
  try {
    const createFactory = app.createFactory({ id: 'root', name: 'Original' }, 'factory-create');
    const updateFactory = app.updateFactory('root', { name: ' First rename ' }, 'factory-update');
    app.updateFactory('root', { name: 'Later rename' });
    assert.deepEqual(app.updateFactory('root', { name: 'First rename' }, 'factory-update'), updateFactory);
    assert.equal(app.factory('root').name, 'Later rename');
    const createLine = app.createLine(line({ id: 'alpha' }), 'line-create');
    const updateLine = app.updateLine('alpha', { name: 'First line rename' }, 'line-update');
    app.updateLine('alpha', { name: 'Later line rename' });
    const deleteLine = app.deleteLine('alpha', 'line-delete');
    assert.deepEqual(app.createLine(line({ id: 'alpha' }), 'line-create'), createLine);
    assert.deepEqual(app.updateLine('alpha', { name: 'First line rename' }, 'line-update'), updateLine);
    assert.deepEqual(app.deleteLine('alpha', 'line-delete'), deleteLine);
    assert.equal(app.lines().lines.length, 0);
    const deleteFactory = app.deleteFactory('root', 'factory-delete');
    assert.deepEqual(app.createFactory({ id: 'root', name: 'Original' }, 'factory-create'), createFactory);
    assert.deepEqual(app.updateFactory('root', { name: 'First rename' }, 'factory-update'), updateFactory);
    assert.deepEqual(app.deleteFactory('root', 'factory-delete'), deleteFactory);
    assert.equal(app.factories().factories.length, 0);
    app.createFactory({ id: 'root', name: 'New identity' }); app.createLine(line({ id: 'alpha', name: 'New line' }));
    assert.deepEqual(app.deleteLine('alpha', 'line-delete'), deleteLine);
    assert.deepEqual(app.deleteFactory('root', 'factory-delete'), deleteFactory);
    assert.equal(app.factory('root').name, 'New identity'); assert.equal(app.line('alpha').name, 'New line');
  } finally { registry.close(); }
});

test('keys conflict across operation, target and normalized payload; omitted PATCH fields remain distinct', () => {
  const registry = new SqliteFactoryRegistry(':memory:'), app = appFor(registry);
  try {
    app.createFactory({ id: 'root', name: 'Root' }, 'global'); app.createFactory({ id: 'other', name: 'Other' });
    conflict(() => app.createFactory({ id: 'root', name: 'Different' }, 'global'));
    conflict(() => app.updateFactory('root', { name: 'Root' }, 'global'));
    conflict(() => app.deleteFactory('root', 'global'));
    conflict(() => app.createLine(line(), 'global'));
    app.updateFactory('root', { name: 'Renamed' }, 'patch');
    conflict(() => app.updateFactory('other', { name: 'Renamed' }, 'patch'));
    conflict(() => app.updateFactory('root', { name: 'Renamed', parentId: null }, 'patch'));
    assert.equal(app.factory('other').name, 'Other'); assert.equal(app.lines().lines.length, 0);
  } finally { registry.close(); }
});

test('failed validation and domain constraints do not reserve a key; receipt insertion failure rolls mutation back', async t => {
  const file = join(await directory(t), 'registry.sqlite'), registry = new SqliteFactoryRegistry(file), app = appFor(registry);
  const db = new DatabaseSync(file);
  try {
    assert.throws(() => app.createFactory({ name: '' }, 'retry-validation'), error => error.code === 'invalid_input');
    app.createFactory({ id: 'root', name: 'Root' }, 'retry-validation');
    app.createFactory({ id: 'child', name: 'Child', parentId: 'root' });
    conflict(() => app.deleteFactory('root', 'retry-constraint'));
    app.deleteFactory('child'); app.deleteFactory('root', 'retry-constraint');
    db.exec("CREATE TRIGGER force_receipt_failure BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT,'injected receipt write failure'); END");
    assert.throws(() => app.createFactory({ id: 'atomic', name: 'Atomic' }, 'atomic-key'), /injected receipt/);
    assert.throws(() => app.factory('atomic'), error => error.code === 'not_found');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get().n, 2);
    db.exec('DROP TRIGGER force_receipt_failure');
    app.createFactory({ id: 'atomic', name: 'Atomic' }, 'atomic-key');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get().n, 3);
  } finally { db.close(); registry.close(); }
});

test('schema-1 migration keeps registrations and durable schema-2 receipts survive reopen without credential values', async t => {
  const file = join(await directory(t), 'registry.sqlite'); let db = new DatabaseSync(file);
  db.exec("CREATE TABLE factories(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES factories(id)); CREATE TABLE lines(id TEXT PRIMARY KEY,name TEXT NOT NULL,factory_id TEXT NOT NULL REFERENCES factories(id),orchestrator_url TEXT NOT NULL UNIQUE,webview_url TEXT NOT NULL,token_env TEXT NOT NULL); INSERT INTO factories VALUES('root','Legacy',NULL); PRAGMA user_version=1;"); db.close();
  let registry = new SqliteFactoryRegistry(file), app = appFor(registry);
  const first = app.createLine(line(), admin); const renamed = app.updateFactory('root', { name: 'Migrated' }, 'migration-update'); registry.close();
  registry = new SqliteFactoryRegistry(file); app = appFor(registry, []); db = new DatabaseSync(file);
  try {
    assert.deepEqual(app.createLine(line(), admin), first, 'replay does not require missing deployment credentials');
    assert.deepEqual(app.updateFactory('root', { name: 'Migrated' }, 'migration-update'), renamed);
    assert.equal(app.factory('root').name, 'Migrated'); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    const receipts = db.prepare('SELECT * FROM mutation_receipts').all(), serialized = JSON.stringify(receipts);
    assert.equal(receipts.length, 2); assert.ok(serialized.includes(reference));
    assert.ok(!serialized.includes(admin)); assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes('migration-update'));
    assert.throws(() => db.exec('DELETE FROM mutation_receipts'), /immutable/);
    assert.throws(() => db.exec("UPDATE mutation_receipts SET response_json='{}'"), /immutable/);
  } finally { db.close(); registry.close(); }
});

test('independent concurrent processes serialize the same key into one generated resource and one receipt', { timeout: 10000 }, async t => {
  const file = join(await directory(t), 'registry.sqlite'); new SqliteFactoryRegistry(file).close();
  const registryModule = new URL('../../src/factory/dist/factory/infrastructure/registry.js', import.meta.url).href;
  const applicationModule = new URL('../../src/factory/dist/factory/application/service.js', import.meta.url).href;
  const code = `import {SqliteFactoryRegistry} from ${JSON.stringify(registryModule)}; import {FactoryApplication} from ${JSON.stringify(applicationModule)}; const registry=new SqliteFactoryRegistry(process.argv[1]); try { const app=new FactoryApplication(registry,{read(){throw Error('unexpected');}},new Set()); console.log(JSON.stringify(app.createFactory({name:'Concurrent'},'one-key'))); } finally {registry.close();}`;
  const results = await Promise.all([child(['--input-type=module', '-e', code, file]), child(['--input-type=module', '-e', code, file])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(results[0].stdout), JSON.parse(results[1].stdout));
  const db = new DatabaseSync(file);
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factories').get().n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get().n, 1); }
  finally { db.close(); }
});

async function server(t, file = ':memory:', credentials = { [reference]: secret }) {
  const app = await startFactoryServer({ db: file, host: '127.0.0.1', port: 0, adminToken: admin, credentials });
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (path, method, body, key) => {
    const response = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + admin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key === undefined ? {} : { 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  return { ...app, base, call };
}

test('a lost HTTP create response replays original status/body after server restart and does not create twice', async t => {
  const file = join(await directory(t), 'registry.sqlite'), first = await server(t, file);
  let drop = true;
  first.server.prependListener('request', (_request, response) => {
    if (drop) { drop = false; response.end = function () { this.destroy(); return this; }; }
  });
  await assert.rejects(first.call('/v1/factories', 'POST', { name: 'Lost response' }, 'lost-response'));
  const committed = JSON.parse(JSON.stringify(first.application.factories().factories[0])); assert.ok(committed?.id); await first.close();
  const restarted = await server(t, file);
  assert.deepEqual(await restarted.call('/v1/factories', 'POST', { name: 'Lost response' }, 'lost-response'), { status: 201, body: committed });
  assert.equal(restarted.application.factories().factories.length, 1);
  assert.equal((await restarted.call('/v1/factories', 'POST', { name: 'Different' }, 'lost-response')).status, 409);
});

test('HTTP PATCH/DELETE receipts and line create preserve status/body after changes or removal; legacy clients remain supported', async t => {
  const app = await server(t);
  assert.equal((await app.call('/v1/factories', 'POST', { id: 'root', name: 'Root' })).status, 201);
  const created = await app.call('/v1/lines', 'POST', line({ id: 'alpha' }), 'http-line-create');
  const updated = await app.call('/v1/lines/alpha', 'PATCH', { name: 'Updated' }, 'http-line-patch');
  const deleted = await app.call('/v1/lines/alpha', 'DELETE', undefined, 'http-line-delete');
  assert.equal(created.status, 201); assert.equal(updated.status, 200); assert.equal(deleted.status, 200);
  assert.deepEqual(await app.call('/v1/lines', 'POST', line({ id: 'alpha' }), 'http-line-create'), created);
  assert.deepEqual(await app.call('/v1/lines/alpha', 'PATCH', { name: 'Updated' }, 'http-line-patch'), updated);
  assert.deepEqual(await app.call('/v1/lines/alpha', 'DELETE', undefined, 'http-line-delete'), deleted);
  assert.equal((await app.call('/v1/lines/alpha', 'DELETE')).status, 404);
  assert.equal((await app.call('/v1/factories/root', 'DELETE', undefined, 'http-line-delete')).status, 409);
  const factoryPatch = await app.call('/v1/factories/root', 'PATCH', { name: 'Updated' }, 'http-factory-patch');
  const factoryDelete = await app.call('/v1/factories/root', 'DELETE', undefined, 'http-factory-delete');
  assert.deepEqual(await app.call('/v1/factories/root', 'PATCH', { name: 'Updated' }, 'http-factory-patch'), factoryPatch);
  assert.deepEqual(await app.call('/v1/factories/root', 'DELETE', undefined, 'http-factory-delete'), factoryDelete);
  const one = await app.call('/v1/factories', 'POST', { name: 'Legacy' }), two = await app.call('/v1/factories', 'POST', { name: 'Legacy' });
  assert.notEqual(one.body.id, two.body.id);
});

test('ambiguous, empty and malformed mutation keys fail before side effects', async t => {
  const app = await server(t);
  for (const key of ['', 'bad key', 'x'.repeat(129), 'comma,key']) assert.equal((await app.call('/v1/factories', 'POST', { name: 'Blocked' }, key)).status, 400);
  const body = JSON.stringify({ name: 'Duplicate header' });
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(app.base + '/v1/factories', { method: 'POST', headers: ['Host', new URL(app.base).host, 'Authorization', 'Bearer ' + admin, 'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)), 'Idempotency-Key', 'one', 'Idempotency-Key', 'two'] }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject); request.end(body);
  });
  assert.equal(status, 400); assert.equal(app.application.factories().factories.length, 0);
});

test('Factory CLI forwards durable keys for create/update/delete and rejects key use on reads', { timeout: 15000 }, async t => {
  const app = await server(t), env = { WERK_FACTORY_ADMIN_TOKEN: admin, WERK_FACTORY_URL: app.base };
  const cli = async (args, body) => child(['src/factory/dist/factory/cli.js', ...args], env, body === undefined ? '' : JSON.stringify(body));
  for (const [args, body] of [
    [['factory', 'create', '--file', '-', '--key', 'cli-create'], { id: 'root', name: 'Root' }],
    [['factory', 'update', '--id', 'root', '--file', '-', '--key', 'cli-update'], { name: 'Updated' }],
    [['factory', 'delete', '--id', 'root', '--key', 'cli-delete'], undefined],
  ]) {
    const first = await cli(args, body), replay = await cli(args, body);
    assert.equal(first.code, 0, first.stderr); assert.equal(replay.code, 0, replay.stderr); assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(first.stdout));
  }
  const denied = await cli(['factory', 'list', '--key', 'read-key']); assert.equal(denied.code, 2);
  const invalid = await cli(['factory', 'create', '--file', '-', '--key', ''], { name: 'Invalid' }); assert.equal(invalid.code, 2);
  assert.equal(app.application.factories().factories.length, 0);
});
