import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { buildDeliveryMetrics } = await frontend('src/worker/application/delivery-metrics.ts');
const { deliveryMetricCards } = await frontend('src/worker/webview/metrics-delivery.ts');
const { deliveryEventMeasurement } = await frontend('src/worker/application/delivery-event-measurement.ts');
const { defaultGatePolicy } = await frontend('src/worker/application/request-gates.ts');
const { observeFeatureIntake, appendFeatureIntake } = await frontend('src/worker/application/feature-intake-measurement.ts');
const { featureRequestReference } = await frontend('src/worker/application/feature-request-reference.ts');
const at = seconds => new Date(Date.UTC(2026, 9, 20, 12, 0, seconds)).toISOString();
/** @returns {import('../../../src/worker/application/request-gates').WorkerRequest} */
function request(id = 'fr') {
  return { schemaVersion: 1, policy: defaultGatePolicy(), id, owner: { sessionId: id + '-session', rootTurnId: 'turn' }, revision: 1, inputRevision: 1, input: { kind: 'patch', title: id, message: 'Implement the accepted request', context: { repositoryId: 'project', deliveryPolicy: { profile: { id: 'feature' } }, implementation: { schemaVersion: 1, mode: 'worktree', baseCommit: 'base', approvedPaths: ['src/'], checks: [{ id: 'unit', name: 'Unit tests', fingerprint: 'unit-v1' }] } } }, inputHash: 'input', policyDigest: 'policy', provider: { id: 'claude-cli', model: '', instruction: '' }, phase: 'review', lifecycle: 'in_review', assignee: 'operator', createdAt: at(0), updatedAt: at(30), reworkCount: 0, evaluations: [], findings: [], candidates: [], reviews: [], execution: null, attestation: null,
    delivery: { schemaVersion: 1, id: id + '-delivery', inputRevision: 1, inputHash: 'input', policyDigest: 'policy', profile: { schemaVersion: 1, id: 'behavior', version: 1, root: { id: 'wait', type: 'action', action: 'wait', reason: 'Wait' } }, profileDigest: 'behavior', status: 'completed', phase: 'packaging', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2, startedAt: at(0), finishedAt: at(30), steps: [], decision: { profileId: 'behavior', profileVersion: 1, selectedNode: 'wait', selectedAction: 'wait', reason: 'Wait', waitingFor: null, conditions: [] }, allowedControls: [] } };
}
/** @param {number} sequence @param {string} type @param {number} seconds @param {Partial<import('../../../src/worker/application/request-gates').RequestEvent>} [extra]
 * @returns {import('../../../src/worker/application/request-gates').RequestEvent} */
function event(sequence, type, seconds, extra = {}) {
  const phase = extra.phase ?? (type === 'delivery_review_packaged' ? 'review' : type === 'operator_attested' ? 'done' : 'running');
  return { schemaVersion: 1, id: 'event-' + sequence, sequence, requestId: 'fr', revision: sequence, inputRevision: 1, type, phase, at: at(seconds), measurement: { projectId: 'project', profileId: 'feature', lifecycle: phase === 'review' ? 'in_review' : phase === 'done' ? 'done' : phase === 'cancelled' ? 'cancelled' : 'in_progress', blockers: [] }, ...extra };
}
/** @param {number} sequence @param {number} seconds @param {import('../../../src/worker/application/delivery-metrics-contracts').DeliveryMetricObservation[]} observations */
const observation = (sequence, seconds, observations) => event(sequence, 'observation', seconds, { measurement: { projectId: 'project', profileId: 'feature', lifecycle: observations.some(item => ['review_effort', 'human_review_failure'].includes(item.kind)) ? 'in_review' : 'in_progress', blockers: [], observations } });
/** @returns {import('../../../src/worker/application/run-evidence').WorkerRun} */
function invocation() { return { schemaVersion: 1, id: 'call', sequence: 1, attempt: 1, requestId: 'fr', sessionId: 'fr-session', taskId: 'task', kind: 'local', title: 'Work', provider: 'claude-cli', model: 'saved', outcome: 'completed', acceptedAt: at(1), startedAt: at(2), before: null, after: { measurement: 'execution_boundary', capturedAt: at(25), state: 'completed', resources: { scope: 'worker_process', processInstanceId: 'process', rssBytes: 0, heapUsedBytes: 0, cpuUserMicros: 0, cpuSystemMicros: 0, uptimeSeconds: 0 }, consumption: { runs: 1, reportedRuns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, providerReportedCostUsd: null, coverage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, providerReportedCostUsd: 0 } } }, durationMs: 23000, queueDurationMs: 1000, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, providerReportedCostUsd: null, source: 'provider_reported', reason: null, costBasis: 'unavailable' }, resourceDelta: { scope: 'worker_process_between_snapshots', cpuUserMicros: null, cpuSystemMicros: null } }; }

