import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, unlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { executeAttempt } from '../../src/worker/dist/worker/application/execute-attempt.js';
import { ReportingError } from '../../src/worker/dist/worker/application/errors.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { HttpWorkerGateway } from '../../src/worker/dist/worker/infrastructure/orchestrator-client.js';
import { startServer } from '../../src/orchestrator/dist/orchestrator/server.js';

const profile = { id: 'claude-1', provider: 'claude', mode: 'mock', maxParallel: 1 };
const state = () => ({ lastContact: null, heartbeatErrors: 0, lastError: null, lastSnapshot: null, completedSimulations: 0 });
const task = lease => ({ id: 'task-' + lease, project: 'demo', title: 'Retention', criteria: ['done'], wikilinks: [], provider: 'claude', priority: 1, status: 'running', attempt: 1, workerId: 'worker-1', lease, expiresAt: Date.now() + 60000, profile: profile.id, createdAt: Date.now() });
const digest = 'a'.repeat(64);
async function fixture(t, keep = 2, checkout = false) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-retention-')), journals = [];
  const projectDir = checkout ? join(directory, 'checkout') : undefined;
  if (projectDir) await mkdir(join(projectDir, '.git'), { recursive: true });
  const open = async (count = keep) => { const j = new SnapshotJournal(join(directory, 'state'), digest, digest, projectDir, {}, count); journals.push(j); await j.init(); return j; };
  t.after(async () => { for (const j of journals) j.close(); await rm(directory, { recursive: true, force: true }); });
  const journal = await open();
  return { directory, projectDir, journal, open, pairs: () => readdir(join(journal.stateDir, 'snapshots')), outbox: () => readdir(join(journal.stateDir, 'outbox')) };
}
async function pair(journal, lease) {
  const assigned = task(lease), before = await journal.persist(journal.capture(assigned, 'worker-1', profile, state(), 'before'));
  const after = await journal.persist(journal.capture(assigned, 'worker-1', profile, state(), 'after', before, 'simulated'));
  return { before, after };
}
async function acknowledge(journal, lease) { await pair(journal, lease); await journal.flush(async () => {}); await journal.checkpoint(lease); }
function dependencies(journal) {
  let runs = 0, completions = 0;
  const client = { async heartbeat(value) { return value; }, async publishSnapshot() {}, async complete() { completions++; }, async abandon() {} };
  return { client, journal, identity: { id: 'worker-1', project: 'demo' }, profiles: [profile], state: state(),
    adapter: { mode: 'mock', async run() { runs++; return { kind: 'simulated' }; } }, async saveState() {}, timeoutMs: 1000,
    counts: () => ({ runs, completions }) };
}

test('retention bounds acknowledged history and never removes unsettled or active evidence', async t => {
  const f = await fixture(t);
  await pair(f.journal, 'pending');
  await f.journal.persist(f.journal.capture(task('active'), 'worker-1', profile, state(), 'before'));
  for (const lease of ['a', 'b', 'c']) await acknowledge(f.journal, lease);
  assert.deepEqual((await f.pairs()).sort(), ['active', 'b', 'c', 'pending']);
  assert.equal((await f.journal.read('pending', 'after')).execution.outcome, 'simulated');
  assert.equal((await f.journal.read('active', 'before')).phase, 'before');
});

test('snapshot delivery alone cannot checkpoint queued records or remove terminal-retry evidence', async t => {
  const f = await fixture(t, 0); await pair(f.journal, 'pending');
  await assert.rejects(f.journal.checkpoint('pending'), /Unacknowledged snapshot delivery/);
  assert.equal((await f.outbox()).length, 2);
  await f.journal.flush(async () => {});
  const restarted = await f.open(); await restarted.recover('worker-1', [profile], state());
  assert.equal((await f.outbox()).length, 2, 'published telemetry without a terminal checkpoint must replay');
  assert.equal((await restarted.read('pending', 'after')).execution.outcome, 'simulated');
});

