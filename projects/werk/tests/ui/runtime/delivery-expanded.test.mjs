import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { deliveryMetricCards, deliveryMetricInterval, deliverySubmissionCoverage } = await frontend('src/worker/webview/metrics-delivery.ts');
const { buildDeliveryMetrics } = await frontend('src/worker/application/delivery-metrics.ts');
const { buildWorkerCapacityView } = await frontend('src/worker/webview/worker-capacity.ts');
const { defaultGatePolicy } = await frontend('src/worker/application/request-gates.ts');
const { resolveValidatedDeliveryExecutionProfile } = await frontend('src/worker/application/delivery-execution-routing.ts');
const { deliveryBehaviorNodes, deliveryInvocationLimits } = await frontend('src/worker/webview/delivery-behavior-view.ts');
const { readinessDecision, reportedReviewMinutes } = await frontend('src/worker/webview/delivery-readiness-view.ts');
const { deliveryDecisionSubject } = await frontend('src/worker/webview/delivery-decision-subject.ts');
const { deliveryHumanReviewReady } = await frontend('src/worker/webview/delivery-human-review.ts');
const { deliveryReviewStages } = await frontend('src/worker/webview/delivery-review-stages.ts');
const { deliveryAssessments } = await frontend('src/worker/webview/delivery-provider-view.ts');
const { publicationCommand, publicationLink } = await frontend('src/worker/webview/delivery-publication-view.ts');
const at = '2026-10-20T10:00:00.000Z';
/** @returns {import('../../../src/worker/application/request-gates').WorkerRequest} */
function subject() {
  const request = { schemaVersion: 1, id: 'request', owner: { sessionId: 'session', rootTurnId: 'turn' }, revision: 1, inputRevision: 1, input: { kind: 'patch', title: 'Work', message: 'Implement accepted work', context: { implementation: { checks: [{ id: 'test', name: 'Unit tests', fingerprint: 'fingerprint' }] }, deliveryPolicy: { schemaVersion: 1, baseline: 'a'.repeat(40), configurationDigest: 'x', configuration: { reviewDirectory: 'reviews' }, profile: { id: 'feature', maxRepairAttempts: 2, verificationInputs: ['tests/'], exceptions: { exemptibleCriteria: ['check:test'], notApplicableCriteria: [] } } } } }, inputHash: 'a'.repeat(64), policyDigest: 'b'.repeat(64), policy: defaultGatePolicy(), provider: { id: 'claude-cli', model: '', instruction: '' }, phase: 'review', lifecycle: 'in_review', assignee: 'operator', createdAt: at, updatedAt: at, reworkCount: 0, evaluations: [], findings: [], candidates: [], reviews: [], execution: null, attestation: null };
  const candidate = { requestId: 'request', inputRevision: 1, inputHash: request.inputHash, runId: 'delivery', baseline: 'a'.repeat(40), branch: 'werk/request', candidateCommit: 'c'.repeat(40), tree: 'd'.repeat(40), candidateDigest: 'e'.repeat(64), patchDigest: 'f'.repeat(64), policyDigest: request.policyDigest, checkDefinitionDigest: 'c'.repeat(64), createdAt: at };
  const profile = { schemaVersion: 1, id: 'behavior', version: 1, root: { id: 'root', type: 'sequence', children: [{ id: 'condition', type: 'condition', condition: 'needs_review' }, { id: 'action', type: 'action', action: 'review', reason: 'Review current work' }] } };
  return /** @type {import('../../../src/worker/application/request-gates').WorkerRequest} */ ({ ...request, delivery: { schemaVersion: 1, id: 'delivery', inputRevision: 1, inputHash: request.inputHash, policyDigest: request.policyDigest, profile, profileDigest: 'profile', status: 'completed', phase: 'packaging', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2, startedAt: at, finishedAt: at, steps: [], decision: { profileId: 'behavior', profileVersion: 1, selectedNode: 'action', selectedAction: 'review', reason: 'Inspect candidate', waitingFor: 'Human review', conditions: [] }, allowedControls: [], checkpoints: [candidate], review: { schemaVersion: 1, candidate, criteria: [{ id: 'check:test', description: 'Unit tests', mandatory: true, evaluator: 'check', checkId: 'test' }], results: [{ criterionId: 'check:test', status: 'failed', evidenceRefs: [] }], checks: [], markdown: '# Review', publication: 'local_only' } } });
}
test('routing is deterministic, previews only authorized overrides and returns an isolated selection', () => {
  const profile = id => ({ id, provider: 'claude-cli', model: 'model', effort: 'high', authenticationMode: 'cli-account', boundary: 'worker_grants' });
  const policy = { profiles: [profile('default'), profile('review'), profile('urgent')], defaultProfile: 'default', allowedOverrides: ['review'], fallbackProfiles: [], fallbackOn: [], maxHandoffs: 0, routing: [{ id: 'urgent-rule', profile: 'urgent', modes: ['patch'], priorities: [0] }] };
  assert.equal(resolveValidatedDeliveryExecutionProfile(policy, undefined, { mode: 'patch', priority: 0 }).profile.id, 'urgent');
  assert.equal(resolveValidatedDeliveryExecutionProfile(policy, 'review', { mode: 'patch', priority: 0 }).source, 'override');
  assert.equal(resolveValidatedDeliveryExecutionProfile(policy, undefined, { mode: 'chat', priority: 0 }).profile.id, 'default');
  assert.throws(() => resolveValidatedDeliveryExecutionProfile(policy, 'urgent'), /not allowed/);
  const selected = resolveValidatedDeliveryExecutionProfile(policy); selected.profile.model = 'changed'; assert.equal(policy.profiles[0].model, 'model');
});
test('behavior inspection separates unvisited conditions from false observations and retains effective limits before dispatch', () => {
  const value = subject(), run = value.delivery;
  assert.equal(deliveryBehaviorNodes(run.profile, run.decision)[1].inspected, 'not_inspected');
  run.decision.conditions = [{ nodeId: 'condition', condition: 'needs_review', result: false }];
  assert.equal(deliveryBehaviorNodes(run.profile, run.decision)[1].inspected, 'not_met');
  assert.deepEqual(deliveryBehaviorNodes(run.profile, run.decision)[2].path, ['root', 'action']);
  run.effectiveLimits = { maxRuntimeMs: 60000, commandTimeoutMs: 1000, maxToolCalls: 8, maxRepairAttempts: 2 };
  assert.equal(deliveryInvocationLimits(run).maxToolCalls, 8); assert.equal(deliveryInvocationLimits(run).deadline, null);
});
test('readiness decisions bind exact accepted input and do not turn missing or already decided proposals into commands', () => {
  const value = subject();
  const evaluation = { readiness: { assessment: { id: 'assessment', inputRevision: 1, inputHash: value.inputHash, policyDigest: value.policyDigest }, proposals: [{ id: 'assume', status: 'proposed' }] } };
  const command = readinessDecision(value, evaluation, 'assume', 'accepted', '  Explicit reasoning  ');
  assert.equal(command.assessmentId, 'assessment'); assert.equal(command.note, 'Explicit reasoning'); assert.equal(command.inputHash, value.inputHash);
  assert.equal(readinessDecision(value, evaluation, 'missing', 'accepted', 'Reason'), null);
  value.inputRevision++; assert.equal(readinessDecision(value, evaluation, 'assume', 'accepted', 'Reason'), null);
  value.inputRevision--; evaluation.readiness.proposals[0].status = 'accepted'; assert.equal(readinessDecision(value, evaluation, 'assume', 'accepted', 'Reason'), null);
  assert.deepEqual(reportedReviewMinutes(''), { valid: true }); assert.equal(reportedReviewMinutes('0').minutes, 0);
  for (const invalid of ['-1', 'NaN', 'Infinity', '1441']) assert.equal(reportedReviewMinutes(invalid).valid, false);
});
test('failed checkpoint exposes only accepted check IDs and unknown/live/current-input mismatches cannot authorize decisions', () => {
  const value = subject(), run = value.delivery; run.review = undefined; run.status = 'failed';
  assert.deepEqual(deliveryDecisionSubject(value).criteria.map(item => item.id), ['check:test']);
  assert.equal(deliveryDecisionSubject(value).packaged, false);
  for (const status of ['running', 'outcome_unknown', 'reconciling', 'interrupting']) { run.status = /** @type {import('../../../src/worker/application/delivery-contracts').DeliveryStatus} */ (status); assert.equal(deliveryDecisionSubject(value), null); }
  run.status = 'failed'; run.checkpoints[0].inputRevision++; assert.equal(deliveryDecisionSubject(value), null);
});
test('policy-authorized exact candidate decisions affect eligibility while failed observed results remain failed', () => {
  const value = subject(), review = value.delivery.review, candidate = review.candidate;
  /** @type {import('../../../src/worker/application/delivery-criterion-decisions').DeliveryCriterionDecision} */
  const decision = { schemaVersion: 1, operationId: 'exception-1', criterionId: 'check:test', kind: 'exempted', reason: 'Separate approved decision', actor: 'operator', at, subject: { ...candidate } };
  const policy = { exemptibleCriteria: ['check:test'], notApplicableCriteria: [] };
  assert.equal(deliveryHumanReviewReady(review, () => '', { policy, decisions: [decision] }), true);
  value.delivery.criterionDecisions = [decision]; assert.match(deliveryReviewStages(value).verification.detail, /disclosed/);
  assert.equal(review.results[0].status, 'failed');
  decision.subject.candidateCommit = 'd'.repeat(40); assert.equal(deliveryHumanReviewReady(review, () => '', { policy, decisions: [decision] }), false);
  decision.subject.candidateCommit = candidate.candidateCommit; assert.equal(deliveryHumanReviewReady(review, () => '', { decisions: [decision] }), false);
});
test('provider assessment remains historical after candidate or canonical outcome changes', () => {
  const value = subject(), run = value.delivery;
  run.assessments = [{ stepId: 'review', invocationRunId: 'call', profileId: 'reviewer', selection: { provider: 'claude-cli', model: '', effort: 'high' }, candidate: { ...run.review.candidate }, evidenceDigest: 'evidence', dispatchDigest: 'dispatch', at, passed: true, summary: 'No blocking findings', findings: [] }];
  assert.equal(deliveryAssessments(value)[0].current, true); run.status = 'interrupted'; assert.equal(deliveryAssessments(value)[0].current, false);
  run.status = 'completed'; run.assessments[0].candidate.candidateDigest = 'other'; assert.equal(deliveryAssessments(value)[0].current, false);
});
test('publication actions bind exact candidate and reconciliation never becomes a second publish', () => {
  const value = subject(), candidate = value.delivery.review.candidate;
  const target = { remote: 'origin', repository: 'acme/web', base: 'main', push: true, pullRequest: true, draft: true };
  const view = { configured: true, authorized: true, reason: null, target, candidate, canPush: true, canCreatePullRequest: true, canReconcile: true, publications: [] };
  assert.equal(publicationCommand(value, view, 'push_candidate').candidateDigest, candidate.candidateDigest);
  const receipt = { operationId: 'publication-1', action: 'pull_request', candidate, target, repositoryId: 'web', configurationDigest: 'policy', status: 'unknown', createdAt: at, updatedAt: at, detail: 'Unknown' };
  view.publications = [receipt]; const reconcile = publicationCommand(value, view, 'reconcile_publication', receipt);
  assert.equal(reconcile.action, 'reconcile_publication'); assert.equal(reconcile.publicationOperationId, 'publication-1');
  assert.equal(publicationLink(receipt), null); receipt.status = 'confirmed'; receipt.observation = { branch: candidate.branch, commit: candidate.candidateCommit, pullRequest: { number: 12, url: 'https://github.com/acme/web/pull/12', state: 'open' } };
  assert.equal(publicationLink(receipt), receipt.observation.pullRequest.url); receipt.observation.pullRequest.url = 'https://github.com/other/web/pull/12'; assert.equal(publicationLink(receipt), null);
  view.authorized = false; assert.equal(publicationCommand(value, view, 'push_candidate'), null);
});