test('nine metrics remain unavailable when evidence is absent rather than inventing zero success, review time or billing', () => {
  const value = request(), report = buildDeliveryMetrics({ requests: [value], events: [], runs: [], completeRequestIds: [] }, {}, at(60));
  assert.equal(report.autonomousReview.percent, null); assert.equal(report.firstFeedback.p95Ms, null);
  assert.equal(report.review.effort.p50Ms, null); assert.equal(report.recovery.percent, null);
  assert.equal(report.integrity.unknownRequests, 1); assert.equal(report.blockerCoverage.unknownRequests, 1);
  assert.equal(report.consumption.meanTokens, null); assert.equal(report.consumption.costUsd, null);
  const cards = deliveryMetricCards(report); assert.equal(cards.length, 9);
  for (const id of ['MET-01', 'MET-02', 'MET-03', 'MET-05', 'MET-06', 'MET-07', 'MET-08', 'MET-09']) assert.equal(cards.find(card => card.id === id).value, 'Unavailable');
});
test('canonical request metrics keep clarification, orchestration, review and incidents distinct with explicit coverage', () => {
  const value = request(); value.lifecycle = 'done'; value.phase = 'done';
  value.delivery.steps = [verificationStep('check1', 'first', 'failed', 10, 15), verificationStep('check2', 'second', 'completed', 20, 25)];
  const events = [event(1, 'gate_held', 5), observation(2, 8, [{ kind: 'clarification', questionId: 'q1', cycleId: 'cycle1', cause: 'scope' }]), event(3, 'delivery_review_packaged', 30), observation(4, 35, [{ kind: 'review_effort', durationMs: 120000, source: 'user_reported' }, { kind: 'human_review_failure', candidateDigest: 'second', criterionId: 'human:1' }, { kind: 'clarification_answer', questionId: 'q1', cycleId: 'cycle1', cause: 'scope' }]), event(5, 'review_changes_requested', 36), observation(6, 40, [{ kind: 'recovery', operationId: 'stop', outcome: 'known', duplicateActions: false }, { kind: 'integrity_audit', auditId: 'audit', scope: 'release_acceptance', incidentIds: [] }]), event(7, 'operator_attested', 50, { phase: 'done' })];
  const report = buildDeliveryMetrics({ requests: [value], events: [...events, events[1]], runs: [invocation()], completeRequestIds: ['fr'] }, {}, at(60));
  assert.equal(report.cohort.requests, 1); assert.equal(report.autonomousReview.percent, 100);
  assert.equal(report.firstFeedback.p95Ms, 5000); assert.equal(report.firstFeedback.providerPortion.p95Ms, 3000);
  assert.equal(report.clarification.cycles, 1); assert.equal(report.clarification.completedCycles, 1); assert.deepEqual(report.clarification.groups, [{ profileId: 'feature', cause: 'scope', cycles: 1, completedCycles: 1, pendingCycles: 0, unknownCycles: 0 }]);
  assert.equal(report.verification.firstPass.percent, 0); assert.equal(report.verification.eventualPass.percent, 100); assert.equal(report.verification.humanFailures, 1);
  assert.equal(report.review.effort.p50Ms, 120000); assert.equal(report.review.changesRequested.percent, 100);
  assert.equal(report.recovery.percent, 100); assert.equal(report.integrity.incidents, 0); assert.equal(report.integrity.releaseAudits, 1);
  assert.equal(report.consumption.meanTokens, 15); assert.equal(report.consumption.costUsd, null);
});
test('manual retry before review prevents autonomous attribution and filters do not merge projects', () => {
  const one = request(), two = request('second'); two.input.context = { repositoryId: 'other', deliveryPolicy: { profile: { id: 'lightweight' } } };
  const report = buildDeliveryMetrics({ requests: [one, two], events: [event(1, 'delivery_retry', 10), event(2, 'delivery_review_packaged', 20)], runs: [], completeRequestIds: ['fr'] }, { projectId: 'project', profileId: 'feature' }, at(60));
  assert.equal(report.cohort.requests, 1); assert.equal(report.autonomousReview.numerator, 0); assert.equal(report.autonomousReview.denominator, 1);
  assert.deepEqual(report.projects, ['other', 'project']); assert.deepEqual(report.profiles, ['feature', 'lightweight']);
  assert.equal(buildDeliveryMetrics({ requests: [one], events: [], runs: [], completeRequestIds: [] }, { since: at(1) }, at(60)).cohort.requests, 0);
  assert.throws(() => buildDeliveryMetrics({ requests: [], events: [], runs: [], completeRequestIds: [] }, { since: at(61) }, at(60)), /valid.*window/);
});
test('blocker intervals coalesce repeated snapshots and distinguish concurrent causes from elapsed time', () => {
  const blocked = (sequence, seconds, categories) => event(sequence, 'delivery_held', seconds, { measurement: { projectId: 'project', profileId: 'feature', lifecycle: 'in_progress', blockers: categories.map(category => ({ code: category, category })) } });
  const report = buildDeliveryMetrics({ requests: [request()], events: [blocked(1, 5, ['provider']), blocked(2, 8, ['provider']), blocked(3, 10, ['provider', 'budget']), blocked(4, 20, ['budget'])], runs: [], completeRequestIds: ['fr'] }, {}, at(30));
  assert.deepEqual(report.blockers, [{ category: 'provider', waits: 1, totalMs: 15000, active: 0 }, { category: 'budget', waits: 1, totalMs: 20000, active: 1 }]);
});
test('partial usage and delegated calls never manufacture complete accepted-request averages', () => {
  const call = invocation(), child = { ...invocation(), id: 'child', parentRunId: 'call', parentSessionId: 'fr-session', delegationId: 'agent' };
  const report = buildDeliveryMetrics({ requests: [request()], events: [event(1, 'operator_attested', 40, { phase: 'done' })], runs: [call, child, call], completeRequestIds: ['fr'] }, {}, at(60));
  assert.equal(report.consumption.inputTokens, 10); assert.equal(report.consumption.outputTokens, 5);
  assert.equal(report.consumption.measuredRequests, 0); assert.equal(report.consumption.partialRequests, 1); assert.equal(report.consumption.meanTokens, null);
});
test('historical windows exclude later feedback, acceptance and observations', () => {
  const report = buildDeliveryMetrics({ requests: [request()], events: [event(1, 'delivery_review_packaged', 30), event(2, 'operator_attested', 40, { phase: 'done' })], runs: [invocation()], completeRequestIds: ['fr'] }, { until: at(20) }, at(60));
  assert.equal(report.autonomousReview.percent, null); assert.equal(report.autonomousReview.unknown, 1); assert.equal(report.consumption.acceptedRequests, 0);
  assert.equal(report.review.effort.samples, 0);
});

