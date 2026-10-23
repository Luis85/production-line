import test from 'node:test';
import assert from 'node:assert/strict';
import { executeModel, prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { providerFailureOutcome } from '../../src/worker/dist/worker/application/provider-outcome.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { providerTransport } from '../../src/worker/dist/worker/infrastructure/provider-transport.js';
/** @type {import('../../src/worker/application/conversation-contracts.js').ChatMessage[]} */
const messages = [{ id: 'api-cancellation', role: 'user', state: 'complete', at: '2026-10-20T00:00:00.000Z', text: 'Fixture request; no external calls.' }];
const unknown = error => {
  const outcome = providerFailureOutcome(error);
  assert.equal(outcome.code, 'outcome_unknown'); assert.equal(outcome.state, 'outcome_unknown'); assert.equal(outcome.automaticRetry, false);
  return true;
};
for (const id of /** @type {const} */ (['openai-api', 'anthropic-api'])) {
  test(`${id} cancellation before the actual transport call performs no paid dispatch`, async () => {
    for (const fromBoundary of [false, true]) {
      const controller = new AbortController(); let calls = 0;
      const model = modelFor({ id, model: 'fixture-model', apiKey: 'fixture-only', executable: '' }, '/unused', async () => { calls++; throw Error('Transport must not be reached.'); }); assert.ok(model);
      const request = prepareModelRequest(model, messages);
      if (!fromBoundary) controller.abort();
      await assert.rejects(executeModel(model, request, controller.signal, undefined, { beforeCall() { controller.abort(); } }), error => providerFailureOutcome(error).code === 'cancelled');
      assert.equal(calls, 0);
    }
  });
  test(`${id} cancellation after fetch was attempted retains unknown remote completion without retry`, async () => {
    const controller = new AbortController(), started = Promise.withResolvers(); let calls = 0, usage = 0;
    const model = modelFor({ id, model: 'fixture-model', apiKey: 'fixture-only', executable: '' }, '/unused', async (_url, init) => {
      calls++; started.resolve(undefined);
      await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }));
      throw new DOMException('Private transport diagnostic.', 'AbortError');
    }); assert.ok(model);
    const assertion = assert.rejects(executeModel(model, prepareModelRequest(model, messages), controller.signal, () => usage++), unknown);
    await started.promise; controller.abort(); await assertion;
    assert.equal(calls, 1); assert.equal(usage, 0);
  });
  test(`${id} loss of an aborted response body does not establish that the remote model stopped`, async () => {
    const controller = new AbortController(); let calls = 0, usage = 0;
    const model = modelFor({ id, model: 'fixture-model', apiKey: 'fixture-only', executable: '' }, '/unused', async () => {
      calls++;
      return new Response(new ReadableStream({ pull(stream) { controller.abort(); stream.error(new DOMException('Private body diagnostic.', 'AbortError')); } }), { status: 200 });
    }); assert.ok(model);
    await assert.rejects(executeModel(model, prepareModelRequest(model, messages), controller.signal, () => usage++), unknown);
    assert.equal(calls, 1); assert.equal(usage, 0);
  });
}

test('the owned transport rejects an already aborted request before opening a connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(providerTransport('http://127.0.0.1:1/never-dispatched', { method: 'POST', signal: controller.signal }), error => providerFailureOutcome(error).code === 'cancelled');
});
