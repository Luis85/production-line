import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFrontend, deferred } from '../ui/helpers/frontend-loader.mjs';

async function fixture(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = await freshFrontend('src/worker/webview/store.ts');
  const payloads = { '/status': { state: 'standalone' }, '/api/environment': { capturedAt: 'environment-sample' }, '/api/consumption': { accountingAvailable: true, measuredTokens: 0 }, '/api/chat/session': { sessions: { selected: '', records: [] }, chat: {} }, '/api/definitions': { definitions: [] } };
  store.state.unlocked = true;
  globalThis.fetch = async path => Response.json(payloads[path] ?? {});
  return { ...store, payloads };
}

test('metrics freshness follows each source independently and failed reads retain its previous values', async t => {
  const f = await fixture(t); await f.refresh();
  for (const source of ['status', 'environment', 'consumption']) { assert.ok(f.state[source + 'ReadAt']); assert.equal(f.state[source + 'Error'], ''); }
  f.state.statusReadAt = 'previous-status'; f.state.environmentReadAt = 'previous-environment'; f.state.consumptionReadAt = 'previous-consumption';
  globalThis.fetch = async path => path === '/api/environment' || path === '/api/consumption' ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(f.payloads[path] ?? {});
  await f.refresh();
  assert.notEqual(f.state.statusReadAt, 'previous-status'); assert.equal(f.state.statusError, '');
  assert.equal(f.state.environmentReadAt, 'previous-environment'); assert.match(f.state.environmentError, /could not be refreshed/);
  assert.equal(f.state.consumptionReadAt, 'previous-consumption'); assert.match(f.state.consumptionError, /could not be refreshed/);
  assert.equal(f.state.environment.capturedAt, 'environment-sample'); assert.equal(f.state.consumption.measuredTokens, 0);
  globalThis.fetch = async path => path === '/status' ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(f.payloads[path] ?? {});
  const statusReadAt = f.state.statusReadAt; await f.refresh();
  assert.equal(f.state.statusReadAt, statusReadAt); assert.match(f.state.statusError, /could not be refreshed/); assert.equal(f.state.error, f.state.statusError);
  assert.notEqual(f.state.environmentReadAt, 'previous-environment'); assert.equal(f.state.environmentError, '');
  assert.notEqual(f.state.consumptionReadAt, 'previous-consumption'); assert.equal(f.state.consumptionError, '');
});

test('lock clears metric source metadata and delayed refresh cannot restore it', async t => {
  const f = await fixture(t); await f.refresh();
  const pending = deferred();
  globalThis.fetch = async path => path === '/api/access' ? Response.json({}) : pending.promise;
  const refresh = f.refresh(); await f.lock();
  for (const source of ['status', 'environment', 'consumption']) { assert.equal(f.state[source + 'ReadAt'], ''); assert.equal(f.state[source + 'Error'], ''); }
  pending.resolve(Response.json({ private: 'late' })); await refresh;
  assert.equal(f.state.environment, null); assert.equal(f.state.consumption, null);
  for (const source of ['status', 'environment', 'consumption']) assert.equal(f.state[source + 'ReadAt'], '');
});


test('a slow unrelated endpoint cannot make earlier metric measurements appear newly read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T12:00:00.000Z') });
  const f = await fixture(t), held = deferred();
  globalThis.fetch = async path => path === '/api/history' ? held.promise : Response.json(f.payloads[path] ?? {});
  const refresh = f.refresh();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(9000); held.resolve(Response.json({ rows: [] })); await refresh;
  for (const source of ['status', 'environment', 'consumption']) assert.equal(f.state[source + 'ReadAt'], '2026-10-18T12:00:00.000Z');
  assert.equal(f.state.lastRead, '2026-10-18T12:00:09.000Z');
});
