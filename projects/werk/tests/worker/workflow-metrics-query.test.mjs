import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowMetrics } from '../../src/worker/dist/worker/status/workspace-workflow-metrics.js';
import { deliveryMetricQuery, readDeliveryMetricEvidence } from '../../src/worker/dist/worker/status/workspace-delivery-metric-evidence.js';
import { buildWorkflowMetrics } from '../../src/worker/dist/worker/application/workflow-metrics.js';
import { workflowRequest as request } from './workflow-metrics-fixture.mjs';

const now = '2026-10-26T12:00:00.000Z';
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest[]} [requests] @param {import('../../src/worker/application/request-gates.ts').RequestEvent[]} [events] */
function workspace(requests = [], events = []) {
  const calls = { pages: [], events: [], runs: 0 };
  const gates = {
    list({ after = 0, limit = 100 } = {}) { calls.pages.push(after); const rows = requests.slice(after, after + limit); return { requests: rows, hasMore: after + rows.length < requests.length, nextAfter: after + rows.length }; },
    get(id) { const value = requests.find(request => request.id === id); assert.ok(value); return value; },
    events(id, after = 0, limit = 100) { calls.events.push([id, after]); const selected = events.filter(event => event.requestId === id && event.sequence > after), batch = selected.slice(0, limit); return { events: batch, hasMore: selected.length > limit, nextAfter: batch.at(-1)?.sequence ?? after }; },
  };
  const value = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({ sessions: { requests: gates, runs: { list() { calls.runs++; return { rows: [], nextCursor: null }; } } }, featureProjects: { all: () => [] } }));
  return { value, calls, gates };
}

function invalid(operation) { assert.throws(operation, error => error instanceof Error && 'code' in error && error.code === 'invalid_input'); }

test('workflow query normalizes offsets and rejects undocumented actions, malformed dates and unbounded windows before reading history', () => {
  assert.deepEqual(deliveryMetricQuery({ action: 'workflow_metrics', since: '2026-10-19T02:00:00+02:00', until: '2026-10-26T00:00:00Z', projectId: 'project-one' }, 'workflow_metrics', now),
    { since: '2026-10-19T00:00:00.000Z', until: '2026-10-26T00:00:00.000Z', projectId: 'project-one' });
  for (const body of [{ action: 'metrics' }, { action: 'workflow_metrics', since: '2026-10-19' }, { action: 'workflow_metrics', until: 'not-a-date' }, { action: 'workflow_metrics', projectId: [] }, { action: 'workflow_metrics', unknown: true }, { action: 'workflow_metrics', since: '2026-10-26T00:00:00Z', until: '2026-10-19T00:00:00Z' }]) invalid(() => deliveryMetricQuery(body, 'workflow_metrics', now));
  const f = workspace(); f.gates.list = () => { throw Error('Window refusal must precede evidence collection.'); };
  invalid(() => workflowMetrics(f.value, { action: 'workflow_metrics', since: '0001-01-01T00:00:00Z' }));
  const empty = workflowMetrics(workspace().value, { action: 'workflow_metrics' });
  assert.equal(empty.throughput.weeks.length, 104); assert.equal(empty.throughput.completed, 0); assert.equal(empty.flow.wip, 0);
  assert.equal(empty.window.until, empty.capturedAt); assert.equal(empty.window.bounds, '[since,until)');
});

test('one paginated aggregate keeps older submissions in WIP while the embedded submitted cohort stays filtered', () => {
  const requests = Array.from({ length: 101 }, (_, index) => request('other-' + index, 'other-project'));
  const selected = request(); requests.push(selected);
  const events = Array.from({ length: 102 }, (_, index) => ({ schemaVersion: /** @type {const} */ (1), id: 'event-' + index, requestId: selected.id, revision: index + 1, inputRevision: 1, sequence: index + 1,
    type: 'ready_observed', phase: /** @type {const} */ ('ready'), at: '2026-10-20T00:00:00.000Z', measurement: { projectId: 'project-one', profileId: 'feature', lifecycle: /** @type {const} */ ('ready'), blockers: [] } }));
  const f = workspace(requests, events), query = { projectId: 'project-one', since: '2026-10-19T00:00:00.000Z', until: '2026-10-26T00:00:00.000Z' };
  const evidence = readDeliveryMetricEvidence(f.value, query, now, false), report = buildWorkflowMetrics(evidence, query, now);
  assert.deepEqual(f.calls.pages, [0, 100]); assert.deepEqual(f.calls.events, [[selected.id, 0], [selected.id, 100]]); assert.equal(f.calls.runs, 1);
  assert.equal(report.coverage.canonicalRequests, 1); assert.equal(report.flow.wip, 1); assert.equal(report.flow.stages.find(stage => stage.id === 'pre_production').wip, 1);
  assert.equal(report.delivery.cohort.requests, 0, 'Submitted-within quality is not used as a completion or current-WIP cohort.');
  assert.deepEqual(report.projects, ['other-project', 'project-one']); assert.doesNotMatch(JSON.stringify(report), /Private requested outcome|Private instructions/);
  const legacy = readDeliveryMetricEvidence(workspace(requests).value, query, now); assert.equal(legacy.requests.length, 0, 'Existing delivery metrics preserve their submission filter.');
});

test('the evidence reader refuses stalled cursors and the aggregate limit instead of reporting partial denominators', () => {
  const f = workspace(); f.gates.list = () => ({ requests: [], hasMore: true, nextAfter: 0 });
  assert.throws(() => readDeliveryMetricEvidence(f.value, {}, now, false), error => error instanceof Error && 'code' in error && error.code === 'conflict');
  const large = Array.from({ length: 5 }, (_, index) => { const value = request('large-' + index); value.input.message = 'x'.repeat(14 * 1024 * 1024); return value; });
  const bounded = workspace(large);
  assert.throws(() => readDeliveryMetricEvidence(bounded.value, {}, now, false), error => error instanceof Error && 'code' in error && error.code === 'conflict' && /64 MiB/.test(error.message));
  assert.equal(bounded.calls.runs, 0);
});
