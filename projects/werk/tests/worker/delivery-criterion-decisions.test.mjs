import test from 'node:test';
import assert from 'node:assert/strict';
import { recordDeliveryCriterionDecision, deliveryCriterionDecision, validateDeliveryCriterionExceptionPolicy } from '../../src/worker/dist/worker/application/delivery-criterion-decisions.js';
import { deliveryVerificationEligibility } from '../../src/worker/dist/worker/application/delivery-verification-eligibility.js';
import { assertDeliveryAcceptance, buildDeliveryReview, deliveryCheckDefinitionDigest } from '../../src/worker/dist/worker/application/delivery-review.js';
import { freezeDevelopmentScope } from '../../src/worker/dist/worker/application/development.js';
import { baselineCheckDigest } from '../../src/worker/dist/worker/application/development-baseline.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { defaultGatePolicy, evaluateGate } from '../../src/worker/dist/worker/application/request-gates.js';
import { humanReviewObservations, humanReviewOutcomes } from '../../src/worker/dist/worker/application/delivery-human-review.js';
const at = '2026-10-20T12:00:00.000Z';
const policy = { exemptibleCriteria: ['check:unit'], notApplicableCriteria: ['check:unit'] };
function setup() {
  const tools = defaultToolPolicy(); tools.builtins.files = true;
  tools.builtins.commands = [{ id: 'unit', name: 'Unit tests', executable: 'node', args: ['test.mjs'], enabled: true, verification: true }];
  const scope = freezeDevelopmentScope('1'.repeat(40), ['src/'], tools);
  /** @type {import('../../src/worker/application/delivery-review-contracts.js').DeliveryCandidate} */
  const candidate = { requestId: 'request', inputRevision: 1, inputHash: 'a'.repeat(64), runId: 'run', baseline: scope.baseCommit, candidateCommit: '2'.repeat(40), branch: 'werk/delivery/fixture', tree: '3'.repeat(40), candidateDigest: 'b'.repeat(64), patchDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), checkDefinitionDigest: deliveryCheckDefinitionDigest(scope), createdAt: at };
  /** @type {import('../../src/worker/application/development.js').DevelopmentEvidence} */
  const evidence = { schemaVersion: 1, updatedAt: at, candidateDigest: candidate.candidateDigest, changedPaths: ['src/value.mjs'], checks: [{ presetId: 'unit', presetFingerprint: scope.checks[0].fingerprint, candidateDigest: candidate.candidateDigest, status: 'failed', exitCode: 1, stdout: 'private stdout', stderr: 'private stderr', startedAt: at, finishedAt: at }] };
  const criteria = [{ id: 'check:unit', description: 'Unit tests', mandatory: true, evaluator: /** @type {const} */ ('check'), checkId: 'unit' }];
  const context = { candidate, criteria, policy, operationId: 'decision', at };
  const input = { candidate, scope, evidence, criteria: [], title: 'Bounded change', summary: 'Implementation retained.', environment: { platform: 'fixture', architecture: 'fixture', nodeVersion: '24' } };
  return { scope, candidate, evidence, context, input };
}
test('exception permission is explicit, exact and cannot extend scope or waive unknown criteria', () => {
  const f = setup();
  for (const value of [{ ...policy, exemptibleCriteria: ['check:*'] }, { ...policy, notApplicableCriteria: ['anything'] }, { ...policy, exemptibleCriteria: ['check:unit', 'check:unit'] }]) assert.throws(() => validateDeliveryCriterionExceptionPolicy(value));
  const input = { criterionId: 'check:unit', kind: /** @type {const} */ ('exempted'), reason: 'Approved known failure.' };
  assert.throws(() => recordDeliveryCriterionDecision(input, { ...f.context, policy: undefined }), /does not permit/);
  assert.throws(() => recordDeliveryCriterionDecision({ ...input, criterionId: 'check:other' }, f.context), /not part/);
  assert.throws(() => recordDeliveryCriterionDecision(input, { ...f.context, policy: { ...policy, exemptibleCriteria: [] } }), /not permitted/);
  assert.throws(() => recordDeliveryCriterionDecision({ ...input, reason: ' ' }, f.context));
});
test('every candidate and authority field invalidates an old decision; malformed or revoked receipts fail closed', () => {
  const f = setup(), decision = recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'exempted', reason: 'Team accepts the known issue.' }, f.context);
  assert.deepEqual(deliveryCriterionDecision('check:unit', f.candidate, [decision], policy), decision);
  for (const patch of [{ requestId: 'other' }, { inputRevision: 2 }, { inputHash: 'f'.repeat(64) }, { runId: 'other' }, { baseline: 'f'.repeat(40) }, { candidateCommit: 'f'.repeat(40) }, { candidateDigest: 'f'.repeat(64) }, { policyDigest: 'f'.repeat(64) }, { checkDefinitionDigest: 'f'.repeat(64) }]) assert.equal(deliveryCriterionDecision('check:unit', { ...f.candidate, ...patch }, [decision], policy), undefined);
  for (const patch of [{ actor: 'model' }, { reason: '' }, { at: 'invalid' }, { operationId: '' }, { schemaVersion: 2 }]) assert.equal(deliveryCriterionDecision('check:unit', f.candidate, [/** @type {typeof decision} */ ({ ...decision, ...patch })], policy), undefined);
  assert.equal(deliveryCriterionDecision('check:unit', f.candidate, [decision], { ...policy, exemptibleCriteria: [] }), undefined);
});
test('authorized exception enables review without rewriting failed evidence, and no-scope/no-candidate remains ineligible', () => {
  const f = setup(), decision = recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'exempted', reason: 'Explicitly accepted fixture failure.' }, f.context);
  const before = structuredClone(f.evidence);
  assert.throws(() => buildDeliveryReview(f.input), /current worker verification/);
  const classification = deliveryVerificationEligibility(f.scope, f.evidence, f.candidate, [decision], policy);
  assert.equal(classification.eligible, true); assert.equal(classification.observedVerified, false); assert.equal(classification.checks[0].status, 'failed');
  for (const patch of [{ changedPaths: [] }, { changedPaths: ['outside.txt'] }, { candidateDigest: 'e'.repeat(64) }]) assert.equal(deliveryVerificationEligibility(f.scope, { ...f.evidence, ...patch }, f.candidate, [decision], policy).eligible, false);
  const review = buildDeliveryReview({ ...f.input, criterionDecisions: [decision], exceptionPolicy: policy });
  assert.equal(review.results[0].status, 'failed'); assert.equal(review.results[0].observedStatus, 'failed'); assert.ok(review.results[0].decisionRef);
  assert.match(review.markdown, /Authorized criterion decisions/); assert.match(review.markdown, /Actual check observations above remain unchanged/);
  assert.deepEqual(f.evidence, before);
  assertDeliveryAcceptance(review, { ...f.candidate, humanOutcomes: [], criterionDecisions: [decision], exceptionPolicy: policy });
  assert.throws(() => assertDeliveryAcceptance(review, { ...f.candidate, humanOutcomes: [], criterionDecisions: [decision] }), /passing evidence/);
});
test('not-applicable preserves its prior observation and only current policy can satisfy manual criteria', () => {
  const f = setup();
  const decision = recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'not_applicable', reason: 'Check not applicable to this exact candidate.' }, f.context);
  const review = buildDeliveryReview({ ...f.input, criterionDecisions: [decision], exceptionPolicy: policy, criteria: ['Inspect contrast manually.'] });
  assert.equal(review.results[0].status, 'not_applicable'); assert.equal(review.results[0].observedStatus, 'failed');
  const human = review.criteria.find(item => item.evaluator === 'human');
  const expanded = { ...policy, exemptibleCriteria: [human.id] };
  const manual = recordDeliveryCriterionDecision({ criterionId: human.id, kind: 'exempted', reason: 'Separate operator decision.' }, { ...f.context, criteria: review.criteria, policy: expanded, operationId: 'manual' });
  assert.throws(() => assertDeliveryAcceptance(review, { ...f.candidate, humanOutcomes: [{ criterionId: human.id, outcome: 'exempted', reason: 'Bare exemption', actor: 'operator', at }], criterionDecisions: [decision], exceptionPolicy: policy }), /human criterion/);
  assertDeliveryAcceptance(review, { ...f.candidate, humanOutcomes: [], criterionDecisions: [decision, manual], exceptionPolicy: expanded });
});
test('baseline observations disclose pre-existing failures without creating exceptions or leaking raw output', () => {
  const f = setup(), priorDigest = 'e'.repeat(64);
  f.evidence.baseline = { schemaVersion: 1, baseline: f.scope.baseCommit, checkDefinitionDigest: baselineCheckDigest(f.scope), sourceDigest: priorDigest, status: 'observed', observedAt: at, retainedWorktree: '/private/baseline', checks: [{ ...f.evidence.checks[0], candidateDigest: priorDigest }] };
  assert.throws(() => buildDeliveryReview(f.input), /current worker verification/);
  const decision = recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'exempted', reason: 'Explicit exception, distinct from baseline.' }, f.context);
  const review = buildDeliveryReview({ ...f.input, criterionDecisions: [decision], exceptionPolicy: policy });
  assert.equal(review.baselineComparison[0].classification, 'pre_existing');
  assert.doesNotMatch(JSON.stringify(review.baseline), /private stdout|private stderr|private\/baseline/);
  assert.ok(review.baseline.checks[0].stdoutDigest); assert.match(review.markdown, /pre-existing failure is diagnostic/);
  const corrupt = { ...f.evidence, baseline: { ...f.evidence.baseline, baseline: 'f'.repeat(40) } };
  assert.throws(() => buildDeliveryReview({ ...f.input, evidence: corrupt, criterionDecisions: [decision], exceptionPolicy: policy }), /baseline check/);
});
test('effective eligibility is a separate done-gate fact and custom observed-pass rules remain mandatory', () => {
  const policy = defaultGatePolicy(); policy.done.chat = [];
  assert.equal(evaluateGate(policy, 'done', 'chat', { 'output.verificationPassed': false }).passed, false);
  assert.equal(evaluateGate(policy, 'done', 'chat', { 'output.verificationPassed': false, 'output.verificationEligible': true }).passed, true);
  policy.done.chat.push({ id: 'project-observed-pass', fact: 'output.verificationPassed', op: 'eq', value: true });
  assert.equal(evaluateGate(policy, 'done', 'chat', { 'output.verificationPassed': false, 'output.verificationEligible': true }).passed, false);
});
test('review metrics count explicit failures and reported time, never missing observations as zero', () => {
  assert.deepEqual(humanReviewObservations([], 'a'.repeat(64)), []);
  const observed = humanReviewObservations([{ criterionId: 'human:1:0123456789ab', outcome: 'failed', reason: 'Observed contrast failure.', actor: 'operator', at }], 'a'.repeat(64), 2.5);
  assert.equal(observed[0].kind, 'human_review_failure'); assert.deepEqual(observed[1], { kind: 'review_effort', source: 'user_reported', durationMs: 150000 });
  for (const value of [-1, NaN, Infinity, 1441]) assert.throws(() => humanReviewObservations([], 'a'.repeat(64), value));
});

