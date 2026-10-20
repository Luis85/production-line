import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolRuntime, mcpToolName } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';

prepareNativeProcessFixture();

const signal = () => new AbortController().signal;
const decoded = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
const denied = async operation => { const result = await operation; assert.equal(result.isError, true); return result.content[0].text; };
async function fixture(t, mutate = (_policy) => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-tools-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'worktree'); await mkdir(worktree);
  const policy = defaultToolPolicy(); mutate(policy);
  const runtime = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree });
  t.after(() => runtime.close());
  return { directory, worktree, policy, runtime };
}

test('tools default to none; file grants need an injected task worktree and manifests are immutable', async t => {
  const { directory, policy, runtime } = await fixture(t);
  assert.deepEqual(runtime.manifest.tools, []);
  await assert.rejects(runtime.call('werk_files_read', { path: 'file' }, signal()), /not granted/);
  policy.builtins.files = true;
  assert.deepEqual(runtime.manifest.tools, [], 'saved-policy mutations cannot change an invocation snapshot');
  const chat = createToolRuntime({ policy, currentRevision: () => 0, directory });
  assert.deepEqual(chat.manifest.tools, []);
  const scoped = createToolRuntime({ policy, currentRevision: () => 0, directory, worktree: directory });
  assert.equal(scoped.manifest.tools.length, 3);
  assert.throws(() => scoped.manifest.tools.push({ name: 'fixture', description: 'Frozen manifest', inputSchema: {} }), TypeError);
  await Promise.all([chat.close(), scoped.close()]);
});

test('file tools read/list/search only regular worktree content and exclude traversal, links, Git metadata and binaries', async t => {
  const { directory, worktree, runtime } = await fixture(t, policy => { policy.builtins.files = true; });
  await mkdir(join(worktree, 'src'));
  await writeFile(join(worktree, 'src', 'main.txt'), 'first\nneedle here\nlast');
  await writeFile(join(worktree, '.git'), 'gitdir: private-admin-directory');
  await writeFile(join(worktree, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(directory, 'outside.txt'), 'host-secret');
  await symlink(directory, join(worktree, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const list = decoded(await runtime.call('werk_files_list', {}, signal()));
  assert.deepEqual(list.entries.map(item => item.name), ['binary.bin', 'src']);
  const read = decoded(await runtime.call('werk_files_read', { path: 'src/main.txt', offset: 6, limit: 6 }, signal()));
  assert.equal(read.text, 'needle'); assert.equal(read.nextOffset, 12);
  const search = decoded(await runtime.call('werk_files_search', { query: 'needle' }, signal()));
  assert.deepEqual(search.matches, [{ path: 'src/main.txt', line: 2, text: 'needle here' }]);
  for (const path of ['../outside.txt', join(directory, 'outside.txt'), '.git', '.GIT', '.git::$DATA', 'escape/outside.txt', 'src/../../outside.txt', '..\\outside.txt', 'binary.bin']) {
    const message = await denied(runtime.call('werk_files_read', { path }, signal()));
    assert.equal(message.includes('host-secret'), false);
    assert.equal(message.includes(directory), false, 'host diagnostics never leak through tool errors');
  }
  await denied(runtime.call('werk_files_read', { path: 'missing' }, signal()));
  await denied(runtime.call('werk_files_read', { path: 'src/main.txt', limit: 32769 }, signal()));
});

test('file reads preserve UTF-8 boundaries and bound large files without loading them fully', async t => {
  const { worktree, runtime } = await fixture(t, policy => { policy.builtins.files = true; });
  await writeFile(join(worktree, 'unicode.txt'), 'a😀b');
  const first = decoded(await runtime.call('werk_files_read', { path: 'unicode.txt', limit: 3 }, signal()));
  assert.equal(first.text, 'a'); assert.equal(first.nextOffset, 1);
  const second = decoded(await runtime.call('werk_files_read', { path: 'unicode.txt', offset: first.nextOffset, limit: 4 }, signal()));
  assert.equal(second.text, '😀'); assert.equal(second.nextOffset, 5);
  await denied(runtime.call('werk_files_read', { path: 'unicode.txt', offset: 2 }, signal()));
  await writeFile(join(worktree, 'large.txt'), 'x'.repeat(300000));
  const large = decoded(await runtime.call('werk_files_read', { path: 'large.txt' }, signal()));
  assert.equal(large.text.length, 32768); assert.equal(large.nextOffset, 32768);
  assert.equal(decoded(await runtime.call('werk_files_search', { query: 'x' }, signal())).truncated, true);
});

test('file scope fails closed after its approved worktree is replaced', async t => {
  const { directory, worktree, runtime } = await fixture(t, policy => { policy.builtins.files = true; });
  await writeFile(join(worktree, 'file.txt'), 'approved');
  await rename(worktree, join(directory, 'old-worktree'));
  await mkdir(worktree); await writeFile(join(worktree, 'file.txt'), 'replacement');
  assert.match(await denied(runtime.call('werk_files_read', { path: 'file.txt' }, signal())), /worktree changed/);
});

test('a new invocation cannot approve a retained worktree replaced by a link', async t => {
  const { directory, worktree, policy } = await fixture(t, policy => { policy.builtins.files = true; });
  await rename(worktree, join(directory, 'old-worktree'));
  const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'outside scope');
  await symlink(outside, worktree, process.platform === 'win32' ? 'junction' : 'dir');
  const fresh = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree });
  t.after(() => fresh.close());
  assert.match(await denied(fresh.call('werk_files_read', { path: 'private.txt' }, signal())), /worktree changed/);
});

