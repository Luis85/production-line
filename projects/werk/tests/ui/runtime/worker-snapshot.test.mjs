import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { deferred } from '../helpers/frontend-loader.mjs';

// Run the actual composable with Vue reactivity and controlled lifecycle/clock boundaries.
async function fixture(t, read) {
  const source = await readFile(new URL('../../../src/worker/webview/useWorkerSnapshot.ts', import.meta.url), 'utf8');
  const state = vue.reactive({ unlocked: true, refreshRevision: 0, paused: false });
  const query = vue.ref('today'), observedRevision = vue.ref(1), hooks = { mounted: [], activated: [], deactivated: [], unmounted: [] };
  /** @type {Set<() => void>} */
  const timers = new Set();
  let time = Date.parse('2026-10-18T12:00:00.000Z');
  class Clock extends Date { static now() { return time; } }
  const ports = { ...vue, onMounted: callback => hooks.mounted.push(callback), onActivated: callback => hooks.activated.push(callback), onDeactivated: callback => hooks.deactivated.push(callback), onUnmounted: callback => hooks.unmounted.push(callback) };
  const exports = /** @type {typeof import('../../../src/worker/webview/useWorkerSnapshot.ts')} */ ({});
  new Function('require', 'exports', 'Date', 'setInterval', 'clearInterval', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(
    name => name === 'vue' ? ports : { state }, exports, Clock,
    callback => { timers.add(callback); return callback; }, timer => timers.delete(timer),
  );
  const scope = vue.effectScope();
  const snapshot = scope.run(() => exports.useWorkerSnapshot(() => read(query.value), [query], [observedRevision]));
  const trigger = event => hooks[event].forEach(callback => callback());
  t.after(() => { trigger('unmounted'); scope.stop(); });
  trigger('mounted'); trigger('activated');
  await vue.nextTick();
  return { ...snapshot, state, query, observedRevision, trigger, timers, tick: (ms = 1000) => { time += ms; for (const callback of timers) callback(); } };
}
async function settle() { await vue.nextTick(); await vue.nextTick(); }
async function poll(f) { f.state.refreshRevision++; await settle(); }

test('background reads retain values without explicit progress and newer manual refresh wins', async t => {
  const background = deferred(), manual = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { version: 'saved' } : calls === 2 ? background.promise : manual.promise);
  assert.equal(calls, 1, 'mounted and activated do not duplicate the first request');
  await poll(f);
  assert.equal(f.loading.value, true); assert.equal(f.refreshing.value, false);
  assert.equal(f.data.value.version, 'saved');
  const refresh = f.refresh(); assert.equal(f.refreshing.value, true);
  await f.refresh(); assert.equal(calls, 3, 'duplicate deliberate refresh is suppressed');
  manual.resolve({ version: 'newer' }); await refresh;
  background.resolve({ version: 'older' }); await settle();
  assert.equal(f.data.value.version, 'newer'); assert.equal(f.loading.value, false); assert.equal(f.refreshing.value, false);
});

test('query changes synchronously clear incompatible values and fence older reads', async t => {
  const background = deferred(), changed = deferred(); let calls = 0; const queries = [];
  const f = await fixture(t, async query => { queries.push(query); return ++calls === 1 ? { period: query } : calls === 2 ? background.promise : changed.promise; });
  await poll(f); f.query.value = 'week';
  assert.equal(f.data.value, null); assert.equal(f.readAt.value, ''); assert.equal(f.error.value, '');
  assert.deepEqual(queries, ['today', 'today', 'week']);
  background.resolve({ period: 'today' }); await settle(); assert.equal(f.data.value, null);
  changed.resolve({ period: 'week' }); await settle();
  assert.equal(f.data.value.period, 'week'); assert.ok(f.readAt.value);
});

test('failed reads preserve values and their age while a retry keeps the warning visible', async t => {
  const retry = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { value: 0 } : calls === 2 ? Promise.reject(Error('Measurement unavailable')) : retry.promise);
  const readAt = f.readAt.value;
  f.tick(5000); await poll(f);
  assert.equal(f.data.value.value, 0); assert.equal(f.readAt.value, readAt); assert.match(f.error.value, /Measurement unavailable/);
  await poll(f); assert.match(f.error.value, /Measurement unavailable/); assert.equal(f.refreshing.value, false);
  retry.resolve({ value: 7 }); await settle();
  assert.equal(f.error.value, ''); assert.equal(f.data.value.value, 7); assert.notEqual(f.readAt.value, readAt);
});

test('locking clears private snapshots and fences a response even after a rapid unlock', async t => {
  const beforeLock = deferred(), afterUnlock = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { private: 'saved' } : calls === 2 ? beforeLock.promise : afterUnlock.promise);
  await poll(f); f.state.unlocked = false;
  assert.equal(f.data.value, null); assert.equal(f.readAt.value, ''); assert.equal(f.error.value, ''); assert.equal(f.timers.size, 0);
  f.state.unlocked = true; beforeLock.resolve({ private: 'old access' }); await settle();
  assert.equal(f.data.value, null);
  afterUnlock.resolve({ private: 'new access' }); await settle(); assert.equal(f.data.value.private, 'new access');
});

