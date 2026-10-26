import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowMetrics } from '../../src/worker/dist/worker/application/workflow-metrics.js';
import { workflowWeekStart, workflowMetricsWindow } from '../../src/worker/dist/worker/application/workflow-metrics-window.js';
import { workflowDistribution } from '../../src/worker/dist/worker/application/workflow-metric-evidence.js';
import { appendFeatureIntake } from '../../src/worker/dist/worker/application/feature-intake-measurement.js';
import { boundaryRequest, boundaryEvent, boundaryIntake } from './workflow-boundary-fixtures.mjs';
const since = '2026-12-28T00:00:00.000Z', until = '2027-01-11T00:00:00.000Z', captured = '2027-01-12T00:00:00.000Z';
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest[]} requests */
function evidence(requests, events = [], intake = []) { return { requests, events, intake, runs: [], completeRequestIds: requests.map(request => request.id) }; }
const stage = (report, id) => report.flow.stages.find(value => value.id === id);

test('completion windows include earlier submissions without changing the separate submitted cohort or leaking request content', () => {
  const request = boundaryRequest('earlier-submission', { completedAt: '2027-01-05T00:00:00.000Z' });
  const report = buildWorkflowMetrics(evidence([request]), { since, until }, captured);
  assert.equal(report.throughput.completed, 1); assert.equal(report.delivery.cohort.requests, 0); assert.equal(report.flow.wip, 0);
  assert.equal(report.timing.lead.samples, 1); assert.equal(report.timing.lead.p50Ms, 35 * 86400000); assert.equal(report.timing.cycle.p50Ms, 21 * 86400000);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
  for (const id of ['current_value', 'unrealized_value']) { const area = report.ebm.find(item => item.id === id); assert.equal(area.status, 'unmeasured'); assert.deepEqual(area.evidence, []); assert.ok(area.unavailable.length > 0); }
});

test('UTC Monday boundaries are independent of host timezone and count each endpoint in only its half-open week', () => {
  const previousTz = process.env.TZ; process.env.TZ = 'Pacific/Honolulu';
  try {
    assert.equal(new Date(workflowWeekStart(Date.parse('2027-01-04T02:00:00+02:00'))).toISOString(), '2027-01-04T00:00:00.000Z');
    assert.equal(new Date(workflowWeekStart(Date.parse('2027-01-03T23:59:59.999Z'))).toISOString(), '2026-12-28T00:00:00.000Z');
    const times = ['2026-12-27T23:59:59.999Z', since, '2027-01-03T23:59:59.999Z', '2027-01-04T02:00:00+02:00', '2027-01-10T23:59:59.999Z', until];
    const report = buildWorkflowMetrics(evidence(times.map((completedAt, index) => boundaryRequest('boundary-' + index, { completedAt }))), { since, until }, captured);
    assert.deepEqual(report.throughput.weeks, [
      { weekStart: since, weekEnd: '2027-01-04T00:00:00.000Z', completed: 2, partial: false },
      { weekStart: '2027-01-04T00:00:00.000Z', weekEnd: until, completed: 2, partial: false },
    ]); assert.equal(report.throughput.completed, 4); assert.equal(report.throughput.completeWeeks, 2); assert.equal(report.throughput.meanPerCompleteWeek, 2);
  } finally { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; }
});

test('partial calendar weeks are excluded from the complete-week mean even when they contain completions', () => {
  const input = evidence(['2026-12-31T00:00:00Z', '2027-01-05T00:00:00Z'].map((completedAt, index) => boundaryRequest('partial-' + index, { completedAt })));
  const report = buildWorkflowMetrics(input, { since: '2026-12-30T00:00:00Z', until }, captured);
  assert.deepEqual(report.throughput.weeks.map(week => week.partial), [true, false]); assert.equal(report.throughput.completed, 2); assert.equal(report.throughput.meanPerCompleteWeek, 1);
  const partialOnly = buildWorkflowMetrics(input, { since: '2026-12-30T00:00:00Z', until: '2027-01-06T00:00:00Z' }, captured);
  assert.equal(partialOnly.throughput.completeWeeks, 0); assert.equal(partialOnly.throughput.meanPerCompleteWeek, null);
});

