import { testErrorCode, testErrorMessage, testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { interactWithWorker } from '../../../src/orchestrator/dist/orchestrator/infrastructure/interaction.js';
import { DomainError } from '../../../src/orchestrator/dist/shared/errors.js';

async function fixture(t) {
  const requests = []; let selected = 'original', worker = 'registered', reject = false, mutate = (_path, value) => value;
  const credential = 'private-worker-fixture-token';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined });
    assert.equal(req.headers.authorization, 'Bearer ' + credential);
    res.setHeader('content-type', 'application/json');
    if (reject) { res.writeHead(401); res.end(JSON.stringify({ error: credential })); return; }
    const sessions = () => ({ selected, records: [{ id: selected, title: selected === 'created' ? 'New task' : 'Original task', provider: 'claude-cli' }] });
    let value;
    if (req.url === '/status') value = { workerId: worker };
    else if (req.url === '/api/chat/session') value = { sessions: sessions(), chat: { messages: [], available: true, busy: false, phase: 'idle' } };
    else if (req.url === '/api/sessions') { selected = 'created'; value = sessions(); }
    else value = { messages: [], available: true, busy: false };
    res.end(JSON.stringify(mutate(req.url, value)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { requests, mutate: callback => { mutate = callback; }, call: input => interactWithWorker({ workerUrl: 'http://127.0.0.1:' + testListeningAddress(server).port, workerToken: credential, ...input }, id => { if (id !== 'registered') throw new DomainError('not_found', 'Worker not registered in this line'); }), foreign: () => { worker = 'foreign'; }, reject: () => { reject = true; }, credential };
}

test('New task uses the selected provider and returns the worker atomic task/session view', async t => {
  const f = await fixture(t);
  const result = await f.call({ action: 'new', sessionId: 'original' });
  assert.equal(result.workerId, 'registered'); assert.equal(result.sessions.selected, 'created');
  assert.equal(result.sessions.records[0].title, 'New task'); assert.deepEqual(result.chat.messages, []);
  assert.deepEqual(f.requests.map(item => item.path), ['/status', '/api/chat/session', '/api/sessions', '/api/chat/session']);
  assert.deepEqual(f.requests[2].body, { action: 'create', title: 'New task', provider: 'claude-cli' });
  assert.ok(!JSON.stringify(result).includes(f.credential));
  await f.call({ action: 'send', sessionId: 'created', message: 'First task message' });
  await f.call({ action: 'send', sessionId: 'created', message: 'Follow up on the same task' });
  assert.deepEqual(f.requests.filter(item => item.path === '/api/chat').map(item => item.body.sessionId), ['created', 'created']);
});

test('New task holds worker and selected-session boundaries before creating anything', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: 'new', sessionId: 'stale' }), error => testErrorCode(error) === 'conflict');
  assert.equal(f.requests.some(item => item.method === 'POST'), false);
  f.requests.length = 0; f.foreign();
  await assert.rejects(f.call({ action: 'new', sessionId: 'original' }), error => testErrorCode(error) === 'not_found');
  assert.deepEqual(f.requests.map(item => item.path), ['/status']);
  f.requests.length = 0;
  await assert.rejects(f.call({ action: ['new'], sessionId: 'original' }), error => testErrorCode(error) === 'invalid_input');
  assert.equal(f.requests.length, 0);
});

test('upstream rejection hides private response bodies and creates no retry mutation', async t => {
  const f = await fixture(t); f.reject();
  await assert.rejects(f.call({ action: 'new', sessionId: 'original' }), error => testErrorCode(error) === 'unavailable' && !testErrorMessage(error).includes(f.credential));
  assert.equal(f.requests.length, 1);
});

