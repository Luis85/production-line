import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowMetrics } from '../../src/worker/dist/worker/application/workflow-metrics.js';
import { workflowRequest, workflowRun, workflowStep, workflowEvent } from './workflow-metrics-fixture.mjs';
const at = hour => '2026-10-19T' + String(hour).padStart(2, '0') + ':00:00.000Z';
const receipt = at => ({ mergeCommit: 'a'.repeat(40), tree: 'b'.repeat(40), previousHead: 'c'.repeat(40), candidateCommit: 'd'.repeat(40), branch: 'main', mergedAt: at });

/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request
 * @param {import('../../src/worker/application/request-gates.ts').RequestEvent[]} [events] @param {boolean} [complete] */
function evidence(request, events = [], complete = true) { return { requests: [request], events, runs: [], completeRequestIds: complete ? [request.id] : [] }; }

test('stage pressure uses contiguous observed stages while repair/failure evidence is deduplicated independently of attempts', () => {
  const request = workflowRequest(), run = workflowRun(request); request.delivery = run; request.phase = 'review'; request.lifecycle = 'in_review'; request.updatedAt = at(8);
  run.steps = [workflowStep('plan', 'planning', at(1)), workflowStep('prepare', 'preparing', at(2)), workflowStep('implement', 'implementing', at(3)), workflowStep('repair', 'repairing', at(4)), workflowStep('check', 'verifying', at(5), '2026-10-19T05:30:00.000Z', 'failed'), workflowStep('package', 'packaging', at(6))];
  const events = [workflowEvent(request, 1, 'execution_started', at(1), 'running'), workflowEvent(request, 2, 'delivery_step_failed', '2026-10-19T05:30:00.000Z', 'running', { deliveryRunId: run.id, deliveryStepId: 'check' }),
    workflowEvent(request, 3, 'delivery_review_packaged', at(7), 'review'), workflowEvent(request, 4, 'review_changes_requested', '2026-10-19T07:30:00.000Z', 'review')];
  const report = buildWorkflowMetrics(evidence(request, [...events, events[1]]), { since: at(0), until: at(8) }, at(10));
  const review = report.flow.stages.find(stage => stage.id === 'review');
  assert.equal(report.flow.wip, 1); assert.equal(review.wip, 1); assert.equal(review.age.p50Ms, 3600000); assert.equal(review.oldestAgeMs, 3600000);
  assert.deepEqual(report.rework, { requests: 1, observations: 2, measuredRequests: 1, unknownRequests: 0 });
  assert.deepEqual(report.failures, { requests: 1, observations: 1, measuredRequests: 1, unknownRequests: 0 });
  assert.equal(report.throughput.completed, 0);
});

test('missing historical state does not borrow future holds or mutable terminal status', () => {
  const request = workflowRequest(), run = workflowRun(request); request.delivery = run; request.updatedAt = at(10); request.phase = 'done'; request.lifecycle = 'done';
  run.holds = [{ code: 'source', reason: 'Future private source hold' }]; run.localMerge = { operations: [], merged: receipt(at(10)) };
  const report = buildWorkflowMetrics(evidence(request, [], false), { since: at(0), until: at(5) }, at(12));
  assert.equal(report.flow.unknownState, 1); assert.equal(report.flow.wip, 0); assert.equal(report.flow.blocked, 0); assert.equal(report.throughput.completed, 0);
  assert.doesNotMatch(JSON.stringify(report), /Future private/);
});

test('a done lifecycle cannot hide a required integration with missing or malformed completion evidence', () => {
  for (const merged of [undefined, receipt('invalid-time')]) {
    const request = workflowRequest(), run = workflowRun(request); request.delivery = run; request.updatedAt = at(3); request.phase = 'done'; request.lifecycle = 'done'; run.localMerge = { operations: [], ...(merged ? { merged } : {}) };
    const report = buildWorkflowMetrics(evidence(request), { since: at(0), until: at(5) }, at(12));
    assert.equal(report.flow.wip, 1); assert.equal(report.flow.stages.find(stage => stage.id === 'merge').wip, 1); assert.equal(report.throughput.completed, 0); assert.equal(report.coverage.closedWithoutIntegration, 0);
    assert.equal(report.coverage.unknownCompletionTimes, merged ? 1 : 0);
  }
});

