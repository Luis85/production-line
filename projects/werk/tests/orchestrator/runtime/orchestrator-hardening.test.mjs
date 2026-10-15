import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';

const profiles = [{ id: 'claude', provider: 'claude', mode: 'mock' }];
const task = (extra = {}) => ({ project: 'demo', title: 'Feature', criteria: ['Accepted'], wikilinks: [], provider: 'auto', priority: 1, ...extra });
const config = { db: ':memory:', host: '127.0.0.1', port: 0, project: 'demo', adminToken: 'a'.repeat(32), enrollmentToken: 'e'.repeat(32) };

test('scheduler loads only an eligible task and never scans the queue when capacity is full', () => {
  const store = new Store(':memory:');
  try {
    const worker = store.worker(store.register('demo', profiles).token);
    for (let i = 0; i < 100; i++) {
      store.submit(task({ project: 'other', priority: 2 }), `foreign-${i}`);
      store.submit(task({ provider: 'codex', priority: 2 }), `provider-${i}`);
    }
    const eligible = store.submit(task(), 'eligible');
    const decode = store.decode.bind(store);
    let decoded = 0;
    store.decode = row => { decoded++; return decode(row); };
    assert.equal(store.claim(worker, 'first').id, eligible.id);
    assert.ok(decoded <= 2, `decoded ${decoded} task payloads for a single assignment`);
    decoded = 0;
    assert.equal(store.claim(worker, 'second'), null);
    assert.equal(decoded, 1, 'only the active assignment is loaded for a full worker');
    assert.equal(store.claim(worker, 'first').id, eligible.id, 'claim replay survives full capacity');
  } finally { store.close(); }
});

test('FIFO scheduling skips saturated providers while preserving order among compatible tasks', () => {
  let now = 1000;
  const store = new Store(':memory:', 60000, () => now++);
  try {
    const worker = store.worker(store.register('demo', [...profiles, { id: 'codex', provider: 'codex', mode: 'mock' }], { maxParallel: 2, order: 'fifo', configHash: 'default' }).token);
    const first = store.submit(task({ provider: 'claude' }), 'first');
    store.submit(task({ provider: 'claude', priority: 2 }), 'saturated');
    const second = store.submit(task({ provider: 'codex', priority: 1 }), 'second');
    store.submit(task({ provider: 'codex', priority: 2 }), 'later-high-priority');
    assert.equal(store.claim(worker, 'claim-1').id, first.id);
    assert.equal(store.claim(worker, 'claim-2').id, second.id);
    assert.equal(store.claim(worker, 'claim-3'), null);
  } finally { store.close(); }
});

test('independent SQLite processes claim disjoint assignments and retain fencing after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-scheduler-concurrency-'));
  const path = join(directory, 'state.sqlite');
  let store;
  try {
    store = new Store(path);
    const registrations = Array.from({ length: 2 }, () => store.register('demo', [{ ...profiles[0], maxParallel: 8 }], { maxParallel: 8, order: 'priority', configHash: 'default' }));
    for (let i = 0; i < 16; i++) store.submit(task(), `task-${i}`);
    store.close(); store = undefined;
    const source = `import { Store } from ${JSON.stringify(new URL('../../../src/orchestrator/dist/orchestrator/persistence/store.js', import.meta.url).href)};
      const store = new Store(process.argv[1]);
      try { const worker = store.worker(process.argv[2]); const tasks = [];
        for (let i = 0; i < 400 && tasks.length < 8; i++) { const task = store.claim(worker, 'claim-' + i); if (task) tasks.push(task); else await new Promise(resolve => setTimeout(resolve, 10)); }
        console.log(JSON.stringify(tasks));
      } finally { store.close(); }`;
    const results = await Promise.all(registrations.map(auth => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, path, auth.token])));
    const assigned = results.flatMap(result => JSON.parse(result.stdout));
    assert.equal(assigned.length, 16);
    assert.ok(assigned.every(Boolean));
    assert.equal(new Set(assigned.map(item => item.id)).size, 16);
    assert.equal(new Set(assigned.map(item => item.lease)).size, 16);
    store = new Store(path);
    const worker = store.worker(registrations[0].token);
    const own = assigned.find(item => item.workerId === worker.id);
    const foreign = assigned.find(item => item.workerId !== worker.id);
    assert.equal(store.claim(worker, 'claim-0').lease, JSON.parse(results[0].stdout)[0].lease);
    assert.throws(() => store.heartbeat(worker, foreign.id, foreign.lease, foreign.attempt), error => error.code === 'conflict');
    assert.equal(store.heartbeat(worker, own.id, own.lease, own.attempt).status, 'running');
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('shutdown aborts an unfinished upload at its configured deadline and releases the database', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-shutdown-'));
  const path = join(directory, 'state.sqlite');
  const app = await startServer({ ...config, db: path, shutdownTimeoutMs: 40 });
  let socket;
  try {
    const requestStarted = once(app.server, 'request');
    socket = connect(app.server.address().port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(`POST /v1/tasks HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${config.adminToken}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    const [request] = await requestStarted;
    assert.equal(request.complete, false, 'the real HTTP upload remains incomplete');
    const aborted = new Promise(resolve => request.once('aborted', resolve));
    const forceClose = t.mock.method(app.server, 'closeAllConnections');
    const closeStore = t.mock.method(app.store, 'close');
    // Control only the shutdown clock; real TCP and SQLite cleanup may be delayed by CI scheduling.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const closing = app.close();
    assert.equal(app.close(), closing, 'concurrent shutdown callers share one completion');
    t.mock.timers.tick(39);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(forceClose.mock.callCount(), 0, 'active uploads retain their configured grace period');
    assert.equal(closeStore.mock.callCount(), 0, 'the database stays open until active requests stop');
    assert.equal(request.destroyed, false);
    assert.deepEqual(app.store.list(), []);
    t.mock.timers.tick(1);
    assert.equal(forceClose.mock.callCount(), 1, 'the deadline forces active connections closed');
    await Promise.all([closing, aborted]);
    assert.equal(request.destroyed, true);
    assert.equal(app.server.listening, false);
    assert.equal(closeStore.mock.callCount(), 1, 'shutdown releases the database exactly once');
    const reopened = new Store(path);
    try { assert.deepEqual(reopened.list(), []); } finally { reopened.close(); }
  } finally {
    socket?.destroy(); app.server.closeAllConnections();
    try { await app.close(); }
    finally { t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('shutdown deadlines reject invalid configuration before opening a server', async () => {
  for (const shutdownTimeoutMs of [0, -1, 0.5, 60001, NaN]) {
    await assert.rejects(startServer({ ...config, shutdownTimeoutMs }), error => error.code === 'invalid_input');
  }
});
