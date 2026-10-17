import { expectImported } from '../iteration-results.mjs';
import { testErrorStatus } from '../../helpers/process-errors.mjs';
import { testErrorCode, testErrorMessage, testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { importIteration } from '../../../src/orchestrator/dist/orchestrator/intake/importer.js';

const task = extra => ({ project: 'demo', title: 'Feature', criteria: ['Accepted'], wikilinks: [], provider: 'auto', priority: 1, ...extra });
const profiles = [{ id: 'claude', provider: 'claude', mode: 'mock' }];
const config = { db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken: 'a'.repeat(32), enrollmentToken: 'e'.repeat(32) };
const exec = promisify(execFile);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function remaining(first, read, key) {
  let page = first;
  const rows = [...page[key]];
  const cursors = new Set();
  while (page.hasMore) {
    assert.equal(typeof page.nextCursor, 'string');
    assert.ok(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor);
    page = read(page.nextCursor); rows.push(...page[key]);
  }
  assert.equal(page.nextCursor, null);
  return rows;
}

test('task cursor pages preserve ordering through tied timestamps, backdated inserts and database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-pages-'));
  const path = join(directory, 'db.sqlite');
  let now = 1000, store = new Store(path, 60000, () => now);
  try {
    for (let n = 0; n < 7; n++) store.submit(task(), 'old-' + n);
    const expected = store.list().map(t => t.id);
    const first = store.taskPage({ limit: 2 });
    assert.equal(first.tasks.length, 2); assert.equal(first.hasMore, true);
    now = 500; store.submit(task(), 'backdated-new');
    now = 1000; store.submit(task(), 'tied-new');
    store.close(); store = new Store(path, 60000, () => now);
    const rows = remaining(first, cursor => store.taskPage({ cursor, limit: 2 }), 'tasks');
    assert.deepEqual(rows.map(t => t.id), expected);
    assert.equal(store.list().length, 9);
    assert.deepEqual(store.taskPage({ limit: 100 }).tasks.map(t => t.id), store.list().map(t => t.id));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('worker cursor pages use registration order and exclude later registrations despite heartbeats', () => {
  let now = 1000; const store = new Store(':memory:', 100, () => now);
  try {
    const ids = Array.from({ length: 5 }, () => store.register('demo', profiles).id);
    const first = store.workerPage({ limit: 2 });
    now = 2000;
    store.db.prepare('UPDATE workers SET seen=? WHERE id=?').run(now, ids[0]);
    store.register('demo', profiles);
    const rows = remaining(first, cursor => store.workerPage({ limit: 2, cursor }), 'workers');
    assert.deepEqual(rows.map(w => w.id), [...ids].reverse());
    assert.equal(rows.at(-1).online, true);
    assert.ok(!JSON.stringify(rows).includes('token'));
  } finally { store.close(); }
});

test('event pages are task-scoped with a stable first-page watermark', () => {
  const store = new Store(':memory:');
  try {
    const one = store.submit(task(), 'one'), two = store.submit(task(), 'two');
    for (let n = 0; n < 5; n++) store.event(one.id, 'observed', { n });
    const expected = store.events(one.id).map(event => event.seq);
    const first = store.eventPage(one.id, { limit: 2 });
    store.event(one.id, 'later', {});
    assert.throws(() => store.eventPage(two.id, { cursor: first.nextCursor }), error => testErrorCode(error) === 'invalid_input');
    const rows = remaining(first, cursor => store.eventPage(one.id, { limit: 2, cursor }), 'events');
    assert.deepEqual(rows.map(event => event.seq), expected);
    assert.throws(() => store.eventPage('missing', {}), error => testErrorCode(error) === 'not_found');
  } finally { store.close(); }
});

test('page bytes stay below transport limits without dropping large task records', () => {
  const store = new Store(':memory:');
  try {
    const large = task({ criteria: Array.from({ length: 30 }, () => 'x'.repeat(1900)) });
    for (let n = 0; n < 85; n++) store.submit(large, 'large-' + n);
    const first = store.taskPage({ limit: 1000 });
    assert.ok(first.tasks.length < 85); assert.equal(first.hasMore, true);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 4 * 1024 * 1024 + 1024);
    const pages = [first];
    const rows = remaining(first, cursor => { const page = store.taskPage({ limit: 1000, cursor }); pages.push(page); return page; }, 'tasks');
    assert.equal(rows.length, 85); assert.equal(new Set(rows.map(t => t.id)).size, 85);
    for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4 * 1024 * 1024 + 1024);
  } finally { store.close(); }
});

