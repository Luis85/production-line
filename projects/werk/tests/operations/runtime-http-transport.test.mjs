import { testErrorCode, testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { controlRequest } from '../../scripts/runtime/control.mjs';
import { orchestratorReady } from '../../scripts/runtime/health.mjs';
import { privateJson } from '../../src/worker/dist/shared/http/bounded-client.js';

const run = promisify(execFile);
const source = new URL('../../', import.meta.url);
const runId = 'a'.repeat(64), controlToken = 'b'.repeat(64);
const record = port => ({ schemaVersion: 1, runId, controlToken, pid: process.pid, controlPort: port, children: [] });
const snapshot = { runId, state: 'running', mode: 'mock', project: 'demo', workers: 0 };
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

// This isolates a deliberately throwing socket API from the test runner. Native Node 24
// versions differ in default QoS behavior, so force an explicit priority through each
// owned dispatcher and require that the throwing platform method was actually invoked.
test('runtime requests own the packaged transport and survive observed socket QoS failures', { timeout: process.platform === 'win32' ? 120000 : 30000 }, async () => {
  const code = `
    import assert from 'node:assert/strict';
    import { Socket } from 'node:net';
    import { createServer } from 'node:http';
    import { createControl, controlRequest } from ${JSON.stringify(new URL('scripts/runtime/control.mjs', source).href)};
    import { orchestratorReady } from ${JSON.stringify(new URL('scripts/runtime/health.mjs', source).href)};
    import { privateJson } from ${JSON.stringify(new URL('src/worker/dist/shared/http/bounded-client.js', source).href)};
    import { request } from ${JSON.stringify(new URL('src/worker/dist/shared/http/client.js', source).href)};
    let qosCalls = 0, stops = 0;
    const failingQoS = function () { qosCalls++; throw Object.assign(Error('Fixture socket QoS rejection'), { code: 'EINVAL' }); };
    Socket.prototype.setTypeOfService = failingQoS;
    const originalFetch = globalThis.fetch, dispatchers = [];
    globalThis.fetch = (url, options) => {
      assert.ok(options?.dispatcher, 'Runtime HTTP must use its owned packaged dispatcher');
      const dispatcher = options.dispatcher, dispatch = dispatcher.dispatch.bind(dispatcher);
      dispatcher.dispatch = (options, handler) => dispatch({ ...options, typeOfService: 32 }, handler);
      dispatchers.push(dispatcher);
      return originalFetch(url, options);
    };
    const runId = 'a'.repeat(64), controlToken = 'b'.repeat(64);
    const control = await createControl({ runId, controlToken, snapshot: () => ({ runId, state: 'running', project: 'demo', mode: 'mock', workers: 0 }), stop: () => { stops++; } });
    const service = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schemaVersion: 1, project: 'demo', mode: 'mock', ok: true })); });
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + service.address().port;
    try {
      const identity = { schemaVersion: 1, runId, controlToken, pid: process.pid, controlPort: control.address().port, children: [] };
      for (let index = 0; index < 4; index++) {
        assert.equal((await controlRequest(identity)).state, 'running');
        assert.equal((await controlRequest(identity, 'stop')).state, 'stopping');
        assert.equal(await orchestratorReady({ orchestratorPort: service.address().port, project: 'demo' }, { WERK_ADMIN_TOKEN: controlToken }), true);
      }
      assert.equal((await privateJson(new URL(base), controlToken)).ok, true);
      assert.equal((await request(base, '/', controlToken)).ok, true);
      assert.equal(stops, 4);
      assert.equal(dispatchers.length, 14);
      assert.ok(qosCalls >= dispatchers.length, 'The explicit QoS fault must execute for every request');
      assert.equal(Socket.prototype.setTypeOfService, failingQoS, 'Production transport does not replace the socket API');
      for (const dispatcher of dispatchers) await assert.rejects(dispatcher.request({ origin: base, path: '/', method: 'GET' }), error => error.code === 'UND_ERR_DESTROYED');
      console.log(JSON.stringify({ requests: dispatchers.length, qosCalls }));
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([control, service].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    }
  `;
  const result = await run(process.execPath, ['--input-type=module', '-e', code], { timeout: process.platform === 'win32' ? 110000 : 25000, windowsHide: true, maxBuffer: 1048576 });
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.requests, 14);
  assert.ok(evidence.qosCalls >= 14);
});

test('control, health and private requests retain body bounds, identity checks and owned cleanup', { timeout: 15000 }, async t => {
  let mode = 'ok', redirected = false;
  const server = createServer((req, res) => {
    if (req.url === '/redirected') redirected = true;
    if (mode === 'redirect') { res.writeHead(302, { location: '/redirected' }); res.end(); return; }
    if (mode === 'hang') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"pending":'); return; }
    const data = mode === 'identity' ? { ...snapshot, runId: 'c'.repeat(64) } : snapshot;
    res.end(JSON.stringify({ schemaVersion: 1, ...data, ...(mode === 'large' ? { padding: 'x'.repeat(1048576) } : {}) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => close(server));
  const port = testListeningAddress(server).port, base = `http://127.0.0.1:${port}`;
  const dispatchers = [], fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => { dispatchers.push(options.dispatcher); return fetch(url, options); });
  const health = () => orchestratorReady({ orchestratorPort: port, project: 'demo' }, { WERK_ADMIN_TOKEN: controlToken });
  mode = 'identity'; await assert.rejects(controlRequest(record(port)), /identity could not be verified/);
  mode = 'large'; await assert.rejects(controlRequest(record(port)), /Invalid supervisor response/);
  await assert.rejects(health(), /Unexpected health response/);
  await assert.rejects(privateJson(new URL(base), controlToken), error => testErrorCode(error) === 'unavailable');
  mode = 'redirect'; await assert.rejects(controlRequest(record(port))); await assert.rejects(health());
  assert.equal(redirected, false);
  mode = 'hang'; await assert.rejects(controlRequest(record(port))); await assert.rejects(health());
  mode = 'ok'; assert.equal((await controlRequest(record(port))).state, 'running'); assert.equal(await health(), true);
  assert.equal(dispatchers.length, 10);
  for (const dispatcher of dispatchers) {
    assert.ok(dispatcher);
    await assert.rejects(dispatcher.request({ origin: base, path: '/', method: 'GET' }), error => testErrorCode(error) === 'UND_ERR_DESTROYED');
  }
});

test('local control and health requests never forward their credentials through environment proxies', async t => {
  let proxied = 0;
  const proxy = createServer((req, res) => { proxied++; res.writeHead(502); res.end(); });
  const service = createServer((req, res) => res.end(JSON.stringify({ schemaVersion: 1, ...snapshot })));
  await Promise.all([proxy, service].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))));
  t.after(() => Promise.all([proxy, service].map(close)));
  const previous = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const endpoint = `http://127.0.0.1:${testListeningAddress(proxy).port}`;
  Object.assign(process.env, { HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, http_proxy: endpoint, https_proxy: endpoint, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' });
  assert.equal((await controlRequest(record(testListeningAddress(service).port))).state, 'running');
  assert.equal(await orchestratorReady({ orchestratorPort: testListeningAddress(service).port, project: 'demo' }, { WERK_ADMIN_TOKEN: controlToken }), true);
  assert.equal(proxied, 0);
});
