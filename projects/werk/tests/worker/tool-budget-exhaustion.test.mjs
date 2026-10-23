import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { completedText } from './model-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolRuntime, toolBudgetNote } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { withCliToolBridge } from '../../src/worker/dist/worker/infrastructure/cli-tool-bridge.js';
import { providerCommand } from '../../src/worker/dist/worker/infrastructure/codex-adapter.js';
import { prepareModelRequest, executeModel, modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';

prepareNativeProcessFixture();

const signal = () => new AbortController().signal;
const exhaustedPattern = /^Tool budget exhausted \(4 calls \/ 120 s window\): the 4-call limit of this invocation is reached\. No further tool calls will run in this invocation\. Finish with the information you have, or ask the operator with a werkInteraction question\.$/;
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-budget-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'worktree'); await mkdir(worktree); await writeFile(join(worktree, 'README.md'), 'budget fixture');
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  policy.builtins.commands = [{ id: 'wait', name: 'Wait', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], enabled: true }];
  const create = (overrides = {}) => { const runtime = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree, maxCalls: 32, maxRuntimeMs: 120000, ...options, ...overrides }); t.after(() => runtime.close()); return runtime; };
  return { directory, worktree, policy, create };
}

test('budget notes appear only once a quarter or less of the calls or window remains, with deterministic text', () => {
  assert.equal(toolBudgetNote(31, 32, 120000, 120000), undefined);
  assert.equal(toolBudgetNote(9, 32, 31000, 120000), undefined, 'just above both thresholds');
  assert.equal(toolBudgetNote(8, 32, 120000, 120000), 'Tool budget: 8 of 32 calls and 120 s of the 120 s tool window remain.');
  assert.equal(toolBudgetNote(5, 32, 38900, 120000), 'Tool budget: 5 of 32 calls and 38 s of the 120 s tool window remain.');
  assert.equal(toolBudgetNote(20, 32, 30000, 120000), 'Tool budget: 20 of 32 calls and 30 s of the 120 s tool window remain.');
  assert.equal(toolBudgetNote(20, 32, 400, 120000), 'Tool budget: 20 of 32 calls and less than 1 s of the 120 s tool window remain.');
  assert.equal(toolBudgetNote(20, 32, -5, 120000), 'Tool budget: 20 of 32 calls and less than 1 s of the 120 s tool window remain.');
  assert.match(toolBudgetNote(0, 32, 90000, 120000), /^Tool budget: 0 of 32 calls remain in this invocation\. No further tool calls will run\. Finish with the information you have/);
});

test('call exhaustion returns a normal tool error, keeps structured output parseable and records counts', async t => {
  const { create } = await fixture(t);
  const runtime = create({ maxCalls: 4 });
  assert.deepEqual(runtime.budget(), { maxCalls: 4, windowMs: 120000, callsUsed: 0, refusedCalls: 0, exhausted: null });
  const results = [];
  for (let index = 0; index < 4; index++) results.push(await runtime.call('werk_files_list', {}, signal()));
  for (const result of results) {
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text).entries.map(item => item.name), ['README.md'], 'the tool output item is unchanged');
  }
  assert.deepEqual(results.slice(0, 2).map(result => result.content.length), [1, 1], 'no note while more than a quarter remains');
  assert.match(results[2].content[1].text, /^Tool budget: 1 of 4 calls and (\d+ s|less than 1 s) of the 120 s tool window remain\.$/);
  assert.match(results[3].content[1].text, /^Tool budget: 0 of 4 calls remain in this invocation\./);
  assert.equal(runtime.budget().exhausted, null, 'using the whole budget is not exhaustion');
  for (let index = 0; index < 2; index++) {
    const refused = await runtime.call('werk_files_read', { path: 'README.md' }, signal());
    assert.equal(refused.isError, true); assert.equal(refused.content.length, 1);
    assert.match(refused.content[0].text, exhaustedPattern);
  }
  assert.deepEqual(runtime.budget().exhausted, { reason: 'calls', maxCalls: 4, windowMs: 120000, callsUsed: 4, refusedCalls: 2 });
  await assert.rejects(runtime.call('werk_files_missing', {}, signal()), /not granted/, 'ungranted tools still fail closed');
});

