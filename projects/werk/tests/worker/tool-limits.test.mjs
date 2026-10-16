import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanup } from './fixture-cleanup.mjs';
import { defaultToolPolicy, persistedToolPolicy, publicToolPolicy, updateToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { resolveToolLimits, resolveCommandTimeoutMs } from '../../src/worker/dist/worker/application/tool-limits.js';
import { cliToolName } from '../../src/worker/dist/worker/application/cli-tool-policy.js';
import { developmentCheckFingerprint, freezeDevelopmentScope, assertDevelopmentPolicy, validateDevelopmentState } from '../../src/worker/dist/worker/application/development.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { createToolRuntime, mcpToolName } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { toolAccessBody } from '../../scripts/runtime/portable/worker-commands.mjs';

const signal = () => new AbortController().signal;
const preset = (extra = {}) => ({ id: 'unit-tests', name: 'Unit tests', executable: process.execPath, args: ['--version'], enabled: true, ...extra });
const cliTool = (extra = {}) => ({ id: 'harness', name: 'Project harness', enabled: true, executable: process.execPath, args: ['harness.mjs'], commands: [{ command: 'check' }], ...extra });
const stdioMcp = (extra = {}) => ({ id: 'local', name: 'Local MCP', transport: 'stdio', enabled: true, command: process.execPath, args: ['server.mjs'], url: '', secretEnv: 'MCP_AUTH_TOKEN', secret: '', allowedTools: [], discoveredTools: [], ...extra });
const httpMcp = (extra = {}) => ({ id: 'remote', name: 'Remote MCP', transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '', secret: '', allowedTools: [], discoveredTools: [], ...extra });
const policyWith = ({ commands = [], cliTools = [], mcp = [] } = {}) => validateToolPolicy({ schemaVersion: 1, revision: 1, builtins: { files: false, commands, cliTools, webOrigins: [] }, mcp });
const update = policy => ({ expectedRevision: policy.revision, builtins: structuredClone(policy.builtins), mcp: publicToolPolicy(policy).mcp.map(({ discoveredTools, hasSecret, ...item }) => item) });
async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-limits-'))); cleanup(t, () => rm(path, { recursive: true, force: true })); return path; }
async function runtimeFor(t, policy, budget = {}) {
  const path = await directory(t), worktree = join(path, 'worktree'); await mkdir(worktree);
  const runtime = createToolRuntime({ policy, currentRevision: () => policy.revision, directory: path, worktree, ...budget });
  cleanup(t, () => runtime.close()); return { path, worktree, runtime };
}

test('legacy policy has no new configuration and inherits the established invocation and command budgets', () => {
  const legacy = { schemaVersion: 1, revision: 4, builtins: { files: false, commands: [preset()], webOrigins: [] }, mcp: [httpMcp()] };
  const policy = validateToolPolicy(legacy), limits = resolveToolLimits(policy);
  assert.deepEqual(persistedToolPolicy(policy), legacy);
  assert.equal(policy.limits, undefined); assert.equal(policy.builtins.commands[0].timeoutMs, undefined); assert.equal(policy.mcp[0].timeoutMs, undefined);
  assert.deepEqual({ maxCalls: limits.maxCalls, maxRuntimeMs: limits.maxRuntimeMs, commandTimeoutMs: limits.commandTimeoutMs }, { maxCalls: 128, maxRuntimeMs: 21600000, commandTimeoutMs: 300000 });
  assert.equal(limits.presetTimeoutMs['unit-tests'], 300000); assert.equal(limits.mcpTimeoutMs.remote, 30000);
  assert.throws(() => validateToolPolicy({ ...legacy, limits: { windowMs: 120000 } }), /documented tool policy/);
});

test('explicit deadline ranges are bounded by tool kind without reducing the one-hour command allowance', () => {
  const policy = policyWith({ commands: [preset({ timeoutMs: 3600000 })], cliTools: [cliTool({ timeoutMs: 3600000 })], mcp: [stdioMcp({ timeoutMs: 900000 }), httpMcp({ timeoutMs: 300000 })] });
  const limits = resolveToolLimits(policy, { maxCalls: 512, commandTimeoutMs: 600000 });
  assert.equal(limits.presetTimeoutMs['unit-tests'], 600000); assert.equal(limits.cliTimeoutMs.harness, 600000);
  assert.equal(limits.mcpTimeoutMs.local, 900000, 'MCP does not inherit the command-only cap');
  assert.equal(resolveCommandTimeoutMs(3600000, 1000), 1000);
  for (const timeoutMs of [0, 999, 3600001, 1500.5, '1000', null, NaN]) assert.throws(() => policyWith({ commands: [preset({ timeoutMs })] }), /timeout/);
  assert.throws(() => policyWith({ cliTools: [cliTool({ timeoutMs: 3600001 })] }), /timeout/);
  assert.throws(() => policyWith({ mcp: [stdioMcp({ timeoutMs: 900001 })] }), /timeout/);
  assert.throws(() => policyWith({ mcp: [httpMcp({ timeoutMs: 300001 })] }), /timeout/);
  assert.equal(policyWith({ commands: [preset({ timeoutMs: 1500 })] }).builtins.commands[0].timeoutMs, 1500);
});

test('omitted update fields preserve overrides and MCP authority; explicit null clears only the deadlines', () => {
  const tools = [{ name: 'suite', description: 'Run suite', inputSchema: { type: 'object' } }];
  const previous = policyWith({ commands: [preset({ timeoutMs: 300000, verification: true })], cliTools: [cliTool({ timeoutMs: 30000 })], mcp: [stdioMcp({ timeoutMs: 30000, secret: 'retained-secret', allowedTools: ['suite'], discoveredTools: tools })] });
  const older = update(previous);
  for (const item of [...older.builtins.commands, ...older.builtins.cliTools, ...older.mcp]) delete item.timeoutMs;
  const next = updateToolPolicy(previous, older);
  assert.deepEqual(next.builtins, previous.builtins); assert.deepEqual(next.mcp, previous.mcp);
  const reset = update(next); for (const item of [...reset.builtins.commands, ...reset.builtins.cliTools, ...reset.mcp]) item.timeoutMs = null;
  const cleared = updateToolPolicy(next, reset);
  for (const item of [...cleared.builtins.commands, ...cleared.builtins.cliTools, ...cleared.mcp]) assert.equal('timeoutMs' in item, false);
  assert.equal(cleared.builtins.commands[0].verification, true); assert.equal(cleared.mcp[0].secret, 'retained-secret'); assert.deepEqual(cleared.mcp[0].allowedTools, ['suite']);
  assert.throws(() => updateToolPolicy(next, older), error => error.code === 'conflict');
  const changed = update(previous); delete changed.mcp[0].timeoutMs; changed.mcp[0].args = ['different.mjs'];
  const moved = updateToolPolicy(previous, changed); assert.equal(moved.mcp[0].timeoutMs, 30000); assert.equal(moved.mcp[0].secret, ''); assert.deepEqual(moved.mcp[0].allowedTools, []);
});

test('explicit equal-default values survive persistence, restart and old-client saves until reset', async t => {
  const path = await directory(t); let settings = new WorkerSettings(path); await settings.init();
  const value = policyWith({ commands: [preset({ timeoutMs: 300000 })], cliTools: [cliTool({ timeoutMs: 300000 })], mcp: [httpMcp({ timeoutMs: 30000 })] });
  await settings.updateToolAccess({ ...update(value), expectedRevision: 0 });
  settings = new WorkerSettings(path); await settings.init();
  const older = update(settings.toolPolicy()); for (const item of [...older.builtins.commands, ...older.builtins.cliTools, ...older.mcp]) delete item.timeoutMs;
  await settings.updateToolAccess(older);
  let document = JSON.parse(await readFile(join(path, 'tool-access.json'), 'utf8'));
  assert.equal(document.builtins.commands[0].timeoutMs, 300000); assert.equal(document.builtins.cliTools[0].timeoutMs, 300000); assert.equal(document.mcp[0].timeoutMs, 30000);
  const reset = update(settings.toolPolicy()); for (const item of [...reset.builtins.commands, ...reset.builtins.cliTools, ...reset.mcp]) item.timeoutMs = null;
  await settings.updateToolAccess(reset); document = JSON.parse(await readFile(join(path, 'tool-access.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(document), /timeoutMs|windowMs/);
});

test('portable get/edit/set preserves explicit caps and null resets while dropping read-only catalog metadata', () => {
  const view = { ...publicToolPolicy(policyWith({ commands: [preset({ timeoutMs: 1000 })], cliTools: [cliTool({ timeoutMs: 2000 })], mcp: [httpMcp({ timeoutMs: 1500 })] })), canEdit: true, saveBlockedReason: null, workerNode: process.execPath };
  const command = toolAccessBody(view);
  assert.equal(command.builtins.commands[0].timeoutMs, 1000); assert.equal(command.builtins.cliTools[0].timeoutMs, 2000); assert.equal(command.mcp[0].timeoutMs, 1500);
  view.builtins.commands[0].timeoutMs = null; view.builtins.cliTools[0].timeoutMs = null; view.mcp[0].timeoutMs = null;
  const reset = toolAccessBody(view); assert.equal(reset.builtins.commands[0].timeoutMs, null); assert.equal(reset.builtins.cliTools[0].timeoutMs, null); assert.equal(reset.mcp[0].timeoutMs, null);
  assert.equal(reset.mcp[0].discoveredTools, undefined); assert.equal(reset.mcp[0].hasSecret, undefined);
});

test('runtime records immutable effective deadlines while unchanged tool descriptions remain compatible', async t => {
  const catalog = [{ name: 'suite', description: 'Run suite', inputSchema: { type: 'object' } }];
  const policy = policyWith({ commands: [preset({ timeoutMs: 600000, verification: true })], cliTools: [cliTool({ timeoutMs: 1000 })], mcp: [stdioMcp({ timeoutMs: 900000, allowedTools: ['suite'], discoveredTools: catalog })] });
  const { runtime } = await runtimeFor(t, policy, { maxCalls: 256, maxRuntimeMs: 7200000, commandTimeoutMs: 300000 });
  assert.deepEqual(runtime.manifest.limits, { maxCalls: 256, windowMs: 7200000, callTimeoutMs: { werk_command_run: 300000, [cliToolName('harness')]: 1000, [mcpToolName('local', 'suite')]: 900000 }, presetTimeoutMs: { 'unit-tests': 300000 } });
  assert.ok(Object.isFrozen(runtime.manifest.limits)); assert.ok(Object.isFrozen(runtime.manifest.limits.callTimeoutMs));
  policy.builtins.commands[0].timeoutMs = 1000; assert.equal(runtime.manifest.limits.presetTimeoutMs['unit-tests'], 300000);
  const plain = await runtimeFor(t, policyWith({ commands: [preset()], cliTools: [cliTool()] }));
  assert.equal(plain.runtime.manifest.tools[0].inputSchema.properties.preset.description, 'unit-tests: Unit tests');
  assert.doesNotMatch(plain.runtime.manifest.tools[1].description, /timeout|stops after/);
});

test('per-grant deadlines stop real commands, CLI tools and MCP startup while later calls remain available', { timeout: process.platform === 'win32' ? 240000 : 120000 }, async t => {
  const silentServer = "process.stdin.on('data',()=>{});setInterval(()=>{},1000)";
  const policy = policyWith({ commands: [preset({ args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 1000 }), preset({ id: 'quick' })], cliTools: [cliTool({ timeoutMs: 1000 })], mcp: [stdioMcp({ args: ['-e', silentServer], timeoutMs: 1000, discoveredTools: [{ name: 'suite', description: 'Suite', inputSchema: { type: 'object' } }], allowedTools: ['suite'] })] });
  const { worktree, runtime } = await runtimeFor(t, policy);
  await writeFile(join(worktree, 'harness.mjs'), 'setInterval(()=>{},1000);');
  for (const [name, args] of [['werk_command_run', { preset: 'unit-tests' }], [cliToolName('harness'), { args: ['check'] }], [mcpToolName('local', 'suite'), {}]]) {
    const result = await runtime.call(name, args, signal()); assert.equal(result.isError, true, name);
  }
  const quick = await runtime.call('werk_command_run', { preset: 'quick' }, signal()); assert.equal(quick.isError, undefined); assert.match(quick.content[0].text, /exitCode/);
});

test('the existing total invocation cap still cancels a longer per-grant command and blocks later calls', { timeout: process.platform === 'win32' ? 120000 : 30000 }, async t => {
  const policy = policyWith({ commands: [preset({ args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 600000 })] });
  const { runtime } = await runtimeFor(t, policy, { maxRuntimeMs: 100 });
  await assert.rejects(runtime.call('werk_command_run', { preset: 'unit-tests' }, signal()), /cancelled or its invocation ended/);
  await assert.rejects(runtime.call('werk_command_run', { preset: 'unit-tests' }, signal()), /cancelled or its invocation ended/);
});

test('required-check fingerprints preserve old authority and bind an explicit deadline into new scopes', () => {
  const command = preset({ verification: true }), policy = policyWith({ commands: [command] }); policy.builtins.files = true;
  const base = 'a'.repeat(40), old = freezeDevelopmentScope(base, ['source.ts'], policy);
  const legacy = gateDigest({ id: command.id, name: command.name, executable: command.executable, args: command.args });
  assert.equal(developmentCheckFingerprint(command), legacy); assert.equal(old.checks[0].fingerprint, legacy); assert.equal('timeoutMs' in old.checks[0], false);
  policy.builtins.commands[0].timeoutMs = 300000;
  const next = freezeDevelopmentScope(base, ['source.ts'], policy); assert.equal(next.checks[0].timeoutMs, 300000); assert.notEqual(next.checks[0].fingerprint, legacy);
  assert.throws(() => assertDevelopmentPolicy(old, policy), /verification commands changed/); assert.doesNotThrow(() => validateDevelopmentState(next));
  policy.builtins.commands[0].timeoutMs = 1000; assert.equal(next.checks[0].timeoutMs, 300000); assert.throws(() => assertDevelopmentPolicy(next, policy), /verification commands changed/);
  const corrupt = structuredClone(next); corrupt.checks[0].timeoutMs = null; assert.throws(() => validateDevelopmentState(corrupt), /invalid/);
});
