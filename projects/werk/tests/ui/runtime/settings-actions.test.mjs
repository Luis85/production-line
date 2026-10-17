import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, freshFrontend } from '../helpers/frontend-loader.mjs';

const settings = ({ queueCapacity = 16, maxRuntimeMs = 7200000, allowance = 1000 } = {}) => ({
  board: { maxParallel: 1, queueCapacity, orchestratorQueue: 2, order: 'fifo', paused: false },
  execution: { maxRuntimeMs }, executionSource: 'saved_settings',
  resources: { longRunningMs: 3600000 },
  consumption: { enabled: true, period: 'daily', allowance, workerPercent: 50, perRunReservation: 100 },
});
const queue = value => { const { queueCapacity, orchestratorQueue, order } = value.board; return { queueCapacity, orchestratorQueue, order }; };
async function workspace() {
  const store = await freshFrontend('src/worker/webview/store.ts');
  store.state.unlocked = true;
  // Keep the background read in progress: its refresh cannot mask a stale write acknowledgement.
  store.state.loading = true;
  store.state.settings = settings();
  return store;
}

test('a delayed consumption acknowledgement preserves the newer queue snapshot and its own saved policy', async t => {
  const { state, consumptionAction, guardedSettingsAction } = await workspace();
  const baseline = settings(), older = settings({ allowance: 2000 }), newer = settings({ allowance: 2000, queueCapacity: 24 });
  const pending = deferred(), commands = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    assert.equal(path, '/api/settings'); assert.equal(init.method, 'POST');
    const command = JSON.parse(init.body); commands.push(command);
    return command.consumption ? pending.promise : Response.json(newer);
  });
  const first = consumptionAction({ consumption: older.consumption, expectedConsumption: baseline.consumption });
  const latest = await guardedSettingsAction({ board: queue(newer), expectedBoard: queue(older) });
  assert.deepEqual(latest, newer);
  assert.deepEqual(state.settings, newer);
  pending.resolve(Response.json(older));
  assert.deepEqual(await first, older.consumption, 'the consumption editor still receives its successful save');
  assert.deepEqual(state.settings, newer, 'the older full settings response cannot replace the later queue acknowledgement');
  assert.equal(commands.length, 2);
});

test('a delayed queue acknowledgement preserves the newer duration snapshot and its own saved values', async t => {
  const { state, guardedSettingsAction } = await workspace();
  const baseline = settings(), older = settings({ queueCapacity: 24 }), newer = settings({ queueCapacity: 24, maxRuntimeMs: 10800000 });
  const pending = deferred(), commands = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    assert.equal(path, '/api/settings'); assert.equal(init.method, 'POST');
    const command = JSON.parse(init.body); commands.push(command);
    return command.board ? pending.promise : Response.json(newer);
  });
  const first = guardedSettingsAction({ board: queue(older), expectedBoard: queue(baseline) });
  const latest = await guardedSettingsAction({
    execution: { maxRuntimeMs: newer.execution.maxRuntimeMs }, resources: newer.resources,
    expectedDuration: { maxRuntimeMs: older.execution.maxRuntimeMs, longRunningMs: older.resources.longRunningMs },
  });
  assert.deepEqual(latest, newer);
  assert.deepEqual(state.settings, newer);
  pending.resolve(Response.json(older));
  assert.deepEqual(await first, older, 'the queue editor still receives its successful save');
  assert.deepEqual(state.settings, newer, 'the older full settings response cannot replace the later duration acknowledgement');
  assert.equal(commands.length, 2);
});