test('cycle time prefers implementation over earlier orchestration and stays unknown for incomplete retained history', () => {
  const request = workflowRequest(), run = workflowRun(request); request.delivery = run; request.createdAt = at(0); request.updatedAt = at(8); request.phase = 'done'; request.lifecycle = 'done';
  run.steps = [workflowStep('plan', 'planning', at(1)), workflowStep('implement', 'implementing', at(3))]; run.localMerge = { operations: [], merged: receipt(at(7)) };
  const events = [workflowEvent(request, 1, 'execution_started', at(1), 'running')];
  const measured = buildWorkflowMetrics(evidence(request, events), { since: at(0), until: at(8) }, at(12));
  assert.equal(measured.timing.lead.p50Ms, 7 * 3600000); assert.equal(measured.timing.cycle.p50Ms, 4 * 3600000);
  const partial = buildWorkflowMetrics(evidence(request, events, false), { since: at(0), until: at(8) }, at(12));
  assert.equal(partial.throughput.completed, 1); assert.equal(partial.timing.cycle.samples, 0); assert.equal(partial.timing.cycle.unknown, 1); assert.equal(partial.timing.lead.samples, 1);
});

test('EBM value areas remain unmeasured and sample coverage cannot be mistaken for business outcomes', () => {
  const report = buildWorkflowMetrics({ requests: [], events: [], runs: [], completeRequestIds: [] }, { since: at(0), until: at(8) }, at(12));
  assert.deepEqual(report.ebm.filter(area => area.status === 'unmeasured').map(area => area.id), ['current_value', 'unrealized_value']);
  assert.deepEqual(report.ebm.filter(area => area.status === 'operational_proxy').map(area => area.id), ['time_to_market', 'ability_to_innovate']);
  assert.equal(report.timing.lead.p50Ms, null); assert.equal(report.timing.cycle.p95Ms, null); assert.equal(report.throughput.meanPerCompleteWeek, null);
  assert.ok(report.notes.some(note => /not proof that retained history is exhaustive/.test(note)));
});


test('a typed implementation start wins same-millisecond readiness timestamps without losing its observed stage age', () => {
  const request = workflowRequest(), run = workflowRun(request); request.delivery = run; request.phase = 'running'; request.lifecycle = 'in_progress'; request.updatedAt = at(3);
  run.phase = 'implementing'; run.steps = [workflowStep('implement', 'implementing', at(2), at(3), 'running')];
  const events = [workflowEvent(request, 1, 'gate_passed', at(2), 'ready'), workflowEvent(request, 2, 'execution_started', at(2), 'running', { deliveryRunId: run.id })];
  const report = buildWorkflowMetrics(evidence(request, events), { since: at(0), until: at(4) }, at(12));
  const production = report.flow.stages.find(stage => stage.id === 'production'); assert.equal(production.wip, 1); assert.equal(production.age.p50Ms, 2 * 3600000);
});


test('a new legacy execution enters production even when an older retained run has typed steps', () => {
  for (const explicitRun of [false, true]) {
    const request = workflowRequest(), previous = workflowRun(request), current = workflowRun(request);
    previous.id = 'previous-run'; previous.status = 'completed'; previous.finishedAt = at(4);
    previous.steps = [workflowStep('previous-implementation', 'implementing', at(1), at(3))];
    current.id = 'current-legacy-run'; current.startedAt = at(6); current.steps = [];
    request.deliveryHistory = [previous]; request.delivery = current; request.phase = 'running'; request.lifecycle = 'in_progress'; request.updatedAt = at(6);
    const events = [workflowEvent(request, 1, 'delivery_review_packaged', at(4), 'review', { deliveryRunId: previous.id }),
      workflowEvent(request, 2, 'execution_started', at(6), 'running', explicitRun ? { deliveryRunId: current.id } : {})];
    const report = buildWorkflowMetrics(evidence(request, events), { since: at(0), until: at(8) }, at(10));
    const production = report.flow.stages.find(stage => stage.id === 'production'), review = report.flow.stages.find(stage => stage.id === 'review');
    assert.equal(production.wip, 1); assert.equal(production.age.p50Ms, 2 * 3600000); assert.equal(production.oldestAgeMs, 2 * 3600000);
    assert.equal(review.wip, 0); assert.equal(report.flow.wip, 1); assert.equal(report.flow.unknownState, 0);
  }
});
