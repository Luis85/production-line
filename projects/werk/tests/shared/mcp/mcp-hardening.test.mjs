import { testErrorMessage, testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { ToolCatalog } from '../../../src/orchestrator/dist/shared/mcp/catalog.js';
import { serveStdio } from '../../../src/orchestrator/dist/shared/mcp/stdio.js';

const token = 'mcp-pagination-admin-'.repeat(3), enrollment = 'mcp-enrollment-'.repeat(3);
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hardening-test', version: '1' } } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const ping = id => ({ jsonrpc: '2.0', id, method: 'ping' });
function client(url) {
  const child = spawn(process.execPath, ['src/orchestrator/dist/orchestrator/cli.js', 'mcp', 'serve', '--url', url, '--allow-writes', 'true'], { env: { ...process.env, WERK_ADMIN_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let next = 1, stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line), pending = waiting.get(message.id);
    if (pending) { clearTimeout(pending.timer); waiting.delete(message.id); pending.resolve(message); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++, timer = setTimeout(() => reject(Error('MCP response timed out')), 5000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
  });
  return { call, get stdout() { return stdout; }, get stderr() { return stderr; },
    async init() { await call('initialize', initialize.params); child.stdin.write(encode(initialized)); },
    async close() { child.stdin.end(); await once(child, 'close'); lines.close(); for (const pending of waiting.values()) clearTimeout(pending.timer); },
  };
}
const data = response => { assert.equal(response.result?.isError, false, JSON.stringify(response)); return JSON.parse(response.result.content[0].text); };

async function withApi(handler, run) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run('http://127.0.0.1:' + testListeningAddress(server).port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

// This integration starts the packaged MCP subprocess, traverses HTTP, and uses a real SQLite service.
test('MCP task, worker and event tools default to 100-item pages and expose complete continuation', { timeout: 20000 }, async () => {
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, adminToken: token, enrollmentToken: enrollment, project: 'demo' });
  const requests = [], workers = []; app.server.on('request', request => requests.push(request.url));
  let firstTask;
  for (let i = 0; i < 101; i++) {
    const task = app.store.submit({ project: 'demo', title: 'Feature ' + i, criteria: ['Accepted'] }, 'page-' + i);
    firstTask ??= task;
    workers.push(app.store.register('demo', [{ id: 'mock', provider: 'claude', mode: 'mock' }]));
  }
  for (let i = 0; i < 100; i++) app.store.event(firstTask.id, 'fixture_event', { index: i });
  const session = client('http://127.0.0.1:' + testListeningAddress(app.server).port);
  try {
    await session.init();
    const tools = (await session.call('tools/list')).result.tools;
    /** @type {[string, string, Record<string, unknown>][]} */
    const collections = [['werk_task_list', 'tasks', {}], ['werk_workers_list', 'workers', {}], ['werk_task_events', 'events', { id: firstTask.id }]];
    for (const [name, collection, args] of collections) {
      const definition = tools.find(tool => tool.name === name);
      assert.equal(definition.inputSchema.properties.limit.default, 100);
      assert.equal(definition.inputSchema.properties.cursor.maxLength, 1024);
      assert.match(definition.description, /hasMore.*nextCursor/);
      const first = data(await session.call('tools/call', { name, arguments: args }));
      assert.equal(first[collection].length, 100);
      assert.equal(first.hasMore, true); assert.equal(typeof first.nextCursor, 'string');
      const last = data(await session.call('tools/call', { name, arguments: { ...args, cursor: first.nextCursor } }));
      assert.equal(last[collection].length, 1);
      assert.equal(last.hasMore, false); assert.equal(last.nextCursor, null);
      assert.equal(new Set([...first[collection], ...last[collection]].map(item => item.id ?? item.seq)).size, 101);
    }
    assert.ok(requests.every(path => path.includes('limit=100')));
    const count = requests.length;
    for (const args of [{ limit: 0 }, { limit: 1.5 }, { limit: '2' }, { limit: 1001 }, { cursor: '' }, { cursor: 'bad/cursor' }, { cursor: 'x'.repeat(1025) }]) {
      assert.equal((await session.call('tools/call', { name: 'werk_task_list', arguments: args })).error.code, -32602);
    }
    assert.equal((await session.call('tools/call', { name: 'werk_task_create', arguments: { task: { project: 'demo', requirementRef: '[[Feature]]', context: { sha256: 'forged' } }, idempotencyKey: 'forged-context' } })).error.code, -32602);
    assert.equal(requests.length, count, 'invalid schemas must not invoke HTTP');
    assert.match(tools.find(tool => tool.name === 'werk_task_create').description, /operator-configured.*mock/);
    assert.ok(!session.stdout.includes(token));
    assert.ok(workers.every(worker => !session.stdout.includes(worker.token)));
    assert.equal(session.stderr, '');
  } finally { await session.close(); await app.close(); }
});

test('MCP rejects unpaged, oversized and contradictory collection results rather than imply a complete inventory', async () => {
  let response;
  await withApi((req, res) => {
    assert.equal(req.url, '/v1/tasks?limit=2');
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response));
  }, async base => {
    const catalog = new ToolCatalog('orchestrator', base, token);
    for (const invalid of [
      { tasks: [] }, { tasks: [], hasMore: 'false', nextCursor: null },
      { tasks: [], hasMore: true, nextCursor: 'YQ' }, { tasks: [{}], hasMore: false, nextCursor: 'YQ' },
      { tasks: [{}], hasMore: true, nextCursor: 'bad/cursor' }, { tasks: [{}, {}, {}], hasMore: false, nextCursor: null },
    ]) {
      response = invalid;
      await assert.rejects(catalog.call('werk_task_list', { limit: 2 }), /HTTP 502/);
    }
    response = { tasks: [{ id: 'one', token, description: token }], hasMore: false, nextCursor: null };
    const page = await catalog.call('werk_task_list', { limit: 2 });
    assert.deepEqual(page, { tasks: [{ id: 'one', token: '[REDACTED]', description: '[REDACTED]' }], hasMore: false, nextCursor: null });
  });
});

