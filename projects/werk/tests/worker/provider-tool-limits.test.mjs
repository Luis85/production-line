import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelFor, claudeToolEnvironment } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerCommand } from '../../src/worker/dist/worker/infrastructure/provider-process.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { consumptionModel } from '../../src/worker/dist/worker/application/consumption-model.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { prepareModelRequest, requireModelRequest, executeModel } from '../../src/worker/dist/worker/application/model-contract.js';

const signal = () => new AbortController().signal;
const messages = [{ id: 'u', role: 'user', text: 'Run the granted check.', state: 'complete', at: '2026-10-16T00:00:00Z' }];
const connection = { id: 'openai-api', apiKey: 'fixture-only', executable: '', model: 'fixture' };
const answer = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Complete.' }] }] });
const tools = [{ name: 'werk_command_run', description: 'Run a granted preset.', inputSchema: { type: 'object' } }];
const limits = { maxCalls: 128, windowMs: 21600000, callTimeoutMs: { werk_command_run: 300000 }, presetTimeoutMs: { check: 300000 } };

test('manifest preparation and dispatch use frozen budgets through composition and consumption wrappers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-manifest-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'not-created-by-metadata'), policy = defaultToolPolicy();
  policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: ['-e', 'throw Error("Must not execute during metadata inspection")'], enabled: true, timeoutMs: 2500 }];
  const settings = { value: { execution: { maxToolCalls: 40, maxRuntimeMs: 900000, commandTimeoutMs: 1500 }, repositories: { items: [] } }, toolPolicy: () => policy };
  let requests = 0;
  const factory = workspaceModelFactory(state, settings, (saved, path, _transport, options) => modelFor(saved, path, async () => { requests++; return answer(); }, options));
  const model = factory(connection, { sessionId: 'chat' });
  const wrapped = consumptionModel(model, { status() { throw Error('Metadata inspection must not reserve consumption'); } });
  const request = prepareModelRequest(wrapped, messages, 'chat', 4321);
  assert.equal(request.policy.maxToolCalls, 40); assert.equal(request.policy.commandTimeoutMs, 1500);
  assert.deepEqual(request.toolManifest.limits, { maxCalls: 40, windowMs: 4321, callTimeoutMs: { werk_command_run: 1500 }, presetTimeoutMs: { check: 1500 } });
  assert.ok(Object.isFrozen(request.toolManifest.limits.presetTimeoutMs));
  await assert.rejects(access(state), { code: 'ENOENT' });
  settings.value.execution = { maxToolCalls: 1, maxRuntimeMs: 1000, commandTimeoutMs: 1000 };
  assert.equal((await executeModel(model, request, signal())).text, 'Complete.');
  assert.equal(requests, 1, 'changing live execution settings cannot widen or invalidate this accepted snapshot');
  await assert.rejects(access(state), { code: 'ENOENT' });
});

test('manifest validation bounds only named tools and preserves legacy metadata absence', () => {
  const runtime = { manifest: { revision: 1, tools, limits }, async call() {}, async close() {} };
  const model = modelFor(connection, '/unused', undefined, { tools: () => runtime });
  const request = prepareModelRequest(model, messages);
  const changed = change => { const copy = structuredClone(request); change(copy.toolManifest); return copy; };
  assert.doesNotThrow(() => requireModelRequest(changed(value => { delete value.limits; }), connection.id));
  for (const change of [
    value => { value.limits = null; },
    value => { value.limits.maxCalls = 513; },
    value => { value.limits.windowMs = 86400001; },
    value => { value.limits.callTimeoutMs = { unknown: 1000 }; },
    value => { value.limits.callTimeoutMs.werk_command_run = 3600001; },
    value => { value.limits.callTimeoutMs.werk_command_run = 0; },
    value => { value.limits.callTimeoutMs = []; },
    value => { value.limits.presetTimeoutMs = { '../private': 1000 }; },
    value => { value.limits.extra = true; },
  ]) assert.throws(() => requireModelRequest(changed(change), connection.id), { code: 'protocol' });
  const maximum = changed(value => { value.limits.maxCalls = 512; value.limits.windowMs = 86400000; value.limits.callTimeoutMs.werk_command_run = 3600000; });
  assert.doesNotThrow(() => requireModelRequest(maximum, connection.id));
});

test('legacy dispatches may omit limits but cannot change grant revisions or exact tool definitions', async () => {
  let current = { revision: 1, tools, limits }, requests = 0, closed = 0;
  const model = modelFor(connection, '/unused', async () => { requests++; return answer(); }, { tools: () => ({ manifest: structuredClone(current), async call() { throw Error('Not called'); }, async close() { closed++; } }) });
  const request = structuredClone(prepareModelRequest(model, messages)); delete request.toolManifest.limits;
  assert.equal((await executeModel(model, request, signal())).text, 'Complete.');
  for (const change of [
    value => { value.revision++; },
    value => { value.tools[0].description = 'Changed definition'; },
    value => { value.tools[0].inputSchema = { type: 'object', additionalProperties: true }; },
    value => { value.tools.push({ name: 'additional_tool', description: 'New authority', inputSchema: {} }); },
  ]) {
    current = structuredClone({ revision: 1, tools, limits }); change(current);
    await assert.rejects(executeModel(model, request, signal()), { code: 'tool_access' });
  }
  current = structuredClone({ revision: 1, tools, limits });
  const modern = prepareModelRequest(model, messages);
  current.limits.callTimeoutMs.werk_command_run = 1000;
  await assert.rejects(executeModel(model, modern, signal()), { code: 'tool_access' });
  assert.equal(requests, 1); assert.equal(closed, 6);
});

test('provider process accepts only the bounded Claude MCP wait override and keeps isolation settings', { timeout: 30000 }, async () => {
  const environment = { ...claudeToolEnvironment({ toolTimeoutMs: 450000 }), HOME: '/forbidden-override', WERK_UNAPPROVED_ENV: 'private', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '100' };
  const script = 'console.log(JSON.stringify({timeout:process.env.MCP_TOOL_TIMEOUT??null,home:process.env.HOME??null,extra:process.env.WERK_UNAPPROVED_ENV??null,background:process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS??null}))';
  const output = await providerCommand(process.execPath, ['-e', script], tmpdir(), AbortSignal.timeout(20000), undefined, true, 'claude', undefined, environment);
  assert.deepEqual(JSON.parse(output.toString()), { timeout: '450000', home: process.env.HOME ?? null, extra: null, background: '0' });
  assert.deepEqual(claudeToolEnvironment(undefined), {});
  for (const timeout of ['NaN', '999', '86400001', '1000ms']) await assert.rejects(providerCommand(process.execPath, ['-e', 'throw Error("Must not launch")'], tmpdir(), signal(), undefined, true, 'claude', undefined, { MCP_TOOL_TIMEOUT: timeout }), { code: 'tool_access' });
});