test('review package retains accepted source/outcome and filters model assessments from other candidates or evidence', async () => {
  const { gateDigest } = await import('../../src/worker/dist/worker/application/request-gates.js');
  const f = setup(); f.evidence.checks[0].status = 'passed'; f.evidence.checks[0].exitCode = 0;
  /** @type {import('../../src/worker/application/delivery-provider-contracts.js').DeliveryCandidateAssessment} */
  const assessment = { stepId: 'review', invocationRunId: 'review-invocation', profileId: 'reviewer', selection: { provider: 'claude-cli', model: null, effort: null, authenticationMode: 'cli-account' }, candidate: f.candidate, evidenceDigest: gateDigest(f.evidence), dispatchDigest: 'e'.repeat(64), at, passed: true, summary: 'Model reviewed the current candidate.', findings: [] };
  const details = { featureId: 'FR-42', sourcePath: 'features/FR-42.md', requestedOutcome: 'Preserve request-owned boundaries.', readinessSupplements: [{ id: 'approved', kind: /** @type {const} */ ('assumption'), text: 'Retain existing order.', status: 'accepted', reason: 'Team decision' }] };
  const review = buildDeliveryReview({ ...f.input, requestDetails: details, assessments: [assessment, { ...assessment, stepId: 'stale', candidate: { ...f.candidate, candidateDigest: 'f'.repeat(64) } }, { ...assessment, stepId: 'wrong-evidence', evidenceDigest: 'f'.repeat(64) }] });
  assert.deepEqual(review.assessments, [assessment]); assert.deepEqual(review.requestDetails, details);
  for (const text of ['features/FR-42.md', 'Preserve request-owned boundaries', 'Retain existing order', 'Model-reported implementation summary', 'Material deviations are not separately classified', 'review-invocation', 'does not replace deterministic']) assert.ok(review.markdown.includes(text), text);
  assert.throws(() => buildDeliveryReview({ ...f.input, assessments: [{ ...assessment, passed: false }] }), /provenance/);
});