test('window exhaustion stops an in-flight call with a clear message and refuses later calls', { timeout: 20000 }, async t => {
  const { create } = await fixture(t);
  const running = create({ maxRuntimeMs: 300 });
  const stopped = await running.call('werk_command_run', { preset: 'wait' }, signal());
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /^Tool budget exhausted \(32 calls \/ 300 ms window\): the 300 ms tool window ended while this call was running, so it was stopped and its result is unavailable\./);
  assert.deepEqual(running.budget().exhausted, { reason: 'window', maxCalls: 32, windowMs: 300, callsUsed: 1, refusedCalls: 1 });
  const after = await running.call('werk_files_list', {}, signal());
  assert.equal(after.isError, true); assert.match(after.content[0].text, /tool window of this invocation ended after 1 of 32 calls/);
  assert.deepEqual(running.budget().exhausted, { reason: 'window', maxCalls: 32, windowMs: 300, callsUsed: 1, refusedCalls: 2 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(running.call('werk_files_list', {}, controller.signal), /cancelled/, 'cancellation is not reported as a budget refusal');
});

/** @type {import('../../src/worker/application/conversation-contracts.js').ChatMessage[]} */
const messages = [{ id: 'u', role: 'user', text: 'Read the fixture repeatedly.', state: 'complete', at: '2026-10-16T00:00:00Z' }];
const toolCall = id => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'function_call', name: 'werk_files_list', call_id: 'call_' + id, arguments: '{}' }] });
const finalAnswer = { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Finished with partial results.' }] }] };
test('API tool loops deliver the refusal, let the model finish, report evidence and stop a model that ignores it', async t => {
  const { create } = await fixture(t);
  for (const ignore of [false, true]) {
    const bodies = [], observed = [];
    const model = modelFor({ id: 'openai-api', apiKey: 'fixture-only', model: 'fixture', executable: '' }, '/unused', async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const refused = bodies.length > 1 && /Tool budget exhausted/.test(JSON.stringify(bodies.at(-1).input.at(-1)));
      return Response.json(refused && !ignore ? finalAnswer : toolCall(bodies.length));
    }, { tools: () => create({ maxCalls: 2 }) });
    const execution = executeModel(model, prepareModelRequest(model, messages), signal(), undefined, { beforeCall() {}, observeToolBudget: value => observed.push(value) });
    if (ignore) await assert.rejects(execution, { code: 'protocol' });
    else assert.equal(completedText((await execution)), 'Finished with partial results.');
    assert.equal(bodies.length, 4, 'two executed calls, one refused call, then the answer or the stop');
    const refusal = JSON.parse(bodies[3].input.at(-1).output);
    assert.equal(refusal.isError, true); assert.match(refusal.content[0].text, /the 2-call limit of this invocation is reached/);
    assert.deepEqual(observed, [{ reason: 'calls', maxCalls: 2, windowMs: 120000, callsUsed: 2, refusedCalls: 1 }]);
  }
});

test('the CLI bridge returns budget refusals as MCP tool errors instead of dropping the call', { timeout: 30000 }, async t => {
  const { create, directory } = await fixture(t);
  const runtime = create({ maxCalls: 1 });
  let privateFile;
  const output = await withCliToolBridge(runtime, AbortSignal.timeout(20000), async bridge => {
    privateFile = bridge.args[1];
    const input = [1, 2, 3].map(id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'werk_files_list', arguments: {} } })).join('\n') + '\n';
    // A fixture cwd keeps the target outside the supervisor's private cache storage.
    return providerCommand(bridge.command, bridge.args, directory, AbortSignal.timeout(15000), input, true, 'claude');
  });
  const responses = output.toString('utf8').trim().split('\n').map(value => JSON.parse(value));
  assert.equal(responses.length, 3);
  assert.equal(responses[0].result.isError, undefined);
  assert.match(responses[0].result.content[1].text, /^Tool budget: 0 of 1 call remain/);
  for (const response of responses.slice(1)) {
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /^Tool budget exhausted \(1 call \/ 120 s window\)/);
  }
  assert.deepEqual(runtime.budget().exhausted, { reason: 'calls', maxCalls: 1, windowMs: 120000, callsUsed: 1, refusedCalls: 2 });
  await assert.rejects(access(privateFile));
});

