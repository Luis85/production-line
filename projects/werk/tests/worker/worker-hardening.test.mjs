import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { readBoundedFile } from '../../src/worker/dist/worker/infrastructure/journal/files.js';
import { loadOrRegisterIdentity } from '../../src/worker/dist/worker/infrastructure/identity.js';
import { executeAttempt } from '../../src/worker/dist/worker/application/execute-attempt.js';
import { ReportingError } from '../../src/worker/dist/worker/application/errors.js';

const profile = { id: 'claude-1', provider: 'claude', mode: 'mock', maxParallel: 1 };
const task = () => ({ id: 'task-1', project: 'demo', title: 'Test', criteria: ['Done'], wikilinks: [], provider: 'claude', priority: 1, status: 'running', attempt: 1, workerId: 'worker-1', lease: 'lease-1', expiresAt: Date.now() + 60000, profile: profile.id, createdAt: Date.now() });
const state = () => ({ lastContact: null, heartbeatErrors: 0, lastError: null, lastSnapshot: null, completedSimulations: 0 });
const digest = 'a'.repeat(64);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-worker-hardening-'));
  const journal = new SnapshotJournal(join(directory, 'state'), digest, digest);
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  await journal.init();
  return { directory, journal, capture: () => journal.capture(task(), 'worker-1', profile, state(), 'before') };
}

test('journal startup refuses symlinked state directories without writing outside state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-worker-paths-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outside = join(directory, 'outside'); await mkdir(outside);
  for (const name of ['root', 'outbox', 'snapshots']) {
    const root = join(directory, name); const journal = new SnapshotJournal(root, digest, digest);
    try {
      if (name === 'root') await symlink(outside, root, 'dir');
      else { await mkdir(root); await symlink(outside, join(root, name), 'dir'); }
      await assert.rejects(journal.init(), /symlink/);
      assert.deepEqual(await readdir(outside), []);
    } finally { journal.close(); }
  }
});

test('journal persistence refuses symlinked lease directories', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.journal.stateDir, 'snapshots', 'lease-1'), 'dir');
  await assert.rejects(f.journal.persist(f.capture()), /symlink/);
  assert.deepEqual(await readdir(outside), []);
});

test('journal rejects a valid snapshot stored under a different lease or phase', async t => {
  const f = await fixture(t); await f.journal.persist(f.capture());
  const root = join(f.journal.stateDir, 'snapshots');
  await mkdir(join(root, 'different-lease'));
  await writeFile(join(root, 'different-lease', 'before.json'), JSON.stringify(f.capture()));
  await assert.rejects(f.journal.read('different-lease', 'before'), /identity mismatch/);
  await writeFile(join(root, 'lease-1', 'after.json'), JSON.stringify(f.capture()));
  await assert.rejects(f.journal.read('lease-1', 'after'), /identity mismatch/);
});

test('queued persistence detaches validated snapshots from subsequent caller mutation', async t => {
  const f = await fixture(t), before = f.capture();
  const saving = f.journal.persist(before);
  before.pairId = '../escape'; before.configuration.changedAfterEnqueue = true;
  const saved = await saving;
  assert.equal(saved.pairId, 'lease-1');
  assert.equal((await f.journal.read('lease-1', 'before')).configuration.changedAfterEnqueue, undefined);
});

test('outbox rejects mismatched filenames before delivery and preserves evidence', async t => {
  const f = await fixture(t); await f.journal.persist(f.capture());
  const directory = join(f.journal.stateDir, 'outbox');
  await rename(join(directory, 'lease-1-before.json'), join(directory, 'wrong-before.json'));
  let deliveries = 0;
  await assert.rejects(f.journal.flush(async () => { deliveries++; }), /identity mismatch/);
  assert.equal(deliveries, 0); assert.deepEqual(await readdir(directory), ['wrong-before.json']);
});

test('state reads bound bytes and reject symlinks and nonregular files', async t => {
  const f = await fixture(t), path = join(f.directory, 'large.json');
  await writeFile(path, 'x'.repeat(131073));
  await assert.rejects(readBoundedFile(path, 131072), /exceeds/);
  await writeFile(path, 'hello'); assert.equal(await readBoundedFile(path, 5), 'hello');
  const link = join(f.directory, 'link.json'); await symlink(path, link);
  await assert.rejects(readBoundedFile(link, 100), /symlink/);
  await assert.rejects(readBoundedFile(f.directory, 100), /regular file/);
});

test('invalid enrollment cannot poison persisted identity and malformed state fails clearly', async t => {
  const f = await fixture(t), path = join(f.journal.stateDir, 'identity.json');
  const gateway = { async register() { return { id: '../escape', project: 'demo', token: 'secret' }; } };
  const load = () => loadOrRegisterIdentity(f.journal.stateDir, 'http://localhost', [profile], { configHash: digest }, gateway, new AbortController().signal);
  await assert.rejects(load(), /Invalid persisted worker identity/);
  await assert.rejects(readFile(path), error => error.code === 'ENOENT');
  await writeFile(path, 'null');
  await assert.rejects(load(), /Invalid persisted worker identity/);
});

test('lease loss fences completion retries while preserving terminal evidence', { timeout: 5000 }, async t => {
  const f = await fixture(t), attempt = task(), status = state();
  let completions = 0, executed = 0, lost;
  const leaseLost = new Promise(resolve => { lost = resolve; });
  const client = {
    async heartbeat(value) {
      if (completions) { lost(); throw new ReportingError('Lease ownership lost', false); }
      return { ...value, expiresAt: Date.now() + 300 };
    },
    async publishSnapshot() {},
    async complete() { completions++; await leaseLost; await delay(10); throw new ReportingError('Temporary outage', true); },
    async abandon() { assert.fail('Successful terminal evidence must not be abandoned'); }
  };
  await assert.rejects(executeAttempt(attempt, new AbortController().signal, {
    client, journal: f.journal, identity: { id: 'worker-1', project: 'demo' }, profiles: [profile], state: status,
    adapter: { mode: 'mock', async run() { executed++; return { kind: 'simulated' }; } },
    async saveState() {}, timeoutMs: 1000
  }));
  assert.equal(completions, 1); assert.equal(executed, 1); assert.equal(status.completedSimulations, 0);
  assert.equal((await f.journal.read('lease-1', 'after')).execution.outcome, 'simulated');
});
