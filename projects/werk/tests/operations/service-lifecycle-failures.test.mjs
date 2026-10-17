import { testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';
import { SqliteFactoryRegistry } from '../../src/factory/dist/factory/infrastructure/registry.js';
import { SqliteIntakeStore } from '../../src/factory/dist/factory/infrastructure/intake-store.js';
import { startServer } from '../../src/orchestrator/dist/orchestrator/server.js';
import { BoundContextIntake } from '../../src/orchestrator/dist/orchestrator/context/intake.js';

const factoryConfig = { db: ':memory:', host: '127.0.0.1', port: 0, adminToken: 'lifecycle-factory-admin-token', credentials: {} };
const lineConfig = { db: ':memory:', host: '127.0.0.1', port: 0, adminToken: 'lifecycle-orchestrator-admin-token', enrollmentToken: 'lifecycle-worker-enrollment-token', project: 'lifecycle', context: { repo: '.', commit: 'a'.repeat(40), vaultRoot: '.' } };

test('Factory closes previously acquired registry when intake construction fails, preserving the startup error', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-factory-lifecycle-')), db = join(directory, 'registry.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(db + '.intake.sqlite');
  const close = SqliteFactoryRegistry.prototype.close, secondary = Error('secondary registry cleanup'); let closed = 0;
  t.mock.method(SqliteFactoryRegistry.prototype, 'close', function () { close.call(this); closed++; throw secondary; });
  await assert.rejects(startFactoryServer({ ...factoryConfig, db }), error => error !== secondary && /open|database/i.test(testErrorMessage(error)));
  assert.equal(closed, 1);
});

test('Factory failed intake drain still closes both stores once after all drains settle', { timeout: 10000 }, async t => {
  const app = await startFactoryServer(factoryConfig), held = Promise.withResolvers(), entered = Promise.withResolvers(), failure = Error('intake close failed');
  const events = [], closeIntake = app.intake.close.bind(app.intake), closeStore = SqliteIntakeStore.prototype.close, closeRegistry = app.registry.close.bind(app.registry);
  t.after(async () => { held.resolve(); await app.close().catch(() => {}); });
  app.intake.close = async () => { entered.resolve(); await held.promise; await closeIntake(); events.push('intake'); throw failure; };
  t.mock.method(SqliteIntakeStore.prototype, 'close', function () { events.push('intake store'); closeStore.call(this); });
  app.registry.close = () => { events.push('registry'); closeRegistry(); };
  const closing = app.close(); assert.equal(app.close(), closing);
  const rejected = assert.rejects(closing, error => error === failure);
  await entered.promise; assert.deepEqual(events, []);
  held.resolve(); await rejected;
  assert.deepEqual(events, ['intake', 'intake store', 'registry']);
  assert.equal(app.server.listening, false);
  assert.equal(app.close(), closing);
});

test('orchestrator closes context acquired before a store constructor failure', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-line-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const close = BoundContextIntake.prototype.close, secondary = Error('secondary context cleanup'); let closed = 0;
  t.mock.method(BoundContextIntake.prototype, 'close', async function () { await close.call(this); closed++; throw secondary; });
  await assert.rejects(startServer({ ...lineConfig, db: directory }), error => error !== secondary && /open|database/i.test(testErrorMessage(error)));
  assert.equal(closed, 1);
});

test('orchestrator failed context drain still closes SQLite after the drain settles, exactly once', { timeout: 10000 }, async t => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers(), failure = Error('context close failed');
  const close = BoundContextIntake.prototype.close, events = [];
  t.mock.method(BoundContextIntake.prototype, 'close', async function () { entered.resolve(); await held.promise; await close.call(this); events.push('context'); throw failure; });
  const app = await startServer(lineConfig), closeStore = app.store.close.bind(app.store);
  t.after(async () => { held.resolve(); await app.close().catch(() => {}); });
  app.store.close = () => { events.push('store'); closeStore(); };
  const closing = app.close(); assert.equal(app.close(), closing);
  const rejected = assert.rejects(closing, error => error === failure);
  await entered.promise; assert.deepEqual(events, []);
  held.resolve(); await rejected;
  assert.deepEqual(events, ['context', 'store']); assert.equal(app.server.listening, false);
  assert.equal(app.close(), closing);
});

test('Factory intake schema failure closes its own database and preserves the schema error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-intake-schema-')), path = join(directory, 'intake.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = new DatabaseSync(path);
  fixture.exec('CREATE TABLE intake(id TEXT PRIMARY KEY)'); fixture.close();
  const original = DatabaseSync.prototype.close, closed = [], secondary = Error('database close failed');
  t.mock.method(DatabaseSync.prototype, 'close', function () { original.call(this); closed.push(this); throw secondary; });
  assert.throws(() => new SqliteIntakeStore(path), error => error !== secondary && /no such column/i.test(testErrorMessage(error)));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].isOpen, false);
});
