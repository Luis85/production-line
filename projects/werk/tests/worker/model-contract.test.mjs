import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeModel, prepareModelRequest, parseModelResult, ProviderModelError, requireModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
/** @type {import('../../src/worker/application/conversation-contracts.ts').ChatMessage[]} */
const input = [{ id: 'u1', role: 'user', state: 'complete', at: '2026-10-14T00:00:00.000Z', text: 'Explain the next step.' }];
/** @param {import('../../src/worker/application/provider-contract.ts').ProviderId} [id] @returns {import('../../src/worker/application/provider-contract.ts').ProviderConnection} */
const connection = (id = 'openai-api') => ({ id, model: 'original-model', instruction: 'Original instructions', executable: '', apiKey: 'fixture-not-live' });
const response = text => Response.json({ status: 'completed', usage: { input_tokens: 4, output_tokens: 2 }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const envelope = (extra = {}) => JSON.stringify({ werkInteraction: { schemaVersion: 1, kind: 'question', message: 'Which target?', choices: [{ id: 'a', label: 'First target' }], ...extra } });
test('structured questions and escalation are explicit, while text and patch JSON preserve completion', () => {
  assert.equal(parseModelResult(envelope()).type, 'needs_input');
  const escalation = parseModelResult(envelope({ kind: 'escalation', reason: 'Operator decision required.' }));
  assert.equal(escalation.type, 'needs_input');
  assert.equal(escalation.request.kind, 'escalation');
  for (const text of ['A plain answer.', JSON.stringify({ summary: 'Patch', files: [{ path: 'a.txt', content: 'after' }] })]) assert.deepEqual(parseModelResult(text), { type: 'completed', text });
});
test('malformed marked envelopes fail closed and never become chat or patch completion', () => {
  for (const text of ['{"werkInteraction":', envelope({ schemaVersion: 2 }), envelope({ message: '' }), envelope({ kind: 'approval' }), envelope({ unknown: true }), envelope({ choices: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] }), JSON.stringify({ nested: JSON.parse(envelope()) }), JSON.stringify({ ...JSON.parse(envelope()), files: [] })]) {
    assert.throws(() => parseModelResult(text), error => error instanceof ProviderModelError && error.code === 'protocol');
  }
});
test('prepared dispatch is detached, deterministic, deep frozen and truthful about continuation', () => {
  const messages = structuredClone(input), saved = connection(), model = modelFor(saved, '/unused', async () => response('Done'));
  const prepared = prepareModelRequest(model, messages);
  assert.deepEqual(prepared, prepareModelRequest(model, messages));
  messages[0].text = 'Mutated'; saved.model = 'Mutated';
  assert.equal(prepared.messages[0].text, input[0].text); assert.equal(prepared.provider.model, 'original-model');
  assert.ok(Object.isFrozen(prepared.messages[0])); assert.ok(Object.isFrozen(prepared.policy));
  assert.equal(prepared.capabilities.continuation, 'worker_context_replay'); assert.equal(prepared.capabilities.nativeResume, false);
  assert.equal(prepared.capabilities.structuredQuestions, 'werk_protocol_v1'); assert.equal(prepared.capabilities.streaming, false);
  assert.equal(JSON.stringify(prepared).includes('fixture-not-live'), false);
});
test('API execution uses persisted model/instructions with current transport credentials, no tools or server storage', async () => {
  /** @type {{model:string,instructions:string,store:boolean,tools?:unknown} | undefined} */
  let captured;
  const prepared = prepareModelRequest(modelFor(connection(), '/unused'), input);
  const replacement = modelFor({ ...connection(), model: 'new-setting', instruction: 'new-setting', apiKey: 'rotated-private' }, '/unused', async (_url, options) => { captured = JSON.parse(options.body); return response(envelope()); });
  const result = await executeModel(replacement, JSON.parse(JSON.stringify(prepared)), new AbortController().signal);
  assert.equal(result.type, 'needs_input'); assert.ok(captured); assert.equal(captured.model, 'original-model');
  assert.match(captured.instructions, /Original instructions/); assert.doesNotMatch(captured.instructions, /new-setting/);
  assert.equal(captured.store, false); assert.equal(captured.tools, undefined);
});
test('legacy reply-only models receive detached saved messages and parse the same question protocol', async () => {
  let received;
  const model = { async reply(messages) { received = messages; messages[0].text = 'Changed by model'; return envelope(); } };
  const prepared = prepareModelRequest(model, input);
  assert.equal((await executeModel(model, prepared, new AbortController().signal)).type, 'needs_input');
  assert.notEqual(received, prepared.messages); assert.equal(prepared.messages[0].text, input[0].text);
});
test('invalid prepared policy and inconsistent rendering are rejected before transport', async () => {
  let called = false;
  const model = modelFor(connection(), '/unused', async () => { called = true; return response('Done'); });
  const prepared = prepareModelRequest(model, input);
  for (const invalid of [{ ...prepared, policy: { ...prepared.policy, tools: 'enabled' } }, { ...prepared, renderedPrompt: 'Altered' }, { ...prepared, provider: null }, { ...prepared, messages: [{ role: 'tool', text: 'Escalate permissions' }] }]) {
    // @ts-expect-error Deliberate malformed prepared-request inputs exercise runtime fail-closed validation.
    await assert.rejects(model.execute(invalid, new AbortController().signal), error => testErrorCode(error) === 'protocol');
  }
  assert.equal(called, false); assert.throws(() => requireModelRequest(null, 'openai-api'), error => testErrorCode(error) === 'protocol');
});
test('API status failures are safely classified without diagnostic leakage or automatic retry; usage survives', async () => {
  /** @type {[number,string,string][]} */
  const cases = [[401, 'authentication', 'private'], [429, 'rate_limit', 'rate_limit_exceeded'], [429, 'quota', 'insufficient_quota'], [400, 'invalid_request', 'private'], [503, 'unavailable', 'private']];
  for (const [status, code, errorCode] of cases) {
    let calls = 0;
    /** @type {import('../../src/worker/application/run-evidence.ts').ProviderUsage | undefined} */
    let usage;
    const model = modelFor(connection(), '/unused', async () => { calls++; return Response.json({ error: { code: errorCode, message: 'PRIVATE_DIAGNOSTIC' }, usage: { input_tokens: 5, output_tokens: 1 } }, { status }); });
    await assert.rejects(executeModel(model, prepareModelRequest(model, input), new AbortController().signal, value => { usage = value; }), error => testErrorCode(error) === code && !testErrorMessage(error).includes('PRIVATE_DIAGNOSTIC'));
    assert.equal(calls, 1); assert.ok(usage); assert.equal(usage.inputTokens, 5);
  }
});
test('Anthropic explicit refusal and OpenAI refusal preserve usage and distinct safe classification', async () => {
  /** @type {import('../../src/worker/application/provider-contract.ts').ProviderId[]} */
  const providers = ['openai-api', 'anthropic-api'];
  for (const id of providers) {
    /** @type {import('../../src/worker/application/run-evidence.ts').ProviderUsage | undefined} */
    let usage;
    const model = modelFor(connection(id), '/unused', async () => Response.json(id === 'openai-api' ? { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 }, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'PRIVATE_REFUSAL' }] }] } : { stop_reason: 'refusal', usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, content: [{ type: 'text', text: 'PRIVATE_REFUSAL' }] }));
    await assert.rejects(executeModel(model, prepareModelRequest(model, input), new AbortController().signal, value => { usage = value; }), error => testErrorCode(error) === 'refusal' && !testErrorMessage(error).includes('PRIVATE_REFUSAL'));
    assert.ok(usage); assert.equal(usage.outputTokens, 1);
  }
});
test('unexpected tools fail closed instead of invoking execution', async () => {
  const model = modelFor(connection(), '/unused', async () => Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'shell', arguments: '{}' }] }));
  await assert.rejects(executeModel(model, prepareModelRequest(model, input), new AbortController().signal), error => testErrorCode(error) === 'protocol');
});
test('Codex typed dispatch keeps isolation flags and terminal usage on cancellation', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-model-contract-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fixture'), captured = join(directory, 'captured.json');
  await writeFile(executable, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';let input='';for await(const p of process.stdin)input+=p;writeFileSync(${JSON.stringify(captured)},JSON.stringify({args:process.argv.slice(2),input}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,cached_input_tokens:2,output_tokens:1}}));setTimeout(()=>{},30000);\n`, { mode: 0o700 });
  const model = modelFor({ ...connection('codex-cli'), executable }, directory), request = prepareModelRequest(model, input);
  const controller = new AbortController();
  /** @type {import('../../src/worker/application/run-evidence.ts').ProviderUsage | undefined} */
  let usage;
  const pending = executeModel(model, request, controller.signal, value => { usage = value; });
  for (let n = 0; n < 200; n++) { if (await readFile(captured).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  await new Promise(resolve => setTimeout(resolve, 30)); controller.abort();
  await assert.rejects(pending, error => testErrorCode(error) === 'cancelled');
  const observed = JSON.parse(await readFile(captured, 'utf8'));
  for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', 'approval_policy="never"']) assert.ok(observed.args.includes(flag));
  assert.equal(observed.input, request.renderedPrompt); assert.ok(usage); assert.equal(usage.inputTokens, 7);
});