/** @param {string} id @param {string} digest @param {'completed'|'failed'} status @param {number} start @param {number} finish
 * @returns {import('../../../src/worker/application/delivery-contracts').DeliveryStep} */
function verificationStep(id, digest, status, start, finish) {
  return { id, phase: 'verifying', status, turnId: null, invocationRunId: null, startedAt: at(start), finishedAt: at(finish), detail: null,
    evidence: { schemaVersion: 1, candidateDigest: digest, changedPaths: ['src/a'], updatedAt: at(finish), checks: [{ presetId: 'unit', presetFingerprint: 'unit-v1', candidateDigest: digest,
      status: status === 'completed' ? 'passed' : 'failed', exitCode: status === 'completed' ? 0 : 1, stdout: '', stderr: '', startedAt: at(start), finishedAt: at(finish) }] } };
}

test('verification rates require current nonempty complete check receipts and exclude provider review sessions', () => {
  const value = request(), base = verificationStep('checks', 'candidate', 'completed', 5, 10);
  const variants = [
    { ...base, evidence: { ...base.evidence, checks: [] } },
    { ...base, evidence: { ...base.evidence, checks: [{ ...base.evidence.checks[0], candidateDigest: 'stale' }] } },
    { ...base, evidence: { ...base.evidence, checks: [{ ...base.evidence.checks[0], presetFingerprint: 'old-definition' }] } },
    { ...base, evidence: { ...base.evidence, checks: [base.evidence.checks[0], base.evidence.checks[0]] } },
    { ...base, purpose: /** @type {const} */ ('candidate_review') },
  ];
  for (const step of variants) {
    value.delivery.steps = [step];
    const report = buildDeliveryMetrics({ requests: [value], events: [], runs: [], completeRequestIds: ['fr'] }, {}, at(60));
    assert.equal(report.verification.firstPass.percent, null); assert.equal(report.verification.firstPass.unknown, 1); assert.equal(report.verification.eventualPass.percent, null);
  }
  value.delivery.steps = [base];
  assert.equal(buildDeliveryMetrics({ requests: [value], events: [], runs: [], completeRequestIds: ['fr'] }, {}, at(60)).verification.firstPass.percent, 100);
  const { implementation: scope } = /** @type {{ implementation: import('../../../src/worker/application/development').DevelopmentScopeView }} */ (value.input.context);
  scope.checks.push({ id: 'integration', name: 'Integration tests', fingerprint: 'integration-v1' });
  assert.equal(buildDeliveryMetrics({ requests: [value], events: [], runs: [], completeRequestIds: ['fr'] }, {}, at(60)).verification.eventualPass.percent, null, 'one passing receipt cannot satisfy two required checks');
  scope.checks.pop();
  value.delivery.steps = [verificationStep('failed', 'candidate', 'failed', 5, 10)];
  let report = buildDeliveryMetrics({ requests: [value], events: [], runs: [], completeRequestIds: ['fr'] }, {}, at(60));
  assert.equal(report.verification.firstPass.percent, 0); assert.equal(report.verification.eventualPass.percent, null, 'a request still eligible for repair has no eventual outcome yet');
  report = buildDeliveryMetrics({ requests: [value], events: [event(1, 'delivery_cancel', 40, { phase: 'cancelled' })], runs: [], completeRequestIds: ['fr'] }, {}, at(60));
  assert.equal(report.verification.eventualPass.percent, 0);
});

