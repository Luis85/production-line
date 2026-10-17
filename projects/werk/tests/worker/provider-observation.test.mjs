import { testErrorField } from '../helpers/typed-boundaries.mjs';
import { completedText } from './model-fixtures.mjs';
import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { executeModel, prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { SerialExecutor } from '../../src/worker/dist/worker/application/serial-executor.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';

/** @type {import('../../src/worker/application/conversation-contracts.js').ChatMessage[]} */
const messages = [{ id: 'input', role: 'user', state: 'complete', at: '2026-10-15T00:00:00Z', text: 'A fixture task.' }];
/** @returns {import('../../src/worker/application/run-evidence.js').ProviderUsage} */
const measured = () => ({ ...unknownUsage(), inputTokens: 8, outputTokens: 3, source: 'provider_reported', reason: null });
const connection = id => ({ id, model: 'fixture-model', apiKey: 'fixture-private', executable: '' });
const apiResult = id => id === 'openai-api'
  ? { status: 'completed', usage: { input_tokens: 8, output_tokens: 3 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture complete.' }] }] }
  : { stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'Fixture complete.' }] };

test('API usage observers cannot replace successful results or classified provider failures', async () => {
  for (const id of /** @type {const} */ (['openai-api', 'anthropic-api'])) {
    for (const observer of [() => { throw Error('PRIVATE_OBSERVER_FAILURE'); }, async () => { throw Error('PRIVATE_OBSERVER_FAILURE'); }]) {
      for (const direct of [false, true]) {
        for (const status of [200, 429]) {
          let calls = 0;
          const model = modelFor(connection(id), '/unused', async () => {
            calls++;
            return Response.json(status === 200 ? apiResult(id) : { error: { type: 'rate_limit', message: 'PRIVATE_PROVIDER_FAILURE' }, usage: { input_tokens: 8 } }, { status });
          });
          const invocation = direct ? model.execute(prepareModelRequest(model, messages), new AbortController().signal, observer) : model.reply(messages, new AbortController().signal, observer);
          if (status === 200) assert.equal(direct ? completedText((await invocation)) : await invocation, 'Fixture complete.');
          else await assert.rejects(invocation, error => testErrorCode(error) === 'rate_limit' && testErrorField(error, 'status') === 429 && !testErrorMessage(error).includes('PRIVATE'));
          assert.equal(calls, 1, 'observation failure never retries model work');
        }
      }
    }
  }
  await nextTurn(); // An unhandled asynchronous observer rejection fails node:test.
});

test('usage observations are detached and frozen for structured and legacy adapters', async () => {
  for (const typed of [false, true]) {
    const original = measured();
    /** @type {import('../../src/worker/application/run-evidence.js').ProviderUsage} */
    let observed;
    let providerAfterObserver;
    let frozen;
    let mutationAccepted;
    const reply = async (_messages, _signal, notify) => {
      notify(original);
      providerAfterObserver = original.inputTokens;
      original.inputTokens = 900;
      return 'Fixture complete.';
    };
    const model = { reply, ...(typed ? { execute: async (_request, signal, notify) => ({ type: 'completed', text: await reply(null, signal, notify) }) } : {}) };
    const result = await executeModel(model, prepareModelRequest(model, messages), new AbortController().signal, value => {
      observed = value;
      frozen = Object.isFrozen(value);
      mutationAccepted = Reflect.set(value, 'inputTokens', 700);
    });
    assert.equal(completedText(result), 'Fixture complete.');
    assert.notEqual(observed, original);
    assert.equal(frozen, true);
    assert.equal(mutationAccepted, false);
    assert.equal(providerAfterObserver, 8);
    assert.equal(observed.inputTokens, 8, 'later provider mutation cannot rewrite observed evidence');
  }
});

test('settled model invocations discard late usage on success and failure', async () => {
  for (const fail of [false, true]) {
    /** @type {(usage: import('../../src/worker/application/run-evidence.js').ProviderUsage) => void} */ let retained; const observations = [];
    const failure = Error('provider failed');
    const model = { async reply(_messages, _signal, notify) { retained = notify; notify(measured()); if (fail) throw failure; return 'Done.'; } };
    const pending = executeModel(model, prepareModelRequest(model, messages), new AbortController().signal, value => observations.push(value));
    if (fail) await assert.rejects(pending, error => error === failure); else await pending;
    retained({ ...measured(), outputTokens: 900 });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].outputTokens, 3);
  }
});

