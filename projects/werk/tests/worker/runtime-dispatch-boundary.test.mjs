import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { executeModel, prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { FileModelSessionStore } from '../../src/worker/dist/worker/infrastructure/model-session-store.js';
import { sessionDigest, validateModelSessionUpdate } from '../../src/worker/dist/worker/application/model-session.js';
import { defaultToolPolicy, updateToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';

/** @returns {import('../../src/worker/application/conversation-contracts.js').ChatMessage} */
const message = id => ({ id, role: 'user', state: 'complete', at: '2026-10-21T00:00:00Z', text: 'Fixture request ' + id });
/** @returns {import('../../src/worker/application/model-session.js').ModelSessionBinding} */
const binding = id => ({ schemaVersion: 1, logicalSessionId: 'dispatch-boundary', featureRequestKey: 'fr-' + 'a'.repeat(64), providerId: id, generation: 1 });
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-dispatch-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const response = id => id === 'openai-api'
  ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture complete.' }] }] }
  : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixture complete.' }] };

// CLI probes and Cursor chat allocation are not inference. The fixture records only actual dispatches.
async function executableFixture(root, id, log) {
  const executable = join(root, 'provider-fixture');
  await writeFile(executable, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.277 (Claude Code)'); process.exit(0); }
if (args.includes('create-chat')) { console.log('33333333-3333-4333-8333-333333333333'); process.exit(0); }
let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, 'x');
  if (${JSON.stringify(id)} === 'codex-cli') {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixture complete.' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  } else {
    const nativeId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: nativeId, result: 'Fixture complete.' }));
  }
});`, { mode: 0o700 });
  return executable;
}
for (const id of /** @type {const} */ (['openai-api', 'anthropic-api', 'claude-cli', 'codex-cli', 'cursor-cli'])) {
  for (const priorSuccess of [false, true]) test(`${id} cancellation at the dispatch boundary restores its prior checkpoint (prior success: ${priorSuccess})`, { skip: process.platform === 'win32' && id.endsWith('-cli') }, async t => {
    const root = await directory(t), log = join(root, 'inference-calls'), store = new FileModelSessionStore(root), scope = binding(id);
    const executable = id.endsWith('-cli') ? await executableFixture(root, id, log) : '';
    let apiCalls = 0;
    const model = modelFor({ id, executable, model: 'fixture', apiKey: 'fixture-only' }, root, async () => { apiCalls++; return Response.json(response(id)); }, { session: { binding: scope, store } });
    assert.ok(model);
    const first = prepareModelRequest(model, [message('first')]);
    if (priorSuccess) await executeModel(model, first, t.signal);
    const previous = await store.load(scope), controller = new AbortController();
    const request = priorSuccess ? prepareModelRequest(model, [...first.messages, message('next')]) : first;
    let boundaries = 0;
    await assert.rejects(executeModel(model, request, controller.signal, undefined, { beforeCall() { boundaries++; controller.abort(); } }), { code: 'cancelled' });
    const stopped = await store.load(scope);
    assert.equal(boundaries, 1); assert.equal(stopped.status, 'idle');
    assert.equal(stopped.lastDispatchDigest, previous.lastDispatchDigest);
    assert.deepEqual(stopped.checkpoint, previous.checkpoint, 'No uncertain native identity or input history is retained before dispatch.');
    const calls = async () => id.endsWith('-cli') ? (await readFile(log, 'utf8').catch(() => '')).length : apiCalls;
    assert.equal(await calls(), priorSuccess ? 1 : 0);
    const recovery = { ...request, sessionRecovery: { operationId: 'operator-resume', priorTurnId: 'cancelled-turn', priorDispatchDigest: sessionDigest(request) } };
    assert.equal((await executeModel(model, recovery, t.signal)).type, 'completed');
    assert.equal(await calls(), priorSuccess ? 2 : 1); assert.equal((await store.load(scope)).status, 'idle');
  });
}

test('model session checkpoints reject coerced lifecycle states on validation and restart', async t => {
  const root = await directory(t), store = new FileModelSessionStore(root), scope = binding('openai-api');
  const saved = await store.save(scope, 0, { status: 'idle' });
  const path = join(root, 'model-sessions', sessionDigest([scope.logicalSessionId, scope.generation]) + '.json');
  for (const status of [['idle'], ['running'], ['unknown'], {}, null, 0, true]) {
    assert.throws(() => validateModelSessionUpdate({ status }), /Invalid model session checkpoint/);
    await writeFile(path, JSON.stringify({ ...saved, status }));
    await assert.rejects(new FileModelSessionStore(root).load(scope), /Invalid model session checkpoint/);
  }
  for (const status of ['idle', 'running', 'unknown']) assert.doesNotThrow(() => validateModelSessionUpdate({ status }));
});

test('MCP transport must be an exact supported string before save or update', () => {
  const policy = defaultToolPolicy();
  const connection = { id: 'fixture', name: 'Fixture', enabled: false, command: '', args: [], url: '', secretEnv: '', secret: '', discoveredTools: [], allowedTools: [] };
  for (const transport of [['http'], ['stdio'], {}, null, 0, true, 'HTTP']) {
    assert.throws(() => validateToolPolicy({ ...policy, mcp: [{ ...connection, transport }] }), /Choose stdio or HTTP/);
    const { discoveredTools, secret, ...input } = connection;
    assert.throws(() => updateToolPolicy(policy, { expectedRevision: 0, builtins: policy.builtins, mcp: [{ ...input, transport }] }), /Choose stdio or HTTP/);
  }
  assert.equal(validateToolPolicy({ ...policy, mcp: [{ ...connection, transport: 'http', url: 'https://mcp.example.test' }] }).mcp[0].transport, 'http');
  assert.equal(validateToolPolicy({ ...policy, mcp: [{ ...connection, transport: 'stdio', command: process.execPath }] }).mcp[0].transport, 'stdio');
});
