import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerConsumption } from '../../src/worker/dist/worker/application/consumption.js';
import { WorkerConsumptionJournal } from '../../src/worker/dist/worker/infrastructure/journal/consumption.js';
import { consumptionModel, withConsumption } from '../../src/worker/dist/worker/application/consumption-model.js';
import { prepareModelRequest, executeModel } from '../../src/worker/dist/worker/application/model-contract.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerUsage } from '../../src/worker/dist/worker/infrastructure/provider-usage.js';
import { SerialExecutor } from '../../src/worker/dist/worker/application/serial-executor.js';
const messages = [{ id: 'u', role: 'user', text: 'Fixture input.', state: 'complete', at: '2026-10-16T00:00:00Z' }];
const connection = id => ({ id, model: 'fixture', apiKey: 'fixture-only', executable: '' });
const signal = () => AbortSignal.timeout(5000);
const rawUsage = { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const answer = id => id === 'openai-api'
  ? { status: 'completed', usage: rawUsage, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Completed answer.' }] }] }
  : { stop_reason: 'end_turn', usage: rawUsage, content: [{ type: 'text', text: 'Completed answer.' }] };
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-consumption-runtime-'));
  const policy = { enabled: true, period: 'daily', allowance: 100, workerPercent: 50, perRunReservation: 40, ...overrides };
  let now = new Date('2026-10-16T12:00:00Z');
  const journal = new WorkerConsumptionJournal(directory), runtime = new WorkerConsumption(journal, () => policy, () => now);
  await runtime.init(); t.after(async () => { runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, journal, policy, advance: () => { now = new Date('2026-10-17T12:00:00Z'); } };
}
for (const id of ['openai-api', 'anthropic-api']) {
  test(id + ' accepts a paid final answer at the limit and fences subsequent invocations', async t => {
    const f = await fixture(t); let calls = 0;
    const model = consumptionModel(modelFor(connection(id), '/unused', async () => { calls++; return Response.json(answer(id)); }), f.runtime);
    assert.equal(await model.reply(messages, signal()), 'Completed answer.');
    assert.equal(f.runtime.status().measuredTokens, 50); assert.equal(f.runtime.status().uncertainInvocations, 0);
    assert.equal(f.runtime.status().reason, 'exhausted');
    await assert.rejects(model.reply(messages, signal()), /allowance/); assert.equal(calls, 1);
    f.advance(); assert.equal(await model.reply(messages, signal()), 'Completed answer.'); assert.equal(calls, 2);
  });
  for (const unknown of [false, true]) test(id + ' stops a tool loop before a new paid request when ' + (unknown ? 'usage is missing' : 'the allowance is consumed'), async t => {
    const f = await fixture(t); let calls = 0, tools = 0, closed = 0;
    const manifest = { revision: 0, tools: [{ name: 'fixture_read', description: 'Read fixture', inputSchema: { type: 'object' } }] };
    const result = id === 'openai-api'
      ? { status: 'completed', output: [{ type: 'function_call', name: 'fixture_read', call_id: 'one', arguments: '{}' }] }
      : { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'fixture_read', id: 'one', input: {} }] };
    if (!unknown) result.usage = rawUsage;
    const model = consumptionModel(modelFor(connection(id), '/unused', async () => { calls++; return Response.json(result); }, { tools: () => ({ manifest, async call() { tools++; return { content: [{ type: 'text', text: 'Fixture result.' }] }; }, async close() { closed++; } }) }), f.runtime);
    await assert.rejects(executeModel(model, prepareModelRequest(model, messages), signal()), { code: 'consumption_limit' });
    assert.equal(calls, 1); assert.equal(tools, 1); assert.equal(closed, 1);
    assert.equal(f.runtime.status().uncertainInvocations, unknown ? 1 : 0);
    assert.equal(f.runtime.status().reason, unknown ? 'unmeasured_usage' : 'exhausted');
  });
}

test('failed and cancelled model invocations retain observed spend and conservative reservations', async t => {
  for (const cancelled of [false, true]) {
    const f = await fixture(t); const controller = new AbortController();
    const model = consumptionModel({ async reply(_messages, bounded, observe) {
      observe(providerUsage('openai', { usage: { input_tokens: 8, output_tokens: 2 } }));
      if (cancelled) controller.abort();
      assert.equal(bounded.aborted, cancelled);
      throw Error('fixture provider interruption');
    } }, f.runtime);
    await assert.rejects(model.reply(messages, controller.signal));
    const status = f.runtime.status();
    assert.equal(status.measuredTokens, 10); assert.equal(status.chargedTokens, 40);
    assert.equal(status.uncertainInvocations, 1); assert.equal(status.blocked, true);
  }
});

test('disabled limits still account for usage and cannot erase uncertainty when enabled', async t => {
  const f = await fixture(t, { enabled: false });
  const model = consumptionModel({ async reply() { return 'Unmeasured fixture.'; } }, f.runtime);
  assert.equal(await model.reply(messages, signal()), 'Unmeasured fixture.');
  assert.equal(f.runtime.status().uncertainInvocations, 1); assert.equal(f.runtime.status().blocked, false);
  f.policy.enabled = true;
  await assert.rejects(model.reply(messages, signal()), /incomplete usage/);
});

