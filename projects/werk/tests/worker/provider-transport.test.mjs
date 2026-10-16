import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerTransport } from '../../src/worker/dist/worker/infrastructure/provider-transport.js';

const messages = [{ id: 'input', role: 'user', state: 'complete', at: '2026-10-16T00:00:00Z', text: 'Local HTTP fixture.' }];
const encodings = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
const result = id => id === 'openai-api'
  ? { status: 'completed', usage: { input_tokens: 8, output_tokens: 3 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture complete.' }] }] }
  : { stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'Fixture complete.' }] };
async function fixture(t, handler) {
  const calls = [], closed = [];
  const server = createServer((req, res) => { calls.push(req.url); req.resume(); handler(req, res); });
  server.on('connection', socket => closed.push(new Promise(resolve => socket.once('close', resolve))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, calls, async drained() {
    let timer;
    try { await Promise.race([Promise.all(closed), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Provider sockets remained open')), 2000); })]); }
    finally { clearTimeout(timer); }
  } };
}
function invoke(url, { id = 'openai-api', signal = AbortSignal.timeout(5000), observe, response } = {}) {
  const model = modelFor({ id, model: 'fixture-model', apiKey: 'local-fixture-token', executable: '' }, '/unused', async (_url, init) => {
    const value = await providerTransport(url, init); response?.(value); return value;
  });
  return model.reply(messages, signal, observe);
}
function encoded(res, encoding, body, status = 200) {
  const bytes = encodings[encoding](body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': bytes.length });
  res.end(bytes);
}

test('actual provider HTTP decodes gzip, deflate and Brotli with one usage observation', async t => {
  for (const [encoding] of Object.entries(encodings)) for (const id of ['openai-api', 'anthropic-api']) await t.test(`${id} ${encoding}`, async t => {
    const f = await fixture(t, (_req, res) => encoded(res, encoding, JSON.stringify(result(id))));
    const usage = []; let headers;
    assert.equal(await invoke(f.url, { id, observe: value => usage.push(value), response: value => { headers = value.headers; } }), 'Fixture complete.');
    assert.equal(f.calls.length, 1, 'one inference request without replay');
    assert.equal(usage.length, 1); assert.equal(usage[0].inputTokens, 8); assert.equal(usage[0].outputTokens, 3);
    assert.equal(headers.get('content-encoding'), null); assert.equal(headers.get('content-length'), null);
    await f.drained();
  });
});

test('decoded body limits stop compressed expansion and remain protocol errors', async t => {
  for (const encoding of ['identity', ...Object.keys(encodings)]) await t.test(encoding, async t => {
    const body = Buffer.from('x'.repeat(2 * 1024 * 1024));
    const f = await fixture(t, (_req, res) => encoding === 'identity' ? res.end(body) : encoded(res, encoding, body));
    const usage = [];
    await assert.rejects(invoke(f.url, { observe: value => usage.push(value) }), error => error.code === 'protocol' && !error.message.includes('x'.repeat(20)));
    assert.equal(f.calls.length, 1); assert.equal(usage.length, 0, 'invalid responses never fabricate measured usage');
    await f.drained();
  });
});

test('malformed compression, JSON and UTF-8 are rejected as protocol failures', async t => {
  for (const encoding of Object.keys(encodings)) await t.test(encoding, async t => {
    const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-encoding': encoding }); res.end('PRIVATE_INVALID_COMPRESSED_CONTENT'); });
    await assert.rejects(invoke(f.url), error => error.code === 'protocol' && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 1); await f.drained();
  });
  for (const [name, body] of [['json', Buffer.from('{PRIVATE_INVALID_JSON')], ['utf8', Buffer.from([34, 0xc3, 0x28, 34])]]) await t.test(name, async t => {
    const f = await fixture(t, (_req, res) => encoded(res, 'gzip', body));
    await assert.rejects(invoke(f.url), error => error.code === 'protocol' && !error.message.includes('PRIVATE'));
    await f.drained();
  });
});

test('compressed authentication and rate-limit errors retain safe provider classifications', async t => {
  for (const [status, code] of [[401, 'authentication'], [429, 'rate_limit']]) await t.test(String(status), async t => {
    const f = await fixture(t, (_req, res) => encoded(res, 'gzip', JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_DETAIL' } }), status));
    await assert.rejects(invoke(f.url), error => error.code === code && error.status === status && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 1); await f.drained();
  });
});

test('provider transport rejects redirects without forwarding credentials or retrying inference', async t => {
  const target = await fixture(t, (_req, res) => res.end(JSON.stringify(result('openai-api'))));
  const origin = await fixture(t, (_req, res) => { res.writeHead(307, { location: target.url }); res.end(); });
  await assert.rejects(invoke(origin.url), error => error.code === 'unavailable');
  assert.equal(origin.calls.length, 1); assert.equal(target.calls.length, 0);
  await origin.drained();
});

test('cancelled and broken provider responses remain distinct and drain sockets', async t => {
  await t.test('cancelled body', async t => {
    let started;
    const headersSent = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.flushHeaders(); started(); });
    const controller = new AbortController();
    const assertion = assert.rejects(invoke(f.url, { signal: controller.signal }), error => error.code === 'cancelled');
    await headersSent; controller.abort(); await assertion;
    assert.equal(f.calls.length, 1); await f.drained();
  });
  await t.test('broken socket', async t => {
    const f = await fixture(t, (req) => req.socket.destroy());
    await assert.rejects(invoke(f.url), error => error.code === 'unavailable');
    assert.equal(f.calls.length, 1); await f.drained();
  });
});

test('provider-owned transport ignores a shorter global header cap and obeys its invocation signal', async t => {
  const previous = getGlobalDispatcher(), short = new Agent({ headersTimeout: 100 });
  setGlobalDispatcher(short); t.after(async () => { setGlobalDispatcher(previous); await short.destroy(); });
  const f = await fixture(t, (_req, res) => { setTimeout(() => { if (!res.destroyed) encoded(res, 'gzip', JSON.stringify(result('openai-api'))); }, 1500); });
  await assert.rejects(fetch(f.url, { signal: AbortSignal.timeout(5000) }), error => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(await invoke(f.url), 'Fixture complete.');
  assert.equal(getGlobalDispatcher(), short); assert.equal(f.calls.length, 2); await f.drained();
});
