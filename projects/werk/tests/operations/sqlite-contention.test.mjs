import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

for (const target of [
  { name: 'Factory registry', exportName: 'SqliteFactoryRegistry', module: '../../src/factory/dist/factory/infrastructure/registry.js', table: 'factories' },
  { name: 'orchestrator store', exportName: 'Store', module: '../../src/orchestrator/dist/orchestrator/persistence/store.js', table: 'tasks' },
]) test(`${target.name} waits for an existing database lock before WAL setup and migration`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-sqlite-contention-')), file = join(directory, 'database.sqlite');
  let holder, contender, release;
  try {
    holder = new DatabaseSync(file);
    // WAL does not yet exist. This lock specifically fences the first journal-mode
    // PRAGMA, rather than a later mutation that already had a busy handler installed.
    holder.exec('PRAGMA journal_mode=DELETE; CREATE TABLE existing_data(value TEXT); INSERT INTO existing_data VALUES(\'preserved\'); BEGIN EXCLUSIVE;');
    const code = `import { ${target.exportName} as Repository } from ${JSON.stringify(new URL(target.module, import.meta.url).href)};
      process.send({ event: 'opening' });
      let repository;
      try {
        repository = new Repository(process.argv[1]);
        const mode = repository.db.prepare('PRAGMA journal_mode').get().journal_mode;
        const timeout = repository.db.prepare('PRAGMA busy_timeout').get().timeout;
        const existing = repository.db.prepare('SELECT value FROM existing_data').get().value;
        const migrated = Boolean(repository.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(${JSON.stringify(target.table)}));
        process.send({ event: 'opened', mode, timeout, existing, migrated });
      } catch (error) { process.send({ event: 'failed', code: error.code, message: error.message }); process.exitCode = 1; }
      finally { repository?.close(); process.disconnect(); }`;
    contender = spawn(process.execPath, ['--input-type=module', '-e', code, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages = []; contender.stderr.resume();
    const closed = new Promise((resolve, reject) => { contender.once('error', reject); contender.once('exit', code => resolve(code)); });
    const opening = new Promise((resolve, reject) => {
      contender.on('message', value => { messages.push(value); if (value.event === 'opening') resolve(); });
      contender.once('error', reject);
      contender.once('exit', () => { if (!messages.some(value => value.event === 'opening')) reject(Error('Contender exited before the constructor handshake')); });
    });
    await opening;
    // Release from the holder process while the other process is synchronously
    // waiting inside its constructor. No sleeps or retries occur in production code.
    await new Promise(resolve => { release = setTimeout(() => { holder.exec('COMMIT'); holder.close(); holder = undefined; resolve(); }, 200); });
    assert.equal(await closed, 0, JSON.stringify(messages));
    assert.deepEqual(messages.find(value => value.event === 'opened'), { event: 'opened', mode: 'wal', timeout: 5000, existing: 'preserved', migrated: true });
  } finally {
    clearTimeout(release);
    if (holder?.isOpen) holder.close();
    if (contender && contender.exitCode === null && contender.signalCode === null) { const closed = new Promise(resolve => contender.once('exit', resolve)); contender.kill(); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});