for (const [label, path, replacement] of [
  ['status identity', '/status', { workerId: { diagnostic: 'PRIVATE_REMOTE_DETAIL' } }],
  ['missing session', '/api/chat/session', { sessions: null, chat: {} }],
  ['records collection', '/api/chat/session', { sessions: { selected: 'original', records: {} }, chat: {} }],
  ['unknown selected session', '/api/chat/session', { sessions: { selected: 'missing', records: [] }, chat: {} }],
  ['malformed chat', '/api/chat/session', { sessions: { selected: 'original', records: [{ id: 'original', title: 'Task', provider: 'claude-cli' }] }, chat: { available: true, busy: false, messages: [{ role: 'assistant', text: {} }] } }],
  ['creation acknowledgement', '/api/sessions', { selected: 'PRIVATE_REMOTE_DETAIL', records: [] }],
]) test('malformed remote ' + label + ' fails safely without a retry or later mutation', async t => {
  const f = await fixture(t);
  f.mutate((requestPath, value) => requestPath === path ? replacement : value);
  await assert.rejects(f.call({ action: 'new', sessionId: 'original' }), error => testErrorCode(error) === 'unavailable' && !testErrorMessage(error).includes('PRIVATE_REMOTE_DETAIL'));
  assert.equal(f.requests.filter(item => item.method === 'POST').length, path === '/api/sessions' ? 1 : 0);
  assert.equal(f.requests.at(-1).path, path);
});

test('invalid action input is rejected before contacting the worker', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: 'send', sessionId: 'original', message: [] }), error => testErrorCode(error) === 'invalid_input');
  assert.equal(f.requests.length, 0);
});

test('worker metadata extensions remain available in validated interaction responses', async t => {
  const f = await fixture(t);
  f.mutate((path, value) => path === '/api/chat/session' ? { ...value, sessions: { ...value.sessions, execution: { maxParallel: 1 } }, chat: { ...value.chat, request: { revision: 2 } } } : value);
  const result = await f.call({ action: 'read' });
  assert.deepEqual(result.sessions.execution, { maxParallel: 1 });
  assert.deepEqual(result.chat.request, { revision: 2 });
});

test('interaction abort cancels an upstream status read before checking worker identity', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), paths = [], controller = new AbortController(); let checked = false;
  const server = createServer((request, _response) => { paths.push(request.url); entered.resolve(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const pending = interactWithWorker({ workerUrl: 'http://127.0.0.1:' + testListeningAddress(server).port, workerToken: 'private-abort-fixture', action: 'read' }, () => { checked = true; }, controller.signal);
  const rejected = assert.rejects(pending, error => testErrorCode(error) === 'unavailable' && !testErrorMessage(error).includes('private-abort-fixture'));
  await entered.promise; controller.abort(); await rejected;
  assert.equal(checked, false); assert.deepEqual(paths, ['/status']);
});

test('orchestrator shutdown cancels pending worker status before releasing SQLite', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), upstreamClosed = Promise.withResolvers();
  /** @type {import('node:http').ServerResponse | undefined} */
  let response;
  let reads = 0;
  const remote = createServer((_request, res) => { response = res; res.once('close', upstreamClosed.resolve); entered.resolve(); });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => { remote.closeAllConnections(); return new Promise(resolve => remote.close(resolve)); });
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, project: 'shutdown', adminToken: 'a'.repeat(32), enrollmentToken: 'e'.repeat(32), shutdownTimeoutMs: 10 });
  t.after(() => app.close());
  const detail = app.store.workerDetail.bind(app.store);
  app.store.workerDetail = (...args) => { reads++; assert.equal(app.store.db.isOpen, true); return detail(...args); };
  const request = fetch('http://127.0.0.1:' + testListeningAddress(app.server).port + '/v1/interaction', { method: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(32), 'content-type': 'application/json' }, body: JSON.stringify({ workerUrl: 'http://127.0.0.1:' + testListeningAddress(remote).port, workerToken: 'private-shutdown-fixture', action: 'read' }) }).then(async response => { await response.text(); }, () => {});
  await entered.promise;
  await app.close();
  assert.equal(app.store.db.isOpen, false);
  await upstreamClosed.promise;
  assert.ok(response, 'Upstream response started before shutdown');
  response.end(JSON.stringify({ workerId: 'late-worker' }));
  await request;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
});