test('first-feedback provider duration unions overlapping calls and rejects missing referenced or ambiguous legacy invocations', () => {
  const first = invocation(); first.after.capturedAt = at(15);
  const child = { ...invocation(), id: 'child', parentRunId: 'call', startedAt: at(5), after: { ...invocation().after, capturedAt: at(18) } };
  const events = [event(1, 'gate_held', 20, { runId: 'call' })], evidence = { requests: [request()], events, runs: [first, child, first], completeRequestIds: ['fr'] };
  const report = buildDeliveryMetrics(evidence, {}, at(60));
  assert.equal(report.firstFeedback.p95Ms, 20000); assert.equal(report.firstFeedback.providerPortion.p95Ms, 16000);
  assert.equal(buildDeliveryMetrics({ ...evidence, events: [event(1, 'gate_held', 20, { runId: 'lost-call' })] }, {}, at(60)).firstFeedback.providerPortion.p95Ms, null);
  const legacy = { ...invocation(), id: 'unmapped-legacy' }; delete legacy.requestId;
  assert.equal(buildDeliveryMetrics({ ...evidence, runs: [...evidence.runs, legacy] }, {}, at(60)).firstFeedback.providerPortion.p95Ms, null);
  const missingTime = { ...invocation(), startedAt: null };
  assert.equal(buildDeliveryMetrics({ ...evidence, runs: [missingTime] }, {}, at(60)).firstFeedback.providerPortion.p95Ms, null);
});

test('ongoing and historical review cohorts remain unknown until their observed outcome settles', () => {
  const value = request(), beforeReview = [event(1, 'gate_held', 5), event(2, 'delivery_review_packaged', 30), event(3, 'operator_attested', 50)];
  const evidence = { requests: [value], events: beforeReview, runs: [], completeRequestIds: ['fr'] };
  const historical = buildDeliveryMetrics(evidence, { until: at(20) }, at(60));
  assert.equal(historical.autonomousReview.denominator, 0); assert.equal(historical.autonomousReview.unknown, 1);
  const inReview = buildDeliveryMetrics(evidence, { until: at(40) }, at(60));
  assert.equal(inReview.autonomousReview.percent, 100); assert.equal(inReview.review.changesRequested.percent, null); assert.equal(inReview.review.changesRequested.unknown, 1);
  const accepted = buildDeliveryMetrics(evidence, {}, at(60)); assert.equal(accepted.review.changesRequested.percent, 0);
  const pendingRecovery = buildDeliveryMetrics({ ...evidence, events: [observation(1, 20, [{ kind: 'recovery', operationId: 'recover', outcome: 'unknown', duplicateActions: false }])] }, {}, at(60));
  assert.equal(pendingRecovery.recovery.percent, null); assert.equal(pendingRecovery.recovery.unknown, 1);
});

