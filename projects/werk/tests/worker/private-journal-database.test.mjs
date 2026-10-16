import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPrivateJournal } from '../../src/worker/dist/worker/infrastructure/journal/database.js';
import { WorkerInteractionJournal } from '../../src/worker/dist/worker/infrastructure/journal/interactions.js';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { WorkerResourceJournal } from '../../src/worker/dist/worker/infrastructure/journal/resource-events.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'werk-private-journal-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('private journal opening keeps durability, private permissions and application-owned schemas', async t => {
  const root = await directory(t), path = join(root, 'fixture.sqlite');
  await writeFile(path, ''); await chmod(path, 0o666);
  const db = await openPrivateJournal(root, 'fixture.sqlite', 'Expected regular file.');
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(), []);
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
  } finally { db.close(); }
});

for (const suffix of ['', '-wal', '-shm']) test(`private journal rejects a nonregular ${suffix || 'database'} before opening SQLite`, async t => {
  const root = await directory(t), path = join(root, 'fixture.sqlite');
  await mkdir(path + suffix);
  await assert.rejects(openPrivateJournal(root, 'fixture.sqlite', 'Expected regular file.'), /Expected regular file/);
  assert.ok((await lstat(path + suffix)).isDirectory());
  if (suffix) await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('private journal refuses a symlinked WAL without touching its target', { skip: process.platform === 'win32' ? 'Symlink privileges are host-dependent' : false }, async t => {
  const root = await directory(t), target = join(root, 'private.txt');
  await writeFile(target, 'preserve');
  await symlink(target, join(root, 'fixture.sqlite-wal'));
  await assert.rejects(openPrivateJournal(root, 'fixture.sqlite', 'Expected regular file.'), /Expected regular file/);
  assert.equal(await readFile(target, 'utf8'), 'preserve');
});

test('private journal configuration failure closes its database while preserving the original error', async t => {
  const root = await directory(t), primary = Error('configuration failed'), secondary = Error('close failed');
  const close = DatabaseSync.prototype.close, closed = [];
  t.mock.method(DatabaseSync.prototype, 'exec', () => { throw primary; });
  t.mock.method(DatabaseSync.prototype, 'close', function () { close.call(this); closed.push(this); throw secondary; });
  await assert.rejects(openPrivateJournal(root, 'fixture.sqlite', 'Expected regular file.'), error => error === primary);
  assert.equal(closed.length, 1); assert.equal(closed[0].isOpen, false);
});

for (const [name, Journal] of [
  ['interactions', WorkerInteractionJournal], ['runs', WorkerRunJournal],
  ['resources', WorkerResourceJournal], ['requests', WorkerRequestJournal],
]) test(`${name} journal closes failed schema initialization and can initialize again`, async t => {
  const root = await directory(t), journal = new Journal(root), failure = Error('schema failed');
  const execute = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close, closed = [];
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql.includes('CREATE TABLE')) throw failure;
    return execute.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function () { close.call(this); closed.push(this); });
  await assert.rejects(journal.init(), error => error === failure);
  assert.equal(closed.length, 1); assert.equal(closed[0].isOpen, false);
  mocked.mock.restore();
  await journal.init();
  journal.close();
  assert.equal(closed.length, 2); assert.equal(closed[1].isOpen, false);
});
