import test from 'node:test';
import assert from 'node:assert/strict';
import { readResponseBody, ResponseBodyLimitError } from '../../../.mutation-build/shared/http/response-body.js';
/** @type {('always' | undefined)[]} */
const cancellationModes = [undefined, 'always'];
function stream(chunks, close = true) {
  let cancelled = 0;
  const body = new ReadableStream({ pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else if (close) controller.close(); }, cancel() { cancelled++; } });
  return { body, cancelled: () => cancelled };
}
test('response collection preserves ordered bytes, exact boundaries and reader ownership', async () => {
  assert.deepEqual(await readResponseBody(null, 0), new Uint8Array());
  const empty = stream([]); assert.deepEqual(await readResponseBody(empty.body, 0), new Uint8Array()); assert.equal(empty.body.locked, false);
  const exact = stream([Uint8Array.of(1, 2), new Uint8Array(), Uint8Array.of(3, 4)]);
  assert.deepEqual(await readResponseBody(exact.body, 4), Uint8Array.of(1, 2, 3, 4));
  assert.equal(exact.body.locked, false); assert.equal(exact.cancelled(), 0);
});
test('response overflow counts all chunks and cancels the upstream once', async () => {
  for (const cancel of cancellationModes) {
    const overflow = stream([Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)], false);
    await assert.rejects(readResponseBody(overflow.body, 4, { cancel }), error => error instanceof ResponseBodyLimitError && error.name === 'ResponseBodyLimitError' && error.limit === 4 && /byte limit/.test(error.message));
    assert.equal(overflow.body.locked, false); assert.equal(overflow.cancelled(), 1);
  }
});
test('provider cleanup cancels on success and failure without hiding a read failure', async () => {
  for (const fails of [false, true]) for (const cancel of cancellationModes) {
    const failure = Error('read failed'), events = [];
    const body = { getReader: () => ({ async read() { events.push('read'); if (fails) throw failure; return { done: true }; }, async cancel() { events.push('cancel'); throw Error('cleanup failed'); }, releaseLock() { events.push('release'); } }) };
    // @ts-expect-error Deliberately inject the reader seam with failing cleanup to verify ownership.
    if (fails) await assert.rejects(readResponseBody(body, 8, { cancel }), error => error === failure);
    // @ts-expect-error Deliberately inject the same partial reader seam for successful completion.
    else assert.deepEqual(await readResponseBody(body, 8, { cancel }), new Uint8Array());
    assert.deepEqual(events, cancel === 'always' ? ['read', 'cancel', 'release'] : ['read', 'release']);
  }
});

test('always-cancel overflow delegates cancellation to one final cleanup', async () => {
  const events = [];
  const body = { getReader: () => ({ async read() { return { done: false, value: Uint8Array.of(1, 2) }; }, async cancel() { events.push('cancel'); }, releaseLock() { events.push('release'); } }) };
  // @ts-expect-error Deliberately inject the reader seam to count cancellation and release calls.
  await assert.rejects(readResponseBody(body, 1, { cancel: 'always' }), error => error instanceof ResponseBodyLimitError);
  assert.deepEqual(events, ['cancel', 'release']);
});
