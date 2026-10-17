import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { waitForPreparedSession } = await frontend('src/worker/webview/request-preparation.ts');
const initial = () => ({ id: 'request-a', state: 'preparing', phase: 'waiting' });
const ports = overrides => ({ active: () => true, now: () => 0, pause: async () => {}, progress() {}, read: async () => ({ preparations: [], tasks: [] }), ...overrides });

test('preparation observes each phase and selects only the original request session', async () => {
  const progress = [], snapshots = [
    { preparations: [{ ...initial(), phase: 'worktree' }], tasks: [{ id: 'other', sessionId: 'other-session' }] },
    { preparations: [{ ...initial(), phase: 'admission' }], tasks: [] },
    { preparations: [], tasks: [{ id: 'request-a', sessionId: 'local-request-a' }] },
  ];
  assert.equal(await waitForPreparedSession('request-a', initial(), ports({ read: async () => snapshots.shift(), progress: item => progress.push(item.phase) })), 'local-request-a');
  assert.deepEqual(progress, ['waiting', 'worktree', 'admission']); assert.equal(snapshots.length, 0);
});
test('failed preparation retains its error and asks for an explicit same-request retry', async () => {
  await assert.rejects(waitForPreparedSession('request-a', { ...initial(), state: 'failed', error: 'Repository is locked.' }, ports({ read: async () => assert.fail('must not poll a known failure') })), /Repository is locked.*instructions are kept.*Retry the same request/);
});
test('missing preparation after restart does not select unrelated work or silently resubmit', async () => {
  await assert.rejects(waitForPreparedSession('request-a', initial(), ports({ read: async () => ({ preparations: [], tasks: [{ id: 'other', sessionId: 'local-other' }] }) })), /Preparation could not be confirmed.*Retry the same request/);
});
test('mismatched and malformed preparation receipts are rejected before exposing progress', async () => {
  for (const preparation of [{ ...initial(), id: 'different' }, { ...initial(), phase: 'completed' }, null]) {
    await assert.rejects(waitForPreparedSession('request-a', preparation, ports({ progress: () => assert.fail('must not expose mismatched progress') })), /could not be confirmed/);
  }
});
test('access changes while awaiting a poll suppress its late session identity', async () => {
  let active = true; const read = deferred();
  const waiting = waitForPreparedSession('request-a', initial(), ports({ active: () => active, read: () => read.promise }));
  await Promise.resolve(); active = false; read.resolve({ preparations: [], tasks: [{ id: 'request-a', sessionId: 'private-session' }] });
  assert.equal(await waiting, undefined);
});
test('the preparation observer stops at its deadline without another read', async () => {
  let now = 0, reads = 0;
  await assert.rejects(waitForPreparedSession('request-a', initial(), ports({ now: () => now, pause: async () => { now += 11 * 60_000; }, read: async () => { reads++; return {}; } })), /longer than expected.*Retry the same request/);
  assert.equal(reads, 0);
});
