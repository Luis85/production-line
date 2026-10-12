import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createFactoryHandler } from '../../../src/factory/dist/factory/http.js';
import { createHttpHandler, tokenAuthorization } from '../../../src/orchestrator/dist/orchestrator/http.js';
import { DomainError as FactoryError } from '../../../src/factory/dist/shared/errors.js';
import { DomainError as OrchestratorError } from '../../../src/orchestrator/dist/shared/errors.js';
import { request } from '../../../src/orchestrator/dist/shared/http/client.js';

const adminToken = 'admin-token-for-transport-testing';
const variants = [
  { name: 'Factory', path: '/v1/factories', Error: FactoryError, handler(application, errors) {
    return createFactoryHandler(application, adminToken, '<h1>Factory</h1>', error => errors.push(error));
  } },
  { name: 'orchestrator', path: '/v1/tasks', Error: OrchestratorError, handler(application, errors) {
    return createHttpHandler({ application, schemaVersion: 3, authorize: tokenAuthorization(adminToken, 'enrollment-token'), views: { intake: '<h1>Intake</h1>', concept: '<h1>Concept</h1>' }, reportError: error => errors.push(error) });
  } },
];

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

// Deliberately incomplete uploads verify that rejection does not wait for request EOF.
function rawRequest(url, headers, chunks = [], finish = true) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        req.destroy();
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('No timely HTTP rejection')), 3000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.flushHeaders();
    for (const chunk of chunks) req.write(chunk);
    if (finish) req.end();
  });
}

for (const variant of variants) {
  test(`${variant.name}: Bearer parsing rejects ambiguous credentials and accepts case-insensitive schemes`, async () => {
    let writes = 0;
    const create = input => { writes++; return input; };
    const errors = [];
    await withServer(variant.handler({ createFactory: create, createTask: create }, errors), async base => {
      for (const authorization of [adminToken, 'Basic ' + adminToken, 'Bearer ' + adminToken + ',other']) {
        const response = await fetch(base + variant.path, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('www-authenticate'), 'Bearer');
        await response.text();
      }
      const duplicate = await rawRequest(base + variant.path, [
        'Host', new URL(base).host, 'Authorization', 'Bearer ' + adminToken, 'Authorization', 'Bearer ' + adminToken,
        'Content-Type', 'application/json', 'Content-Length', '2',
      ], ['{}']);
      assert.equal(duplicate.status, 401);
      assert.equal(writes, 0);
      const accepted = await fetch(base + variant.path, { method: 'POST', headers: { authorization: 'bEaReR ' + adminToken, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(accepted.status, 201);
      assert.equal(writes, 1);
      await accepted.text();
      assert.deepEqual(errors, []);
    });
  });

  test(`${variant.name}: oversized declared and chunked uploads receive a bounded early 413`, async () => {
    let writes = 0;
    const create = input => { writes++; return input; };
    const errors = [];
    const headers = { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' };
    await withServer(variant.handler({ createFactory: create, createTask: create }, errors), async base => {
      const declared = await rawRequest(base + variant.path, { ...headers, 'content-length': '1000000000' }, [], false);
      assert.equal(declared.status, 413);
      assert.equal(declared.headers.connection, 'close');
      assert.equal(JSON.parse(declared.body).error, 'Body limit: 64 KiB');
      const chunked = await rawRequest(base + variant.path, { ...headers, 'transfer-encoding': 'chunked' }, [Buffer.alloc(65536, 32), Buffer.from('x')], false);
      assert.equal(chunked.status, 413);
      assert.equal(chunked.headers.connection, 'close');
      assert.equal(JSON.parse(chunked.body).error, 'Body limit: 64 KiB');
      assert.equal(writes, 0);
      const exact = await fetch(base + variant.path, { method: 'POST', headers, body: '{"value":"' + 'x'.repeat(65524) + '"}' });
      assert.equal(exact.status, 201);
      await exact.text();
      assert.equal(writes, 1);
      assert.deepEqual(errors, []);
    });
  });

  test(`${variant.name}: malformed UTF-8 and unsupported encodings cannot mutate state`, async () => {
    let writes = 0;
    const create = input => { writes++; return input; };
    const headers = { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' };
    await withServer(variant.handler({ createFactory: create, createTask: create }, []), async base => {
      const malformed = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
      const utf8 = await fetch(base + variant.path, { method: 'POST', headers, body: malformed });
      assert.equal(utf8.status, 400);
      await utf8.text();
      const encoded = await fetch(base + variant.path, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: '{}' });
      assert.equal(encoded.status, 415);
      await encoded.text();
      assert.equal(writes, 0);
    });
  });

  test(`${variant.name}: disconnected uploads do not mutate state or report internal errors`, { timeout: 3000 }, async () => {
    let writes = 0;
    const create = input => { writes++; return input; };
    const errors = [];
    const handler = variant.handler({ createFactory: create, createTask: create }, errors);
    let started, handled;
    const requestStarted = new Promise(resolve => { started = resolve; });
    const requestHandled = new Promise(resolve => { handled = resolve; });
    await withServer((req, res) => {
      started();
      return handler(req, res).finally(handled);
    }, async base => {
      const req = httpRequest(base + variant.path, { method: 'POST', headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json', 'content-length': '1000' } });
      req.on('error', () => {});
      req.write('{');
      await requestStarted;
      req.destroy();
      await requestHandled;
      assert.equal(writes, 0);
      assert.deepEqual(errors, []);
    });
  });

  test(`${variant.name}: serialization and internal failures return safe 500 responses and are reported`, async () => {
    let output;
    const errors = [];
    const list = () => { if (output instanceof Error) throw output; return output; };
    await withServer(variant.handler({ factories: list, tasks: list }, errors), async base => {
      const circular = {}; circular.self = circular;
      for (const invalid of [circular, { value: 1n }, undefined, new variant.Error('internal', '/private/database.sqlite failed')]) {
        output = invalid;
        const response = await fetch(base + variant.path, { headers: { authorization: 'Bearer ' + adminToken } });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: 'Internal server error' });
      }
      assert.equal(errors.length, 4);
      output = new variant.Error('invalid_input', 'Invalid selection');
      const expected = await fetch(base + variant.path, { headers: { authorization: 'Bearer ' + adminToken } });
      assert.equal(expected.status, 400);
      assert.deepEqual(await expected.json(), { error: 'Invalid selection' });
      assert.equal(errors.length, 4);
      output = { ok: true };
      assert.deepEqual(await (await fetch(base + variant.path, { headers: { authorization: 'Bearer ' + adminToken } })).json(), variant.name === 'Factory' ? { ok: true, access: { principal: { id: 'legacy-admin', role: 'admin' }, permissions: { read: true, write: true } } } : { ok: true });
    });
  });
}

test('empty configured credentials fail closed', () => {
  assert.throws(() => tokenAuthorization('', '')('', 'admin'), error => error.status === 401);
  assert.throws(() => tokenAuthorization('', '')('', 'enrollment'), error => error.status === 401);
});

test('HTTP client rejects invalid UTF-8 without silently altering remote JSON', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  }, async base => {
    await assert.rejects(request(base, '/', 'token'), error => error.status === 502 && error.message.includes('invalid JSON'));
  });
});