test('capacity distinguishes live work from unresolved reservations without erasing occupied slots', () => {
  /** @type {import('../../../src/worker/application/worker-capacity').WorkerCapacitySnapshot} */
  const capacity = { schemaVersion: 1, capturedAt: at, execution: { limit: 3, inUse: 2, sessionId: null, sessions: [], unresolved: [{ sessionId: 'unknown', projectId: 'web' }, { sessionId: 'other', projectId: 'shared' }] }, local: { limit: 8, used: 2, remaining: 6, overLimit: false }, remote: { waiting: 0, running: 0, extraQueuePlaces: 2, accepted: 0 }, starts: { paused: false, consumption: { blocked: false, reason: 'disabled' } } };
  const view = buildWorkerCapacityView(capacity); assert.equal(view.state, 'unknown'); assert.match(view.title, /needs inspection/); assert.equal(view.unresolvedCount, 2); assert.equal(view.executionLabel, '2 / 3 task slots occupied'); assert.equal(view.admissionAvailable, true); assert.doesNotMatch(view.title, /running|progress/);
  capacity.execution.sessions = [{ sessionId: 'live', projectId: 'web', startedAt: at }]; capacity.execution.inUse++; const mixed = buildWorkerCapacityView(capacity); assert.equal(mixed.state, 'running'); assert.equal(mixed.title, '1 running · 2 unresolved');
  const stale = buildWorkerCapacityView(capacity, 'stale'); assert.equal(stale.state, 'unknown'); assert.match(stale.title, /refresh/);
});

