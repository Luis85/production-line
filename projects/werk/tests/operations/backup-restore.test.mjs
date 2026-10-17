import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Store } from '../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { SqliteFactoryRegistry } from '../../src/factory/dist/factory/infrastructure/registry.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

// Exercise the documented stopped-writer procedure with real independent SQLite
// databases and pending worker evidence, copied into a different location.
test('restored fleet preserves registry, identities and pending evidence without duplicate completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-restore-'));
  const original = join(directory, 'original'), backup = join(directory, 'backup'), restored = join(directory, 'restored');
  let store, registry, journal;
  const clock = () => 1000;
  /** @type {import('../../src/orchestrator/dist/shared/contracts.js').Profile} */
const profile = { id: 'claude-1', provider: 'claude', mode: 'mock' };
  const state = { lastContact: null, heartbeatErrors: 0 };
  try {
    await mkdir(original);
    store = new Store(join(original, 'line', 'db.sqlite'), 60000, clock);
    registry = new SqliteFactoryRegistry(join(original, 'factory', 'registry.sqlite'));
    registry.createFactory({ id: 'root', name: 'Root', parentId: null });
    registry.createLine({ id: 'line-a', name: 'Line A', factoryId: 'root', orchestratorUrl: 'http://127.0.0.1:3000', webviewUrl: 'http://127.0.0.1:3000/', tokenEnv: 'WERK_LINE_A_TOKEN' });
    const auth = store.register('demo', [profile]);
    await writeFile(join(original, 'credentials.json'), JSON.stringify(auth), { mode: 0o600 });
    const worker = store.worker(auth.token);
    const submitted = store.submit({ project: 'demo', title: 'Restore rehearsal', criteria: ['Preserve evidence'], wikilinks: [], provider: 'auto', priority: 1 }, 'restore-task');
    const assigned = store.claim(worker, 'restore-claim');
    journal = new SnapshotJournal(join(original, 'worker'), 'default', 'restore');
    await journal.init();
    const before = await journal.persist(journal.capture(assigned, worker.id, profile, state, 'before'));
    // Simulate the response being lost after the server accepted before evidence.
    store.snapshot(worker, before);
    const after = await journal.persist(journal.capture(assigned, worker.id, profile, state, 'after', before, 'simulated'));
    journal.close(); journal = undefined;
    store.close(); store = undefined;
    registry.close(); registry = undefined;

    await cp(original, backup, { recursive: true });
    await cp(backup, restored, { recursive: true });
    const backupDatabase = join(backup, 'line', 'db.sqlite');
    const backupDigest = createHash('sha256').update(await readFile(backupDatabase)).digest('hex');
    const restoredAuth = JSON.parse(await readFile(join(restored, 'credentials.json'), 'utf8'));
    store = new Store(join(restored, 'line', 'db.sqlite'), 60000, clock);
    registry = new SqliteFactoryRegistry(join(restored, 'factory', 'registry.sqlite'));
    assert.equal(registry.line('line-a').factoryId, 'root');
    assert.equal(registry.line('line-a').tokenEnv, 'WERK_LINE_A_TOKEN');
    const restoredWorker = store.worker(restoredAuth.token);
    assert.equal(restoredWorker.id, worker.id);
    assert.equal(store.claim(restoredWorker, 'restore-claim').lease, assigned.lease);
    assert.equal(store.submit({ project: 'demo', title: 'Restore rehearsal', criteria: ['Preserve evidence'], wikilinks: [], provider: 'auto', priority: 1 }, 'restore-task').id, submitted.id);
    journal = new SnapshotJournal(join(restored, 'worker'), 'default', 'restore');
    await journal.init();
    await journal.recover(restoredWorker.id, [profile], state);
    await journal.flush(async snapshot => store.snapshot(restoredWorker, snapshot));
    assert.deepEqual((await journal.read(assigned.lease, 'after')), after);
    assert.equal(store.snapshots().length, 2);
    assert.equal(store.finish(restoredWorker, assigned.id, assigned.lease, assigned.attempt).status, 'simulated');
    store.finish(restoredWorker, assigned.id, assigned.lease, assigned.attempt);
    assert.equal(store.events(assigned.id).filter(event => event.kind === 'simulation_finished').length, 1);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    // Restoring operates on copies; the preserved backup remains at its checkpoint.
    const checkpoint = new DatabaseSync(backupDatabase, { readOnly: true });
    try {
      assert.equal(checkpoint.prepare('SELECT status FROM tasks WHERE id=?').get(assigned.id).status, 'running');
      assert.equal(checkpoint.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 1);
    } finally { checkpoint.close(); }
    assert.equal(createHash('sha256').update(await readFile(backupDatabase)).digest('hex'), backupDigest);
  } finally {
    journal?.close(); store?.close(); registry?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