test('criterion decisions and human outcomes reject coercible enums and candidate identity values', () => {
  const f = setup(), input = { criterionId: 'check:unit', kind: /** @type {const} */ ('exempted'), reason: 'Exact authorization.' };
  const malformed = value => [[value], { toString: () => value }];
  for (const value of malformed('exempted')) { const bad = { ...input }; Reflect.set(bad, 'kind', value); assert.throws(() => recordDeliveryCriterionDecision(bad, f.context)); }
  for (const field of ['requestId', 'runId', 'inputHash', 'candidateDigest', 'policyDigest', 'checkDefinitionDigest', 'baseline', 'candidateCommit']) for (const value of malformed(f.candidate[field])) {
    const candidate = { ...f.candidate }; Reflect.set(candidate, field, value); assert.throws(() => recordDeliveryCriterionDecision(input, { ...f.context, candidate }));
  }
  f.evidence.checks[0].status = 'passed'; f.evidence.checks[0].exitCode = 0;
  const review = buildDeliveryReview({ ...f.input, criteria: ['Inspect manually.'] }), criterionId = review.criteria.find(item => item.evaluator === 'human').id;
  for (const outcome of malformed('passed')) assert.throws(() => humanReviewOutcomes([{ criterionId, outcome, reason: 'Reviewed.' }], review, at));
});