test('page validation rejects malformed, mismatched and oversized cursor or limit values', () => {
  const store = new Store(':memory:');
  try {
    for (let n = 0; n < 101; n++) store.submit(task(), 'task-' + n);
    assert.equal(store.taskPage({}).tasks.length, 100);
    for (const limit of [0, -1, 0.5, 1001, NaN, '2', null]) {
      // @ts-expect-error Intentionally send nonnumeric and out-of-range limits to runtime validation.
      assert.throws(() => store.taskPage({ limit }), error => testErrorCode(error) === 'invalid_input');
    }
    const valid = store.taskPage({ limit: 1 }).nextCursor;
    const decoded = JSON.parse(Buffer.from(valid, 'base64url').toString('utf8'));
    for (const cursor of ['', '*', 'x'.repeat(1025), encode(null), encode({ ...decoded, version: 2 }), encode({ ...decoded, watermark: -1 }), encode({ ...decoded, created: '1000' }), encode({ ...decoded, extra: true }), valid + '=']) {
      assert.throws(() => store.taskPage({ cursor }), error => testErrorCode(error) === 'invalid_input');
    }
    assert.throws(() => store.workerPage({ cursor: valid }), error => testErrorCode(error) === 'invalid_input');
    // @ts-expect-error Unknown pagination options must be rejected at the runtime boundary.
    assert.throws(() => store.taskPage({ unexpected: true }), error => testErrorCode(error) === 'invalid_input');
  } finally { store.close(); }
});

test('HTTP and CLI expose additive pages while legacy list shapes remain unchanged', async () => {
  const app = await startServer(config);
  try {
    for (let n = 0; n < 3; n++) app.store.submit(task(), 'task-' + n);
    for (let n = 0; n < 3; n++) app.store.register('demo', profiles);
    const id = app.store.list()[0].id; app.store.event(id, 'extra', {});
    const base = 'http://127.0.0.1:' + testListeningAddress(app.server).port;
    const get = path => fetch(base + path, { headers: { Authorization: 'Bearer ' + config.adminToken } });
    for (const [path, key] of [['/v1/tasks', 'tasks'], ['/v1/workers', 'workers'], ['/v1/tasks/' + id + '/events', 'events']]) {
      const legacy = await (await get(path)).json(); assert.deepEqual(Object.keys(legacy), [key]);
      const page = await (await get(path + '?limit=1')).json(); assert.equal(page[key].length, 1); assert.equal(page.hasMore, true);
      const next = await (await get(path + '?limit=1&cursor=' + page.nextCursor)).json();
      assert.notDeepEqual(page[key], next[key]);
      for (const query of ['limit=0', 'limit=1001', 'limit=', 'limit=01', 'limit=1e2', 'limit=0x10', 'limit=%201', 'limit=%2B1', 'limit=1.0', 'limit=9007199254740992', 'limit=1&limit=2', 'cursor=', 'cursor=a&cursor=b', 'limt=1']) {
        const response = await get(path + '?' + query); assert.equal(response.status, 400, path + '?' + query); await response.text();
      }
    }
    assert.equal((await fetch(base + '/v1/tasks?limit=bad')).status, 401);
    for (const query of ['after=', 'before=', 'after=1e2', 'after=0x10', 'after=%2B1', 'after=1&after=2', 'order=asc&order=desc', 'limit=01', 'worker=', 'limt=1']) {
      const response = await get('/v1/snapshots?' + query); assert.equal(response.status, 400, query); await response.text();
    }
    for (const commands of [['task', 'list'], ['workers', 'list'], ['task', 'events', '--id', id]]) {
      const result = await exec(process.execPath, ['src/orchestrator/dist/orchestrator/cli.js', ...commands, '--limit', '1', '--url', base], { env: { ...process.env, WERK_ADMIN_TOKEN: config.adminToken } });
      const page = JSON.parse(result.stdout); assert.equal(page.hasMore, true); assert.equal(typeof page.nextCursor, 'string');
    }
  } finally { await app.close(); }
});