test('persisted worktree identity prevents a new runtime from accepting a replacement directory', async t => {
  const { directory, worktree, policy } = await fixture(t, policy => { policy.builtins.files = true; });
  const original = await lstat(worktree);
  const worktreeIdentity = { dev: String(original.dev), ino: String(original.ino), birthtimeMs: original.birthtimeMs };
  await rename(worktree, join(directory, 'retained-original')); await mkdir(worktree); await writeFile(join(worktree, 'private.txt'), 'replacement content');
  const fresh = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree, worktreeIdentity });
  t.after(() => fresh.close());
  await assert.rejects(fresh.call('werk_files_read', { path: 'private.txt' }, signal()), /worktree changed/);
  policy.builtins.files = false;
  policy.builtins.commands = [{ id: 'cwd', name: 'Check working directory', executable: process.execPath, args: ['-e', 'console.log(process.cwd())'], enabled: true }];
  const commandOnly = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree, worktreeIdentity });
  t.after(() => commandOnly.close());
  assert.deepEqual(commandOnly.manifest.tools.map(tool => tool.name), ['werk_command_run']);
  await assert.rejects(commandOnly.call('werk_command_run', { preset: 'cwd' }, signal()), /worktree changed/);
});

test('commands use a fixed preset, task worktree cwd and a minimal explicit environment', async t => {
  const { worktree, runtime } = await fixture(t, policy => {
    policy.builtins.commands = [{ id: 'inspect', name: 'Inspect', executable: process.execPath, args: ['-e', `console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],secret:process.env.WERK_TEST_SECRET??null}));process.exitCode=4`, 'fixed'], enabled: true }];
  });
  const before = process.env.WERK_TEST_SECRET; process.env.WERK_TEST_SECRET = 'do-not-inherit';
  try {
    const result = decoded(await runtime.call('werk_command_run', { preset: 'inspect' }, signal()));
    assert.equal(result.exitCode, 4);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: worktree, arg: 'fixed', secret: null });
    await denied(runtime.call('werk_command_run', { preset: 'inspect', args: ['other'] }, signal()));
    await denied(runtime.call('werk_command_run', { preset: 'missing' }, signal()));
  } finally { if (before === undefined) delete process.env.WERK_TEST_SECRET; else process.env.WERK_TEST_SECRET = before; }
});

test('chat commands use private scratch and permission changes or call limits stop further execution', async t => {
  const { directory, policy } = await fixture(t, policy => {
    policy.builtins.commands = [{ id: 'cwd', name: 'Working directory', executable: process.execPath, args: ['-e', 'console.log(process.cwd())'], enabled: true }];
  });
  const runtime = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, maxCalls: 1, maxRuntimeMs: 120000 });
  t.after(() => runtime.close());
  assert.equal(decoded(await runtime.call('werk_command_run', { preset: 'cwd' }, signal())).stdout.trim(), join(directory, 'chat-workspace'));
  assert.match(await denied(runtime.call('werk_command_run', { preset: 'cwd' }, signal())), /^Tool budget exhausted \(1 call \/ 120 s window\): the 1-call limit of this invocation is reached\. No further tool calls will run/);
  const stale = createToolRuntime({ policy, currentRevision: () => policy.revision, directory });
  t.after(() => stale.close()); policy.revision++;
  await assert.rejects(stale.call('werk_command_run', { preset: 'cwd' }, signal()), /permissions changed/);
});