test('acceptance and stale done lifecycle cannot hide pending integration or establish throughput', () => {
  const accepted = boundaryRequest('accepted-only'), stale = boundaryRequest('stale-done', { completedAt: 'not-a-date', updatedAt: '2027-01-05T00:00:00Z' }); stale.lifecycle = 'done';
  const report = buildWorkflowMetrics(evidence([accepted, stale]), { since, until }, captured);
  assert.equal(report.throughput.completed, 0); assert.equal(report.flow.wip, 2); assert.equal(stage(report, 'merge').wip, 2); assert.equal(report.coverage.unknownCompletionTimes, 1);
  assert.equal(report.coverage.closedWithoutIntegration, 0);
});

test('release policy requires published assets receipt; a merge/build or future publication remains visible as pending work', () => {
  const request = boundaryRequest('release-pending', { release: true, completedAt: '2027-01-12T02:00:00Z', updatedAt: '2027-01-12T02:00:00Z' });
  request.delivery.release.merge = { pullRequest: 1, headCommit: 'c'.repeat(40), mergeCommit: 'e'.repeat(40), url: 'https://github.com/example/project/pull/1', mergedAt: '2027-01-02T00:00:00Z' };
  request.delivery.release.build = { operationId: 'build-one', commit: 'e'.repeat(40), manifestDigest: 'a'.repeat(64), artifacts: [], builtAt: '2027-01-03T00:00:00Z' };
  const events = [boundaryEvent(request, 1, '2027-01-03T00:00:00Z', 'release_build_confirmed', 'done', 'in_progress')];
  const before = buildWorkflowMetrics(evidence([request], events), { since, until }, captured);
  assert.equal(before.throughput.completed, 0); assert.equal(before.flow.wip, 1); assert.equal(stage(before, 'publish').wip, 1);
  const after = buildWorkflowMetrics(evidence([request], events), { since, until: '2027-01-13T00:00:00Z' }, '2027-01-14T00:00:00Z'); assert.equal(after.throughput.completed, 1); assert.equal(after.flow.wip, 0);
});

test('unknown original submission and incomplete implementation history retain completion throughput without invented timing', () => {
  const request = boundaryRequest('old-history', { completedAt: '2027-01-05T00:00:00Z' }), intake = boundaryIntake(request, null);
  const report = buildWorkflowMetrics(evidence([request], [], [intake]), { since, until }, captured);
  assert.equal(report.throughput.completed, 1); assert.equal(report.coverage.unknownSubmissionTimes, 1); assert.equal(report.coverage.completeHistories, 0);
  assert.equal(report.timing.lead.samples, 0); assert.equal(report.timing.lead.unknown, 1); assert.equal(report.timing.cycle.samples, 0); assert.equal(report.timing.cycle.unknown, 1);
});

test('canonical retries and correlated intake count once, while different projects remain independently filterable', () => {
  const one = boundaryRequest('dedup-one', { completedAt: '2027-01-05T00:00:00Z' }), other = boundaryRequest('other-project', { completedAt: '2027-01-06T00:00:00Z', projectId: 'project-two' });
  one.deliveryHistory = [structuredClone(one.delivery)]; const intake = boundaryIntake(one, one.createdAt);
  const report = buildWorkflowMetrics(evidence([one, structuredClone(one), other], [], [intake, structuredClone(intake)]), { since, until, projectId: 'project-one' }, captured);
  assert.equal(report.throughput.completed, 1); assert.equal(report.coverage.canonicalRequests, 1); assert.equal(report.coverage.intakeOnly, 0); assert.deepEqual(report.projects, ['project-one', 'project-two']);
});

test('later running evidence supersedes a historical ready state even when legacy execution lacks a typed implementation step', () => {
  const request = boundaryRequest('legacy-running', { updatedAt: '2027-01-05T00:00:00Z' }); request.phase = 'running'; request.delivery.status = 'running'; request.delivery.steps = [];
  const events = [boundaryEvent(request, 1, '2027-01-04T00:00:00Z', 'gate_passed', 'ready', 'ready'), boundaryEvent(request, 2, '2027-01-05T00:00:00Z', 'execution_started', 'running', 'in_progress')];
  const report = buildWorkflowMetrics(evidence([request], events), { since, until }, captured);
  assert.equal(stage(report, 'production').wip, 1); assert.equal(stage(report, 'pre_production').wip, 0);
});

