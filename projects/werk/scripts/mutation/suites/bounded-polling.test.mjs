import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedPoller } from '../../../.mutation-build/shared/webview/bounded-polling.js';
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture() {
  const calls = [], timers = new Set(); let paused = false, hidden = false;
  const poller = createBoundedPoller({ refresh: signal => { const task = deferred(); calls.push({ signal, ...task }); return task.promise; }, paused: () => paused, hidden: () => hidden, schedule: callback => { timers.add(callback); return callback; }, cancel: timer => timers.delete(timer) });
  return { poller, calls, timers, set paused(value) { paused = value; }, set hidden(value) { hidden = value; }, tick() { for (const callback of timers) callback(); } };
}
test('poller owns one active timer and suppresses overlapping, hidden and paused reads', async () => {
  const f = fixture(); f.poller.activate(false); f.poller.activate(); assert.equal(f.timers.size, 1); assert.equal(f.calls.length, 0);
  f.paused = true; f.tick(); f.paused = false; f.hidden = true; f.tick(); assert.equal(f.calls.length, 0);
  f.hidden = false; f.tick(); f.tick(); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(); await Promise.resolve(); await Promise.resolve(); f.tick(); assert.equal(f.calls.length, 2);
  f.poller.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.calls[1].signal.aborted, true); f.calls[1].resolve();
});
test('KeepAlive reactivation reads once and late inactive completion cannot unlock the next read', async () => {
  const f = fixture(); f.poller.activate(); assert.equal(f.calls.length, 1);
  f.poller.deactivate(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.timers.size, 0);
  f.tick(); await f.poller.refresh(); assert.equal(f.calls.length, 1);
  f.poller.activate(); f.poller.activate(); assert.equal(f.calls.length, 2); assert.equal(f.timers.size, 1);
  f.calls[0].resolve(); await Promise.resolve(); await Promise.resolve(); f.tick(); assert.equal(f.calls.length, 2);
  f.calls[1].resolve(); await Promise.resolve(); await Promise.resolve(); f.tick(); assert.equal(f.calls.length, 3);
  f.poller.dispose(); f.calls[2].resolve(); f.poller.activate(); assert.equal(f.timers.size, 0);
});

test('inactive deactivation is inert and activated timers need no active read to stop', () => {
  const events = [];
  const poller = createBoundedPoller({ refresh() { events.push('refresh'); }, paused: () => false, hidden: () => false, schedule() { events.push('schedule'); return 42; }, cancel(timer) { events.push(['cancel', timer]); } });
  poller.deactivate(); assert.deepEqual(events, []);
  poller.activate(false); poller.deactivate(); poller.deactivate(); poller.dispose();
  assert.deepEqual(events, ['schedule', ['cancel', 42]]);
  poller.activate(); assert.deepEqual(events, ['schedule', ['cancel', 42]]);
});
