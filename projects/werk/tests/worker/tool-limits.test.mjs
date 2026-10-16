import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanup } from './fixture-cleanup.mjs';
import { defaultToolPolicy, persistedToolPolicy, publicToolPolicy, updateToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { toolTimeLimits } from '../../src/worker/dist/worker/application/tool-limits.js';
import { cliToolName } from '../../src/worker/dist/worker/application/cli-tool-policy.js';
import { createToolRuntime, mcpToolName } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { bridgeToolTimeoutMs, withCliToolBridge } from '../../src/worker/dist/worker/infrastructure/cli-tool-bridge.js';
import { claudeToolEnvironment } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { prepareModelRequest, requireModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';

const node = process.execPath;
const signal = () => new AbortController().signal;
const preset = (extra = {}) => ({ id: 'unit-tests', name: 'Unit tests', executable: node, args: ['-e', 'process.stdout.write("ok")'], enabled: true, ...extra });
const cliTool = (extra = {}) => ({ id: 'harness', name: 'Project harness', enabled: true, executable: node, args: ['harness.mjs'], commands: [{ command: 'check' }], ...extra });
const stdioMcp = (extra = {}) => ({ id: 'local', name: 'Local MCP', transport: 'stdio', enabled: true, command: node, args: [], url: '', secretEnv: 'MCP_AUTH_TOKEN', secret: '', allowedTools: [], discoveredTools: [], ...extra });
const httpMcp = (extra = {}) => ({ id: 'remote', name: 'Remote MCP', transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '', secret: '', allowedTools: [], discoveredTools: [], ...extra });
const policyWith = ({ limits, commands = [], cliTools = [], mcp = [] } = {}) => validateToolPolicy({ schemaVersion: 1, revision: 1, ...(limits ? { limits } : {}), builtins: { files: false, commands, cliTools, webOrigins: [] }, mcp });
async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-limits-'))); cleanup(t, () => rm(path, { recursive: true, force: true })); return path; }
async function runtimeFor(t, policy) {
  const path = await directory(t), worktree = join(path, 'worktree'); await mkdir(worktree);
  const runtime = createToolRuntime({ policy, currentRevision: () => policy.revision, directory: path, worktree });
  cleanup(t, () => runtime.close());
  return { path, worktree, runtime };
}

test('defaults equal the fixed 0.9.0 limits and an unchanged policy keeps the 0.9.0 document shape', () => {
  assert.deepEqual(defaultToolPolicy().limits, { windowMs: 120000 });
  const legacy = { schemaVersion: 1, revision: 4, builtins: { files: false, commands: [preset()], webOrigins: [] }, mcp: [httpMcp()] };
  const policy = validateToolPolicy(legacy);
  assert.equal(policy.limits.windowMs, 120000);
  assert.equal(policy.builtins.commands[0].timeoutMs, 30000);
  assert.equal(policy.mcp[0].timeoutMs, 30000);
  // A rolled-back 0.9.0 worker rejects unknown fields, so defaults are never written.
  assert.deepEqual(persistedToolPolicy(policy), legacy);
  assert.equal(toolTimeLimits.callMaxMs, 900000); assert.equal(toolTimeLimits.httpMcpMaxMs, 300000); assert.equal(toolTimeLimits.windowMaxMs, 86400000);
});

test('raised limits are validated per grant, bounded and never longer than the shared window', () => {
  const raised = policyWith({ limits: { windowMs: 1800000 }, commands: [preset({ timeoutMs: 900000 })], cliTools: [cliTool({ timeoutMs: 600000 })], mcp: [stdioMcp({ timeoutMs: 900000 }), httpMcp({ timeoutMs: 300000 })] });
  assert.deepEqual([raised.limits.windowMs, raised.builtins.commands[0].timeoutMs, raised.builtins.cliTools[0].timeoutMs, raised.mcp[0].timeoutMs, raised.mcp[1].timeoutMs], [1800000, 900000, 600000, 900000, 300000]);
  const saved = persistedToolPolicy(raised);
  assert.deepEqual(saved.limits, { windowMs: 1800000 }); assert.equal(saved.builtins.commands[0].timeoutMs, 900000);
  assert.deepEqual(validateToolPolicy(JSON.parse(JSON.stringify(saved))), raised, 'saved limits round-trip');
  const window = { windowMs: 1800000 };
  for (const [input, pattern] of [
    [{ limits: window, commands: [preset({ timeoutMs: 900001 })] }, /Command preset "unit-tests" timeout must be whole milliseconds from 1000 to 900000/],
    [{ limits: window, commands: [preset({ timeoutMs: 999 })] }, /from 1000/],
    [{ limits: window, commands: [preset({ timeoutMs: 1500.5 })] }, /whole milliseconds/],
    [{ limits: window, cliTools: [cliTool({ timeoutMs: '600000' })] }, /CLI tool "harness" timeout/],
    [{ limits: window, mcp: [httpMcp({ timeoutMs: 300001 })] }, /MCP connection "remote" \(HTTP\) timeout must be whole milliseconds from 1000 to 300000/],
    [{ commands: [preset({ timeoutMs: 600000 })] }, /Command preset "unit-tests" timeout \(600 s\) exceeds the tool window \(120 s\)/],
    [{ limits: { windowMs: 60000 }, mcp: [stdioMcp({ timeoutMs: 90000 })] }, /MCP connection "local" timeout \(90 s\) exceeds the tool window \(60 s\)/],
    [{ limits: { windowMs: 9999 } }, /Tool window must be whole milliseconds from 10000 to 86400000/],
    [{ limits: { windowMs: 86400001 } }, /Tool window/],
    [{ limits: { windowMs: 120000, maxCalls: 64 } }, /documented tool limit fields: windowMs/],
  ]) assert.throws(() => policyWith(input), pattern);
});

test('API updates carry limits and timeouts without resetting MCP discovery or secrets', () => {
  const discovered = [{ name: 'run_suite', description: 'Run a suite', inputSchema: { type: 'object' } }];
  const previous = policyWith({ mcp: [stdioMcp({ secret: 'kept-secret', discoveredTools: discovered, allowedTools: ['run_suite'] })] });
  const mcp = publicToolPolicy(previous).mcp.map(({ discoveredTools, hasSecret, ...item }) => ({ ...item, timeoutMs: 600000 }));
  const next = updateToolPolicy(previous, { expectedRevision: previous.revision, limits: { windowMs: 900000 }, builtins: { ...previous.builtins, commands: [preset({ timeoutMs: 300000 })] }, mcp });
  assert.equal(next.limits.windowMs, 900000); assert.equal(next.builtins.commands[0].timeoutMs, 300000);
  assert.equal(next.mcp[0].timeoutMs, 600000); assert.deepEqual(next.mcp[0].allowedTools, ['run_suite']); assert.equal(next.mcp[0].secret, 'kept-secret');
  const restored = updateToolPolicy(next, { expectedRevision: next.revision, builtins: { ...next.builtins, commands: [preset()] }, mcp: mcp.map(({ timeoutMs, ...item }) => item) });
  assert.equal(restored.limits.windowMs, 120000, 'omitted limits return to the default'); assert.equal(restored.mcp[0].timeoutMs, 30000);
  assert.throws(() => updateToolPolicy(next, { expectedRevision: next.revision, limits: { windowMs: 60000 }, builtins: next.builtins, mcp }), /exceeds the tool window/);
});

test('the invocation manifest records the enforced limits and names raised deadlines to the model', async t => {
  const policy = policyWith({ limits: { windowMs: 900000 }, commands: [preset({ timeoutMs: 600000 }), preset({ id: 'lint', name: 'Lint' })], cliTools: [cliTool({ timeoutMs: 300000 })], mcp: [stdioMcp({ timeoutMs: 120000, discoveredTools: [{ name: 'suite', description: 'Suite', inputSchema: { type: 'object' } }], allowedTools: ['suite'] })] });
  policy.builtins.webOrigins = ['https://docs.example.test'];
  const { runtime } = await runtimeFor(t, policy);
  assert.deepEqual(runtime.manifest.limits, {
    maxCalls: 32, windowMs: 900000,
    callTimeoutMs: { werk_command_run: 600000, [cliToolName('harness')]: 300000, werk_web_fetch: 10000, [mcpToolName('local', 'suite')]: 120000 },
    presetTimeoutMs: { 'unit-tests': 600000, lint: 30000 },
  });
  assert.ok(Object.isFrozen(runtime.manifest.limits.callTimeoutMs));
  const tools = Object.fromEntries(runtime.manifest.tools.map(tool => [tool.name, tool]));
  assert.equal(tools.werk_command_run.inputSchema.properties.preset.description, 'unit-tests: Unit tests (stops after 600 s); lint: Lint');
  assert.match(tools[cliToolName('harness')].description, /Each call stops after 300 s\./);
  const defaults = await runtimeFor(t, policyWith({ commands: [preset()], cliTools: [cliTool()] }));
  assert.equal(defaults.runtime.manifest.tools[0].inputSchema.properties.preset.description, 'unit-tests: Unit tests', 'default deadlines keep the 0.9.0 model contract');
  assert.doesNotMatch(defaults.runtime.manifest.tools[1].description, /stops after/);
  assert.equal(defaults.runtime.manifest.limits.windowMs, 120000);
});

test('dispatch validation accepts manifest limits for its own tools and legacy manifests without them', async t => {
  const { runtime } = await runtimeFor(t, policyWith({ limits: { windowMs: 600000 }, commands: [preset({ timeoutMs: 300000 })] }));
  const model = modelFor({ id: 'openai-api', apiKey: 'fixture-only', model: 'fixture', executable: '' }, '/unused', async () => Response.json({}), { tools: () => runtime });
  const request = prepareModelRequest(model, [{ id: 'u', role: 'user', text: 'Run the unit tests.', state: 'complete', at: '2026-10-16T00:00:00Z' }]);
  assert.deepEqual(request.toolManifest.limits, { maxCalls: 32, windowMs: 600000, callTimeoutMs: { werk_command_run: 300000 }, presetTimeoutMs: { 'unit-tests': 300000 } });
  const variant = change => { const copy = structuredClone(request); change(copy.toolManifest); return copy; };
  assert.doesNotThrow(() => requireModelRequest(variant(manifest => { delete manifest.limits; }), 'openai-api'));
  for (const change of [
    manifest => { manifest.limits.callTimeoutMs = { werk_unknown: 1000 }; },
    manifest => { manifest.limits.windowMs = 86400001; },
    manifest => { manifest.limits.maxCalls = 33; },
    manifest => { manifest.limits.callTimeoutMs.werk_command_run = 900001; },
    manifest => { manifest.limits.extra = true; },
  ]) assert.throws(() => requireModelRequest(variant(change), 'openai-api'), { code: 'protocol' });
});

test('configured deadlines stop commands, CLI tools and MCP calls instead of the fixed 30 seconds', { timeout: 60000 }, async t => {
  const silentServer = "process.stdin.on('data',()=>{});setInterval(()=>{},1000)";
  const policy = policyWith({ limits: { windowMs: 60000 }, commands: [preset({ args: ['-e', 'setTimeout(()=>{},20000)'], timeoutMs: 1000 })], cliTools: [cliTool({ timeoutMs: 1000 })], mcp: [stdioMcp({ args: ['-e', silentServer], timeoutMs: 1500, discoveredTools: [{ name: 'suite', description: 'Suite', inputSchema: { type: 'object' } }], allowedTools: ['suite'] })] });
  const { worktree, runtime } = await runtimeFor(t, policy);
  await writeFile(join(worktree, 'harness.mjs'), 'setTimeout(() => {}, 20000);');
  for (const [name, args, pattern] of [['werk_command_run', { preset: 'unit-tests' }, /Command stopped \(timeout after 1 s\); no automatic retry was made\./], [cliToolName('harness'), { args: ['check'] }, /stopped after its 1 s timeout; no automatic retry was made/], [mcpToolName('local', 'suite'), {}, /Tool execution failed/]]) {
    const started = Date.now(), result = await runtime.call(name, args, signal());
    assert.equal(result.isError, true, name); assert.match(result.content[0].text, pattern);
    assert.ok(Date.now() - started < 15000, `${name} stopped at its configured deadline`);
  }
});

test('the policy window bounds every call even when a grant allows longer', { timeout: 60000 }, async t => {
  const policy = policyWith({ commands: [preset({ args: ['-e', 'setTimeout(()=>{},20000)'] })] });
  policy.limits.windowMs = 1500; // Injected below the editable minimum to keep the fixture fast.
  const { runtime } = await runtimeFor(t, policy);
  assert.equal(runtime.manifest.limits.windowMs, 1500);
  const started = Date.now();
  await assert.rejects(runtime.call('werk_command_run', { preset: 'unit-tests' }, signal()), /cancelled or its invocation ended/);
  assert.ok(Date.now() - started < 15000, 'the window stops the process tree before the 30-second grant deadline');
  await assert.rejects(runtime.call('werk_command_run', { preset: 'unit-tests' }, signal()), /cancelled or its invocation ended/, 'an exhausted window admits no further calls');
});

test('injected policies without deadlines receive defaults, never unbounded calls', async t => {
  const policy = defaultToolPolicy(); delete policy.limits;
  policy.builtins.commands.push({ id: 'legacy', name: 'Legacy', executable: node, args: [], enabled: true });
  const { runtime } = await runtimeFor(t, policy);
  assert.deepEqual(runtime.manifest.limits, { maxCalls: 32, windowMs: 120000, callTimeoutMs: { werk_command_run: 30000 }, presetTimeoutMs: { legacy: 30000 } });
});

test('provider MCP clients wait for the tool window, and the bridge forwards calls without a fetch deadline', { timeout: 30000 }, async () => {
  let calls = 0;
  const runtime = { manifest: { revision: 1, tools: [{ name: 'slow_suite', description: 'Slow suite', inputSchema: { type: 'object' } }], limits: { maxCalls: 32, windowMs: 900000, callTimeoutMs: { slow_suite: 900000 } } },
    async call() { calls++; await new Promise(resolve => setTimeout(resolve, 1500)); return { content: [{ type: 'text', text: 'suite passed' }] }; }, async close() {} };
  assert.equal(bridgeToolTimeoutMs(runtime), 930000);
  assert.equal(bridgeToolTimeoutMs({ manifest: { revision: 1, tools: [] } }), 150000, 'legacy manifests use the default window');
  const output = await withCliToolBridge(runtime, AbortSignal.timeout(20000), async bridge => {
    assert.equal(bridge.toolTimeoutMs, 930000);
    assert.match(bridge.codexConfig, /,tool_timeout_sec=930\}$/);
    assert.deepEqual(claudeToolEnvironment(bridge), { MCP_TOOL_TIMEOUT: '930000' });
    assert.equal(JSON.parse(await readFile(bridge.args[1], 'utf8')).timeoutMs, 930000);
    const { providerCommand } = await import('../../src/worker/dist/worker/infrastructure/provider-process.js');
    const input = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow_suite', arguments: {} } }].map(JSON.stringify).join('\n') + '\n';
    return providerCommand(bridge.command, bridge.args, tmpdir(), AbortSignal.timeout(15000), input, true, 'claude');
  });
  const responses = output.toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(responses[1].result.content[0].text, 'suite passed'); assert.equal(calls, 1);
  assert.deepEqual(claudeToolEnvironment(undefined), {});
});

test('worker settings persist raised limits and omit defaults for rollback compatibility', async t => {
  const path = await directory(t); let settings = new WorkerSettings(path); await settings.init();
  const update = (limits, timeoutMs) => ({ expectedRevision: settings.toolPolicy().revision, ...(limits ? { limits } : {}), builtins: { files: false, commands: [preset(timeoutMs ? { timeoutMs } : {})], cliTools: [], webOrigins: [] }, mcp: [] });
  await settings.updateToolAccess(update({ windowMs: 1200000 }, 600000));
  let document = JSON.parse(await readFile(join(path, 'tool-access.json'), 'utf8'));
  assert.deepEqual(document.limits, { windowMs: 1200000 }); assert.equal(document.builtins.commands[0].timeoutMs, 600000);
  settings = new WorkerSettings(path); await settings.init();
  assert.equal(settings.toolPolicy().limits.windowMs, 1200000); assert.equal(settings.toolAccess().builtins.commands[0].timeoutMs, 600000);
  await settings.updateToolAccess(update());
  document = JSON.parse(await readFile(join(path, 'tool-access.json'), 'utf8'));
  assert.equal('limits' in document, false); assert.equal('timeoutMs' in document.builtins.commands[0], false);
});
