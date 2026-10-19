import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { prepareModelRequest, executeModel, ProviderModelError } from '../../src/worker/dist/worker/application/model-contract.js';
import { FileModelSessionStore } from '../../src/worker/dist/worker/infrastructure/model-session-store.js';
import { sessionDigest } from '../../src/worker/dist/worker/application/model-session.js';
import { claudeSessionUsage } from '../../src/worker/dist/worker/infrastructure/provider-usage.js';

/** @param {string} id @param {string} text @param {'user'|'assistant'} [role] */
const message = (id, text, role = 'user') => ({ id, role, text, state: /** @type {const} */ ('complete'), at: '2026-10-18T00:00:00Z' });
/** @param {string} providerId @param {string} [id] */
const binding = (providerId, id = 'feature-one') => ({ schemaVersion: /** @type {const} */ (1), logicalSessionId: id, featureRequestKey: 'fr-' + 'a'.repeat(64), providerId, generation: 1 });
const signal = () => new AbortController().signal;
const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'werk-session-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const response = id => id === 'openai-api'
  ? { status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture result.' }] }] }
  : { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Fixture result.' }] };

for (const id of /** @type {const} */ (['openai-api', 'anthropic-api'])) {
  test(`${id} preserves legacy sessions across default-effort migration and fences changed selections`, async t => {
    const root = await directory(t), store = new FileModelSessionStore(root), scope = binding(id); let calls = 0;
    /** @param {import('../../src/worker/application/model-effort.js').ModelEffort} [effort] */
    const create = (effort, modelName = 'fixture') => modelFor({ id, apiKey: 'fixture-key', model: modelName, executable: '', ...(effort === undefined ? {} : { effort }) }, root, async () => {
      calls++; const state = await store.load(scope); assert.equal(state.status, 'running'); assert.equal(state.checkpoint.nativeId, undefined);
      return Response.json(response(id));
    }, { session: { binding: scope, store } });
    const model = create();
    assert.equal(model.capabilities.nativeResume, false);
    assert.equal(model.capabilities.continuation, 'worker_context_replay');
    const request = prepareModelRequest(model, [message('first', 'Implement feature.')]);
    assert.equal(request.schemaVersion, 2);
    assert.equal((await executeModel(model, request, signal())).type, 'completed');
    const legacy = await store.load(scope); assert.equal(legacy.status, 'idle');
    assert.equal(Object.hasOwn(request.provider, 'effort'), false);
    assert.equal(legacy.checkpoint.providerContextDigest, sessionDigest({ provider: request.provider, executable: '' }));
    const messages = [...request.messages, message('answer', 'Fixture result.', 'assistant'), message('next', 'Add validation.')];
    for (const changed of [create('high'), create('default', 'different-model')]) {
      await assert.rejects(executeModel(changed, prepareModelRequest(changed, messages), signal()), { code: 'session_conflict' });
      assert.deepEqual(await store.load(scope), legacy);
    }
    assert.equal(calls, 1);
    const migrated = create('default'), next = prepareModelRequest(migrated, messages);
    assert.equal(next.provider.effort, 'default');
    await executeModel(migrated, next, signal());
    const continued = await store.load(scope);
    assert.equal(continued.checkpoint.providerContextDigest, legacy.checkpoint.providerContextDigest);
    assert.equal(continued.lastDispatchDigest, sessionDigest(next), 'Dispatch identity remains byte-exact.');
    await assert.rejects(executeModel(migrated, next, signal()), { code: 'session_conflict' });
    assert.equal(calls, 2);
    // A checkpoint written by the earlier explicit-default implementation also remains resumable.
    await store.save(scope, continued.revision, { status: 'idle', lastDispatchDigest: continued.lastDispatchDigest,
      checkpoint: { ...continued.checkpoint, providerContextDigest: sessionDigest({ provider: next.provider, executable: '' }) } });
    const olderAdapter = create(), followup = prepareModelRequest(olderAdapter, [...next.messages, message('later', 'Check the final result.')]);
    await executeModel(olderAdapter, followup, signal());
    assert.equal((await store.load(scope)).checkpoint.providerContextDigest, legacy.checkpoint.providerContextDigest);
    assert.equal(calls, 3);
    const files = await readdir(join(root, 'model-sessions'));
    for (const file of files.filter(file => file.endsWith('.json'))) assert.doesNotMatch(await readFile(join(root, 'model-sessions', file), 'utf8'), /fixture-key|Implement feature/);
  });
}
test('mismatched FR identities and failed checkpoint writes stop before provider inference', async t => {
  const root = await directory(t), scope = binding('openai-api'); let calls = 0;
  const store = new FileModelSessionStore(root);
  const create = session => modelFor({ id: 'openai-api', apiKey: 'fixture-key', model: 'fixture', executable: '' }, root, async () => { calls++; return Response.json(response('openai-api')); }, { session });
  const first = create({ binding: scope, store }), request = prepareModelRequest(first, [message('first', 'Work.')]);
  const second = create({ binding: binding('openai-api', 'another-feature'), store });
  await assert.rejects(executeModel(second, request, signal()), { code: 'session_conflict' });
  const failed = create({ binding: scope, store: { load: value => store.load(value), async save() { throw Error('private checkpoint failure'); } } });
  await assert.rejects(executeModel(failed, request, signal()), { code: 'session_conflict' });
  assert.equal(calls, 0);
});
for (const previousSuccess of [false, true]) test(`a pre-dispatch stop preserves an idle checkpoint and accepts explicit resume (prior success: ${previousSuccess})`, async t => {
  const root = await directory(t), store = new FileModelSessionStore(root), scope = binding('openai-api'); let calls = 0;
  const model = modelFor({ id: 'openai-api', apiKey: 'fixture-key', model: 'fixture', executable: '' }, root, async () => { calls++; return Response.json(response('openai-api')); }, { session: { binding: scope, store } });
  const first = prepareModelRequest(model, [message('first', 'Work.')]);
  if (previousSuccess) await executeModel(model, first, signal());
  const request = previousSuccess ? prepareModelRequest(model, [...first.messages, message('next', 'Follow up.')]) : first;
  await assert.rejects(executeModel(model, request, signal(), undefined, { beforeCall() { throw new ProviderModelError('consumption_limit'); } }), { code: 'consumption_limit' });
  const state = await store.load(scope); assert.equal(state.status, 'idle');
  assert.equal(state.lastDispatchDigest, previousSuccess ? sessionDigest(first) : undefined); assert.equal(calls, previousSuccess ? 1 : 0);
  const recovery = { ...request, sessionRecovery: { operationId: 'resume-operation', priorTurnId: 'blocked-turn', priorDispatchDigest: sessionDigest(request) } };
  await executeModel(model, recovery, signal()); assert.equal(calls, previousSuccess ? 2 : 1);
});
test('uncertain provider work is never replayed; explicit recovery must match its exact dispatch', async t => {
  const root = await directory(t), store = new FileModelSessionStore(root), scope = binding('openai-api'); let calls = 0, failing = true;
  const model = modelFor({ id: 'openai-api', apiKey: 'fixture-key', model: 'fixture', executable: '' }, root, async () => {
    calls++; if (failing) throw Error('fixture process disappeared'); return Response.json(response('openai-api'));
  }, { session: { binding: scope, store } });
  const request = prepareModelRequest(model, [message('first', 'Work.')]);
  await assert.rejects(executeModel(model, request, signal()));
  assert.equal((await store.load(scope)).status, 'unknown');
  failing = false;
  const retry = prepareModelRequest(model, [...request.messages, message('retry', 'Resume the interrupted work.')]);
  await assert.rejects(executeModel(model, retry, signal()), { code: 'session_conflict' });
  const recovered = { ...retry, sessionRecovery: { operationId: 'resume-operation', priorTurnId: 'failed-turn', priorDispatchDigest: sessionDigest(request) } };
  await assert.rejects(executeModel(model, { ...recovered, sessionRecovery: { ...recovered.sessionRecovery, priorDispatchDigest: '0'.repeat(64) } }, signal()), { code: 'session_conflict' });
  await executeModel(model, recovered, signal());
  assert.equal(calls, 2); assert.equal((await store.load(scope)).status, 'idle');
  await assert.rejects(executeModel(model, recovered, signal()), { code: 'session_conflict' });
});

test('Claude cost scopes preserve old per-call totals and subtract only proven cumulative totals', () => {
  const value = { type: 'result', usage, total_cost_usd: 1.5 };
  assert.equal(claudeSessionUsage(value, false, undefined, undefined).providerReportedCostUsd, 1.5);
  assert.equal(claudeSessionUsage(value, true, 'invocation', 1).providerReportedCostUsd, 1.5);
  assert.equal(claudeSessionUsage(value, true, 'session', 1).providerReportedCostUsd, 0.5);
  assert.equal(claudeSessionUsage(value, true, undefined, 1).providerReportedCostUsd, null);
  assert.equal(claudeSessionUsage({ total_cost_usd: 1 }, true, undefined, 0).source, 'unavailable');
  assert.equal(claudeSessionUsage(value, true, 'session', 2).providerReportedCostUsd, null);
  assert.equal(claudeSessionUsage(value, true, 'session', undefined).providerReportedCostUsd, null);
  assert.equal(claudeSessionUsage({ ...value, subtype: 'error_during_execution', total_cost_usd: 0 }, true, 'session', 0).providerReportedCostUsd, null);
});

test('Claude retains the native UUID, history and cost across legacy default-effort migration', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t), store = new FileModelSessionStore(root), executable = join(root, 'claude-fixture'), log = join(root, 'invocations.jsonl');
  await writeFile(executable, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2.1.277 (Claude Code)'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data);
process.stdin.on('end', () => { const resumed = args.includes('--resume'); const id = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: JSON.parse(input), cwd: process.cwd(), id }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: id, result: 'Fixture result.', usage: ${JSON.stringify(usage)}, total_cost_usd: resumed ? 1.5 : 1 })); });
`, { mode: 0o700 });
  const scope = binding('claude-cli');
  /** @param {ReturnType<typeof binding>} current @param {import('../../src/worker/application/model-effort.js').ModelEffort} [effort] */
  const create = (current, effort, modelName = 'fixture') => modelFor({ id: 'claude-cli', executable, model: modelName, apiKey: '', ...(effort === undefined ? {} : { effort }) }, root, undefined, { session: { binding: current, store } });
  const first = create(scope), request = prepareModelRequest(first, [message('first', 'Implement feature.')]);
  assert.equal(first.capabilities.nativeResume, true);
  const observed = [];
  await executeModel(first, request, signal(), value => observed.push(value));
  const state = await store.load(scope); assert.match(state.checkpoint.nativeId, /^[a-f0-9-]{36}$/);
  assert.equal(Object.hasOwn(request.provider, 'effort'), false);
  assert.equal(state.checkpoint.providerContextDigest, sessionDigest({ provider: request.provider, executable }));
  const messages = [...request.messages, message('answer', 'Fixture result.', 'assistant'), message('followup', 'Add validation.')];
  for (const changed of [create(scope, 'high'), create(scope, 'default', 'different-model')]) {
    await assert.rejects(executeModel(changed, prepareModelRequest(changed, messages), signal()), { code: 'session_conflict' });
    assert.deepEqual(await store.load(scope), state);
  }
  const migrated = create(scope, 'default'), next = prepareModelRequest(migrated, messages);
  await executeModel(migrated, next, signal(), value => observed.push(value));
  assert.equal((await store.load(scope)).lastDispatchDigest, sessionDigest(next));
  assert.equal((await store.load(scope)).checkpoint.providerContextDigest, state.checkpoint.providerContextDigest);
  await executeModel(create(binding('claude-cli', 'second-feature')), prepareModelRequest(create(binding('claude-cli', 'second-feature')), [message('another', 'Independent feature.')]), signal());
  const invocations = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(invocations.length, 3); assert.equal(invocations[0].id, invocations[1].id); assert.notEqual(invocations[0].id, invocations[2].id);
  assert.equal(invocations[0].cwd, invocations[1].cwd); assert.notEqual(invocations[0].cwd, invocations[2].cwd);
  assert.deepEqual(invocations[1].input, [{ role: 'user', content: 'Add validation.' }]);
  for (const call of invocations) {
    assert.ok(!call.args.includes('--continue')); assert.ok(!call.args.includes('--no-session-persistence'));
    assert.equal(call.args[call.args.indexOf('--tools') + 1], ''); assert.ok(call.args.includes('--strict-mcp-config')); assert.ok(call.args.includes('--restricted'));
    assert.equal(call.args[call.args.indexOf('--system-prompt-snapshot') + 1], 'off');
  }
  assert.deepEqual(observed.map(value => value.providerReportedCostUsd), [1, 0.5]);
  assert.equal((await store.load(scope)).checkpoint.nativeId, state.checkpoint.nativeId);
});

for (const version of ['2.1.256', '2.1.276', 'unknown-version']) test(`Claude resume accounting respects CLI version ${version}`, { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t), store = new FileModelSessionStore(root), executable = join(root, 'claude-version-fixture');
  await writeFile(executable, '#!' + process.execPath + '\n' + `
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(version)}); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => { const resumed = args.includes('--resume'); const id = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
process.stdout.write(JSON.stringify({ type: 'result', session_id: id, result: 'Fixture result.', usage: ${JSON.stringify(usage)}, total_cost_usd: resumed ? 1.5 : 1 })); });
`, { mode: 0o700 });
  const model = modelFor({ id: 'claude-cli', executable, model: 'fixture', apiKey: '' }, root, undefined, { session: { binding: binding('claude-cli'), store } });
  const first = prepareModelRequest(model, [message('first', 'Work.')]), observed = [];
  if (version !== '2.1.276') {
    let boundaries = 0;
    await assert.rejects(executeModel(model, first, signal(), undefined, { beforeCall() { boundaries++; } }), error => error instanceof ProviderModelError && error.code === 'invalid_request' && error.message.includes('2.1.257'));
    assert.equal(boundaries, 0); assert.equal((await store.load(binding('claude-cli'))).revision, 0); return;
  }
  await executeModel(model, first, signal(), value => observed.push(value));
  await executeModel(model, prepareModelRequest(model, [...first.messages, message('next', 'Continue.')]), signal(), value => observed.push(value));
  assert.deepEqual(observed.map(value => value.providerReportedCostUsd), [1, 1.5]);
});
test('concurrent dispatches cannot claim the same durable FR session', async t => {
  const root = await directory(t), store = new FileModelSessionStore(root), scope = binding('openai-api'); let calls = 0;
  const model = modelFor({ id: 'openai-api', apiKey: 'fixture-key', model: 'fixture', executable: '' }, root, async () => { calls++; return Response.json(response('openai-api')); }, { session: { binding: scope, store } });
  const results = await Promise.allSettled(['one', 'two'].map(id => executeModel(model, prepareModelRequest(model, [message(id, 'Work ' + id)]), signal())));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1); assert.equal(calls, 1);
});

test('Codex v2 retains explicit FR checkpoints while preserving isolated ephemeral execution', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t), store = new FileModelSessionStore(root), executable = join(root, 'codex-fixture'), log = join(root, 'codex.jsonl');
  const scope = binding('codex-cli'), checkpoint = join(root, 'model-sessions', sessionDigest([scope.logicalSessionId, scope.generation]) + '.json');
  await writeFile(executable, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'); let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data);
process.stdin.on('end', () => { const state = JSON.parse(fs.readFileSync(${JSON.stringify(checkpoint)},'utf8'));
if(state.status !== 'running' || state.checkpoint.nativeId) process.exit(11);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),input})+'\\n');
for(const event of [{type:'thread.started',thread_id:'ephemeral-fixture'},{type:'item.completed',item:{type:'agent_message',text:'Fixture result.'}},{type:'turn.completed',usage:{input_tokens:20,output_tokens:3,cached_input_tokens:0}}]) console.log(JSON.stringify(event)); });
`, { mode: 0o700 });
  const create = () => modelFor({ id: 'codex-cli', executable, model: 'fixture', apiKey: '' }, root, undefined, { session: { binding: scope, store } });
  const first = create(), request = prepareModelRequest(first, [message('first', 'Implement feature.')]);
  assert.equal(first.capabilities.nativeResume, false); assert.equal(first.capabilities.continuation, 'worker_context_replay');
  await executeModel(first, request, signal());
  await executeModel(create(), prepareModelRequest(create(), [...request.messages, message('next', 'Add validation.')]), signal());
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.ok(call.args.includes('--ignore-user-config')); assert.ok(call.args.includes('--ephemeral')); assert.ok(!call.args.includes('--resume')); assert.ok(!call.args.includes('app-server')); }
  assert.match(calls[1].input, /Implement feature/); assert.match(calls[1].input, /Add validation/);
  assert.equal((await store.load(scope)).status, 'idle'); assert.equal((await store.load(scope)).checkpoint.nativeId, undefined);
});