test('interaction evidence records budget exhaustion once, with counts only, and shows it on the turn', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-budget-evidence-')));
  const settings = new WorkerSettings(directory); await settings.init();
  /** @type {import('../../src/worker/application/tool-runtime.js').ToolBudgetEvidence} */
  const evidence = { reason: 'window', maxCalls: 32, windowMs: 120000, callsUsed: 12, refusedCalls: 1 };
  /** @type {import('../../src/worker/application/model-contract.js').StructuredModel['execute']} */
  const execute = async (_request, _signal, _onUsage, control) => {
    for (const invalid of /** @type {const} */ ([
      { ...evidence, maxCalls: 0 }, { ...evidence, maxCalls: 513 }, { ...evidence, windowMs: 0 },
      { ...evidence, callsUsed: 33 }, { ...evidence, refusedCalls: 0 }, { ...evidence, reason: 'calls', callsUsed: 12 },
    ])) control.observeToolBudget(invalid);
    // @ts-expect-error Extra private fields must be stripped from external telemetry.
    control.observeToolBudget({ ...evidence, toolName: 'PRIVATE-TOOL', args: 'PRIVATE-ARGS' });
    control.observeToolBudget({ ...evidence, callsUsed: 13 });
    return { type: 'completed', text: 'Done with partial results.' };
  };
  const sessions = WorkerSessions(directory, settings, () => ({ configuration: { id: 'fixture', model: 'model-v1', instruction: '' }, capabilities: modelCapabilities, async reply() { throw Error('Typed model expected'); }, execute }));
  await sessions.init();
  t.after(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  await sessions.start('Use the tools');
  for (let count = 0; count < 300 && sessions.busy; count++) await delay(5);
  const events = sessions.interactions.events('default').events;
  assert.deepEqual(events.map(event => event.type), ['accepted', 'prepared', 'started', 'tool_budget_exhausted', 'completed']);
  assert.deepEqual(events[3].toolBudget, evidence);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-/);
  const turn = sessions.interactions.turn('default', sessions.interactions.view('default').latestTurn.id);
  assert.deepEqual(turn.toolBudget, evidence); assert.equal(turn.status, 'completed');
  sessions.interactions.observeToolBudget('default', turn.id, evidence);
  assert.equal(sessions.interactions.events('default').events.length, 5, 'a finished turn accepts no new budget evidence');
});


test('an accounting runtime cannot widen a smaller frozen API request allowance', async t => {
  const { create } = await fixture(t);
  for (const source of ['limits', 'accounting']) {
    let providerCalls = 0, toolCalls = 0;
    const model = modelFor({ id: 'openai-api', apiKey: 'fixture-only', model: 'fixture', executable: '' }, '/unused', async () => {
      providerCalls++; return Response.json(toolCall(providerCalls));
    }, { tools: () => {
      const runtime = create({ maxCalls: 2 });
      return { manifest: runtime.manifest, ...(source === 'limits' ? { limits: runtime.limits } : {}), budget: () => runtime.budget(),
        call(...args) { toolCalls++; return runtime.call(...args); }, close: () => runtime.close() };
    } });
    const limited = { ...model, executionPolicy: { maxToolCalls: 1 } };
    const request = prepareModelRequest(limited, messages);
    assert.equal(request.policy.maxToolCalls, 1);
    await assert.rejects(executeModel(model, request, signal()), { code: 'tool_access' });
    assert.equal(providerCalls, 0, 'the unsafe runtime is rejected before paid provider dispatch');
    assert.equal(toolCalls, 0, 'no request can widen the frozen allowance');
  }
});


test('actual tool results warn at the remaining-time threshold independently of call count', async t => {
  const { create } = await fixture(t);
  let time = Date.now();
  const clock = t.mock.method(Date, 'now', () => time);
  try {
    const runtime = create({ maxCalls: 32, maxRuntimeMs: 120000 });
    assert.equal((await runtime.call('werk_files_list', {}, signal())).content.length, 1);
    time += 89999;
    assert.equal((await runtime.call('werk_files_list', {}, signal())).content.length, 1, '30,001 ms is above the quarter-window threshold');
    time += 1;
    const threshold = await runtime.call('werk_files_list', {}, signal());
    assert.equal(threshold.isError, undefined);
    assert.equal(threshold.content[1].text, 'Tool budget: 29 of 32 calls and 30 s of the 120 s tool window remain.');
    time += 29601;
    const subsecond = await runtime.call('werk_files_list', {}, signal());
    assert.equal(subsecond.content[1].text, 'Tool budget: 28 of 32 calls and less than 1 s of the 120 s tool window remain.');
    assert.equal(runtime.budget().exhausted, null, 'clock projection does not expire the independent real cancellation timer');
  } finally { clock.mock.restore(); }
});
