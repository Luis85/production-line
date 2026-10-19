import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { executeModel, prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { FileModelSessionStore } from '../../src/worker/dist/worker/infrastructure/model-session-store.js';

const messages = [{ id: 'first', role: /** @type {const} */ ('user'), text: 'Implement the feature.', state: /** @type {const} */ ('complete'), at: '2026-10-18T00:00:00Z' }];
const response = id => id === 'openai-api'
  ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture complete.' }] }] }
  : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixture complete.' }] };

for (const id of /** @type {const} */ (['openai-api', 'anthropic-api'])) {
  for (const effort of /** @type {const} */ ([undefined, 'default', 'high', 'max'])) test(`${id} sends only explicit frozen effort (${effort ?? 'legacy'})`, async () => {
    const bodies = [];
    /** @type {import('../../src/worker/application/provider-contract.js').ProviderConnection} */
    const connection = { id, executable: '', apiKey: 'fixture-key', model: 'accepted-model', ...(effort === undefined ? {} : { effort }) };
    const model = modelFor(connection, '/unused', async (_url, options) => { bodies.push(JSON.parse(String(options.body))); return Response.json(response(id)); });
    const request = prepareModelRequest(model, messages);
    assert.equal(request.provider.effort, effort);
    assert.ok(Object.isFrozen(request.provider));
    connection.model = 'future-default'; connection.effort = 'low';
    await executeModel(model, request, new AbortController().signal);
    assert.equal(bodies.length, 1); assert.equal(bodies[0].model, 'accepted-model');
    const setting = id === 'openai-api' ? bodies[0].reasoning : bodies[0].output_config;
    assert.deepEqual(setting, effort && effort !== 'default' ? { effort } : undefined);
    assert.equal(bodies[0][id === 'openai-api' ? 'output_config' : 'reasoning'], undefined);
  });
  test(`${id} refuses malformed or unsupported saved effort before transport`, async () => {
    let calls = 0;
    const model = modelFor({ id, executable: '', apiKey: 'fixture-key', model: 'fixture' }, '/unused', async () => { calls++; return Response.json(response(id)); });
    for (const effort of ['ultra', 'unrecognized', 3, null]) {
      const request = prepareModelRequest(model, messages);
      await assert.rejects(executeModel(model, /** @type {import('../../src/worker/application/model-contract.js').ModelRequest} */ (/** @type {unknown} */ ({ ...request, provider: { ...request.provider, effort } })), new AbortController().signal), { code: 'protocol' });
    }
    assert.equal(calls, 0);
  });
}

for (const id of /** @type {const} */ (['codex-cli', 'claude-cli'])) {
  test(`${id} retains explicit effort through executable dispatch and durable session reconstruction`, { skip: process.platform === 'win32', timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'werk-effort-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, 'provider-fixture'), log = join(root, 'calls.jsonl');
    await writeFile(executable, '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.277 (Claude Code)'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => {
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(id)} === 'claude-cli') {
const index = args.indexOf(args.includes('--resume') ? '--resume' : '--session-id');
console.log(JSON.stringify({ type:'result', result:'Fixture complete.', ...(index >= 0 ? { session_id: args[index+1] } : {}) }));
} else console.log(JSON.stringify({ type:'item.completed', item:{ type:'agent_message', text:'Fixture complete.' } }));
});
`, { mode: 0o700 });
    const store = new FileModelSessionStore(root);
    const binding = { schemaVersion: /** @type {const} */ (1), logicalSessionId: 'effort-session', featureRequestKey: 'fr-' + 'a'.repeat(64), providerId: id, generation: 1 };
    /** @param {import('../../src/worker/application/model-effort.js').ModelEffort} effort */
    const create = effort => modelFor({ id, executable, apiKey: '', model: 'accepted-model', effort }, root, undefined, { session: { binding, store } });
    const initial = create('high'), first = prepareModelRequest(initial, messages);
    await executeModel(create('low'), first, AbortSignal.timeout(10000));
    const continued = prepareModelRequest(create('high'), [...messages, { ...messages[0], id: 'next', text: 'Continue the same feature.' }]);
    await executeModel(create('low'), continued, AbortSignal.timeout(10000));
    const plain = modelFor({ id, executable, apiKey: '', model: '', effort: 'default' }, root);
    await executeModel(plain, prepareModelRequest(plain, messages), AbortSignal.timeout(10000));
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 3);
    for (const args of calls.slice(0, 2)) {
      if (id === 'claude-cli') assert.equal(args[args.indexOf('--effort') + 1], 'high');
      else assert.ok(args.includes('model_reasoning_effort="high"'));
      assert.equal(args[args.indexOf('--model') + 1], 'accepted-model');
    }
    assert.ok(!calls[2].some(arg => arg === '--effort' || arg.startsWith('model_reasoning_effort=')));
    assert.ok(!calls[2].includes('--model'));
    assert.equal((await store.load(binding)).status, 'idle');
  });
}
