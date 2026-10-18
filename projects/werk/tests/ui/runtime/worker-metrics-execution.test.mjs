import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computed, ref, shallowRef } from 'vue';
import ts from 'typescript';
import { normalizeSource } from '../../helpers/source-text.mjs';
import { executionInterval, executionOutcomes, executionWindows, measuredDuration, reportedCost, reportedCount } from '../../../src/worker/webview/metrics-execution.ts';

const now = Date.parse('2026-10-18T12:30:00.000Z');

test('execution windows carry exact acceptance-time bounds and all retained has no lower bound', () => {
  assert.deepEqual(executionInterval('24h', now), { since: '2026-10-17T12:30:00.000Z', until: '2026-10-18T12:30:00.000Z' });
  assert.deepEqual(executionInterval('7d', now), { since: '2026-10-11T12:30:00.000Z', until: '2026-10-18T12:30:00.000Z' });
  assert.deepEqual(executionInterval('30d', now), { since: '2026-09-18T12:30:00.000Z', until: '2026-10-18T12:30:00.000Z' });
  assert.deepEqual(executionInterval('all', now), { until: '2026-10-18T12:30:00.000Z' });
});

test('outcome distribution preserves review and interruption states without treating them as completion', () => {
  const distribution = executionOutcomes({ total: 10, outcomes: { completed: 3, review: 2, waiting_input: 1, escalated: 1, failed: 1, cancelled: 1, interrupted: 1 } });
  assert.equal(distribution.length, 9);
  assert.deepEqual(distribution.map(({ key }) => key), ['completed', 'review', 'running', 'queued', 'waiting_input', 'escalated', 'failed', 'cancelled', 'interrupted']);
  assert.equal(distribution.find(item => item.key === 'completed').count, 3);
  assert.equal(distribution.find(item => item.key === 'review').percent, 20);
  assert.equal(distribution.find(item => item.key === 'waiting_input').label, 'Waiting for input');
  assert.equal(distribution.find(item => item.key === 'running').count, 0);
  assert.equal(distribution.reduce((total, item) => total + item.percent, 0), 100);
});

test('new backend outcomes remain visible and empty retained history never produces an invalid bar', () => {
  const distribution = executionOutcomes({ total: 4, outcomes: { completed: 1, future_status: 3 } });
  assert.deepEqual(distribution.at(-1), { key: 'future_status', label: 'future status', tone: 'neutral', count: 3, percent: 75 });
  assert.equal(distribution.reduce((total, item) => total + item.count, 0), 4);
  assert.ok(executionOutcomes({ total: 0, outcomes: {} }).every(item => item.percent === 0 && item.count === 0));
});

test('unreported usage remains distinct from measured zero tokens and cost', () => {
  assert.equal(reportedCount(null), 'Not reported');
  assert.equal(reportedCount(undefined), 'Not reported');
  assert.equal(reportedCount(0), '0');
  assert.equal(reportedCost(null), 'Not reported');
  assert.equal(reportedCost(undefined), 'Not reported');
  assert.notEqual(reportedCost(0), 'Not reported');
  assert.equal(reportedCost(0), new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(0));
});

test('execution durations distinguish no sample, subsecond work and readable long runs', () => {
  assert.equal(measuredDuration(null), 'Not measured');
  assert.equal(measuredDuration(0), '0 ms');
  assert.equal(measuredDuration(846), '846 ms');
  assert.equal(measuredDuration(31_000), '31 s');
  assert.equal(measuredDuration(90_000), '1 min 30 s');
  assert.equal(measuredDuration(3_690_000), '1 h 1 min');
});

async function panelFixture(request) {
  const source = normalizeSource(await readFile(new URL('../../../src/worker/webview/components/MetricsExecutionPanel.vue', import.meta.url), 'utf8'));
  const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  let read, sources;
  const ports = { computed, ref, executionInterval, executionOutcomes, executionWindows, measuredDuration, reportedCost, reportedCount, request,
    useWorkerSnapshot(callback, watched) {
      read = callback; sources = watched;
      return { data: shallowRef(null), error: ref(''), loading: ref(false), refreshing: ref(false), readAt: ref(''), now: ref(now), refresh: callback };
    },
  };
  const panel = new Function(...Object.keys(ports), ts.transpile(script, { target: ts.ScriptTarget.ES2022 }) + '\nreturn { window, data, analysis, usage, distribution, refreshing };')(...Object.values(ports));
  return { ...panel, read, sources };
}

test('execution reads freeze the selected filter and interval before awaiting their analysis', async t => {
  let current = now;
  t.mock.method(Date, 'now', () => current);
  const { promise, resolve } = Promise.withResolvers();
  const calls = [];
  const f = await panelFixture(async (path, method, body) => { calls.push({ path, method, body }); return promise; });
  assert.equal(f.window.value, '7d');
  const pending = f.read();
  f.window.value = '24h'; current += 60_000;
  assert.equal(f.sources[0](), '24h', 'filter changes are connected to snapshot invalidation');
  const result = { total: 10 }; resolve(result);
  const snapshot = await pending;
  assert.equal(snapshot.analysis, result);
  assert.equal(snapshot.window, '7d');
  assert.deepEqual(snapshot.interval, executionInterval('7d', now));
  assert.deepEqual(calls, [{ path: '/api/runs', method: 'POST', body: { action: 'analyze', ...executionInterval('7d', now) } }]);
  assert.equal(f.refreshing.value, false, 'read transport does not animate refresh controls');
});

test('input and output displays use their own reported totals without adding cache usage', async () => {
  const f = await panelFixture(async () => ({}));
  f.data.value = { analysis: { total: 2, outcomes: { completed: 2 }, consumption: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 30, providerReportedCostUsd: 0 } } };
  assert.equal(f.usage.value.inputTokens, 100);
  assert.equal(f.usage.value.outputTokens, 20);
  assert.equal(f.usage.value.providerReportedCostUsd, 0);
  assert.equal(f.distribution.value.find(item => item.key === 'completed').count, 2);
});