test('MCP refuses a repeated continuation cursor and surfaces API cursor-scope rejection without secrets', async () => {
  const cursor = 'YQ'; let fail = false;
  await withApi((req, res) => {
    assert.equal(req.url, '/v1/tasks?limit=100&cursor=YQ');
    res.writeHead(fail ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fail ? { error: token } : { tasks: [{ id: 'one' }], hasMore: true, nextCursor: cursor }));
  }, async base => {
    const catalog = new ToolCatalog('orchestrator', base, token);
    await assert.rejects(catalog.call('werk_task_list', { cursor }), /HTTP 502/);
    fail = true;
    await assert.rejects(catalog.call('werk_task_list', { cursor }), error => /HTTP 400/.test(testErrorMessage(error)) && !testErrorMessage(error).includes(token));
  });
});

/** @param {import('../../../src/shared/mcp/catalog.ts').ToolCatalog['call']} call @returns {Parameters<typeof serveStdio>[0]} */
const fixtureCatalog = call => ({ definitions: [{ name: 'fixture', description: 'Isolated transport fixture', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], has: name => name === 'fixture', call });
function collector() {
  const records = [];
  const output = new Writable({ write(chunk, _encoding, callback) { records.push(Buffer.from(chunk)); callback(); } });
  return { output, messages: () => Buffer.concat(records).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
const toolCall = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fixture', arguments: {} } });

test('stdio frames survive fragmented multibyte UTF-8, exact byte limits and coalesced messages', async () => {
  const first = encode({ ...ping('é'), params: { label: '漢字' } });
  const size = 65536, base = JSON.stringify({ ...ping(2), params: { padding: '' } });
  const exact = Buffer.from(JSON.stringify({ ...ping(2), params: { padding: 'x'.repeat(size - Buffer.byteLength(base)) } }) + '\n');
  const sink = collector();
  async function* chunks() { for (const byte of first) yield Buffer.from([byte]); for (let i = 0; i < exact.length; i += 37) yield exact.subarray(i, i + 37); yield Buffer.concat([encode(ping(3)), encode(ping(4))]); }
  await serveStdio(fixtureCatalog(async () => ({})), 'orchestrator', Readable.from(chunks()), sink.output);
  assert.deepEqual(sink.messages().map(message => message.id), ['é', 2, 3, 4]);
  assert.ok(sink.messages().every(message => message.result));
  assert.equal(sink.output.listenerCount('error'), 0);
});

test('stdio rejects excessive frames before later calls and recovers after malformed UTF-8', async () => {
  const oversized = collector();
  await serveStdio(fixtureCatalog(async () => { throw Error('Must not execute'); }), 'orchestrator', Readable.from([Buffer.concat([Buffer.alloc(65537, 120), Buffer.from('\n'), encode(ping(3))])]), oversized.output);
  assert.equal(oversized.messages().length, 1); assert.match(oversized.messages()[0].error.message, /64 KiB/);
  const malformed = collector();
  await serveStdio(fixtureCatalog(async () => ({})), 'orchestrator', Readable.from([Buffer.from([0xff, 10]), encode(ping(4))]), malformed.output);
  assert.equal(malformed.messages()[0].error.code, -32700); assert.deepEqual(malformed.messages()[1].result, {});
  const incomplete = collector();
  await serveStdio(fixtureCatalog(async () => ({})), 'orchestrator', Readable.from([encode(ping(1)).subarray(0, -1)]), incomplete.output);
  assert.equal(incomplete.messages()[0].error.code, -32700);
});

test('stdio respects output backpressure and never overlaps tool calls from a pipelined frame', async () => {
  let active = 0, peak = 0, calls = 0, emitted = 0;
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { setTimeout(() => { emitted++; callback(); }, 5); } });
  const catalog = fixtureCatalog(async () => {
    assert.equal(emitted, calls + 1, 'prior response must flush before the next call');
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { call: calls };
  });
  await serveStdio(catalog, 'orchestrator', Readable.from([Buffer.concat([encode(initialize), encode(initialized), encode(toolCall(2)), encode(toolCall(3))])]), output);
  assert.equal(calls, 2); assert.equal(peak, 1); assert.equal(emitted, 3);
});

test('stdio stops on a failed response write without another response attempt or replaying a tool', async () => {
  let writes = 0, attempts = 0, calls = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { if (++writes === 2) callback(Error('broken output')); else callback(); } });
  const observedErrors = []; output.on('error', error => observedErrors.push(error.message));
  const original = output.write.bind(output);
  output.write = (...args) => { attempts++; return original(...args); };
  const input = Readable.from([Buffer.concat([encode(initialize), encode(initialized), encode(toolCall(2)), encode(toolCall(3))])]);
  await assert.rejects(serveStdio(fixtureCatalog(async () => ({ calls: ++calls })), 'orchestrator', input, output), /broken output/);
  assert.equal(calls, 1); assert.equal(attempts, 2, 'must not reinterpret a failed output write as a new tool response');
  assert.equal(input.destroyed, true); assert.deepEqual(observedErrors, ['broken output']);
  assert.equal(output.listenerCount('error'), 1, 'transport must remove only its own listener');
});