test('clarification metrics never label asked rounds as completed answer cycles', () => {
  const report = buildDeliveryMetrics({ requests: [], events: [], runs: [], completeRequestIds: [] }, {}, at);
  Object.assign(report.clarification, { cycles: 4, completedCycles: 0, pendingCycles: 1, unknownCycles: 3, completionMeasuredRequests: 0, unknownCompletionRequests: 1 });
  let card = deliveryMetricCards(report).find(item => item.id === 'MET-03'); assert.equal(card.value, 'Unavailable'); assert.match(card.description, /4 recorded question rounds/); assert.match(card.description, /3 with unknown completion/);
  report.clarification.completedCycles = 1; card = deliveryMetricCards(report).find(item => item.id === 'MET-03'); assert.equal(card.value, '1'); assert.match(card.coverage, /1 unknown/);
});


test('unknown submission times follow authoritative filter exclusion, including until-only queries', () => {
  assert.equal(deliverySubmissionCoverage({ unknownSubmissionTimes: 0, excludedUnknownSubmissionTimes: 0 }), null);
  const dated = deliverySubmissionCoverage({ unknownSubmissionTimes: 2, excludedUnknownSubmissionTimes: 2 });
  assert.match(dated, /2 retained requests have an unknown submission time/); assert.match(dated, /2 are excluded by this dated submission filter/); assert.doesNotMatch(dated, /included|2026/);
  const allTime = deliverySubmissionCoverage({ unknownSubmissionTimes: 1, excludedUnknownSubmissionTimes: 0 });
  assert.match(allTime, /1 retained request has an unknown submission time/); assert.match(allTime, /included without an inferred submission date/); assert.doesNotMatch(allTime, /excluded|2026/);
  assert.deepEqual(deliveryMetricInterval('all', Date.parse(at)), {});
  assert.deepEqual(deliveryMetricInterval('7d', Date.parse(at)), { since: '2026-10-13T10:00:00.000Z', until: at });
});