test('closing a runtime cancels and awaits its command before returning', { timeout: 20000 }, async t => {
  const { directory, policy } = await fixture(t);
  const marker = join(directory, 'started');
  policy.builtins.commands = [{ id: 'long', name: 'Long command', executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`], enabled: true }];
  const runtime = createToolRuntime({ policy, currentRevision: () => 0, directory });
  const pending = runtime.call('werk_command_run', { preset: 'long' }, signal());
  const rejected = assert.rejects(pending, /cancelled|ended/);
  for (let count = 0; count < 200; count++) { if (await readFile(marker, 'utf8').catch(() => '') === 'ready') break; await delay(25); }
  assert.equal(await readFile(marker, 'utf8'), 'ready');
  await runtime.close(); await rejected; await runtime.close();
  await assert.rejects(runtime.call('werk_command_run', { preset: 'long' }, signal()), /ended/);
});

test('a tool deadline aborts its command and later queued work cannot revive the invocation', { timeout: 20000 }, async t => {
  const { directory, policy } = await fixture(t, policy => {
    policy.builtins.commands = [{ id: 'wait', name: 'Wait', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], enabled: true }];
  });
  const runtime = createToolRuntime({ policy, currentRevision: () => 0, directory, maxCalls: 32, maxRuntimeMs: 30 });
  t.after(() => runtime.close());
  assert.match(await denied(runtime.call('werk_command_run', { preset: 'wait' }, signal())), /window ended while this call was running/);
  assert.match(await denied(runtime.call('werk_command_run', { preset: 'wait' }, signal())), /tool window of this invocation ended after 1 of 32 calls/);
  assert.deepEqual(runtime.budget().exhausted, { reason: 'window', maxCalls: 32, windowMs: 30, callsUsed: 1, refusedCalls: 2 });
});

test('web access enforces exact origins on every redirect, strips ambient credentials and bounds responses', async t => {
  const { directory, policy } = await fixture(t, policy => { policy.builtins.webOrigins = ['https://example.test']; });
  const requests = [];
  const runtime = createToolRuntime({ policy, currentRevision: () => 0, directory, fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { Location: 'https://other.test/private' } });
    if (url.pathname === '/loop') return new Response(null, { status: 302, headers: { Location: '/loop' } });
    if (url.pathname === '/large') return new Response('x'.repeat(65537));
    if (url.pathname === '/binary') return new Response(new Uint8Array([0, 1]));
    return new Response('public content');
  } });
  t.after(() => runtime.close());
  assert.equal(decoded(await runtime.call('werk_web_fetch', { url: 'https://example.test/page' }, signal())).text, 'public content');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.deepEqual(Object.keys(requests[0].init.headers), ['Accept']);
  for (const url of ['https://other.test/page', 'https://example.test:444/page', 'https://user:secret@example.test/page', 'file:///etc/passwd']) await denied(runtime.call('werk_web_fetch', { url }, signal()));
  assert.equal(requests.length, 1);
  await denied(runtime.call('werk_web_fetch', { url: 'https://example.test/redirect' }, signal()));
  assert.equal(requests.length, 2, 'the ungranted redirected origin was never fetched');
  assert.match(await denied(runtime.call('werk_web_fetch', { url: 'https://example.test/loop' }, signal())), /redirect limit/);
  assert.match(await denied(runtime.call('werk_web_fetch', { url: 'https://example.test/large' }, signal())), /64 KiB/);
  assert.match(await denied(runtime.call('werk_web_fetch', { url: 'https://example.test/binary' }, signal())), /Binary/);
});

test('MCP runtime exposes only explicit grants under stable distinct names, executes and redacts a stdio result', { timeout: 20000 }, async t => {
  const { directory, policy } = await fixture(t);
  const definition = { name: 'remote.read', description: 'Read from remote', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const program = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result;if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[${JSON.stringify(definition)}]};if(m.method==='tools/call')result={content:[{type:'text',text:'result '+process.env.MCP_AUTH_TOKEN}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
  policy.mcp = [{ id: 'local', name: 'Local fixture', transport: 'stdio', enabled: true, command: process.execPath, args: ['-e', program], url: '', secretEnv: 'MCP_AUTH_TOKEN', secret: 'private-connection-secret', allowedTools: [], discoveredTools: [definition] }];
  const disabled = createToolRuntime({ policy, currentRevision: () => 0, directory });
  assert.deepEqual(disabled.manifest.tools, []); await disabled.close();
  policy.mcp[0].allowedTools = ['remote.read'];
  const runtime = createToolRuntime({ policy, currentRevision: () => 0, directory }); t.after(() => runtime.close());
  const name = mcpToolName('local', 'remote.read');
  assert.notEqual(name, mcpToolName('local', 'remote_read'));
  assert.ok(name.length <= 64);
  assert.deepEqual(runtime.manifest.tools.map(tool => tool.name), [name]);
  assert.equal(JSON.stringify(runtime.manifest).includes('private-connection-secret'), false);
  await assert.rejects(runtime.call('remote.read', {}, signal()), /not granted/);
  const result = await runtime.call(name, {}, signal());
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.content[0].text, 'result [REDACTED]');
});