test('exception permission catalogs enforce exact identifiers, documented size and detached results', () => {
  const complete = Array.from({ length: 128 }, (_, index) => 'check:rule-' + index);
  const configured = { exemptibleCriteria: complete, notApplicableCriteria: ['human:12:abcdef123456', 'check:x'] };
  const accepted = validateDeliveryCriterionExceptionPolicy(configured);
  assert.deepEqual(accepted, configured); accepted.exemptibleCriteria.pop(); assert.equal(configured.exemptibleCriteria.length, 128);
  for (const entries of [undefined, null, 'check:unit', [...complete, 'check:extra'], [['check:unit']], ['prefix:check:unit'], ['human:12:abcdef123456!'], ['human:1x:abcdef123456'], ['human:0:abcdef123456']])
    assert.throws(() => validateDeliveryCriterionExceptionPolicy({ ...policy, exemptibleCriteria: entries }), { code: 'invalid_input' });
});

test('new decisions reject malformed candidate subjects and operation metadata with stable boundary errors', () => {
  const f = setup(), input = { criterionId: 'check:unit', kind: /** @type {const} */ ('exempted'), reason: 'A bounded exception.' };
  for (const [field, bad] of [['requestId', ''], ['runId', ''], ['inputRevision', 0], ['inputRevision', 1.5], ['inputRevision', Number.MAX_SAFE_INTEGER + 1], ...['inputHash', 'candidateDigest', 'policyDigest', 'checkDefinitionDigest'].flatMap(field => [[field, 'g' + 'a'.repeat(64)], [field, 'a'.repeat(64) + '!']]), ...['baseline', 'candidateCommit'].flatMap(field => [[field, '!' + 'a'.repeat(40)], [field, 'a'.repeat(40) + '!'], [field, 'a'.repeat(41)], [field, 'a'.repeat(39)]])]) {
    const candidate = { ...f.candidate }; Reflect.set(candidate, field, bad);
    assert.throws(() => recordDeliveryCriterionDecision(input, { ...f.context, candidate }), { code: 'invalid_input' });
  }
  const sha256Candidate = { ...f.candidate, baseline: '4'.repeat(64), candidateCommit: '5'.repeat(64) };
  assert.equal(recordDeliveryCriterionDecision(input, { ...f.context, candidate: sha256Candidate }).subject.baseline, sha256Candidate.baseline, 'SHA-256 Git object IDs remain valid');
  for (const metadata of [{ operationId: '!prefix' }, { operationId: 'suffix!' }, { operationId: 'x'.repeat(101) }, { at: 'invalid date' }])
    assert.throws(() => recordDeliveryCriterionDecision(input, { ...f.context, ...metadata }), { code: 'invalid_input' });
  for (const patch of [{ criterionId: 'not-a-criterion' }, { criterionId: 'check:unit!' }, { kind: 'pass' }]) {
    const bad = { ...input }; Object.assign(bad, patch); assert.throws(() => recordDeliveryCriterionDecision(bad, f.context), { code: 'invalid_input' });
  }
  assert.throws(() => recordDeliveryCriterionDecision(input, { ...f.context, policy: undefined }), { code: 'conflict' });
});