test('restart skips checkpointed history and recovers only incomplete attempts', async t => {
  const f = await fixture(t); await acknowledge(f.journal, 'complete');
  await f.journal.persist(f.journal.capture(task('incomplete'), 'worker-1', profile, state(), 'before'));
  const restarted = await f.open(); await restarted.recover('worker-1', [profile], state());
  assert.deepEqual((await f.outbox()).sort(), ['incomplete-after.json', 'incomplete-before.json']);
  assert.equal((await restarted.read('incomplete', 'after')).execution.outcome, 'interrupted');
  assert.equal((await restarted.read('incomplete', 'after')).execution.durationMs, null);
  assert.equal((await restarted.read('complete', 'after')).execution.outcome, 'simulated');
});

test('retention changes are operational and preserve existing execution identity hashes', async t => {
  const f = await fixture(t), path = join(f.directory, 'worker.json');
  const original = await configuration({});
  assert.equal(original.retainedPairs, 1000);
  await writeFile(path, JSON.stringify({ journal: { retainedPairs: 7 } }));
  const changed = await configuration({ config: path });
  assert.equal(changed.retainedPairs, 7); assert.equal(changed.policy.configHash, original.policy.configHash);
  assert.equal((await configuration({ config: path, 'retain-acknowledged-pairs': '0' })).retainedPairs, 0);
  for (const retainedPairs of [-1, 100001, 0.5, '3', null, true, [1]]) {
    await writeFile(path, JSON.stringify({ journal: { retainedPairs } }));
    await assert.rejects(configuration({ config: path }), { code: 'invalid_input' });
  }
});

test('failed completion preserves immutable replay evidence; successful retry checkpoints without rerunning execution', async t => {
  const f = await fixture(t, 0), deps = dependencies(f.journal), assigned = task('retry');
  deps.client.complete = async () => { throw new ReportingError('completion offline', true); };
  await assert.rejects(executeAttempt(assigned, new AbortController().signal, deps), /completion offline/);
  assert.equal((await f.journal.read('retry', 'after')).execution.outcome, 'simulated');
  await assert.rejects(readFile(join(f.journal.stateDir, 'snapshots/retry/acknowledged.json')), { code: 'ENOENT' });
  deps.client.complete = async () => { assert.ok(await f.journal.read('retry', 'after'), 'evidence remains until server acknowledgment'); };
  await executeAttempt(assigned, new AbortController().signal, deps);
  assert.equal(deps.counts().runs, 1); assert.deepEqual(await f.pairs(), []);
});

test('adapter failure requires acknowledged abandonment before local collection', async t => {
  const f = await fixture(t, 0), deps = dependencies(f.journal);
  deps.adapter.run = async () => { throw Error('adapter failed'); };
  let abandoned = false;
  deps.client.abandon = async () => { assert.ok(await f.journal.read('failed', 'after')); abandoned = true; };
  await executeAttempt(task('failed'), new AbortController().signal, deps);
  assert.equal(abandoned, true); assert.deepEqual(await f.pairs(), []);
});

test('recovery finishes partial acknowledged cleanup without fabricating or publishing evidence', async t => {
  const f = await fixture(t, 3);
  for (const id of ['before-removed', 'both-removed', 'empty']) await acknowledge(f.journal, id);
  for (const id of ['before-removed', 'both-removed', 'empty']) await unlink(join(f.journal.stateDir, 'snapshots', id, 'before.json'));
  for (const id of ['both-removed', 'empty']) await unlink(join(f.journal.stateDir, 'snapshots', id, 'after.json'));
  await unlink(join(f.journal.stateDir, 'snapshots/empty/acknowledged.json'));
  const restarted = await f.open(); await restarted.recover('worker-1', [profile], state());
  assert.deepEqual(await f.pairs(), []); assert.deepEqual(await f.outbox(), []);
});

test('a lower retention limit is applied on restart without replaying acknowledged pairs', async t => {
  const f = await fixture(t, 3); for (const id of ['a', 'b', 'c']) await acknowledge(f.journal, id);
  const restarted = await f.open(1); await restarted.recover('worker-1', [], state());
  assert.deepEqual(await f.pairs(), ['c']); assert.deepEqual(await f.outbox(), []);
});

