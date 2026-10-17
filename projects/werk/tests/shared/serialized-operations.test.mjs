import test from 'node:test';
import assert from 'node:assert/strict';
import { SerializedOperations } from '../../src/worker/dist/shared/serialized-operations.js';

test('serialized operations start asynchronously, preserve FIFO and never overlap', async () => {
  const queue = new SerializedOperations(), entered = Promise.withResolvers(), held = Promise.withResolvers(), events = [];
  const first = queue.run(async () => { events.push('first:start'); entered.resolve(); await held.promise; events.push('first:done'); return 'saved'; });
  const second = queue.run(() => { events.push('second'); return 42; });
  const third = queue.run(() => { events.push('third'); });
  assert.deepEqual(events, []);
  await entered.promise;
  assert.deepEqual(events, ['first:start']);
  held.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ['saved', 42, undefined]);
  assert.deepEqual(events, ['first:start', 'first:done', 'second', 'third']);
});

test('synchronous and asynchronous failures remain caller-visible without poisoning later operations', async () => {
  const queue = new SerializedOperations(), sync = Error('invalid revision'), async = Error('disk full'), events = [];
  const first = queue.run(() => { events.push('first'); throw sync; });
  const second = queue.run(async () => { events.push('second'); throw async; });
  const third = queue.run(() => { events.push('third'); return 'recovered'; });
  await Promise.all([assert.rejects(first, error => error === sync), assert.rejects(second, error => error === async)]);
  assert.equal(await third, 'recovered');
  await queue.drain();
  assert.deepEqual(events, ['first', 'second', 'third']);
});

test('drain waits for the accepted tail and settles even when its last operation fails', async () => {
  const queue = new SerializedOperations(), entered = Promise.withResolvers(), held = Promise.withResolvers(), failure = Error('save failed');
  await queue.drain();
  const operation = queue.run(async () => { entered.resolve(); await held.promise; throw failure; });
  const rejected = assert.rejects(operation, error => error === failure);
  let drained = false;
  const draining = queue.drain().then(() => { drained = true; });
  await entered.promise;
  assert.equal(drained, false);
  held.resolve();
  await Promise.all([rejected, draining]);
  assert.equal(drained, true);
});

test('drain is a snapshot and later admissions require a new drain', async () => {
  const queue = new SerializedOperations(), entered = Promise.withResolvers(), held = Promise.withResolvers();
  const first = queue.run(() => 'first');
  const snapshot = queue.drain();
  let laterDone = false;
  const later = queue.run(async () => { entered.resolve(); await held.promise; laterDone = true; });
  await entered.promise;
  await snapshot;
  assert.equal(await first, 'first');
  assert.equal(laterDone, false);
  held.resolve();
  await queue.drain();
  await later;
  assert.equal(laterDone, true);
});

test('follow-up enqueueing preserves operations already waiting in the queue', async () => {
  const queue = new SerializedOperations(), events = [];
  let followup;
  const first = queue.run(() => { events.push('first'); followup = queue.run(() => { events.push('followup'); }); });
  const waiting = queue.run(() => { events.push('waiting'); });
  await first;
  await queue.drain();
  await Promise.all([waiting, followup]);
  assert.deepEqual(events, ['first', 'waiting', 'followup']);
});