test('retained invocation references prevent complete consumption averages after run-ledger loss or request reopening', () => {
  const events = [event(1, 'execution_started', 2, { runId: 'missing' }), event(2, 'operator_attested', 40)], value = request();
  const report = buildDeliveryMetrics({ requests: [value], events, runs: [invocation()], completeRequestIds: ['fr'] }, {}, at(60));
  assert.equal(report.consumption.acceptedRequests, 1); assert.equal(report.consumption.inputTokens, 10); assert.equal(report.consumption.partialRequests, 1);
  assert.equal(report.consumption.measuredRequests, 0); assert.equal(report.consumption.meanTokens, null);
  const reopened = [...events, event(3, 'delivery_reopen', 50, { phase: 'readiness' })];
  assert.equal(buildDeliveryMetrics({ requests: [value], events: reopened, runs: [invocation()], completeRequestIds: ['fr'] }, {}, at(60)).consumption.acceptedRequests, 0);
  assert.equal(buildDeliveryMetrics({ requests: [value], events: reopened, runs: [invocation()], completeRequestIds: ['fr'] }, { until: at(45) }, at(60)).consumption.acceptedRequests, 1);
  const legacy = { ...invocation() }; delete legacy.requestId;
  assert.equal(buildDeliveryMetrics({ requests: [value], events: [event(1, 'operator_attested', 40)], runs: [legacy], completeRequestIds: ['fr'] }, {}, at(60)).consumption.inputTokens, null);
});

test('feedback distributions use canonical requests, including unknown feedback, and include focused questions', () => {
  const requests = ['a', 'b', 'c', 'd'].map(request);
  const events = [10, 20, 30].map((seconds, index) => event(index + 1, 'input_requested', seconds, { requestId: requests[index].id, phase: 'waiting_input' }));
  const report = buildDeliveryMetrics({ requests, events, runs: [], completeRequestIds: requests.map(value => value.id) }, {}, at(60));
  const { providerPortion: _, ...distribution } = report.firstFeedback;
  assert.deepEqual(distribution, { samples: 3, unknown: 1, p50Ms: 20000, p95Ms: 30000, totalMs: 60000 });
  assert.equal(report.clarification.observedRequests, 0); assert.equal(report.clarification.unknownRequests, 4, 'unmeasured legacy questions do not establish zero rounds');
});

test('blocker snapshots classify known operational holds and never label a failed implementation check as missing requirements', () => {
  const value = request(); value.delivery.holds = ['provider_rate_limited', 'provider_quota_exhausted', 'provider_approval_required', 'verification_unavailable', 'checkpoint_unavailable', 'candidate_review_input', 'novel_code'].map(code => ({ code, reason: 'Recorded hold.' }));
  value.findings = [{ id: 'failed-check', kind: 'issue', blocking: true, source: 'deterministic', evaluationId: 'done', ruleId: 'required-checks', status: 'open', message: 'A required check failed.' },
    { id: 'question', kind: 'question', blocking: true, source: 'reviewer', evaluationId: 'ready', status: 'open', message: 'Which behavior is intended?' }];
  const measurement = deliveryEventMeasurement(value), categories = Object.fromEntries(measurement.blockers.map(item => [item.code, item.category]));
  assert.equal(categories.provider_rate_limited, 'provider'); assert.equal(categories.provider_quota_exhausted, 'provider'); assert.equal(categories.provider_approval_required, 'permissions');
  assert.equal(categories.verification_unavailable, 'environment'); assert.equal(categories.checkpoint_unavailable, 'environment'); assert.equal(categories.candidate_review_input, 'requirements');
  assert.equal(categories.novel_code, 'unknown'); assert.equal(categories['finding:failed-check'], 'unknown'); assert.equal(categories['finding:question'], 'requirements');
});


test('truncated verification history never turns a retained later pass into a first pass', () => {
  const value = request(); value.delivery.steps = [verificationStep('latest', 'candidate', 'completed', 20, 25)];
  const evidence = { requests: [value], events: [event(1, 'delivery_step_finished', 10, { deliveryRunId: 'pruned-run' })], runs: [], completeRequestIds: ['fr'] };
  const report = buildDeliveryMetrics(evidence, {}, at(60));
  assert.equal(report.verification.firstPass.percent, null); assert.equal(report.verification.firstPass.unknown, 1);
  assert.equal(report.verification.eventualPass.percent, 100, 'a directly recorded later success is still a known eventual pass');
  assert.equal(buildDeliveryMetrics({ ...evidence, events: [], completeRequestIds: [] }, {}, at(60)).verification.firstPass.percent, null);
  value.delivery.steps = [verificationStep('latest', 'candidate', 'failed', 20, 25)];
  evidence.events.push(event(2, 'delivery_cancel', 40, { phase: 'cancelled' }));
  assert.equal(buildDeliveryMetrics(evidence, {}, at(60)).verification.eventualPass.percent, null, 'a pruned successful attempt cannot be ruled out');
});

