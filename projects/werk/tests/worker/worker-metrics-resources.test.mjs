import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { resourceMetrics, resourceSampleState, measurementStale } = await frontend('src/worker/webview/metrics-resources.ts');

/** @returns {import('../../src/worker/application/resources').ResourceStatus} */
function report() {
  return {
    schemaVersion: 1, sampleIntervalMs: 10000,
    policy: { memoryPercent: 85, heapPercent: 90, cpuPercent: 90, cpuSustainMs: 30000, diskFreeBytes: 256, diskFreePercent: 5, longRunningMs: 3600000 },
    snapshot: { processId: 7, processStartId: 'worker-a', capturedAt: '2026-10-18T12:00:00Z', scope: 'worker_node_process', cpuCapacityBasis: 'available_parallelism', rssBytes: 250, heapUsedBytes: 40, heapLimitBytes: 100, effectiveMemoryLimitBytes: 1000, availableMemoryBytes: 500, cpuCapacityCores: 4, cpuCores: 1, cpuPercent: 25, diskAvailableBytes: 2000, diskTotalBytes: 10000, unavailable: [], active: null },
    alerts: [], persistenceError: false, sampleError: false, sampleErrorReason: null,
  };
}

test('resource comparisons use worker capacity and available volume space with correct warning boundaries', () => {
  const rows = resourceMetrics(report());
  assert.deepEqual(rows.map(row => [row.id, row.percent, row.thresholdPercent]), [
    ['cpu', 25, 90], ['memory', 25, 85], ['heap', 40, 90], ['disk', 20, 5],
  ]);
  const smallVolume = report(); smallVolume.snapshot.diskTotalBytes = 1000;
  assert.equal(resourceMetrics(smallVolume).at(-1).thresholdPercent, 25.6, 'absolute free-space threshold can be stricter than percentage');
});

test('missing samples and missing denominators remain unknown while measured zero remains zero', () => {
  assert.ok(resourceMetrics(null).every(metric => metric.value === null && metric.percent === null));
  const unavailable = report();
  unavailable.snapshot.cpuPercent = null; unavailable.snapshot.cpuCores = null;
  unavailable.snapshot.effectiveMemoryLimitBytes = null; unavailable.snapshot.diskTotalBytes = 0;
  unavailable.snapshot.heapUsedBytes = 0;
  const [cpu, memory, heap, disk] = resourceMetrics(unavailable);
  assert.equal(cpu.value, null); assert.equal(cpu.percent, null);
  assert.equal(memory.value, 250); assert.equal(memory.percent, null);
  assert.equal(heap.percent, 0); assert.equal(disk.percent, null); assert.equal(disk.thresholdPercent, null);
});

test('over-limit measurements remain factual and CPU pressure is not inferred to be sustained', () => {
  const over = report(); over.snapshot.cpuPercent = 120; over.snapshot.rssBytes = 1500;
  let rows = resourceMetrics(over);
  assert.equal(rows[0].percent, 120); assert.equal(rows[1].percent, 150);
  assert.equal(rows[0].warning, false, 'crossing CPU threshold alone does not prove sustained pressure');
  over.alerts.push({ id: 'cpu-alert', code: 'cpu', severity: 'warning', openedAt: over.snapshot.capturedAt, observed: 120, threshold: 90 });
  rows = resourceMetrics(over); assert.equal(rows[0].warning, true); assert.equal(rows[1].warning, false);
});

test('sample freshness ages independently from HTTP reads and respects sampler cadence', () => {
  const value = report(), captured = Date.parse(value.snapshot.capturedAt);
  assert.equal(resourceSampleState(value, captured + 30000, false, '').label, 'Current sample');
  assert.equal(resourceSampleState(value, captured + 30001, false, '').label, 'Last reported sample');
  value.sampleIntervalMs = 20000;
  assert.equal(resourceSampleState(value, captured + 60000, false, '').stale, false);
  assert.equal(resourceSampleState(value, captured + 60001, false, '').stale, true);
  assert.equal(measurementStale('invalid', 10000, captured), true);
});

test('paused, partial and failed refreshes explain retained values without a healthy claim', () => {
  const value = report(), captured = Date.parse(value.snapshot.capturedAt);
  assert.match(resourceSampleState(value, captured, true, '').message, /paused/);
  value.sampleError = true;
  assert.equal(resourceSampleState(value, captured, false, '').stale, true);
  assert.match(resourceSampleState(value, captured, false, '').message, /Some measurements/);
  assert.match(resourceSampleState(value, captured, false, 'offline').message, /could not be refreshed/);
  assert.equal(resourceSampleState(null, captured, false, '').label, 'No sample yet');
});

async function alertPanel(t, props, request) {
  const source = await readFile(new URL('../../src/worker/webview/components/ResourceMonitorPanel.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  const state = reactive({ unlocked: true, refreshRevision: 0, sessions: null });
  const scope = effectScope(); t.after(() => scope.stop());
  const ports = { ref, computed, watch, state, request, defineProps: () => props, onMounted() {}, onActivated() {}, onDeactivated() {}, useRouter: () => ({ push: async () => {} }), workspaceAction: async () => true };
  const panel = scope.run(() => new Function(...Object.keys(ports), ts.transpile(script, { target: ts.ScriptTarget.ES2022 }) + '\nreturn { report, load, loadEvents, events };')(...Object.values(ports)));
  return { ...panel, state };
}

test('nested alert disclosure never duplicates resource GET reads, including parent loading', async t => {
  const calls = [];
  const props = reactive({ resourceReport: null, alertsOnly: true });
  const panel = await alertPanel(t, props, async (path, method) => { calls.push(method ?? 'GET'); return { events: [], nextAfter: 0, hasMore: false, gap: false }; });
  await panel.load(); panel.state.refreshRevision++; await nextTick();
  assert.deepEqual(calls, []);
  props.resourceReport = report(); await panel.load();
  assert.equal(panel.report.value.snapshot.cpuPercent, 25);
  await panel.loadEvents(); assert.deepEqual(calls, ['POST'], 'history is fetched only on demand');
});

test('standalone alert consumers retain their own resource reading and clear after access expiry', async t => {
  const panel = await alertPanel(t, { compact: true }, async () => report());
  await panel.load(); assert.equal(panel.report.value.snapshot.cpuPercent, 25);
  panel.state.unlocked = false; await nextTick(); assert.equal(panel.report.value, null);
});
