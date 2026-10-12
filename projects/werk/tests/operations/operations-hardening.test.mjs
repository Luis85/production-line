import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { HttpLineReader } from '../../src/factory/dist/factory/infrastructure/poller.js';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';

const credential = 'WERK_LINE_ALPHA_TOKEN';
const line = id => ({ id: String(id), name: 'Line', factoryId: 'root', orchestratorUrl: `http://line-${id}.invalid`, webviewUrl: 'http://localhost/', tokenEnv: credential });
const timed = async (promise, timeout = 1000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Operation exceeded its deadline')), timeout); })]); }
  finally { clearTimeout(timer); }
};

test('queued polls cancel immediately on close even while an upstream request is still unwinding', async t => {
  let finish;
  const started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return new Promise(resolve => { finish = () => resolve(new Response('', { status: 503 })); }); });
  const reader = new HttpLineReader({ [credential]: 'secret' }, 30000, 1);
  const active = reader.read(line(0));
  await started.promise;
  const queued = Array.from({ length: 20 }, (_, index) => reader.read(line(index + 1)));
  try {
    reader.close();
    const results = await timed(Promise.all(queued));
    assert.ok(results.every(result => result.status === 'unavailable'));
    assert.equal((await reader.read(line(21))).error, 'Factory service is stopping');
  } finally { finish(); await active; reader.close(); }
});

test('a queued poll deadline is independent of the occupied network slot', async t => {
  let finish;
  const started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return new Promise(resolve => { finish = () => resolve(new Response('', { status: 503 })); }); });
  const reader = new HttpLineReader({ [credential]: 'secret' }, 50, 1);
  const active = reader.read(line(0));
  await started.promise;
  try {
    const result = await timed(reader.read(line(1)));
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /waiting to poll/);
  } finally { finish(); await active; reader.close(); }
});

test('polling rejects excess retained work without starving duplicate reads', async t => {
  let finish;
  const started = Promise.withResolvers();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return new Promise(resolve => { finish = () => resolve(new Response('', { status: 503 })); }); });
  const reader = new HttpLineReader({ [credential]: 'secret' }, 30000, 1);
  const active = reader.read(line(0));
  await started.promise;
  const queued = Array.from({ length: 256 }, (_, index) => reader.read(line(index + 1)));
  try {
    const overloaded = await timed(reader.read(line(257)));
    assert.equal(overloaded.status, 'unavailable');
    assert.match(overloaded.error, /capacity/);
    const duplicate = reader.read({ ...line(0), id: 'alias' });
    reader.close();
    await timed(Promise.all(queued));
    finish();
    const [original, alias] = await Promise.all([active, duplicate]);
    assert.equal(original.line.id, '0');
    assert.equal(alias.line.id, 'alias');
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally { reader.close(); finish(); await active; await Promise.all(queued); }
});

test('polling constructor rejects invalid limits before retaining requests', () => {
  for (const timeout of [NaN, 0, 49, 30001, Infinity]) assert.throws(() => new HttpLineReader({}, timeout), { code: 'invalid_input' });
  for (const concurrency of [NaN, 0, 17, 1.5]) assert.throws(() => new HttpLineReader({}, 3000, concurrency), { code: 'invalid_input' });
});

test('Factory shutdown closes an incomplete HTTP upload within its five-second grace period', { timeout: 9000 }, async () => {
  const token = 'factory-operations-test-token';
  const app = await startFactoryServer({ db: ':memory:', host: '127.0.0.1', port: 0, adminToken: token, credentials: {} });
  const socket = connect(app.server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const requestSeen = once(app.server, 'request');
    socket.write(`POST /v1/factories HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    await requestSeen;
    const first = app.close();
    assert.equal(app.close(), first, 'shutdown is idempotent');
    await timed(first, 7500);
    assert.equal(app.server.listening, false);
  } finally { socket.destroy(); await app.close(); }
});