test('week limits admit exactly104 full UTC weeks, reject105 and clamp future observation windows', () => {
  const first = '2025-01-06T00:00:00Z';
  const valid = buildWorkflowMetrics(evidence([]), { since: first, until: '2027-01-04T00:00:00Z' }, captured); assert.equal(valid.throughput.weeks.length, 104); assert.equal(valid.throughput.completeWeeks, 104);
  assert.throws(() => workflowMetricsWindow({ since: first, until }, captured), /104 UTC week/);
  assert.equal(workflowMetricsWindow({ since, until: '2030-01-01T00:00:00Z' }, captured).until, Date.parse(captured));
  const empty = buildWorkflowMetrics(evidence([]), { since: until, until }, captured); assert.deepEqual(empty.throughput.weeks, []); assert.equal(empty.throughput.meanPerCompleteWeek, null);
});


test('canonical cycle time retains an older legacy implementation but excludes orchestration before typed work in a newer run', () => {
  const request = boundaryRequest('mixed-cycle', { completedAt: '2027-01-05T00:00:00Z' });
  const legacy = structuredClone(request.delivery); legacy.id = 'legacy-run'; legacy.startedAt = '2026-12-02T00:00:00Z'; legacy.finishedAt = '2026-12-10T00:00:00Z'; legacy.status = 'failed'; legacy.steps = []; delete legacy.localMerge;
  request.inputRevision = 2; request.delivery.inputRevision = 2; request.deliveryHistory = [legacy];
  const old = boundaryEvent(request, 1, '2026-12-05T00:00:00Z', 'execution_started', 'running', 'in_progress'); old.inputRevision = 1;
  const implicit = buildWorkflowMetrics(evidence([request], [old]), { since, until }, captured); assert.equal(implicit.timing.cycle.p50Ms, 31 * 86400000, 'Legacy events without run IDs still bind to their dated revision.');
  old.deliveryRunId = legacy.id;
  const report = buildWorkflowMetrics(evidence([request], [old]), { since, until }, captured);
  assert.equal(report.timing.cycle.p50Ms, 31 * 86400000);
  const modern = boundaryRequest('modern-cycle', { completedAt: '2027-01-05T00:00:00Z' }); modern.delivery.startedAt = '2026-12-11T00:00:00Z';
  const orchestration = boundaryEvent(modern, 1, '2026-12-12T00:00:00Z', 'execution_started', 'running', 'in_progress');
  const control = buildWorkflowMetrics(evidence([modern], [orchestration]), { since, until }, captured);
  assert.equal(control.timing.cycle.p50Ms, 21 * 86400000, 'The typed implementation start remains the modern run anchor.');
});

test('historical snapshots retain earlier intake while excluding a later canonical admission and its production activity', () => {
  const request = boundaryRequest('future-admission', { submittedAt: '2027-01-10T00:00:00Z', startedAt: '2027-01-10T00:00:00Z', updatedAt: '2027-01-10T00:00:00Z' }); request.phase = 'running'; request.delivery.status = 'running';
  const source = boundaryIntake(request, '2026-12-29T00:00:00Z');
  appendFeatureIntake(source, { inputRevision: 'first-revision', phase: 'readiness', blockers: [] }, '2026-12-29T00:00:00Z');
  const report = buildWorkflowMetrics(evidence([request], [], [source]), { since, until: '2026-12-30T00:00:00Z' }, captured);
  assert.equal(report.coverage.canonicalRequests, 0); assert.equal(report.coverage.intakeOnly, 1); assert.equal(report.flow.wip, 1); assert.equal(stage(report, 'intake').wip, 1); assert.equal(stage(report, 'production').wip, 0); assert.equal(report.throughput.completed, 0);
});


test('duration distributions sort observed samples, preserve zero and reject nonfinite or negative timing', () => {
  assert.deepEqual(workflowDistribution([400, 0, null, 100, 300, 200, NaN, -1, Infinity]), { samples: 5, unknown: 4, p50Ms: 200, p95Ms: 400, totalMs: 1000 });
  assert.deepEqual(workflowDistribution([null, NaN, -1]), { samples: 0, unknown: 3, p50Ms: null, p95Ms: null, totalMs: null });
});