test('deactivation suppresses late reads and KeepAlive re-entry requests current data', async t => {
  const beforeLeave = deferred(), afterReturn = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { value: 'saved' } : calls === 2 ? beforeLeave.promise : afterReturn.promise);
  await poll(f); f.trigger('deactivated');
  beforeLeave.resolve({ value: 'late' }); await settle();
  assert.equal(f.data.value.value, 'saved'); assert.equal(f.timers.size, 0);
  await poll(f); await f.refresh(); assert.equal(calls, 2, 'inactive pages do not start requests');
  f.trigger('activated'); assert.equal(calls, 3); assert.equal(f.refreshing.value, false);
  afterReturn.resolve({ value: 'current' }); await settle(); assert.equal(f.data.value.value, 'current');
});

test('unmount clears private data and cannot be reactivated or repopulated', async t => {
  const pending = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { secret: 'saved' } : pending.promise);
  const refresh = f.refresh(); f.trigger('unmounted');
  pending.resolve({ secret: 'late' }); await refresh;
  f.trigger('activated'); await poll(f);
  assert.equal(f.data.value, null); assert.equal(f.readAt.value, ''); assert.equal(f.loading.value, false); assert.equal(f.refreshing.value, false);
  assert.equal(calls, 2); assert.equal(f.timers.size, 0);
});

test('freshness clock continues while polling is paused and stops while inactive', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ({ count: ++calls }));
  const readAt = f.readAt.value; f.state.paused = true;
  const stale = vue.computed(() => f.now.value - Date.parse(f.readAt.value) > 15000);
  assert.equal(stale.value, false); f.tick(16000);
  assert.equal(stale.value, true); assert.equal(f.readAt.value, readAt); assert.equal(calls, 1);
  f.trigger('deactivated'); const stopped = f.now.value; f.tick(10000); assert.equal(f.now.value, stopped);
});

test('a locked component never reads until unlocked and inactive query changes stay private', async t => {
  const f = await fixture(t, async query => ({ query }));
  f.state.unlocked = false; f.trigger('deactivated'); f.query.value = 'month';
  assert.equal(f.data.value, null); f.trigger('activated'); assert.equal(f.loading.value, false);
  f.state.unlocked = true; await settle(); assert.equal(f.data.value.query, 'month');
});


test('same-subject revisions retain history but invalidate decision freshness and fence older reads', async t => {
  const older = deferred(), newer = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { receipt: 'retained' } : calls === 2 ? older.promise : newer.promise);
  const retained = f.data.value;
  await poll(f);
  f.observedRevision.value++;
  assert.equal(calls, 3);
  assert.equal(f.data.value, retained, 'same-subject history stays mounted during revalidation');
  assert.equal(f.readAt.value, '', 'old policy availability cannot authorize a new revision');
  assert.equal(f.refreshing.value, false, 'background changes never claim a manual refresh');
  older.resolve({ receipt: 'outdated' }); await settle();
  assert.equal(f.data.value, retained); assert.equal(f.readAt.value, '');
  newer.resolve({ receipt: 'current' }); await settle();
  assert.equal(f.data.value.receipt, 'current'); assert.ok(f.readAt.value);
});

test('failed same-subject revalidation retains readable history until explicit recovery', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { receipt: 'retained' } : calls === 2 ? Promise.reject(Error('Policy unavailable')) : { receipt: 'confirmed' });
  f.observedRevision.value++; await settle();
  assert.equal(f.data.value.receipt, 'retained'); assert.equal(f.readAt.value, '');
  assert.match(f.error.value, /Policy unavailable/);
  await f.refresh();
  assert.equal(f.data.value.receipt, 'confirmed'); assert.ok(f.readAt.value); assert.equal(f.error.value, '');
});

test('identity and access changes still clear history while same-subject revalidation is pending', async t => {
  const changed = deferred(), switched = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { receipt: 'private' } : calls === 2 ? changed.promise : switched.promise);
  f.observedRevision.value++; f.query.value = 'another-request';
  assert.equal(f.data.value, null);
  changed.resolve({ receipt: 'old-request' }); await settle(); assert.equal(f.data.value, null);
  f.state.unlocked = false;
  switched.resolve({ receipt: 'after-lock' }); await settle(); assert.equal(f.data.value, null); assert.equal(f.readAt.value, '');
});


test('a revision supersedes pending manual refresh and keeps decisions stale until its own response', async t => {
  const manual = deferred(), revised = deferred(); let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? { receipt: 'saved' } : calls === 2 ? manual.promise : revised.promise);
  const refresh = f.refresh(); assert.equal(f.refreshing.value, true);
  f.observedRevision.value++;
  assert.equal(calls, 3); assert.equal(f.refreshing.value, false); assert.equal(f.readAt.value, '');
  manual.resolve({ receipt: 'old-manual' }); await refresh;
  assert.equal(f.data.value.receipt, 'saved'); assert.equal(f.readAt.value, ''); assert.equal(f.loading.value, true);
  revised.resolve({ receipt: 'new-revision' }); await settle();
  assert.equal(f.data.value.receipt, 'new-revision'); assert.ok(f.readAt.value); assert.equal(f.loading.value, false);
});
