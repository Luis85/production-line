import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultToolPolicy, updateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { bridgeToolTimeoutMs, withCliToolBridge } from '../../src/worker/dist/worker/infrastructure/cli-tool-bridge.js';
import { claudeToolEnvironment } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
// Establish native process readiness before testing the unchanged per-operation deadlines.
// Allow 45 s for native initialization and 5 s for cancellation cleanup.
before(async t => prepareProcessRuntime(process.cwd(), t.signal), { timeout: 50000 });

const signal = () => new AbortController().signal;
const manifest = { revision: 1, tools: [{ name: 'fixture', description: 'Fixture', inputSchema: { type: 'object' } }] };

async function bridgeClient(bridge, use) {
  const child = spawn(bridge.command, bridge.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close'), lines = createInterface({ input: child.stdout }), pending = new Map(); let id = 0;
  lines.on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); });
  child.stderr.resume();
  const rpc = (method, params = {}) => new Promise(resolve => { pending.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try { return await use(rpc); }
  finally { child.stdin.end(); await closed; lines.close(); }
}

test('the real MCP bridge permits more than 32 tool calls and stops exactly at the frozen allowance', { timeout: 20000 }, async () => {
  let calls = 0;
  /** @type {import('../../src/worker/application/tool-runtime.js').ToolRuntime} */
  const runtime = { manifest, limits: Object.freeze({ maxCalls: 40, maxRuntimeMs: 450000, commandTimeoutMs: 300000 }), async call() { calls++; return { content: [{ type: 'text', text: 'ok' }] }; }, async close() {} };
  await withCliToolBridge(runtime, signal(), async bridge => {
    const bridgeScript = await readFile(bridge.args[0], 'utf8');
    assert.match(bridgeScript, /from 'node:http'/); assert.doesNotMatch(bridgeScript, /\bfetch\(/, 'global fetch has a hidden five-minute header deadline');
    const privateConfig = JSON.parse(await readFile(bridge.args[1], 'utf8'));
    assert.equal(privateConfig.timeoutMs, 450000);
    assert.equal(bridge.toolTimeoutMs, 450000);
    assert.deepEqual(claudeToolEnvironment(bridge), { MCP_TOOL_TIMEOUT: '450000' });
    assert.equal(bridgeToolTimeoutMs({ ...runtime, limits: undefined }), 21600000, 'legacy runtimes use the existing invocation default');
    assert.match(bridge.codexConfig, /required=true,tool_timeout_sec=450/);
    const config = JSON.parse(await readFile(bridge.configFile, 'utf8'));
    assert.equal(config.mcpServers.werk.timeout, 450000);
    await bridgeClient(bridge, async rpc => {
      assert.equal((await rpc('initialize')).result.serverInfo.name, 'werk-granted-tools');
      for (let index = 0; index < 40; index++) assert.equal((await rpc('tools/call', { name: 'fixture', arguments: {} })).result.content[0].text, 'ok');
      assert.equal((await rpc('tools/call', { name: 'fixture', arguments: {} })).error.code, -32000);
    });
    assert.equal(calls, 40);
  });
});

test('bridge child uses its bounded timeout and cleanup cancels the pending broker operation', { timeout: 10000 }, async () => {
  let cancelled = false, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const runtime = { manifest, limits: { maxCalls: 1, maxRuntimeMs: 1000, commandTimeoutMs: 1000 }, async call(_name, _args, signal) {
    await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); entered(); });
    cancelled = signal.aborted; throw Error('fixture cancellation');
  }, async close() {} };
  await withCliToolBridge(runtime, signal(), async bridge => {
    await bridgeClient(bridge, async rpc => {
      const pending = rpc('tools/call', { name: 'fixture', arguments: {} });
      await started;
      assert.equal((await pending).error.code, -32000);
    });
  });
  assert.equal(cancelled, true, 'bridge settlement awaits the cancelled tool operation');
});

test('command timeout is independent of the total invocation deadline and does not revoke later calls', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-tool-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = defaultToolPolicy(); policy.builtins.commands = [
    { id: 'wait', name: 'Wait', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], enabled: true },
    { id: 'quick', name: 'Quick', executable: process.execPath, args: ['-e', 'console.log("complete")'], enabled: true },
  ];
  const options = { policy, currentRevision: () => 0, directory, maxCalls: 40, maxRuntimeMs: 10000, commandTimeoutMs: 1000 };
  const runtime = createToolRuntime(options); t.after(() => runtime.close());
  options.commandTimeoutMs = 1; options.maxCalls = 1;
  assert.deepEqual(runtime.limits, { maxCalls: 40, maxRuntimeMs: 10000, commandTimeoutMs: 1000 }); assert.ok(Object.isFrozen(runtime.limits));
  const timed = await runtime.call('werk_command_run', { preset: 'wait' }, signal());
  assert.equal(timed.isError, true); assert.match(timed.content[0].text, /timeout/);
  const complete = await runtime.call('werk_command_run', { preset: 'quick' }, signal());
  assert.equal(complete.isError, undefined); assert.match(complete.content[0].text, /complete/);
});

test('CLI commands honor the captured timeout and retain bounded partial output for repair', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-cli-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = defaultToolPolicy();
  const policy = updateToolPolicy(initial, { expectedRevision: 0, builtins: { ...initial.builtins, cliTools: [{
    id: 'check', name: 'Fixture check', enabled: true, executable: process.execPath,
    args: ['-e', 'console.log("partial-check-output");setInterval(()=>{},1000)'], commands: [{ command: 'check' }],
  }] }, mcp: [] });
  const runtime = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree: directory, maxRuntimeMs: 10000, commandTimeoutMs: 1000 });
  t.after(() => runtime.close());
  const result = await runtime.call('werk_cli_check', { args: ['check'] }, signal());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /partial-check-output/);
  assert.match(result.content[0].text, /stopped after 1 seconds; no automatic retry was made/);
});

test('bridge HTTP responses are bounded even for an oversized tool catalog', { timeout: 10000 }, async () => {
  const oversized = { ...manifest, tools: [{ ...manifest.tools[0], description: 'x'.repeat(1048576) }] };
  const runtime = { manifest: oversized, limits: { maxCalls: 1, maxRuntimeMs: 5000, commandTimeoutMs: 1000 }, async call() { throw Error('Not expected'); }, async close() {} };
  await withCliToolBridge(runtime, signal(), bridge => bridgeClient(bridge, async rpc => {
    assert.equal((await rpc('tools/list')).error.code, -32000);
  }));
});
