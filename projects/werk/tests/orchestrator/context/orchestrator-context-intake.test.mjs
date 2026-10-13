import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { OrchestratorApplication } from '../../../src/orchestrator/dist/orchestrator/application.js';
import { BoundContextIntake } from '../../../src/orchestrator/dist/orchestrator/context/intake.js';
import { resolveContext } from '../../../src/orchestrator/dist/orchestrator/context/resolver.js';
import { SnapshotJournal } from '../../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

const exec = promisify(execFile);
const input = { project: 'demo', requirementRef: '[[Feature]]' };
const profiles = [{ id: 'claude', provider: 'claude', mode: 'mock' }];
const config = { db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken: 'a'.repeat(32), enrollmentToken: 'e'.repeat(32) };
const note = overrides => '---\n' + Object.entries({ factory_id: 'feature-1', title: '  Pinned feature  ', factory_status: 'ready_for_implementation', factory_acceptance: ['  Observable success  '], factory_context: ['[[Detail]]'], ...overrides }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\nPrivate requirement body.';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-intake-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(join(repo, 'docs'), { recursive: true });
  const git = async (...args) => (await exec('git', ['-C', repo, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  for (const [name, content] of Object.entries({ Feature: note(), Detail: '# Private supporting context', Draft: note({ factory_status: 'draft' }), Excess: note({ factory_acceptance: Array.from({ length: 31 }, () => 'Criterion') }) })) await writeFile(join(repo, 'docs', name + '.md'), content);
  await git('add', '.'); await git('commit', '-qm', 'Original');
  return { root, repo, git, commit: await git('rev-parse', 'HEAD') };
}
async function memoryManifest(commit = 'a'.repeat(40)) {
  const files = [{ path: 'docs/Feature.md', objectId: 'b'.repeat(40), mode: '100644' }];
  return resolveContext({ repository: '/operator/repo', commit, files, read: async () => Buffer.from(note({ factory_context: [] })) }, { project: 'demo', vaultRoot: 'docs', wikilink: '[[Feature]]' });
}
function remote(app) {
  const url = 'http://127.0.0.1:' + app.server.address().port;
  return {
    url,
    get: (path, token = config.adminToken) => fetch(url + path, { headers: { Authorization: 'Bearer ' + token } }),
    post: (body, key = 'feature-1', token = config.adminToken) => fetch(url + '/v1/tasks', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }),
  };
}

test('bound HTTP and minimal CLI intake persist ready context without leaking content in task summaries', async t => {
  const f = await fixture(t); const app = await startServer({ ...config, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
  try {
    const api = remote(app);
    for (const [body, status] of [[{ ...input, project: 'other' }, 403], [{ ...input, title: 'Override' }, 400], [{ ...input, criteria: [] }, 400], [{ ...input, wikilinks: [] }, 400], [{ ...input, context: {} }, 400], [{ project: 'demo', title: 'Manual', criteria: ['Accepted'] }, 400], [{ ...input, requirementRef: '[[Missing]]' }, 400], [{ ...input, requirementRef: '[[Draft]]' }, 400], [{ ...input, requirementRef: '[[Excess]]' }, 400], [{ ...input, requirementRef: '[[../escape]]' }, 400], [{ ...input, requirementRef: '[[Feature#Heading]]' }, 400]]) {
      const response = await api.post(body); assert.equal(response.status, status, JSON.stringify(body)); await response.text();
      assert.equal(app.store.list().length, 0);
    }
    assert.equal((await api.post(input, 'key', config.enrollmentToken)).status, 401);
    const response = await api.post(input); assert.equal(response.status, 201); const task = await response.json();
    assert.equal(task.title, 'Pinned feature'); assert.deepEqual(task.criteria, ['Observable success']);
    assert.equal(task.context.commit, f.commit); assert.equal(task.context.featureId, 'feature-1');
    assert.equal((await (await api.get('/healthz')).json()).schema, 4);
    const manifest = await (await api.get('/v1/tasks/' + task.id + '/context')).json();
    const { sha256, ...unsigned } = manifest;
    assert.equal(sha256, createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'));
    assert.equal(task.context.sha256, sha256); assert.equal(manifest.files.length, 2);
    assert.ok(manifest.files.some(file => file.content.includes('Private supporting context')));
    const listing = await (await api.get('/v1/tasks?limit=100')).text();
    assert.ok(!listing.includes('Private supporting context')); assert.ok(!listing.includes(f.repo));
    const cli = await exec(process.execPath, ['src/orchestrator/dist/orchestrator/cli.js', 'task', 'create', '--project', 'demo', '--wikilink', '[[Feature]]', '--key', 'from-cli', '--url', api.url], { env: { ...process.env, WERK_ADMIN_TOKEN: config.adminToken } });
    assert.equal(JSON.parse(cli.stdout).context.sha256, sha256);
  } finally { await app.close(); }
});

test('bound intake preserves explicit live opt-in, immutable context and mock defaults', async t => {
  const f = await fixture(t); const app = await startServer({ ...config, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
  try {
    const api = remote(app), liveInput = { ...input, provider: 'codex', executionMode: 'cli' };
    for (const invalid of [{ ...liveInput, provider: 'claude' }, { ...liveInput, title: 'Override' }, { ...liveInput, criteria: ['Override'] }]) {
      const response = await api.post(invalid, 'invalid-live'); assert.equal(response.status, 400); await response.text();
    }
    assert.equal(app.store.list().length, 0);
    const response = await api.post(liveInput, 'pinned-live'); assert.equal(response.status, 201);
    const live = await response.json();
    assert.equal(live.executionMode, 'cli'); assert.equal(live.provider, 'codex');
    assert.equal(live.context.commit, f.commit); assert.equal(live.title, 'Pinned feature');
    assert.deepEqual(live.criteria, ['Observable success']);
    const replay = await api.post(liveInput, 'pinned-live'); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), live);
    const changedMode = await api.post({ ...liveInput, executionMode: 'mock' }, 'pinned-live');
    assert.equal(changedMode.status, 409); await changedMode.text();
    const mockAuth = app.store.register('demo', [{ id: 'codex-mock', provider: 'codex', mode: 'mock', maxParallel: 2 }], { maxParallel: 2, order: 'fifo', maxAttempts: 3, configHash: 'mock' });
    const mockWorker = app.store.worker(mockAuth.token);
    assert.equal(app.store.claim(mockWorker, 'mock-cannot-run-live'), null);
    const liveAuth = app.store.register('demo', [{ id: 'codex-live', provider: 'codex', mode: 'cli' }], { maxParallel: 1, order: 'fifo', maxAttempts: 1, configHash: 'live' });
    const liveWorker = app.store.worker(liveAuth.token), assignment = app.store.claim(liveWorker, 'live-claim');
    assert.equal(assignment.id, live.id); assert.equal(assignment.executionMode, 'cli');
    const contextResponse = await api.get('/v1/worker/tasks/' + live.id + '/context?lease=' + assignment.lease + '&attempt=' + assignment.attempt, liveAuth.token);
    assert.equal(contextResponse.status, 200); assert.equal((await contextResponse.json()).sha256, live.context.sha256);
    const defaultResponse = await api.post(input, 'default-mock'); assert.equal(defaultResponse.status, 201);
    const defaultTask = await defaultResponse.json(); assert.equal(defaultTask.executionMode, undefined);
    const mockResponse = await api.post({ ...input, executionMode: 'mock' }, 'explicit-mock'); assert.equal(mockResponse.status, 201);
    const mockTask = await mockResponse.json(); assert.equal(mockTask.executionMode, 'mock');
    const spareLive = app.store.register('demo', [{ id: 'codex-live', provider: 'codex', mode: 'cli' }]);
    assert.equal(app.store.claim(app.store.worker(spareLive.token), 'live-cannot-run-mock'), null);
    const mockAssignments = [app.store.claim(mockWorker, 'mock-one'), app.store.claim(mockWorker, 'mock-two')];
    assert.deepEqual(new Set(mockAssignments.map(task => task.id)), new Set([defaultTask.id, mockTask.id]));
    assert.ok(mockAssignments.every(task => task.context.sha256 === live.context.sha256));
  } finally { await app.close(); }
});

test('retries preserve the first committed manifest after binding changes and repository loss', async t => {
  const f = await fixture(t); const db = join(f.root, 'state.sqlite');
  let app = await startServer({ ...config, db, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
  try {
    const first = await (await remote(app).post(input)).json(); const manifest = app.store.context(first.id);
    await writeFile(join(f.repo, 'docs/Feature.md'), note({ title: 'Changed requirement' })); await f.git('add', '.'); await f.git('commit', '-qm', 'Changed');
    const nextCommit = await f.git('rev-parse', 'HEAD'); await app.close();
    await rename(f.repo, f.repo + '-offline');
    app = await startServer({ ...config, db, context: { repo: f.repo, commit: nextCommit, vaultRoot: 'docs' } });
    const api = remote(app); const replay = await api.post(input); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), first);
    assert.deepEqual(await (await api.get('/v1/tasks/' + first.id + '/context')).json(), manifest);
    const changed = await api.post({ ...input, priority: 2 }); assert.equal(changed.status, 409); await changed.text();
    const fresh = await api.post(input, 'new-key'); assert.equal(fresh.status, 400); await fresh.text();
    assert.equal(app.store.list().length, 1); assert.equal(app.store.events(first.id).length, 1);
  } finally { await app.close(); }
});

test('concurrent resolution commits one immutable context using the original request digest', async () => {
  const store = new Store(':memory:');
  try {
    const [first, second] = await Promise.all([memoryManifest(), memoryManifest('c'.repeat(40))]);
    let completeFirst, completeSecond;
    const app1 = new OrchestratorApplication(store, 'demo', { assertOpen() {}, resolve: () => new Promise(resolve => { completeFirst = resolve; }) });
    const app2 = new OrchestratorApplication(store, 'demo', { assertOpen() {}, resolve: () => new Promise(resolve => { completeSecond = resolve; }) });
    const one = app1.createTask(input, 'same'), two = app2.createTask(input, 'same');
    completeSecond(second); const winner = await two; completeFirst(first); const replay = await one;
    assert.equal(replay.id, winner.id); assert.equal(replay.context.commit, second.commit);
    assert.deepEqual(store.context(winner.id), second); assert.equal(store.list().length, 1);
    assert.throws(() => store.db.prepare('UPDATE task_contexts SET payload=? WHERE task=?').run('{}', winner.id), /immutable/);
    assert.throws(() => store.db.prepare('DELETE FROM task_contexts WHERE task=?').run(winner.id), /immutable/);
    await assert.rejects(app1.createTask({ ...input, priority: 2 }, 'same'), error => error.code === 'conflict');
  } finally { store.close(); }
});

test('context persistence failure rolls back its task and event atomically', async () => {
  const store = new Store(':memory:');
  try {
    const manifest = await memoryManifest();
    store.db.exec("CREATE TRIGGER fail_context BEFORE INSERT ON task_contexts BEGIN SELECT RAISE(ABORT,'injected context failure'); END");
    assert.throws(() => store.submitResolved(input, 'atomic', manifest), /injected context failure/);
    assert.equal(store.list().length, 0); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
    store.db.exec('DROP TRIGGER fail_context');
    const task = store.submitResolved(input, 'atomic', manifest); assert.equal(store.context(task.id).sha256, task.context.sha256);
  } finally { store.close(); }
});

test('schema4 migrates legacy mock tasks without inventing context or changing retries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-v4-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, 'state.sqlite'); let store = new Store(db);
  try {
    const legacy = store.submit(input, 'legacy'); const auth = store.register('demo', profiles);
    store.db.exec('DROP TABLE task_contexts; PRAGMA user_version=3'); store.close(); store = new Store(db);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(store.submission(input, 'legacy'), legacy); assert.equal(store.worker(auth.token).id, auth.id);
    assert.equal(store.get(legacy.id).context, undefined); assert.throws(() => store.context(legacy.id), error => error.code === 'not_found');
    store.db.exec('PRAGMA user_version=5'); store.close(); store = undefined;
    assert.throws(() => new Store(db), /newer than/);
  } finally { store?.close(); }
});

test('worker context reads require exact historical assignment authority and do not restore stale leases', async t => {
  const f = await fixture(t); const app = await startServer({ ...config, context: { repo: f.repo, commit: f.commit, vaultRoot: 'docs' } });
  let journal;
  try {
    const api = remote(app); const task = await (await api.post(input)).json();
    const auth = app.store.register('demo', profiles), foreign = app.store.register('demo', profiles);
    const worker = app.store.worker(auth.token), other = app.store.worker(foreign.token);
    const assigned = app.store.claim(worker, 'first');
    const path = '/v1/worker/tasks/' + task.id + '/context?lease=' + assigned.lease + '&attempt=' + assigned.attempt;
    assert.equal((await api.get(path, auth.token)).status, 200);
    assert.equal((await api.get(path, foreign.token)).status, 403);
    assert.equal((await api.get(path.replace(assigned.lease, 'wrong'), auth.token)).status, 403);
    assert.equal((await api.get('/v1/worker/tasks/' + task.id + '/context', auth.token)).status, 400);
    assert.equal((await api.get('/v1/tasks/' + task.id + '/context', auth.token)).status, 401);
    journal = new SnapshotJournal(f.root, 'default', 'prompt');
    const before = journal.capture(assigned, worker.id, worker.profiles[0], { lastContact: null, heartbeatErrors: 0 }, 'before');
    assert.throws(() => app.store.snapshot(worker, { ...before, provenance: { ...before.provenance, contextManifestHash: null } }), error => error.code === 'invalid_input');
    assert.throws(() => app.store.snapshot(worker, { ...before, provenance: { ...before.provenance, sourceCommit: 'f'.repeat(40) } }), error => error.code === 'invalid_input');
    assert.equal(app.store.snapshot(worker, before).id, before.id);
    app.store.abandon(worker, assigned.id, assigned.lease, assigned.attempt); const current = app.store.claim(other, 'next');
    const count = app.store.events(task.id).length;
    assert.equal((await api.get(path, auth.token)).status, 200); assert.equal(app.store.events(task.id).length, count);
    assert.throws(() => app.store.heartbeat(worker, task.id, assigned.lease, assigned.attempt), error => error.code === 'conflict');
    assert.equal(app.store.get(task.id).lease, current.lease);
    app.store.db.prepare('UPDATE workers SET project=? WHERE id=?').run('different', worker.id);
    assert.equal((await api.get(path, auth.token)).status, 403);
  } finally { journal?.close(); await app.close(); }
});

test('resolver admission and total deadline stay bounded even if underlying source ignores cancellation', { timeout: 3000 }, async () => {
  const store = new Store(':memory:'); const manifest = await memoryManifest(); const pending = [];
  const intake = new BoundContextIntake('demo', { repo: '/operator/repo', commit: manifest.commit, vaultRoot: 'docs' }, { timeoutMs: 25, resolve: () => new Promise(resolve => pending.push(resolve)) });
  const app = new OrchestratorApplication(store, 'demo', intake);
  try {
    const first = app.createTask(input, 'one'), second = app.createTask(input, 'two');
    const settled = Promise.allSettled([first, second]);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.length, 2);
    await assert.rejects(app.createTask(input, 'third'), error => error.code === 'unavailable');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok((await settled).every(result => result.status === 'rejected' && result.reason.code === 'unavailable'));
    await assert.rejects(app.createTask(input, 'still-full'), error => error.code === 'unavailable');
    await intake.close();
    for (const resolve of pending) resolve(manifest);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(store.list().length, 0);
  } finally { await intake.close(); store.close(); }
});

test('closing admitted resolution prevents a late result from inserting after shutdown', async () => {
  const store = new Store(':memory:'); const manifest = await memoryManifest(); let finish;
  const intake = new BoundContextIntake('demo', { repo: '/operator/repo', commit: manifest.commit, vaultRoot: 'docs' }, { resolve: () => new Promise(resolve => { finish = resolve; }) });
  const app = new OrchestratorApplication(store, 'demo', intake);
  const result = app.createTask(input, 'closing'); const rejected = assert.rejects(result, error => error.code === 'unavailable');
  await new Promise(resolve => setImmediate(resolve)); await intake.close(); await rejected; store.close();
  finish(manifest); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(app.createTask(input, 'after-close'), error => error.code === 'unavailable');
});