test('slow asynchronous observers never delay model settlement', { timeout: 2000 }, async () => {
  const model = { async reply(_messages, _signal, notify) { notify(measured()); return 'Done.'; } };
  const result = await executeModel(model, prepareModelRequest(model, messages), new AbortController().signal, () => new Promise(() => {}));
  assert.equal(completedText(result), 'Done.');
});

test('cancelled adapters retain the execution permit until cleanup, then reject late success', { timeout: 2000 }, async () => {
  const controller = new AbortController(), executor = new SerialExecutor();
  /** @type {() => void} */ let settleCleanup;
  /** @type {() => void} */ let reachedAdapter;
  /** @type {(usage: import('../../src/worker/application/run-evidence.js').ProviderUsage) => void} */ let retained;
  let settled = false;
  let nextStarted = false;
  const entered = new Promise(resolve => { reachedAdapter = () => resolve(undefined); });
  const cleanup = new Promise(resolve => { settleCleanup = () => resolve(undefined); });
  const observed = [];
  const model = { async reply(_messages, _signal, notify) { retained = notify; reachedAdapter(); await cleanup; notify(measured()); return 'Stale success.'; } };
  const first = executor.run('first', controller.signal, () => executeModel(model, prepareModelRequest(model, messages), controller.signal, value => observed.push(value)));
  const assertion = assert.rejects(first, { code: 'cancelled' });
  first.then(() => { settled = true; }, () => { settled = true; });
  await entered;
  const second = executor.run('second', new AbortController().signal, async () => { nextStarted = true; });
  controller.abort();
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(executor.current, 'first');
  assert.equal(nextStarted, false);
  settleCleanup();
  await assertion; await second;
  assert.equal(nextStarted, true);
  assert.equal(observed.length, 1, 'terminal usage delivered during cleanup remains measurable');
  retained({ ...measured(), outputTokens: 900 });
  assert.equal(observed.length, 1, 'callbacks after settlement cannot alter the next attempt');
});

test('pre-aborted direct API invocation never reaches transport', async () => {
  let calls = 0;
  const model = modelFor(connection('openai-api'), '/unused', async () => { calls++; return Response.json(apiResult('openai-api')); });
  await assert.rejects(model.execute(prepareModelRequest(model, messages), AbortSignal.abort()), { code: 'cancelled' });
  assert.equal(calls, 0);
});

test('direct API execution rejects success returned after abort while preserving reported usage', async () => {
  const controller = new AbortController();
  /** @type {import('../../src/worker/application/run-evidence.js').ProviderUsage} */
  let usage;
  const model = modelFor(connection('openai-api'), '/unused', async () => { controller.abort(); return Response.json(apiResult('openai-api')); });
  await assert.rejects(model.execute(prepareModelRequest(model, messages), controller.signal, value => { usage = value; }), { code: 'cancelled' });
  assert.equal(usage.inputTokens, 8);
});

test('CLI observations isolate asynchronous rejection and expose immutable snapshots', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const id of /** @type {const} */ (['codex-cli', 'claude-cli'])) {
    const output = id === 'codex-cli' ? [
      { type: 'item.completed', item: { type: 'agent_message', text: 'Fixture complete.' } },
      { type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 3 } }
    ].map(value => JSON.stringify(value)).join('\n') : JSON.stringify({ type: 'result', result: 'Fixture complete.', usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const executable = join(directory, id);
    await writeFile(executable, '#!' + process.execPath + '\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write(' + JSON.stringify(output) + '));\n', { mode: 0o700 });
    const model = modelFor({ ...connection(id), executable }, directory);
    /** @type {import('../../src/worker/application/run-evidence.js').ProviderUsage} */
    let observed;
    const result = await model.execute(prepareModelRequest(model, messages), AbortSignal.timeout(5000), async value => { observed = value; throw Error('PRIVATE_OBSERVER_FAILURE'); });
    assert.equal(completedText(result), 'Fixture complete.');
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(observed.outputTokens, 3);
  }
  await nextTurn();
});
