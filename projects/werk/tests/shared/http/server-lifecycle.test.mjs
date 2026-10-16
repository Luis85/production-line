import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpRequestLifecycle, trackHttpRequests, drainHttpServer } from '../../../src/orchestrator/dist/shared/http/server-lifecycle.js';
import { observeHttp } from '../../../src/orchestrator/dist/shared/http/observability.js';

async function listen(handler, requests) {
  const server = createServer(observeHttp('orchestrator', requests.wrap(handler), () => {}));
  trackHttpRequests(server, requests);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
const url = server => `http://127.0.0.1:${server.address().port}`;

test('HTTP shutdown keeps dependent resources alive until a handler settles after forced socket closure', { timeout: 5000 }, async t => {
  const requests = new HttpRequestLifecycle(), reached = Promise.withResolvers(), release = Promise.withResolvers();
  let databaseOpen = true, drained = false, observed;
  const server = await listen(async (_request, response, signal) => {
    reached.resolve(signal);
    await release.promise;
    observed = databaseOpen;
    if (!response.destroyed) response.end('done');
  }, requests);
  t.after(async () => { release.resolve(); await drainHttpServer(server, 10); });
  const response = fetch(url(server)).then(value => value.text()).catch(() => null);
  const signal = await reached.promise;
  const closing = drainHttpServer(server, 10).then(() => { databaseOpen = false; drained = true; });
  await response;
  assert.equal(signal.aborted, true);
  assert.equal(drained, false);
  assert.equal(databaseOpen, true);
  release.resolve(); await closing;
  assert.equal(observed, true);
  assert.equal(databaseOpen, false);
});

test('stopped HTTP admission rejects new requests without dispatching the application', { timeout: 5000 }, async t => {
  const requests = new HttpRequestLifecycle(); let calls = 0;
  const server = await listen((_request, response) => { calls++; response.end('unexpected'); }, requests);
  t.after(() => drainHttpServer(server, 10));
  requests.stop();
  const response = await fetch(url(server));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Service is stopping.' });
  assert.equal(calls, 0);
});

test('client disconnect cancels owned I/O and releases its tracked handler', { timeout: 5000 }, async t => {
  const requests = new HttpRequestLifecycle(), reached = Promise.withResolvers(), aborted = Promise.withResolvers();
  const server = await listen(async (_request, _response, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    reached.resolve();
    await aborted.promise;
  }, requests);
  t.after(() => drainHttpServer(server, 10));
  const client = new AbortController();
  const response = fetch(url(server), { signal: client.signal }).catch(() => null);
  await reached.promise; client.abort();
  await response; await aborted.promise;
  await requests.drain();
});