async function repository() {
  const repo = await mkdtemp(join(tmpdir(), 'werk-page-import-'));
  await mkdir(join(repo, 'docs/features'), { recursive: true });
  await writeFile(join(repo, 'docs/features/feature.md'), '---\nfactory_id: feature-1\nfactory_iteration: week-1\nfactory_status: ready_for_implementation\ntitle: Planned feature\nfactory_acceptance:\n  - Accepted\n---\nSpecification');
  const git = (...args) => exec('git', ['-C', repo, ...args]);
  await git('init', '-b', 'iteration/week-1'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
  await git('add', '.'); await git('commit', '-m', 'Plan');
  return { repo, branch: 'iteration/week-1', project: 'demo', iteration: 'week-1', 'iteration-pr': 'https://example.test/pull/1' };
}

test('iteration import follows all pages so an old matching feature remains unchanged', async () => {
  const options = await repository(); const app = await startServer(config);
  try {
    options.url = 'http://127.0.0.1:' + testListeningAddress(app.server).port;
    const first = expectImported(await importIteration(options, config.adminToken));
    assert.equal(first.results[0].status, 'created');
    for (let n = 0; n < 105; n++) app.store.submit(task(), 'newer-' + n);
    // Ensure the matching feature is beyond the first page regardless of clock precision.
    app.store.db.prepare('UPDATE tasks SET created=0 WHERE id=?').run(first.results[0].taskId);
    const next = expectImported(await importIteration(options, config.adminToken));
    assert.equal(next.results[0].status, 'unchanged');
    assert.equal(next.results[0].taskId, first.results[0].taskId);
    assert.equal(app.store.list().length, 106);
  } finally { await app.close(); await rm(options.repo, { recursive: true, force: true }); }
});

test('iteration import fails closed when a server repeats a continuation cursor', async () => {
  const options = await repository(); let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tasks: [{ ...task(), id: 'existing-task' }], hasMore: true, nextCursor: 'repeated' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    options.url = 'http://127.0.0.1:' + testListeningAddress(server).port;
    await assert.rejects(importIteration(options, config.adminToken), error => testErrorStatus(error, 'status') === 502 && testErrorMessage(error).includes('did not advance'));
    assert.equal(requests, 2);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(options.repo, { recursive: true, force: true }); }
});


test('large expiry sweeps remain atomic across bounded batches and emit each event once', () => {
  let now = 1000; const store = new Store(':memory:', 100, () => now);
  try {
    for (let n = 0; n < 264; n++) store.submit(task(), 'expired-' + n);
    for (let n = 0; n < 33; n++) {
      const worker = store.worker(store.register('demo', [{ ...profiles[0], maxParallel: 8 }], { maxParallel: 8, order: 'priority', configHash: 'default' }).token);
      for (let slot = 0; slot < 8; slot++) assert.ok(store.claim(worker, 'slot-' + slot));
    }
    now = 1200;
    const event = store.event.bind(store); let written = 0;
    store.event = (...args) => { if (++written === 257) throw Error('Injected event write failure'); return event(...args); };
    assert.throws(() => store.reapExpired(), /Injected event write failure/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status='running'").get().count, 264);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='lease_expired'").get().count, 0);
    store.event = event;
    assert.equal(store.reapExpired(), 264); assert.equal(store.reapExpired(), 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='lease_expired'").get().count, 264);
    assert.equal(store.taskPage({ limit: 1000 }).tasks.every(task => task.status === 'queued'), true);
  } finally { store.close(); }
});
