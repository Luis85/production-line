import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverMcpTools, callMcpTool, McpClientError, mcpTransportConfiguration } from '../../src/worker/dist/worker/infrastructure/tool-mcp.js';
import { launchProcess, terminateProcess } from '../../src/worker/dist/shared/process/launcher.js';

const tool = { name: 'echo', description: 'Read a fixture value.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
const initialize = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const config = { transport: 'http', url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer secret-value' } };
const rejectsWith = (operation, reason) => assert.rejects(operation, error => error instanceof McpClientError && error.reason === reason);
const json = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json', ...headers } });
function transport(handler) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    const message = init.method === 'POST' ? JSON.parse(init.body) : null;
    calls.push({ url, init, message });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (message.method === 'initialize') return json(message.id, initialize, { 'mcp-session-id': 'fixture-session' });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return handler(message, init);
  } };
}

// This is a labelled MCP protocol fixture, never an authenticated external service.
const stdioScript = `
const readline=require('node:readline');let ready=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 if(m.method==='initialize')return reply(${JSON.stringify(initialize)});
 if(m.method==='notifications/initialized'){ready=true;return;}
 if(!ready)throw Error('initialize missing');
 if(m.method==='tools/list')return reply({tools:[${JSON.stringify(tool)}]});
 if(m.method==='tools/call')return reply({content:[{type:'text',text:JSON.stringify({text:m.params.arguments.text,secret:process.env.FIXTURE_TOKEN||null,worker:process.env.WERK_ADMIN_TOKEN||null,home:process.env.HOME||null,cwd:process.cwd()})}],isError:false});
});`;
const stdio = { transport: 'stdio', executable: process.execPath, args: ['-e', stdioScript], env: { FIXTURE_TOKEN: 'private-mcp-token' } };

test('stdio initializes, discovers, calls only a grant and uses a contained minimal environment', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-mcp-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let launched = 0, terminated = 0;
  const dependencies = {
    environment: { ...process.env, WERK_ADMIN_TOKEN: 'ambient-worker-secret', HOME: '/ambient/account', NODE_OPTIONS: '--bad-option' },
    launch(executable, args, options) { launched++; assert.equal(options.mode, 'contained'); assert.equal(options.cwd, directory); assert.equal(options.env.WERK_ADMIN_TOKEN, undefined); assert.equal(options.env.NODE_OPTIONS, undefined); return launchProcess(executable, args, options); },
    terminate(child, signal) { terminated++; terminateProcess(child, signal); },
  };
  const options = { directory, dependencies, timeoutMs: 15000 };
  const definitions = await discoverMcpTools(stdio, options); assert.deepEqual(definitions, [tool]);
  const result = await callMcpTool(stdio, 'echo', { text: 'hello' }, definitions, options);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text), { text: 'hello', secret: '[REDACTED]', worker: null, home: null, cwd: directory });
  await rejectsWith(callMcpTool(stdio, 'ungranted', {}, definitions, options), 'denied');
  assert.equal(launched, 2); assert.ok(terminated >= 2);
});

test('stdio detects malformed frames, excessive stderr, and spawn failures without diagnostics', { timeout: 30000 }, async () => {
  await rejectsWith(discoverMcpTools({ ...stdio, args: ['-e', "process.stdout.write('not-json\\n');setInterval(()=>{},1000)"] }), 'protocol');
  await rejectsWith(discoverMcpTools({ ...stdio, args: ['-e', "process.stderr.write('x'.repeat(1100000));setInterval(()=>{},1000)"] }), 'output_limit');
  await assert.rejects(discoverMcpTools({ ...stdio, executable: join(tmpdir(), 'missing-mcp-executable') }), error => {
    assert.equal(error.reason, 'unavailable'); assert.ok(!error.message.includes('private-mcp-token')); return true;
  });
});

test('stdio deadline and cancellation terminate a descendant process before returning', { timeout: 40000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-mcp-cancel-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'child.pid');
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const running = discoverMcpTools({ ...stdio, args: ['-e', script] }, { signal: controller.signal, timeoutMs: 20000 });
  const failure = rejectsWith(running, 'cancelled');
  let pid;
  for (let n = 0; n < 200 && !pid; n++) { await delay(50); pid = Number(await readFile(pidFile, 'utf8').catch(() => '')) || undefined; }
  assert.ok(pid); controller.abort(); await failure;
  const alive = async () => {
    try { process.kill(pid, 0); if (process.platform === 'linux') return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[0] !== 'Z'; return true; }
    catch { return false; }
  };
  for (let n = 0; n < 100 && await alive(); n++) await delay(20);
  assert.equal(await alive(), false);
  await rejectsWith(discoverMcpTools({ ...stdio, args: ['-e', 'setInterval(()=>{},1000)'] }, { timeoutMs: 30 }), 'timeout');
});