test('human failures union explicit observations with retained criterion outcomes without double counting', () => {
  const value = request(), candidateDigest = 'candidate';
  value.delivery.review = { schemaVersion: 1, publication: 'local_only', candidate: { requestId: value.id, runId: value.delivery.id, inputRevision: 1, inputHash: value.inputHash, policyDigest: value.policyDigest, candidateDigest, baseline: 'base', branch: 'branch', candidateCommit: 'commit', tree: 'tree', patchDigest: 'patch', checkDefinitionDigest: 'checks', createdAt: at(25) }, criteria: [], results: [], checks: [], markdown: 'Recorded review.' };
  value.delivery.humanOutcomes = ['human:1', 'human:2'].map(criterionId => ({ criterionId, outcome: 'failed', actor: 'operator', reason: 'Criterion not met.', at: at(35) }));
  const observed = observation(1, 35, [{ kind: 'human_review_failure', candidateDigest, criterionId: 'human:1' }]);
  const report = buildDeliveryMetrics({ requests: [value], events: [observed], runs: [], completeRequestIds: ['fr'] }, {}, at(60));
  assert.equal(report.verification.humanFailures, 2); assert.equal(report.verification.humanReviewedRequests, 1);
});


test('clarification completes only explicit matching answers to every question; history and legacy remain distinct', () => {
  const asked = observation(1, 5, ['q1', 'q2'].map(questionId => ({ kind: 'clarification', questionId, cycleId: 'round', cause: 'scope', answerTracking: true })));
  const oneAnswer = observation(2, 10, [{ kind: 'clarification_answer', questionId: 'q1', cycleId: 'round', cause: 'scope' }]);
  const remaining = observation(3, 20, [{ kind: 'clarification_answer', questionId: 'q2', cycleId: 'round', cause: 'scope' }]);
  const input = { requests: [request()], events: [asked, oneAnswer, remaining], runs: [], completeRequestIds: ['fr'] };
  const waiting = buildDeliveryMetrics(input, { until: at(15) }, at(60)).clarification;
  assert.equal(waiting.cycles, 1); assert.equal(waiting.completedCycles, 0); assert.equal(waiting.pendingCycles, 1); assert.equal(waiting.unknownCycles, 0);
  const complete = buildDeliveryMetrics({ ...input, events: [...input.events, remaining] }, {}, at(60)).clarification;
  assert.equal(complete.cycles, 1); assert.equal(complete.completedCycles, 1); assert.equal(complete.pendingCycles, 0); assert.equal(complete.completionMeasuredRequests, 1);
  const unrelated = observation(4, 25, [{ kind: 'clarification_answer', questionId: 'q2', cycleId: 'different-round', cause: 'scope' }]);
  assert.equal(buildDeliveryMetrics({ ...input, events: [asked, oneAnswer, unrelated] }, {}, at(60)).clarification.completedCycles, 0);
  const changed = event(4, 'source_revision_accepted', 25, { inputRevision: 2, phase: 'readiness' });
  const revised = buildDeliveryMetrics({ ...input, events: [asked, changed] }, {}, at(60)).clarification;
  assert.equal(revised.completedCycles, 0); assert.equal(revised.pendingCycles, 0); assert.equal(revised.unknownCycles, 1, 'arbitrary edits are not accepted answers or live unanswered questions');
  const old = observation(1, 5, [{ kind: 'clarification', questionId: 'old', cycleId: 'old-round', cause: 'legacy' }]);
  const legacy = buildDeliveryMetrics({ ...input, events: [old] }, {}, at(60)).clarification;
  assert.equal(legacy.completedCycles, 0); assert.equal(legacy.pendingCycles, 0); assert.equal(legacy.unknownCycles, 1); assert.equal(legacy.completionMeasuredRequests, 0); assert.equal(legacy.unknownCompletionRequests, 1);
});


