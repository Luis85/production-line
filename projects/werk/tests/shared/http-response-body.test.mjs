import { productionLine, intakeTask } from '../helpers/factory-intake.mjs';
import { testErrorField, testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readResponseBody, ResponseBodyLimitError } from '../../src/orchestrator/dist/shared/http/response-body.js';
import { request } from '../../src/orchestrator/dist/shared/http/client.js';
import { privateJson } from '../../src/orchestrator/dist/shared/http/bounded-client.js';
import { HttpLineReader } from '../../src/factory/dist/factory/infrastructure/poller.js';
import { HttpLineDelivery } from '../../src/factory/dist/factory/infrastructure/delivery.js';
import { apiReply } from '../../src/worker/dist/worker/infrastructure/provider-api.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';

function stream(chunks, close = true) {
  let cancelled = 0;
  const body = new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else if (close) controller.close(); },
    cancel() { cancelled++; },
  });
  return { body, cancelled: () => cancelled };
}
// Keep an oversized upstream response open until the adapter cancels it.
function oversized(bytes) { return stream([new Uint8Array(bytes)], false); }

test('bounded body collection measures bytes across chunks and releases the reader on success and overflow', async () => {
  const exact = stream([Uint8Array.of(1, 2), Uint8Array.of(3, 4)]);
  assert.deepEqual(await readResponseBody(exact.body, 4), Uint8Array.of(1, 2, 3, 4));
  assert.equal(exact.body.locked, false); assert.equal(exact.cancelled(), 0);
  const overflow = stream([Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)]);
  await assert.rejects(readResponseBody(overflow.body, 4), error => error instanceof ResponseBodyLimitError && error.limit === 4);
  assert.equal(overflow.body.locked, false); assert.equal(overflow.cancelled(), 1);
  assert.deepEqual(await readResponseBody(null, 4), new Uint8Array());
});

test('provider cleanup cancels on read failure, suppresses cleanup errors, and releases the lock', async () => {
  const failure = Error('read failed'), events = [];
  const body = { getReader: () => ({
    async read() { events.push('read'); throw failure; },
    async cancel() { events.push('cancel'); throw Error('cleanup failed'); },
    releaseLock() { events.push('release'); },
  }) };
  // @ts-expect-error Intentionally inject only the reader seam, including failing cleanup methods.
  await assert.rejects(readResponseBody(body, 8, { cancel: 'always' }), error => error === failure);
  assert.deepEqual(events, ['read', 'cancel', 'release']);
  events.length = 0;
  // @ts-expect-error Intentionally inject only the reader seam to observe release after failure.
  await assert.rejects(readResponseBody(body, 8), error => error === failure);
  assert.deepEqual(events, ['read', 'release']);
});

test('HTTP adapters retain strict public decoding and permissive private decoding with private errors', async t => {
  const invalidUtf8 = Uint8Array.from([34, 0xc3, 0x28, 34]);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(invalidUtf8));
  await assert.rejects(request('http://localhost', '/test', 'private'), error => testErrorField(error, 'status') === 502 && /invalid JSON/.test(testErrorMessage(error)));
  assert.equal(await privateJson(new URL('http://localhost/test'), 'private'), '\ufffd(');
  fetchMock.mock.mockImplementation(async () => Response.json({ error: 'PRIVATE_REMOTE_DIAGNOSTIC' }, { status: 403 }));
  await assert.rejects(privateJson(new URL('http://localhost/test'), 'private'), error => testErrorCode(error) === 'unavailable' && !testErrorMessage(error).includes('PRIVATE_REMOTE_DIAGNOSTIC'));
  await assert.rejects(request('http://localhost', '/test', 'private'), error => testErrorField(error, 'status') === 403 && testErrorMessage(error) === 'PRIVATE_REMOTE_DIAGNOSTIC');
});

test('shared, private and Factory response adapters retain their separate byte limits and overflow policies', async t => {
  let current;
  t.mock.method(globalThis, 'fetch', async () => new Response(current.body));
  current = oversized(8 * 1024 * 1024 + 1);
  await assert.rejects(request('http://localhost', '/test', 'private'), error => testErrorField(error, 'status') === 502 && /8 MiB/.test(testErrorMessage(error)));
  assert.equal(current.cancelled(), 1); assert.equal(current.body.locked, false);
  current = oversized(1048577);
  await assert.rejects(privateJson(new URL('http://localhost/test'), 'private'), error => testErrorCode(error) === 'unavailable');
  assert.equal(current.cancelled(), 1); assert.equal(current.body.locked, false);
  const line = productionLine('http://localhost');
  const reader = new HttpLineReader({ LINE: 'private' }); t.after(() => reader.close());
  current = oversized(65537);
  const overview = await reader.read(line);
  assert.equal(overview.status, 'invalid'); assert.match(overview.error, /64 KiB/);
  assert.equal(current.cancelled(), 1); assert.equal(current.body.locked, false);
  const delivery = new HttpLineDelivery({ LINE: 'private' }); t.after(() => delivery.close());
  current = oversized(65537);
  await assert.rejects(delivery.send(line, intakeTask('task')), /Oversized acknowledgement/);
  assert.equal(current.cancelled(), 1); assert.equal(current.body.locked, false);
});

test('provider API preserves response limits, HTTP classification and cancellation without remote diagnostics', async () => {
  /** @type {import('../../src/worker/application/provider-contract.ts').ProviderConnection} */
  const connection = { id: 'openai-api', apiKey: 'private', model: 'fixture', executable: '' };
  const model = { configuration: { id: 'openai-api', model: 'fixture', instruction: '' }, async reply() { return ''; } };
  const request = prepareModelRequest(model, []);
  const controller = new AbortController(), large = oversized(1048577);
  await assert.rejects(apiReply(connection, request, controller.signal, async () => new Response(large.body)), error => testErrorCode(error) === 'protocol');
  assert.equal(large.cancelled(), 1); assert.equal(large.body.locked, false);
  await assert.rejects(apiReply(connection, request, controller.signal, async () => new Response('PRIVATE_REMOTE_DIAGNOSTIC', { status: 401 })), error => testErrorCode(error) === 'authentication' && !testErrorMessage(error).includes('PRIVATE_REMOTE_DIAGNOSTIC'));
  const failed = new ReadableStream({ start(controller) { controller.error(Error('PRIVATE_STREAM_ERROR')); } });
  // Abort after transport admission so the response-reader path performs the classification.
  const lateController = new AbortController();
  await assert.rejects(apiReply(connection, request, lateController.signal, async () => { lateController.abort(); return new Response(failed); }), error => testErrorCode(error) === 'cancelled' && !testErrorMessage(error).includes('PRIVATE_STREAM_ERROR'));
  assert.equal(failed.locked, false);
});