test('not-applicable and exemption are independent permissions, and current receipts retain complete bounded reasons', () => {
  const f = setup(), onlyNA = { exemptibleCriteria: [], notApplicableCriteria: ['check:unit'] };
  const decision = recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'not_applicable', reason: 'x'.repeat(4000) }, { ...f.context, policy: onlyNA, operationId: 'x'.repeat(100) });
  assert.equal(deliveryCriterionDecision('check:unit', f.candidate, [decision], onlyNA), decision);
  assert.throws(() => recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'exempted', reason: 'Different authority.' }, { ...f.context, policy: onlyNA }), { code: 'conflict' });
  for (const patch of [{ reason: ' ' }, { reason: 'x'.repeat(4001) }, { reason: 7 }, { operationId: '!prefix' }, { operationId: 'suffix!' }, { criterionId: 'check:other' }]) {
    const bad = { ...decision }; Object.assign(bad, patch); assert.equal(deliveryCriterionDecision('check:unit', f.candidate, [bad], onlyNA), undefined);
  }
  const malformed = /** @type {typeof decision[]} */ (JSON.parse('[null]'));
  assert.equal(deliveryCriterionDecision('check:unit', f.candidate, malformed, onlyNA), undefined);
  assert.equal(deliveryCriterionDecision('check:unit', f.candidate, undefined, onlyNA), undefined);
});

test('every required check needs a current observation or its own decision; foreign baselines and empty check sets cannot waive failure', () => {
  const f = setup();
  const scope = { ...f.scope, checks: [...f.scope.checks, { ...f.scope.checks[0], id: 'types', name: 'Type checks' }] };
  const candidate = { ...f.candidate, checkDefinitionDigest: deliveryCheckDefinitionDigest(scope) };
  const decision = recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'exempted', reason: 'Only the unit failure is approved.' }, { ...f.context, candidate });
  const evidence = { ...f.evidence, checks: [...f.evidence.checks, { ...f.evidence.checks[0], presetId: 'types', status: /** @type {const} */ ('passed'), exitCode: 0 }] };
  assert.equal(deliveryVerificationEligibility(scope, evidence, candidate, [decision], policy).eligible, true);
  assert.equal(deliveryVerificationEligibility(scope, { ...evidence, checks: evidence.checks.map(check => ({ ...check, status: /** @type {const} */ ('failed'), exitCode: 1 })) }, candidate, [decision], policy).eligible, false);
  const foreign = { ...candidate, baseline: '6'.repeat(40) }, foreignDecision = recordDeliveryCriterionDecision({ criterionId: 'check:unit', kind: 'exempted', reason: 'Approved on another baseline.' }, { ...f.context, candidate: foreign });
  assert.equal(deliveryVerificationEligibility(scope, evidence, foreign, [foreignDecision], policy).eligible, false);
  assert.equal(deliveryVerificationEligibility(scope, evidence, undefined, [decision], policy).eligible, false);
  assert.equal(deliveryVerificationEligibility({ ...scope, checks: [] }, { ...evidence, checks: [] }, candidate, [], policy).eligible, false);
});