test('submitted readiness questions contribute feedback and pending clarification before implementation, with legacy coverage unknown', () => {
  const pending = request(); delete pending.delivery; pending.owner.taskId = 'task'; pending.phase = 'waiting_input'; pending.lifecycle = 'submitted';
  const asked = event(1, 'gate_held', 5, { phase: 'waiting_input', measurement: { projectId: 'project', profileId: 'feature', lifecycle: 'submitted', blockers: [{ code: 'question', category: 'requirements' }], observations: [{ kind: 'clarification', questionId: 'q1', cycleId: 'ready-1', cause: 'scope', answerTracking: true }] } });
  const evidence = { requests: [pending], events: [asked], runs: [], completeRequestIds: ['fr'] };
  const report = buildDeliveryMetrics(evidence, {}, at(60));
  assert.equal(report.cohort.requests, 1); assert.equal(report.autonomousReview.unknown, 1);
  assert.equal(report.firstFeedback.p95Ms, 5000); assert.equal(report.firstFeedback.providerPortion.p95Ms, 0);
  assert.equal(report.clarification.cycles, 1); assert.equal(report.clarification.pendingCycles, 1); assert.equal(report.clarification.completedCycles, 0);
  assert.deepEqual(report.blockers, [{ category: 'requirements', waits: 1, totalMs: 55000, active: 1 }]);
  assert.equal(report.verification.firstPass.percent, null); assert.equal(report.verification.eventualPass.percent, null);
  const legacyEvent = { ...asked }; delete legacyEvent.measurement;
  const legacy = buildDeliveryMetrics({ ...evidence, events: [legacyEvent] }, {}, at(60));
  assert.equal(legacy.cohort.requests, 1); assert.equal(legacy.clarification.unknownRequests, 1); assert.equal(legacy.blockerCoverage.unknownRequests, 1);
  assert.equal(legacy.firstFeedback.providerPortion.p95Ms, null);
  const cancelled = buildDeliveryMetrics({ ...evidence, events: [asked, event(2, 'delivery_cancel', 40, { phase: 'cancelled' })] }, {}, at(60));
  assert.equal(cancelled.autonomousReview.percent, 0, 'a submitted request cancelled before implementation remains in its observed denominator');
  const chat = { ...pending, id: 'chat', input: { ...pending.input, kind: /** @type {const} */ ('chat') } };
  assert.equal(buildDeliveryMetrics({ ...evidence, requests: [pending, chat] }, {}, at(60)).cohort.requests, 1);
});


/** @returns {import('../../../src/worker/application/feature-intake-measurement').FeatureIntakeMeasurement} */
function intakeMeasurement() {
  const feature = featureRequestReference({ id: 'FR-one', source: 'folder', scope: '/project/requests', repositoryId: 'project' });
  const measurement = observeFeatureIntake({}, feature, 'source-1', { projectId: 'project', profileId: 'feature', sessionId: 'fr-session' }, at(0));
  appendFeatureIntake(measurement, { inputRevision: 'source-1', phase: 'readiness', blockers: [{ code: 'reviewer', category: 'provider' }], providerRunId: 'ready-call' }, at(1));
  appendFeatureIntake(measurement, { inputRevision: 'source-1', phase: 'waiting_input', feedback: true, blockers: [{ code: 'question', category: 'requirements' }], providerRunId: 'ready-call', observations: [{ kind: 'clarification', cycleId: 'ready-round', questionId: 'ready-question', cause: 'scope', answerTracking: true }] }, at(10));
  appendFeatureIntake(measurement, { inputRevision: 'source-1', phase: 'queued', blockers: [], observations: [{ kind: 'clarification_answer', cycleId: 'ready-round', questionId: 'ready-question', cause: 'scope' }] }, at(15));
  return measurement;
}

test('intake history deduplicates admission and retains reviewer timing, answered cycles, waits and usage on the accepted FR', () => {
  const value = request(); value.createdAt = at(20); value.owner.featureId = intakeMeasurement().feature.key; value.phase = 'done'; value.lifecycle = 'done';
  const source = intakeMeasurement(), implementation = invocation(); implementation.acceptedAt = at(21); implementation.startedAt = at(22); implementation.after.capturedAt = at(45);
  const reviewer = { ...invocation(), id: 'ready-call', requestId: undefined, sessionId: 'readiness-session', acceptedAt: at(1), startedAt: at(2), after: { ...invocation().after, capturedAt: at(10) }, usage: { ...invocation().usage, inputTokens: 5, outputTokens: 5 } };
  const evidence = { requests: [value], intake: [source], events: [event(1, 'accepted', 20), event(2, 'execution_started', 22, { runId: 'call' }), event(3, 'operator_attested', 50)], runs: [reviewer, implementation], completeRequestIds: ['fr'] };
  const report = buildDeliveryMetrics(evidence, {}, at(60));
  assert.equal(report.cohort.requests, 1); assert.equal(report.firstFeedback.p95Ms, 10000); assert.equal(report.firstFeedback.providerPortion.p95Ms, 8000);
  assert.equal(report.clarification.cycles, 1); assert.equal(report.clarification.completedCycles, 1);
  assert.equal(report.blockers.find(item => item.category === 'requirements').totalMs, 5000);
  assert.equal(report.consumption.acceptedRequests, 1); assert.equal(report.consumption.measuredRequests, 1); assert.equal(report.consumption.meanTokens, 25);
  assert.equal(buildDeliveryMetrics(evidence, { since: at(10) }, at(60)).cohort.requests, 0, 'admission does not reset the observed submission time');
  const missing = buildDeliveryMetrics({ ...evidence, runs: [implementation] }, {}, at(60));
  assert.equal(missing.firstFeedback.providerPortion.p95Ms, null); assert.equal(missing.consumption.meanTokens, null); assert.equal(missing.consumption.partialRequests, 1);
  const pending = buildDeliveryMetrics({ ...evidence, requests: [], events: [], completeRequestIds: [] }, { until: at(12) }, at(60));
  assert.equal(pending.cohort.requests, 1); assert.equal(pending.clarification.pendingCycles, 1); assert.equal(pending.firstFeedback.providerPortion.p95Ms, 8000);
});