test('default observation bounds include the latest104 UTC buckets and refuse each invalid endpoint independently', () => {
  const report = buildWorkflowMetrics(evidence([]), {}, captured);
  assert.equal(report.window.since, '2025-01-20T00:00:00.000Z'); assert.equal(report.window.until, captured); assert.equal(report.throughput.weeks.length, 104); assert.equal(report.throughput.completeWeeks, 103);
  assert.equal(report.window.basis, 'confirmed_completion_time'); assert.equal(report.window.bounds, '[since,until)'); assert.equal(report.flow.basis, 'observation_snapshot_all_submission_dates'); assert.equal(report.flow.asOf, captured); assert.equal(report.throughput.unit, 'confirmed_increments');
  /** @type {[import('../../src/worker/application/workflow-metrics-contracts.ts').WorkflowMetricsQuery, string][]} */
  const invalid = [[{}, 'invalid'], [{ since: 'invalid' }, captured], [{ until: 'invalid' }, captured], [{ since: until, until: since }, captured]];
  for (const [query, capture] of invalid) assert.throws(() => workflowMetricsWindow(query, capture), { code: 'invalid_input' });
  assert.deepEqual(buildWorkflowMetrics(evidence([]), { since: '2027-01-05T01:00:00Z', until: '2027-01-05T01:00:00Z' }, captured).throughput.weeks, []);
});

test('profile selection includes correlated intake fallbacks and reports available options independently of filtering', () => {
  const feature = boundaryRequest('profile-feature', { completedAt: '2027-01-05T00:00:00Z' }), light = boundaryRequest('profile-light', { completedAt: '2027-01-06T00:00:00Z', profileId: 'lightweight' });
  const fallback = boundaryRequest('profile-fallback', { completedAt: '2027-01-07T00:00:00Z' }), source = boundaryIntake(fallback, fallback.createdAt); fallback.input.context = {};
  const input = evidence([light, feature, fallback], [], [source]);
  const selected = buildWorkflowMetrics(input, { since, until, profileId: 'feature' }, captured);
  assert.equal(selected.throughput.completed, 2); assert.equal(selected.coverage.canonicalRequests, 2); assert.equal(selected.coverage.intakeOnly, 0); assert.deepEqual(selected.profiles, ['feature', 'lightweight']); assert.equal(selected.window.profileId, 'feature');
  assert.equal(buildWorkflowMetrics(input, { since, until, profileId: 'lightweight' }, captured).throughput.completed, 1);
  const available = buildWorkflowMetrics({ ...input, availableProjects: ['z', 'a', 'z'], availableProfiles: ['z', 'a', 'z'] }, { since, until }, captured);
  assert.deepEqual(available.projects, ['a', 'z']); assert.deepEqual(available.profiles, ['a', 'z']);
});

test('unknown blocker coverage stays distinct from an observed clear stage and an active recorded blocker', () => {
  const unknown = boundaryRequest('blocker-unknown'), clear = boundaryRequest('blocker-clear'), blocked = boundaryRequest('blocker-recorded');
  for (const request of [unknown, clear, blocked]) { request.phase = 'ready'; request.lifecycle = 'ready'; request.delivery.steps = []; }
  const clearEvent = boundaryEvent(clear, 1, '2027-01-04T00:00:00Z', 'gate_passed', 'ready', 'ready');
  const blockedEvent = boundaryEvent(blocked, 1, '2027-01-04T00:00:00Z', 'gate_blocked', 'ready', 'ready'); blockedEvent.measurement.blockers = [{ code: 'dependency', category: 'dependency' }];
  const report = buildWorkflowMetrics(evidence([unknown, clear, blocked], [clearEvent, blockedEvent]), { since, until }, captured);
  assert.equal(report.flow.wip, 3); assert.equal(report.flow.blocked, 1); assert.equal(report.flow.blockedUnknown, 1);
  const pre = stage(report, 'pre_production'); assert.equal(pre.wip, 3); assert.equal(pre.blocked, 1); assert.equal(pre.blockedUnknown, 1); assert.equal(pre.age.samples, 2); assert.equal(pre.age.unknown, 1); assert.equal(pre.oldestAgeMs, 7 * 86400000);
});

