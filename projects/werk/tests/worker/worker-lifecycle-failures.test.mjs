import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'werk-worker-lifecycle-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { ...await configuration({}), stateDir, url: '', enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 };
}
async function restart(config) {
  const stop = new AbortController();
  await runWorker(config, stop.signal, { ready: async () => stop.abort() });
  await assert.rejects(lstat(join(config.stateDir, 'worker.lock')), { code: 'ENOENT' });
}

test('worker constructor failure releases its lock and journal even when journal cleanup fails', { timeout: 15000 }, async t => {
  const config = await fixture(t), secondary = Error('journal close failed'), close = SnapshotJournal.prototype.close; let closed = 0;
  const mocked = t.mock.method(SnapshotJournal.prototype, 'close', function () { close.call(this); closed++; throw secondary; });
  await assert.rejects(runWorker({ ...config, repositories: { items: 'invalid' } }, new AbortController().signal), error => error !== secondary && /repositor/i.test(error.message));
  assert.equal(closed, 1);
  await assert.rejects(lstat(join(config.stateDir, 'worker.lock')), { code: 'ENOENT' });
  mocked.mock.restore();
  await restart(config);
});

test('worker failed shutdown drains HTTP and evidence, persists stopped state and permits restart', { timeout: 15000 }, async t => {
  const config = await fixture(t), stop = new AbortController(), failure = Error('workspace drain failed'), events = [];
  const close = WorkerWorkspace.prototype.close, evidence = WorkerWorkspace.prototype.closeEvidence, journal = SnapshotJournal.prototype.close;
  const mocked = t.mock.method(WorkerWorkspace.prototype, 'close', async function (options) { await close.call(this, options); events.push('workspace'); throw failure; });
  t.mock.method(WorkerWorkspace.prototype, 'closeEvidence', async function () { await evidence.call(this); events.push('evidence'); });
  t.mock.method(SnapshotJournal.prototype, 'close', function () { journal.call(this); events.push('journal'); });
  let address;
  await assert.rejects(runWorker(config, stop.signal, { ready: async value => { address = value; stop.abort(); } }), error => error === failure);
  assert.deepEqual(events, ['workspace', 'evidence', 'journal']);
  await assert.rejects(lstat(join(config.stateDir, 'worker.lock')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(config.stateDir, 'status.json'), 'utf8')).state, 'stopped');
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/healthz`, { signal: AbortSignal.timeout(1000) }));
  mocked.mock.restore();
  await restart(config);
});

test('worker startup error remains primary when workspace cleanup also fails', { timeout: 15000 }, async t => {
  const config = await fixture(t), primary = Error('ready callback failed'), secondary = Error('workspace cleanup failed');
  const close = WorkerWorkspace.prototype.close;
  t.mock.method(WorkerWorkspace.prototype, 'close', async function (options) { await close.call(this, options); throw secondary; });
  await assert.rejects(runWorker(config, new AbortController().signal, { ready: async () => { throw primary; } }), error => error === primary);
  await assert.rejects(lstat(join(config.stateDir, 'worker.lock')), { code: 'ENOENT' });
});