test('accounting observer failure aborts execution and cannot be swallowed by provider observer isolation', async t => {
  const f = await fixture(t); let aborted = false;
  const save = f.journal.save.bind(f.journal);
  f.journal.save = record => { if (record.usage.source === 'provider_reported') throw Error('fixture durable write failure'); save(record); };
  const model = consumptionModel({ async reply(_messages, bounded, observe) {
    try { observe(providerUsage('openai', { usage: { input_tokens: 3, output_tokens: 2 } })); } catch { /* A provider may isolate usage callbacks. */ }
    aborted = bounded.aborted;
    return 'Do not accept this answer.';
  } }, f.runtime);
  await assert.rejects(model.reply(messages, signal())); assert.equal(aborted, true);
  assert.equal(f.runtime.status().reason, 'accounting_unavailable');
  await assert.rejects(model.reply(messages, signal()), /accounting is unavailable/);
});

test('queued execution resumes after a UTC reset without a failed attempt', async t => {
  const f = await fixture(t);
  await withConsumption(f.runtime, 'codex-cli', signal(), async (_bounded, observe) => { observe(providerUsage('codex', { usage: { input_tokens: 30, output_tokens: 20 } })); });
  const executor = new SerialExecutor(() => f.runtime.status().blocked); let starts = 0;
  const waiting = executor.run('queued', signal(), async () => { starts++; return 'done'; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 0); assert.equal(executor.waiting, 1);
  f.advance(); executor.wake(); assert.equal(await waiting, 'done'); assert.equal(starts, 1);
});

test('pre-aborted and invalid model requests never reserve consumption or dispatch', async t => {
  const f = await fixture(t); let calls = 0;
  const model = consumptionModel({ async reply() { calls++; return 'Fixture.'; } }, f.runtime), controller = new AbortController(); controller.abort();
  await assert.rejects(model.reply(messages, controller.signal));
  await assert.rejects(executeModel(model, { schemaVersion: 99 }, signal()));
  assert.equal(calls, 0); assert.equal(f.runtime.status().activeInvocations, 0); assert.equal(f.runtime.status().uncertainInvocations, 0);
});

test('late provider usage cannot rewrite a settled consumption invocation', async t => {
  const f = await fixture(t); let late;
  const model = consumptionModel({ async reply(_messages, _signal, observe) { late = observe; observe(providerUsage('openai', { usage: { input_tokens: 3, output_tokens: 2 } })); return 'Fixture.'; } }, f.runtime);
  await model.reply(messages, signal()); late(providerUsage('openai', { usage: { input_tokens: 1000, output_tokens: 1000 } }));
  assert.equal(f.runtime.status().measuredTokens, 5); assert.equal(f.runtime.status().blocked, false);
});


test('rejected tool preparation releases its reservation before any model dispatch', async t => {
  const f = await fixture(t); let requests = 0, revision = 1;
  const manifest = { tools: [{ name: 'fixture_read', description: 'Read fixture', inputSchema: { type: 'object' } }] };
  const model = consumptionModel(modelFor(connection('openai-api'), '/unused', async () => { requests++; return Response.json(answer('openai-api')); }, { tools: () => ({ manifest: { ...manifest, revision }, async call() { throw Error('No tool should execute.'); }, async close() {} }) }), f.runtime);
  const dispatch = prepareModelRequest(model, messages); revision++;
  await assert.rejects(executeModel(model, dispatch, signal()), { code: 'tool_access' });
  assert.equal(requests, 0); assert.equal(f.runtime.status().activeInvocations, 0);
  assert.equal(f.runtime.status().uncertainInvocations, 0); assert.equal(f.runtime.status().chargedTokens, 0); assert.equal(f.runtime.status().blocked, false);
});


for (const disable of [false, true]) test('API continuation observes a consumption policy ' + (disable ? 'disabled' : 'lowered') + ' during tool execution', async t => {
  const f = await fixture(t, { allowance: disable ? 100 : 1000, perRunReservation: 10 }); let requests = 0;
  const manifest = { revision: 1, tools: [{ name: 'fixture_read', description: 'Read fixture', inputSchema: { type: 'object' } }] };
  const first = { status: 'completed', usage: rawUsage, output: [{ type: 'function_call', name: 'fixture_read', call_id: 'one', arguments: '{}' }] };
  const model = consumptionModel(modelFor(connection('openai-api'), '/unused', async () => Response.json(++requests === 1 ? first : answer('openai-api')), { tools: () => ({ manifest, async call() {
    if (disable) f.policy.enabled = false; else f.policy.allowance = 100;
    return { content: [{ type: 'text', text: 'Fixture result.' }] };
  }, async close() {} }) }), f.runtime);
  const execution = executeModel(model, prepareModelRequest(model, messages), signal());
  if (disable) assert.equal((await execution).text, 'Completed answer.');
  else await assert.rejects(execution, { code: 'consumption_limit' });
  assert.equal(requests, disable ? 2 : 1); assert.equal(f.runtime.status().measuredTokens, disable ? 100 : 50); assert.equal(f.runtime.status().uncertainInvocations, 0);
});
