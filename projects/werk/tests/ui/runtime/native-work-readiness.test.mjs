import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { buildWorkerCapacityView } = await frontend('src/worker/webview/worker-capacity.ts');
const { nativeWorkReadiness } = await frontend('src/worker/webview/native-work-readiness.ts');
/** @returns {import('../../../src/worker/application/worker-capacity.js').WorkerCapacitySnapshot} */
function capacity() {
  return { schemaVersion: 1, capturedAt: '2026-10-20T12:00:00.000Z', execution: { limit: 1, inUse: 0, sessionId: null }, local: { limit: 4, used: 0, remaining: 4, overLimit: false }, remote: { waiting: 0, running: 0, accepted: 0, extraQueuePlaces: 0 }, starts: { paused: false, consumption: { blocked: false, reason: 'disabled' } } };
}
test('native startup blocks starts while preserving measured durable admission and ready compatibility', () => {
  const value = capacity(), available = buildWorkerCapacityView(value);
  for (const state of /** @type {const} */ (['preparing', 'starting'])) {
    const view = buildWorkerCapacityView(value, 'fresh', { state, message: null });
    assert.equal(view.startBlocked, true); assert.equal(view.admissionAvailable, true);
    assert.equal(view.state, 'blocked'); assert.doesNotMatch(view.description, /Waiting work can start/);
    assert.match(view.nativeWorkMessage, /Saved requests remain queued/);
    assert.equal(view.executionLabel, available.executionLabel);
    assert.equal(value.starts.paused, false, 'startup is not a saved manual pause');
  }
  assert.deepEqual(buildWorkerCapacityView(value, 'fresh', { state: 'ready', message: null }), available);
  assert.equal(nativeWorkReadiness(undefined), null);
});
test('native readiness preserves saved pause, blocked consumption and unknown capacity', () => {
  const pending = /** @type {const} */ ({ state: 'starting', message: 'Checking repositories.' });
  const value = capacity(); value.starts.paused = true;
  value.starts.consumption = { blocked: true, reason: 'exhausted' };
  const paused = buildWorkerCapacityView(value, 'fresh', pending);
  assert.equal(paused.state, 'paused'); assert.match(paused.description, /manual pause/); assert.match(paused.description, /exhausted/);
  assert.match(paused.nativeWorkMessage, /Queue pause and consumption limits still apply/);
  const ready = buildWorkerCapacityView(value, 'fresh', { state: 'ready', message: null });
  assert.equal(ready.state, 'paused'); assert.equal(ready.startBlocked, true); assert.equal(ready.nativeWorkMessage, undefined);
  const stale = buildWorkerCapacityView(value, 'stale', pending);
  assert.equal(stale.state, 'unknown'); assert.equal(stale.admissionAvailable, null); assert.match(stale.executionLabel, /Last reported/);
  assert.equal(buildWorkerCapacityView(null, 'unknown', pending).admissionAvailable, null);
});