test('MCP forwards minimal bound requirement intake unchanged over stdio and HTTP', async () => {
  const received = [];
  await withApi(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ body, path: req.url, method: req.method, authorization: req.headers.authorization, key: req.headers['idempotency-key'] });
    const allowed = ['project', 'requirementRef', 'provider', 'priority'];
    const valid = Object.keys(body).every(key => allowed.includes(key));
    res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(valid ? { task: body } : { error: 'Bound intake rejects expanded fields' }));
  }, async base => {
    const session = client(base);
    try {
      await session.init();
      const payloads = [{ project: 'demo', requirementRef: '[[Feature]]' }, { project: 'demo', requirementRef: '[[Feature]]', provider: 'codex', priority: 2 }];
      for (const [index, task] of payloads.entries()) {
        const result = data(await session.call('tools/call', { name: 'werk_task_create', arguments: { task, idempotencyKey: 'bound-' + index } }));
        assert.deepEqual(result.task, task);
        assert.deepEqual(received[index], { body: task, path: '/v1/tasks', method: 'POST', authorization: 'Bearer ' + token, key: 'bound-' + index });
      }
      for (const task of [{ project: 'demo', requirementRef: '[[Feature]]', provider: 'invalid' }, { project: 'demo', requirementRef: '[[Feature]]', priority: 3 }, { project: 'demo', requirementRef: '[[Feature]]', context: {} }]) {
        assert.equal((await session.call('tools/call', { name: 'werk_task_create', arguments: { task, idempotencyKey: 'invalid-bound' } })).error.code, -32602);
      }
      assert.equal(received.length, 2, 'invalid optional fields must never reach the API');
      const rejected = await session.call('tools/call', { name: 'werk_task_create', arguments: { task: { ...payloads[0], title: 'Explicit override' }, idempotencyKey: 'override' } });
      assert.equal(rejected.result.isError, true);
      assert.equal(received[2].body.title, 'Explicit override', 'client must not silently drop explicit fields');
      assert.ok(!session.stdout.includes(token)); assert.equal(session.stderr, '');
    } finally { await session.close(); }
  });
});
