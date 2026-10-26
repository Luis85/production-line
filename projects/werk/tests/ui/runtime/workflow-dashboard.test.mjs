import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { workflowQuery, workflowDuration, workflowUtcDate, visibleWorkflowWeeks, workflowMeasures, workflowEbmIndicators } = await frontend('src/worker/webview/workflow-dashboard.ts');
const { workerLinks } = await frontend('src/worker/webview/worker-navigation.ts');
const { buildWorkflowMetrics } = await frontend('src/worker/application/workflow-metrics.ts');
const at = '2026-10-26T00:30:00.000Z';
function emptyReport() { return buildWorkflowMetrics({ requests: [], events: [], runs: [], completeRequestIds: [] }, { since: '2026-09-28T00:30:00.000Z', until: at }, at); }

test('workflow query scopes confirmed completions with explicit UTC bounds and preserves the server-bounded long window', () => {
  const now = Date.parse(at), query = workflowQuery('28d', 'portal', now);
  assert.deepEqual(query, { since: '2026-09-28T00:30:00.000Z', until: at, projectId: 'portal' });
  assert.equal(Date.parse(workflowQuery('7d', '', now).since), now - 7 * 86_400_000);
  assert.equal(Date.parse(workflowQuery('90d', '', now).since), now - 90 * 86_400_000);
  assert.deepEqual(workflowQuery('104w', '', now), { until: at }, 'recent104 weeks uses the bounded default instead of an all-time or105-bin query');
});

test('workflow timestamps stay in UTC when the worker operator uses a different timezone', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.match(workflowUtcDate(at), /Oct 26/);
    assert.doesNotMatch(workflowUtcDate(at), /Oct 25/);
    assert.match(new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), /Oct 25/, 'the test actually crosses a local date boundary');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('chart projection preserves every original week and bounds the visible view to the latest12', () => {
  const weeks = Array.from({ length: 14 }, (_, index) => ({ weekStart: new Date(Date.parse(at) + index * 7 * 86_400_000).toISOString(), weekEnd: new Date(Date.parse(at) + (index + 1) * 7 * 86_400_000).toISOString(), completed: index, partial: index === 13 }));
  const before = structuredClone(weeks), visible = visibleWorkflowWeeks(weeks);
  assert.equal(visible.length, 12); assert.equal(visible[0].completed, 2); assert.equal(visible.at(-1).completed, 13); assert.equal(visible.at(-1).partial, true);
  assert.deepEqual(weeks, before); assert.equal(weeks.length, 14, 'the accessible table still receives every week');
});

test('unknown timing and unaudited zero observations remain unmeasured while recorded zeros stay explicit', () => {
  const report = emptyReport(); report.rework.unknownRequests = 2; report.timing.lead.unknown = 2;
  let measures = workflowMeasures(report);
  assert.equal(measures.find(row => row.id === 'completed').value, '0');
  assert.equal(measures.find(row => row.id === 'rework').value, 'Unmeasured');
  assert.equal(measures.find(row => row.id === 'lead').value, 'Unmeasured / Unmeasured');
  assert.equal(measures.find(row => row.id === 'lead').coverage, '0 measured · 2 unknown');
  report.rework.measuredRequests = 3; report.rework.unknownRequests = 0; measures = workflowMeasures(report);
  assert.equal(measures.find(row => row.id === 'rework').value, '0 recorded');
  report.rework.measuredRequests = 0; report.rework.observations = 2;
  assert.equal(workflowMeasures(report).find(row => row.id === 'rework').value, '2 recorded', 'positive retained observations do not disappear because history is incomplete');
});

test('velocity coverage describes temporal buckets and does not claim exhaustive history', () => {
  const report = emptyReport(); report.throughput.completeWeeks = 3; report.throughput.meanPerCompleteWeek = 2.5;
  const metric = workflowMeasures(report).find(row => row.id === 'velocity');
  assert.equal(metric.value, '2.5 / week'); assert.equal(metric.coverage, '3 whole UTC weeks in window'); assert.match(metric.definition, /no story points or forecast/);
  assert.equal(workflowDuration(null), 'Unmeasured'); assert.equal(workflowDuration(0), '0 ms'); assert.equal(workflowDuration(86_400_000), '1 day');
});

test('production and isolated shell navigation expose a dedicated Workflow destination without replacing resource Metrics', () => {
  assert.deepEqual(workerLinks.map(item => item.path), ['/taskboard', '/workflow', '/dashboard', '/history', '/settings']);
  assert.equal(workerLinks.find(item => item.path === '/workflow').label, 'Workflow'); assert.equal(workerLinks.find(item => item.path === '/dashboard').label, 'Metrics');
});


test('EBM exposes operational samples without creating customer or business outcome scores', () => {
  const report = emptyReport(); report.timing.lead.unknown = 3;
  assert.deepEqual(workflowEbmIndicators(report, 'current_value'), []);
  assert.deepEqual(workflowEbmIndicators(report, 'unrealized_value'), []);
  const lead = workflowEbmIndicators(report, 'time_to_market').find(row => row.label === 'Lead time · p50');
  assert.equal(lead.value, 'Unmeasured'); assert.equal(lead.coverage, '0 measured · 3 unknown');
  assert.match(workflowEbmIndicators(report, 'ability_to_innovate')[0].value, /requests/);
});
