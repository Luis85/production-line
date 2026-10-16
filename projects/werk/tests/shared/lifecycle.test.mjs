import test from 'node:test';
import assert from 'node:assert/strict';
import { settleCleanup, withCleanup } from '../../src/worker/dist/shared/lifecycle.js';

test('cleanup waits for every operation in a failed stage before releasing dependent resources', async () => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers(), events = [], failure = Error('first failure');
  const closed = settleCleanup([
    () => { events.push('failed'); throw failure; },
    async () => { entered.resolve(); await held.promise; events.push('drained'); },
  ], () => events.push('database'), () => { events.push('last'); throw Error('later failure'); });
  const rejected = assert.rejects(closed, error => error === failure);
  await entered.promise;
  assert.deepEqual(events, ['failed']);
  held.resolve(); await rejected;
  assert.deepEqual(events, ['failed', 'drained', 'database', 'last']);
});

test('cleanup preserves the operation failure and reports cleanup failure after successful work', async () => {
  const startup = Error('startup'), closing = Error('closing'); let closed = 0;
  await assert.rejects(withCleanup(async () => { throw startup; }, () => { closed++; throw closing; }), error => error === startup);
  await assert.rejects(withCleanup(async () => 'done', () => { closed++; throw closing; }), error => error === closing);
  assert.equal(closed, 2);
});
