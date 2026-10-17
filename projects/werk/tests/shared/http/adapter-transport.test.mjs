import { productionLine, intakeTask } from '../../helpers/factory-intake.mjs';
import { testErrorField, testErrorCode, testErrorMessage, testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { withOwnedResponse } from '../../../src/worker/dist/shared/http/transport.js';
import { HttpLineReader } from '../../../src/factory/dist/factory/infrastructure/poller.js';
import { HttpLineDelivery } from '../../../src/factory/dist/factory/infrastructure/delivery.js';
import { discoverMcpTools } from '../../../src/worker/dist/worker/infrastructure/tool-mcp.js';
import { builtinToolOperations } from '../../../src/worker/dist/worker/infrastructure/builtin-tools.js';
import { defaultToolPolicy } from '../../../src/worker/dist/worker/application/tool-policy.js';

const overview = { schemaVersion: 1, observedAt: '2026-10-17T00:00:00Z', mode: 'mock', project: 'demo', tasks: { total: 0, queued: 0, running: 0, simulated: 0, blocked: 0 }, workers: { total: 0, online: 0, offline: 0, slotsTotal: 0, slotsBusy: 0, slotsAvailable: 0 }, snapshots: { total: 0, before: 0, after: 0 }, cost: { amountUsd: null, reason: 'unavailable_mock' } };
const tool = { name: 'echo', description: 'Local protocol fixture.', inputSchema: { type: 'object' } };
async function fixture(t, handler) {
  const sockets = [];
  const server = createServer(handler);
  server.on('connection', socket => sockets.push(new Promise(resolve => socket.once('close', resolve))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${testListeningAddress(server).port}`, async drained() {
    let timer;
    try { await Promise.race([Promise.all(sockets), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Completed adapter retained its socket')), 5000); })]); }
    finally { clearTimeout(timer); }
  } };
}
function observeTransport(t) {
  const dispatchers = [], fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.ok(options.dispatcher, 'Adapter must own its packaged transport');
    dispatchers.push(options.dispatcher);
    return fetch(url, options);
  });
  return async () => {
    assert.ok(dispatchers.length);
    for (const dispatcher of dispatchers) await assert.rejects(dispatcher.request({ origin: 'http://127.0.0.1', path: '/', method: 'GET' }), error => testErrorCode(error) === 'UND_ERR_DESTROYED');
  };
}
function webTool(origin, fetch) {
  const policy = defaultToolPolicy(); policy.builtins.webOrigins = [origin];
  return builtinToolOperations({ policy, directory: '/unused', fetch }).find(item => item.definition.name === 'werk_web_fetch');
}
const decode = result => JSON.parse(result.content[0].text);

test('Factory observation and delivery dispose owned transports after valid, private-error and invalid acknowledgements', async t => {
  let mode = 'valid', deliveries = 0;
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer local-fixture-token'); request.resume();
    response.setHeader('content-type', 'application/json');
    if (mode === 'denied') { response.writeHead(403); response.end('PRIVATE_DIAGNOSTIC'); return; }
    if (mode === 'large') { response.write('x'.repeat(65537)); return; }
    if (request.method === 'POST') { deliveries++; assert.equal(request.headers['idempotency-key'], 'factory:request'); response.end(JSON.stringify({ id: 'task', project: mode === 'mismatch' ? 'other' : 'demo' })); }
    else response.end(JSON.stringify(overview));
  });
  const disposed = observeTransport(t), line = productionLine(f.url);
  const reader = new HttpLineReader({ LINE: 'local-fixture-token' }); t.after(() => reader.close());
  const delivery = new HttpLineDelivery({ LINE: 'local-fixture-token' }); t.after(() => delivery.close());
  const item = intakeTask();
  assert.equal((await reader.read(line)).status, 'available');
  assert.equal(await delivery.send(line, item), 'task');
  mode = 'denied'; assert.equal((await reader.read(line)).status, 'unauthorized');
  await assert.rejects(delivery.send(line, item), error => testErrorMessage(error) === 'Delivery not acknowledged');
  mode = 'large'; assert.equal((await reader.read(line)).status, 'invalid');
  await assert.rejects(delivery.send(line, item), /Oversized acknowledgement/);
  mode = 'mismatch'; await assert.rejects(delivery.send(line, item), /Wrong project acknowledgement/);
  assert.equal(deliveries, 2, 'delivery never retries a mutation implicitly');
  await disposed(); await f.drained();
});

test('MCP consumes streamed result before disposing its transport and closes the remote session', async t => {
  const methods = [];
  const f = await fixture(t, async (request, response) => {
    if (request.method === 'DELETE') { methods.push('DELETE'); assert.equal(request.headers['mcp-session-id'], 'fixture-session'); response.writeHead(204); response.end(); return; }
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const message = JSON.parse(bytes); methods.push(message.method);
    if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    if (message.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1' } } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [tool] } }) + '\n\n');
    // A Streamable HTTP response remains open; the client owns cancellation after its matching result.
  });
  const disposed = observeTransport(t);
  assert.deepEqual(await discoverMcpTools({ transport: 'http', url: f.url, headers: {} }), [tool]);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
  await disposed(); await f.drained();
});

test('web tools retain origin, redirect and body limits while draining each response', async t => {
  const requests = [];
  const f = await fixture(t, (request, response) => {
    requests.push(request.url); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    if (request.url === '/redirect') { response.writeHead(302, { location: '/text' }); response.end(); return; }
    if (request.url === '/denied') { response.writeHead(302, { location: 'http://localhost:1/private' }); response.end(); return; }
    if (request.url === '/large') { response.write('x'.repeat(65537)); return; }
    response.end('Local fixture text.');
  });
  const disposed = observeTransport(t), tool = webTool(f.url);
  assert.equal(decode(await tool.call({ url: f.url + '/redirect' }, AbortSignal.timeout(5000))).text, 'Local fixture text.');
  await assert.rejects(tool.call({ url: f.url + '/denied' }, AbortSignal.timeout(5000)), /origin is not granted/);
  await assert.rejects(tool.call({ url: f.url + '/large' }, AbortSignal.timeout(5000)), /64 KiB/);
  assert.deepEqual(requests, ['/redirect', '/text', '/denied', '/large']);
  await disposed(); await f.drained();
});

test('body cancellation stays with each operation and disposes Factory, MCP and web transports', async t => {
  for (const kind of ['delivery', 'poller', 'mcp', 'web']) await t.test(kind, async t => {
    let started;
    const headers = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, (request, response) => { request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); started(); });
    const disposed = observeTransport(t), controller = new AbortController(), line = productionLine(f.url);
    let pending, cancel;
    if (kind === 'delivery') {
      const delivery = new HttpLineDelivery({ LINE: 'fixture' });
      pending = assert.rejects(delivery.send(line, intakeTask())); cancel = () => delivery.close();
    } else if (kind === 'poller') {
      const reader = new HttpLineReader({ LINE: 'fixture' });
      pending = reader.read(line).then(value => { assert.equal(value.status, 'unavailable'); }); cancel = () => reader.close();
    } else if (kind === 'mcp') {
      pending = assert.rejects(discoverMcpTools({ transport: 'http', url: f.url, headers: {} }, { signal: controller.signal }), error => testErrorField(error, 'reason') === 'cancelled'); cancel = () => controller.abort();
    } else {
      pending = assert.rejects(webTool(f.url).call({ url: f.url }, controller.signal)); cancel = () => controller.abort();
    }
    await headers; cancel(); await pending; await disposed(); await f.drained();
  });
});

test('injected response transport remains supported and cleanup covers consumer rejection', async () => {
  const failure = Error('Consumer contract failed');
  /** @type {import('undici').Dispatcher | undefined} */
  let dispatcher;
  const injected = async (_url, options) => { dispatcher = options.dispatcher; return new Response('fixture'); };
  await assert.rejects(withOwnedResponse('https://fixture.invalid', {}, 1000, async response => {
    assert.equal(await response.text(), 'fixture'); throw failure;
  }, true, injected), error => error === failure);
  assert.ok(dispatcher);
  await assert.rejects(dispatcher.request({ origin: 'http://127.0.0.1', path: '/', method: 'GET' }), error => testErrorCode(error) === 'UND_ERR_DESTROYED');
});

test('web completion rejects a buffered injected response when cancellation arrives during body consumption', async () => {
  const controller = new AbortController();
  /** @type {import('undici').Dispatcher | undefined} */
  let dispatcher;
  /** @type {ReadableStream<Uint8Array> | undefined} */
  let body;
  const injected = async (_url, options) => {
    dispatcher = options.dispatcher;
    body = new ReadableStream({ pull(stream) {
      controller.abort(); stream.enqueue(new TextEncoder().encode('Late buffered result')); stream.close();
    } });
    return new Response(body);
  };
  await assert.rejects(webTool('https://fixture.invalid', injected).call({ url: 'https://fixture.invalid/result' }, controller.signal), /cancelled/);
  assert.ok(body);
  assert.equal(body.locked, false);
  assert.ok(dispatcher);
  await assert.rejects(dispatcher.request({ origin: 'http://127.0.0.1', path: '/', method: 'GET' }), error => testErrorCode(error) === 'UND_ERR_DESTROYED');
});