test('unknown intake submission timestamps remain explicit and excluded from either dated filter without losing their admitted identity', () => {
  const value = request(); value.owner.featureId = intakeMeasurement().feature.key; const source = intakeMeasurement(); source.submittedAt = null; source.complete = false;
  const evidence = { requests: [value], intake: [source], events: [], runs: [], completeRequestIds: ['fr'] };
  const all = buildDeliveryMetrics(evidence, {}, at(60));
  assert.equal(all.cohort.requests, 1); assert.equal(all.cohort.unknownSubmissionTimes, 1); assert.equal(all.cohort.excludedUnknownSubmissionTimes, 0); assert.equal(all.firstFeedback.p95Ms, null);
  for (const query of [{ since: at(0) }, { until: at(40) }]) {
    const report = buildDeliveryMetrics(evidence, query, at(60));
    assert.equal(report.cohort.requests, 0); assert.equal(report.cohort.unknownSubmissionTimes, 1); assert.equal(report.cohort.excludedUnknownSubmissionTimes, 1);
  }
  const conflicting = { ...value, owner: { ...value.owner, featureId: 'different-feature' } };
  assert.equal(buildDeliveryMetrics({ ...evidence, requests: [conflicting] }, {}, at(60)).cohort.requests, 2, 'a shared session cannot override a conflicting stable feature identity');
});


test('incomplete intake evidence cannot extend an old blocker through an unobserved tail or admission gap', () => {
  const source = intakeMeasurement(); source.events = source.events.slice(0, 3); source.observedAt = at(10); source.complete = false;
  const pending = buildDeliveryMetrics({ requests: [], events: [], runs: [], intake: [source], completeRequestIds: [] }, {}, at(60));
  assert.equal(pending.blockerCoverage.unknownRequests, 1); assert.equal(pending.blockers.find(item => item.category === 'requirements').totalMs, 0); assert.equal(pending.blockers.find(item => item.category === 'requirements').active, 0);
  const value = request(); value.createdAt = at(20); value.owner.featureId = source.feature.key;
  const admitted = buildDeliveryMetrics({ requests: [value], events: [event(1, 'accepted', 20)], runs: [], intake: [source], completeRequestIds: ['fr'] }, {}, at(60));
  assert.equal(admitted.blockers.find(item => item.category === 'requirements').totalMs, 0, 'missing intake history cannot turn its final question into a measured ten-second wait before admission');
});


test('tracked chat Feature Requests merge with their canonical outcome while ordinary conversations stay outside the cohort', () => {
  const source = intakeMeasurement(), tracked = request(); delete tracked.delivery; tracked.input.kind = 'chat'; tracked.owner.featureId = source.feature.key; tracked.createdAt = at(20); tracked.phase = 'done'; tracked.lifecycle = 'done';
  const untracked = { ...tracked, id: 'ordinary', owner: { sessionId: 'ordinary-session', rootTurnId: 'ordinary-turn' } };
  const report = buildDeliveryMetrics({ requests: [tracked, untracked], intake: [source], events: [event(1, 'accepted', 20), event(2, 'operator_attested', 50)], runs: [], completeRequestIds: ['fr', 'ordinary'] }, {}, at(60));
  assert.equal(report.cohort.requests, 1); assert.equal(report.consumption.acceptedRequests, 1); assert.equal(report.clarification.completedCycles, 1);
});