test('each active durable hold blocks current work without inventing a blocker for future mutable evidence', () => {
  const statuses = /** @type {const} */ (['paused', 'failed', 'interrupted', 'outcome_unknown']);
  /** @type {((request: import('../../src/worker/application/request-gates.ts').WorkerRequest) => void)[]} */
  const variants = [request => { request.recoveryHold = { code: 'test', at: '2027-01-04T00:00:00Z' }; }, request => { request.deliveryHolds = [{ code: 'source', reason: 'Private source' }]; }, request => { request.delivery.holds = [{ code: 'source', reason: 'Private run' }]; }, request => { request.delivery.control = { action: 'pause_after_step', operationId: 'operator-control', at: '2027-01-04T00:00:00Z' }; }, ...statuses.map(status => request => { request.delivery.status = status; })];
  for (const [index, change] of variants.entries()) {
    const request = boundaryRequest('hold-' + index); request.phase = 'running'; change(request);
    const report = buildWorkflowMetrics(evidence([request]), { since, until }, captured); assert.equal(report.flow.blocked, 1); assert.equal(stage(report, 'production').blocked, 1); assert.equal(report.flow.blockedUnknown, 0); assert.doesNotMatch(JSON.stringify(report), /Private/);
    request.updatedAt = '2027-01-13T00:00:00Z'; const past = buildWorkflowMetrics(evidence([request]), { since, until }, captured); assert.equal(past.flow.blocked, 0); assert.equal(past.flow.unknownState, 1);
  }
});

test('release stage pressure advances only with observed merge and build receipts, with ages measured from their timestamps', () => {
  const merge = boundaryRequest('stage-merge', { release: true }), build = boundaryRequest('stage-build', { release: true }), publish = boundaryRequest('stage-publish', { release: true });
  const mergeReceipt = { pullRequest: 1, headCommit: 'c'.repeat(40), mergeCommit: 'e'.repeat(40), url: 'https://github.com/example/project/pull/1', mergedAt: '2027-01-02T00:00:00Z' };
  build.delivery.release = { operations: [], merge: mergeReceipt }; publish.delivery.release = { operations: [], merge: mergeReceipt, build: { operationId: 'build-one', commit: 'e'.repeat(40), manifestDigest: 'a'.repeat(64), artifacts: [], builtAt: '2027-01-03T00:00:00Z' } };
  const report = buildWorkflowMetrics(evidence([merge, build, publish]), { since, until }, captured);
  assert.equal(report.throughput.completed, 0); assert.equal(report.flow.wip, 3); assert.equal(stage(report, 'merge').wip, 1); assert.equal(stage(report, 'merge').age.unknown, 1);
  assert.equal(stage(report, 'build').wip, 1); assert.equal(stage(report, 'build').age.p50Ms, 9 * 86400000); assert.equal(stage(report, 'publish').wip, 1); assert.equal(stage(report, 'publish').age.p50Ms, 8 * 86400000);
});

test('retained complete zero-observation histories differ from unavailable failure and rework history', () => {
  const complete = boundaryRequest('zero-known'), partial = boundaryRequest('zero-unknown');
  const input = evidence([complete, partial]); input.completeRequestIds = [complete.id];
  const report = buildWorkflowMetrics(input, { since, until }, captured);
  for (const metric of [report.rework, report.failures]) assert.deepEqual(metric, { requests: 0, observations: 0, measuredRequests: 1, unknownRequests: 1 });
});


test('integration receipts require literal valid commit identities and cannot predate their retained execution', () => {
  const input = evidence(['short', 'C'.repeat(40), 'c'.repeat(39), 'c'.repeat(41)].map((commit, index) => {
    const request = boundaryRequest('invalid-receipt-' + index, { completedAt: '2027-01-05T00:00:00Z' }); request.delivery.localMerge.merged.mergeCommit = commit; return request;
  }));
  const early = boundaryRequest('receipt-before-run', { completedAt: '2026-12-14T23:59:59Z' }); input.requests.push(early); input.completeRequestIds.push(early.id);
  const invalid = buildWorkflowMetrics(input, { since, until }, captured); assert.equal(invalid.throughput.completed, 0); assert.equal(invalid.flow.wip, 5); assert.equal(invalid.coverage.unknownCompletionTimes, 5);
  const valid = boundaryRequest('sha256-receipt', { submittedAt: since, startedAt: since, completedAt: since }); valid.delivery.localMerge.merged.mergeCommit = 'a'.repeat(64);
  const measured = buildWorkflowMetrics(evidence([valid]), { since, until }, captured); assert.equal(measured.throughput.completed, 1); assert.equal(measured.timing.lead.p50Ms, 0); assert.equal(measured.timing.cycle.p50Ms, 0); assert.equal(measured.coverage.unknownCompletionTimes, 0);
});