test('mismatched checkpoints and corrupt acknowledged bytes fail closed without deleting evidence', async t => {
  const f = await fixture(t); await acknowledge(f.journal, 'corrupt');
  const path = join(f.journal.stateDir, 'snapshots/corrupt/after.json');
  const after = JSON.parse(await readFile(path, 'utf8')); after.execution.error = 'modified'; await writeFile(path, JSON.stringify(after));
  const restarted = await f.open(0); await assert.rejects(restarted.recover('worker-1', [profile], state()), /digest mismatch/);
  assert.deepEqual(await f.pairs(), ['corrupt']); assert.ok(await readFile(path));
});

test('foreign checkpoint ownership, unknown files and symlinks cannot authorize cleanup', async t => {
  const f = await fixture(t, 1); await acknowledge(f.journal, 'foreign');
  const restarted = await f.open(0); await assert.rejects(restarted.recover('another-worker', [profile], state()), /another worker/);
  const unexpected = join(f.journal.stateDir, 'snapshots/foreign/operator-note.txt'); await writeFile(unexpected, 'retain');
  await assert.rejects(restarted.recover('worker-1', [profile], state()), /Unexpected file/);
  assert.equal(await readFile(unexpected, 'utf8'), 'retain');
  await unlink(unexpected);
  const after = join(f.journal.stateDir, 'snapshots/foreign/after.json'), outside = join(f.directory, 'outside.json');
  await writeFile(outside, await readFile(after)); await unlink(after); await symlink(outside, after);
  await assert.rejects(restarted.recover('worker-1', [profile], state()), /symlink/);
  assert.ok(await readFile(outside));
});

test('local collection preserves separately managed repository evidence artifacts', async t => {
  const f = await fixture(t, 0, true); const { before, after } = await pair(f.journal, 'repo');
  await f.journal.flush(async () => {}); await f.journal.checkpoint('repo');
  assert.deepEqual(await f.pairs(), []);
  assert.equal(JSON.parse(await readFile(join(f.projectDir, before.provenance.artifactPath))).id, before.id);
  assert.equal(JSON.parse(await readFile(join(f.projectDir, after.provenance.artifactPath))).id, after.id);
});

test('real orchestrator telemetry and completion acknowledgments permit local retention cleanup', async t => {
  const f = await fixture(t, 0), config = await configuration({ profiles: 'claude' });
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken: 'admin-token-for-retention-test', enrollmentToken: 'enrollment-for-retention-test' });
  t.after(() => app.close());
  f.journal.configHash = config.policy.configHash;
  f.journal.promptHash = config.systemPromptHash;
  const gateway = new HttpWorkerGateway('http://127.0.0.1:' + app.server.address().port, 'enrollment-for-retention-test');
  const registration = await gateway.register(config.profiles, config.policy), identity = { ...registration, url: '', configHash: config.policy.configHash };
  const client = gateway.connect(identity);
  const submitted = app.store.submit({ project: 'demo', title: 'Retained evidence', criteria: ['Done'] }, 'retention-key');
  const assigned = await client.claim('retention-request');
  await executeAttempt(assigned, new AbortController().signal, { ...dependencies(f.journal), client, identity, profiles: config.profiles });
  assert.equal(app.store.get(submitted.id).status, 'simulated');
  assert.deepEqual(await f.pairs(), []); assert.deepEqual(await f.outbox(), []);
});

test('invalid direct worker retention configuration fails before acquiring the process lock', async t => {
  const f = await fixture(t), config = await configuration({});
  await assert.rejects(runWorker({ ...config, retainedPairs: -1, url: 'http://localhost', stateDir: f.journal.stateDir,
    enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 }, new AbortController().signal), /retainedPairs/);
  await assert.rejects(readFile(join(f.journal.stateDir, 'worker.lock')), { code: 'ENOENT' });
});
