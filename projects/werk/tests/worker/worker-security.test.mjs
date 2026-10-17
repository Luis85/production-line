import { testErrorField } from '../helpers/typed-boundaries.mjs';
import { testErrorMessage, testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, symlink, readdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { atomicWrite } from '../../src/worker/dist/worker/infrastructure/journal/files.js';
import { executeAttempt } from '../../src/worker/dist/worker/application/execute-attempt.js';
import { HttpWorkerGateway } from '../../src/worker/dist/worker/infrastructure/orchestrator-client.js';
import { ApiError } from '../../src/worker/dist/shared/http/errors.js';
/** @type {import('../../src/shared/domain.ts').Profile} */
const profile = { id: 'mock', provider: 'claude', mode: 'mock' };
/** @returns {import('../../src/shared/domain.ts').Task} */
const task = () => ({ id: 'task', project: 'demo', title: 'Security fixture', criteria: ['Preserve replay ownership'], wikilinks: [], priority: 1, status: 'running', createdAt: 0, profile: profile.id, provider: 'claude', workerId: 'worker', lease: 'lease', attempt: 1, expiresAt: Date.now() + 60000 });
const status = () => ({ lastContact: null, heartbeatErrors: 0, completedSimulations: 0, lastError: null, lastSnapshot: null });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-security-'));
  const journal = new SnapshotJournal(join(directory, 'state'), 'configuration', 'prompt'); await journal.init();
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  const assigned = task(), state = status(), events = [];
  const client = { async heartbeat(value) { return value; }, async publishSnapshot() { events.push('publish'); }, async complete() { events.push('complete'); }, async abandon() { events.push('abandon'); } };
  /** @type {import('../../src/worker/application/ports.ts').AttemptDependencies} */
  const dependencies = { journal, client, identity: { id: 'worker', project: 'demo' }, profiles: [profile], state,
    adapter: { mode: 'mock', async run() { events.push('run'); return { kind: 'simulated', summary: 'Security fixture completed' }; } }, async saveState() {}, timeoutMs: 1000 };
  const before = await journal.persist(journal.capture(assigned, 'worker', profile, state, 'before'));
  return { directory, journal, assigned, before, state, events, dependencies };
}

test('terminal replay rejects different task, attempt, profile and source provenance before publication or completion', async t => {
  const f = await fixture(t);
  const after = await f.journal.persist(f.journal.capture(f.assigned, 'worker', profile, f.state, 'after', f.before, 'simulated'));
  const source = { featureId: '', iterationId: '', branch: '', commit: '', path: '', iterationPrUrl: '', specSha256: '' };
  for (const changes of [{ id: 'other' }, { attempt: 2 }, { project: 'other' }, { profile: 'other' }, { source: { ...source, featureId: 'other' } }, { source: { ...source, commit: 'a'.repeat(40) } }, { source: { ...source, iterationId: 'other' } }]) {
    await assert.rejects(executeAttempt({ ...f.assigned, ...changes }, new AbortController().signal, f.dependencies), /assignment|does not match/);
    assert.deepEqual(f.events, []);
  }
  await executeAttempt(f.assigned, new AbortController().signal, f.dependencies);
  assert.ok(f.events.includes('complete')); assert.ok(!f.events.includes('run'));
  assert.deepEqual(await f.journal.read('lease', 'after'), after);
});

test('journal refuses conflicting prior identity while retaining immutable measurements for equivalent replay', async t => {
  const f = await fixture(t), original = await readFile(f.journal.path('lease', 'before'), 'utf8');
  const changed = f.journal.capture({ ...f.assigned, id: 'other' }, 'worker', profile, f.state, 'before');
  await assert.rejects(f.journal.persist(changed), /does not match/);
  assert.equal(await readFile(f.journal.path('lease', 'before'), 'utf8'), original);
  const wrongAfter = f.journal.capture({ ...f.assigned, id: 'other' }, 'worker', profile, f.state, 'after', f.before, 'simulated');
  await assert.rejects(f.journal.persist(wrongAfter), /does not match/);
  assert.equal(await f.journal.read('lease', 'after'), null);
  const equivalent = f.journal.capture(f.assigned, 'worker', profile, f.state, 'before');
  assert.deepEqual(await f.journal.persist(equivalent), f.before);
});

test('recovery rejects mismatched terminal pairs, orphan terminal records and changed historical providers', async t => {
  for (const kind of ['pair', 'orphan', 'provider']) {
    const f = await fixture(t);
    await f.journal.flush(async () => {});
    if (kind !== 'provider') {
      const after = f.journal.capture(kind === 'pair' ? { ...f.assigned, id: 'other' } : f.assigned, 'worker', profile, f.state, 'after', f.before, 'simulated');
      await writeFile(f.journal.path('lease', 'after'), JSON.stringify(after));
      if (kind === 'orphan') await unlink(f.journal.path('lease', 'before'));
    }
    await assert.rejects(f.journal.recover('worker', kind === 'provider' ? [{ ...profile, provider: 'codex' }] : [profile], f.state), /does not match|original before|changed profile/);
    assert.deepEqual(await readdir(join(f.journal.stateDir, 'outbox')), []);
    if (kind === 'provider') assert.equal(await f.journal.read('lease', 'after'), null);
  }
});

test('journal and atomic state writes reject a replaced root symlink without external reads, delivery or writes', async t => {
  const f = await fixture(t), outside = join(f.directory, 'outside');
  await rename(f.journal.stateDir, join(f.directory, 'saved-state'));
  await mkdir(join(outside, 'outbox'), { recursive: true }); await mkdir(join(outside, 'snapshots'));
  await symlink(outside, f.journal.stateDir, 'dir');
  await assert.rejects(f.journal.read('lease', 'before'), /symlink/);
  await assert.rejects(f.journal.recover('worker', [profile], f.state), /symlink/);
  await assert.rejects(f.journal.flush(async () => assert.fail('must not deliver outside state')), /symlink/);
  await assert.rejects(f.journal.persist(f.before), /symlink/);
  await assert.rejects(atomicWrite(join(f.journal.stateDir, 'identity.json'), 'private-token'), /symlink/);
  assert.deepEqual(await readdir(outside), ['outbox', 'snapshots']);
  assert.deepEqual(await readdir(join(outside, 'outbox')), []); assert.deepEqual(await readdir(join(outside, 'snapshots')), []);
});

test('worker transport suppresses reflected secrets over HTTP while retaining retry classification', async () => {
  const secret = 'worker-token-private-source', server = createServer((request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: request.headers.authorization + ' private requirement content' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const gateway = new HttpWorkerGateway('http://127.0.0.1:' + testListeningAddress(server).port, secret);
    for (const operation of [() => gateway.register([profile], {maxParallel:1,order:'fifo',maxAttempts:1,configHash:'configuration'}), () => gateway.connect({ token: secret }).currentAssignments()])
      await assert.rejects(operation(), error => testErrorField(error, 'retryable') === false && /HTTP 403/.test(testErrorMessage(error)) && !testErrorMessage(error).includes(secret) && !testErrorField(error, 'cause'));
    for (const [cause, retryable] of [[new ApiError(429, secret), true], [new ApiError(503, secret), true], [new ApiError(409, secret), false], [Error(secret), true]]) {
      const client = new HttpWorkerGateway('http://localhost', '', async () => { throw cause; }).connect({ token: secret });
      await assert.rejects(client.currentAssignments(), error => testErrorField(error, 'retryable') === retryable && !testErrorMessage(error).includes(secret) && !testErrorField(error, 'cause'));
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
