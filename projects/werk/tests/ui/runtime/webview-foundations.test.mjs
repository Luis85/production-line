import { testErrorMessage } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend, deferred } from '../helpers/frontend-loader.mjs';
const { requestJson, jsonRequestInit, boundedSignal, WebviewHttpError } = await frontend('src/shared/webview/http.ts');
const { createBoundedPoller } = await frontend('src/shared/webview/bounded-polling.ts');

test('JSON transport preserves app headers, credentials, signal and body without retries', async () => {
  const abort = new AbortController(), calls = [];
  const init = { method: 'POST', credentials: 'same-origin', headers: { Authorization: 'Bearer private', 'Idempotency-Key': 'one' }, body: '{"action":"send"}', signal: abort.signal };
  const result = await requestJson('/api/example', init, { fetcher: async (...args) => { calls.push(args); return { ok: true, status: 200, json: async () => ({ accepted: true }) }; } });
  assert.deepEqual(result, { accepted: true }); assert.equal(calls.length, 1); assert.equal(calls[0][1], init);
});
test('auth response callback precedes unreadable JSON and errors retain HTTP status', async () => {
  const events = [];
  await assert.rejects(requestJson('/api/example', {}, {
    fetcher: async () => ({ ok: false, status: 401, json: async () => { events.push('json'); throw Error('HTML proxy'); } }),
    onResponse: response => events.push(response.status), invalidJson: status => `Unreadable (${status})`,
  }), error => error instanceof WebviewHttpError && error instanceof Error && 'status' in error && error.status === 401 && testErrorMessage(error) === 'Unreadable (401)');
  assert.deepEqual(events, [401, 'json']);
  await assert.rejects(requestJson('/api/example', {}, { fetcher: async () => ({ ok: false, status: 409, json: async () => ({ error: { secret: 'never stringify' } }) }), failure: () => 'Changed' }), { message: 'Changed', status: 409 });
});
test('bounded signals retain caller cancellation and impose a deadline', async () => {
  const controller = new AbortController(), signal = boundedSignal(controller.signal, 1000);
  controller.abort('view closed'); assert.equal(signal.aborted, true); assert.equal(signal.reason, 'view closed');
  const deadline = boundedSignal(undefined, 5); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(deadline.aborted, true); assert.equal(deadline.reason.name, 'TimeoutError');
});

test('JSON request defaults preserve app-owned authentication and exact command identity', async () => {
  const controller = new AbortController();
  const headers = { Authorization: 'Bearer fixture', 'Idempotency-Key': 'accepted-intent' };
  const input = { method: 'POST', body: { action: 'save', enabled: false }, headers, credentials: 'same-origin', signal: controller.signal, timeoutMs: 1000 };
  const init = jsonRequestInit(input);
  assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers.Authorization, 'Bearer fixture'); assert.equal(init.headers['Idempotency-Key'], 'accepted-intent');
  assert.equal(init.headers['Content-Type'], 'application/json'); assert.deepEqual(JSON.parse(init.body), input.body);
  assert.deepEqual(headers, { Authorization: 'Bearer fixture', 'Idempotency-Key': 'accepted-intent' }, 'preparing a request must not mutate caller-owned headers');
  controller.abort('changed view'); assert.equal(init.signal.aborted, true); assert.equal(init.signal.reason, 'changed view');
});
test('JSON request defaults distinguish missing bodies from JSON values without inventing credentials', () => {
  const read = jsonRequestInit({ timeoutMs: 1000 });
  assert.equal(read.method, 'GET'); assert.equal(read.body, undefined); assert.deepEqual(read.headers, {});
  assert.equal(Object.hasOwn(read, 'credentials'), false); assert.equal(Object.hasOwn(read, 'body'), false);
  for (const body of [null, false, 0, '', []]) {
    const init = jsonRequestInit({ method: 'POST', body, timeoutMs: 1000 });
    assert.deepEqual(JSON.parse(init.body), body); assert.equal(init.headers['Content-Type'], 'application/json');
  }
});
test('JSON request defaults impose the owning adapter deadline', async () => {
  const init = jsonRequestInit({ timeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(init.signal.aborted, true); assert.equal(init.signal.reason.name, 'TimeoutError');
});
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