test('every observed delivery phase enters its documented workflow stage with age from that phase start', () => {
  const cases = /** @type {const} */ ([['assessing', 'pre_production'], ['planning', 'pre_production'], ['preparing', 'pre_production'], ['implementing', 'production'], ['repairing', 'production'], ['verifying', 'post_production'], ['packaging', 'post_production']]);
  for (const [phase, expected] of cases) {
    const request = boundaryRequest('phase-' + phase); request.phase = 'running'; request.delivery.phase = phase; request.delivery.steps = [{ ...request.delivery.steps[0], phase, startedAt: '2027-01-04T00:00:00Z' }];
    const report = buildWorkflowMetrics(evidence([request]), { since, until }, captured);
    assert.equal(report.flow.wip, 1); assert.equal(stage(report, expected).wip, 1); assert.equal(stage(report, expected).age.p50Ms, 7 * 86400000); assert.equal(stage(report, expected).age.unknown, 0);
    assert.equal(report.flow.stages.filter(value => value.wip > 0).length, 1);
  }
});

test('stage pressure reports the oldest known age independently of its median and missing anchors', () => {
  const younger = boundaryRequest('age-younger'), older = boundaryRequest('age-older'), unknown = boundaryRequest('age-unknown');
  for (const request of [younger, older]) { request.phase = 'running'; request.delivery.steps = [{ ...request.delivery.steps[0], phase: 'planning', startedAt: request === older ? '2027-01-02T00:00:00Z' : '2027-01-04T00:00:00Z' }]; }
  unknown.phase = 'ready'; unknown.delivery.steps = [];
  const report = buildWorkflowMetrics(evidence([younger, older, unknown]), { since, until }, captured), pre = stage(report, 'pre_production');
  assert.equal(pre.wip, 3); assert.deepEqual(pre.age, { samples: 2, unknown: 1, p50Ms: 7 * 86400000, p95Ms: 9 * 86400000, totalMs: 16 * 86400000 }); assert.equal(pre.oldestAgeMs, 9 * 86400000); assert.equal(stage(report, 'publish').oldestAgeMs, null);
});

test('retained canonical integration counts once at its earliest confirmed receipt rather than its latest attempt', () => {
  const request = boundaryRequest('earliest-receipt', { completedAt: '2027-01-06T00:00:00Z' }), previous = structuredClone(request.delivery);
  previous.id = 'earlier-integrated-run'; previous.localMerge.merged.mergedAt = '2026-12-30T00:00:00Z'; request.deliveryHistory = [previous];
  const report = buildWorkflowMetrics(evidence([request]), { since, until }, captured);
  assert.equal(report.throughput.completed, 1); assert.deepEqual(report.throughput.weeks.map(week => week.completed), [1, 0]); assert.equal(report.timing.lead.p50Ms, 29 * 86400000); assert.equal(report.timing.cycle.p50Ms, 15 * 86400000);
});

test('failure and rework observations respect half-open event boundaries and deduplicate a failed step across journal and run evidence', () => {
  const request = boundaryRequest('observation-window'); request.updatedAt = until;
  const events = [boundaryEvent(request, 1, since, 'execution_failed', 'running', 'in_progress'), boundaryEvent(request, 2, '2027-01-10T23:59:59Z', 'review_failed', 'review', 'in_review'), boundaryEvent(request, 3, '2027-01-05T00:00:00Z', 'delivery_step_failed', 'running', 'in_progress'), boundaryEvent(request, 4, '2026-12-27T23:59:59Z', 'review_failed', 'review', 'in_review'), boundaryEvent(request, 5, until, 'execution_failed', 'running', 'in_progress'), boundaryEvent(request, 6, since, 'review_changes_requested', 'review', 'in_review'), boundaryEvent(request, 7, until, 'review_changes_requested', 'review', 'in_review')];
  events[2].deliveryRunId = request.delivery.id; events[2].deliveryStepId = 'failed-check';
  request.delivery.steps.push({ ...request.delivery.steps[0], id: 'failed-check', phase: 'verifying', status: 'failed', startedAt: '2027-01-04T00:00:00Z', finishedAt: '2027-01-05T00:00:00Z' }, { ...request.delivery.steps[0], id: 'repair-inside', phase: 'repairing', startedAt: '2027-01-10T23:59:59Z' }, { ...request.delivery.steps[0], id: 'repair-outside', phase: 'repairing', startedAt: until });
  const report = buildWorkflowMetrics(evidence([request], [...events, events[1]]), { since, until }, captured);
  assert.deepEqual(report.failures, { requests: 1, observations: 3, measuredRequests: 1, unknownRequests: 0 }); assert.deepEqual(report.rework, { requests: 1, observations: 2, measuredRequests: 1, unknownRequests: 0 });
});