test('HTTP discovers bounded pagination, carries negotiated session, and does not grant during discovery', async () => {
  const second = { ...tool, name: 'second' };
  const fixture = transport(message => json(message.id, message.params.cursor ? { tools: [second] } : { tools: [tool], nextCursor: 'page-2' }));
  assert.deepEqual(await discoverMcpTools(config, { dependencies: fixture }), [tool, second]);
  assert.deepEqual(fixture.calls.map(call => call.message?.method ?? call.init.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
  for (const call of fixture.calls) { assert.equal(call.init.redirect, 'error'); assert.equal(call.init.headers.Authorization, 'Bearer secret-value'); }
  assert.equal(fixture.calls[2].init.headers['Mcp-Session-Id'], 'fixture-session');
  assert.equal(fixture.calls[2].init.headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(fixture.calls[3].message.params.cursor, 'page-2');
  await rejectsWith(callMcpTool(config, 'echo', {}, [], { dependencies: fixture }), 'denied');
  assert.equal(fixture.calls.length, 5);
});

test('HTTP rechecks a granted schema before calling and preserves error/structured content as untrusted text', async () => {
  const fixture = transport(message => json(message.id, message.method === 'tools/list' ? { tools: [tool] } : { content: [{ type: 'text', text: 'secret-value failed' }, { type: 'resource_link', name: 'report', uri: 'https://example.invalid/report' }], structuredContent: { tokenEcho: 'secret-value' }, isError: true }));
  const result = await callMcpTool(config, 'echo', { text: 'hello' }, [tool], { dependencies: fixture });
  assert.equal(result.isError, true); assert.equal(result.content[0].text, '[REDACTED] failed');
  assert.deepEqual(JSON.parse(result.content[2].text), { tokenEcho: '[REDACTED]' });
  assert.deepEqual(fixture.calls.find(call => call.message?.method === 'tools/call').message.params, { name: 'echo', arguments: { text: 'hello' } });
  const changed = transport(message => json(message.id, { tools: [{ ...tool, inputSchema: { type: 'object' } }] }));
  await rejectsWith(callMcpTool(config, 'echo', {}, [tool], { dependencies: changed }), 'changed');
  assert.equal(changed.calls.some(call => call.message?.method === 'tools/call'), false);
});

test('Streamable HTTP accepts fragmented SSE with CRLF and returns without waiting for stream end', async () => {
  let cancelled = false;
  const fixture = transport(message => {
    const text = ': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [tool] } }) + '\r\n\r\n';
    return new Response(new ReadableStream({ start(controller) { for (const char of text) controller.enqueue(Buffer.from(char)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.deepEqual(await discoverMcpTools(config, { dependencies: fixture }), [tool]); assert.equal(cancelled, true);
});

test('HTTP rejects wrong IDs, unsupported versions, malformed results, duplicate names, and cursor cycles', async () => {
  const handlers = [
    message => json(message.id + 1, { tools: [tool] }),
    message => json(message.id, { tools: [tool, tool] }),
    message => json(message.id, { tools: [tool], nextCursor: 'same' }),
    message => json(message.id, { tools: [{ ...tool, inputSchema: false }] }),
    message => json(message.id, { tools: [{ ...tool, inputSchema: { type: 'object', description: 'x'.repeat(17000) } }] }),
  ];
  for (let i = 0; i < handlers.length; i++) await rejectsWith(discoverMcpTools(config, { dependencies: transport(handlers[i]) }), i === 4 ? 'output_limit' : 'protocol');
  await rejectsWith(discoverMcpTools(config, { dependencies: { fetch: async (_url, init) => json(JSON.parse(init.body).id, { ...initialize, protocolVersion: 'unknown' }) } }), 'protocol');
  const result = transport(message => json(message.id, message.method === 'tools/list' ? { tools: [tool] } : { content: [{ type: 'text', text: 123 }] }));
  await rejectsWith(callMcpTool(config, 'echo', {}, [tool], { dependencies: result }), 'protocol');
});

test('HTTP rejects notification response payloads instead of treating them as initialized', async () => {
  const dependencies = { fetch: async (_url, init) => {
    const message = JSON.parse(init.body);
    return message.method === 'initialize' ? json(message.id, initialize) : new Response('{"error":"unexpected response"}', { status: 202 });
  } };
  await rejectsWith(discoverMcpTools(config, { dependencies }), 'protocol');
});

test('HTTP bounds catalogs, result bytes and wire bytes', async () => {
  const catalog = transport(message => json(message.id, { tools: Array.from({ length: 65 }, (_, n) => ({ ...tool, name: 'tool-' + n })) }));
  await rejectsWith(discoverMcpTools(config, { dependencies: catalog }), 'output_limit');
  const result = transport(message => json(message.id, message.method === 'tools/list' ? { tools: [tool] } : { content: [{ type: 'text', text: 'x'.repeat(65536) }] }));
  await rejectsWith(callMcpTool(config, 'echo', {}, [tool], { dependencies: result }), 'output_limit');
  const wire = transport(() => new Response('x'.repeat(1048577), { headers: { 'content-type': 'application/json' } }));
  await rejectsWith(discoverMcpTools(config, { dependencies: wire }), 'output_limit');
});

test('HTTP cancellation/deadlines and errors never expose credentials or replay a mutation', async () => {
  for (const reason of ['cancelled', 'timeout']) {
    const controller = new AbortController(); let calls = 0;
    const dependencies = { fetch: async (_url, init) => { calls++; return new Promise((_resolve, reject) => { const hold = setTimeout(() => {}, 1000); init.signal.addEventListener('abort', () => { clearTimeout(hold); reject(Error('secret-value from endpoint')); }, { once: true }); }); } };
    const running = discoverMcpTools(config, { dependencies, signal: controller.signal, timeoutMs: 30 });
    if (reason === 'cancelled') controller.abort();
    await rejectsWith(running, reason); assert.equal(calls, 1);
  }
  const fixture = transport(message => message.method === 'tools/list' ? json(message.id, { tools: [tool] }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'secret-value' } }), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(callMcpTool(config, 'echo', {}, [tool], { dependencies: fixture }), error => { assert.equal(error.reason, 'unavailable'); assert.ok(!error.message.includes('secret-value')); return true; });
  assert.equal(fixture.calls.filter(call => call.message?.method === 'tools/call').length, 1);
});

test('operator configuration refuses remote plaintext, URL credentials and injected process loaders before I/O', async () => {
  let calls = 0; const dependencies = { fetch: async () => { calls++; throw Error(); }, launch() { calls++; throw Error(); } };
  for (const url of ['http://example.com/mcp', 'https://user:password@example.com/mcp', 'https://example.com/mcp?token=secret', 'file:///tmp/mcp', 'https://example.com/#secret']) await rejectsWith(discoverMcpTools({ ...config, url }, { dependencies }), 'configuration');
  for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'WERK_ADMIN_TOKEN', 'PATH']) await rejectsWith(discoverMcpTools({ ...stdio, env: { [name]: 'value' } }, { dependencies }), 'configuration');
  await rejectsWith(discoverMcpTools(config, { dependencies, signal: AbortSignal.abort() }), 'cancelled');
  assert.equal(calls, 0);
  assert.deepEqual(mcpTransportConfiguration({ transport: 'stdio', command: '/operator/server', args: ['serve'], secretEnv: 'GITHUB_TOKEN', secret: 'private' }), { transport: 'stdio', executable: '/operator/server', args: ['serve'], env: { GITHUB_TOKEN: 'private' } });
});

test('real loopback Streamable HTTP handshake and redirect refusal', { timeout: 10000 }, async t => {
  let initialized = false, redirects = 0, calls = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') { redirects++; response.writeHead(307, { location: '/mcp' }); response.end(); return; }
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text); calls++;
    assert.equal(request.headers.authorization, 'Bearer secret-value');
    if (message.method === 'notifications/initialized') { initialized = true; response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') assert.equal(initialized, true);
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'loopback-session' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? initialize : { tools: [tool] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await discoverMcpTools({ ...config, url: url + '/mcp' }), [tool]);
  await rejectsWith(discoverMcpTools({ ...config, url: url + '/redirect' }), 'unavailable');
  assert.equal(redirects, 1); assert.equal(calls, 3);
});
