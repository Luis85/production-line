import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryReadinessView, readinessAssessment, decideReadinessProposal, validateDeliveryReadinessPolicy, validateDeliveryReadinessResult, validateDeliveryReadinessReferences } from '../../src/worker/dist/worker/application/delivery-readiness.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, deliveryGatePolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { advisoryResult } from '../../src/worker/dist/worker/application/request-review-protocol.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { fixture, provider, dispatch } from './request-gate-fixtures.mjs';
import { parseFeature, featureInput } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { markdownCommands } from '../../src/worker/dist/worker/infrastructure/features/markdown-contract.js';
import { featureInputHash } from '../../src/worker/dist/worker/application/feature-markdown.js';
const at = '2026-10-20T12:00:00.000Z';
const subject = { inputRevision: 1, inputHash: 'a'.repeat(64), policyDigest: 'b'.repeat(64) };
/** @type {import('../../src/worker/application/delivery-readiness.js').DeliveryReadinessPolicy} */
const policy = { assessment: 'required', assumptions: 'explicit', requiredReferences: [], maxEstimatedMinutes: 60 };
/** @returns {import('../../src/worker/application/delivery-readiness.js').DeliveryReadinessResult} */
const result = () => ({ conditions: ['outcome', 'criteria', 'scope'].map(id => ({ id: /** @type {'outcome'|'criteria'|'scope'} */ (id), outcome: 'pass', reason: 'Specified and testable.' })), estimatedMinutes: 30, proposals: [{ id: 'wording', kind: 'assumption', text: 'Use the current display order.', impact: 'low', blockingQuestionIds: [] }] });
const assessment = () => readinessAssessment(result(), subject, { kind: 'model', id: 'reviewer' }, 'assessment', at);
test('structured readiness is explicit, bounded and cannot claim deterministic observations', () => {
  assert.deepEqual(validateDeliveryReadinessPolicy(policy), policy);
  for (const patch of [{ assumptions: 'invent' }, { requiredReferences: ['../secret'] }, { requiredReferences: ['Readme.md', 'README.md'] }, { maxEstimatedMinutes: 0 }, { commands: ['rm'] }]) assert.throws(() => validateDeliveryReadinessPolicy({ ...policy, ...patch }));
  for (const patch of [{ conditions: result().conditions.slice(1) }, { conditions: [result().conditions[0], result().conditions[0], result().conditions[2]] }, { testsPassed: true }, { proposals: [{ ...result().proposals[0], blockingQuestionIds: ['same', 'same'] }] }]) assert.throws(() => validateDeliveryReadinessResult({ ...result(), ...patch }));
  assert.equal(deliveryReadinessView(undefined, subject).configured, false);
  assert.equal(deliveryReadinessView(undefined, subject).passed, true, 'retained legacy profiles stay compatible');
  assert.equal(deliveryReadinessView(policy, subject).passed, false, 'a configured semantic assessment is mandatory');
});
test('low-impact permission never adopts a material proposal or answers a blocking question', () => {
  const original = assessment(); original.result.conditions[0].outcome = 'unknown';
  original.result.proposals.push({ ...result().proposals[0], id: 'material', impact: 'material' }, { ...result().proposals[0], id: 'unanswered', blockingQuestionIds: ['Q1'] });
  const state = { assessments: [original], decisions: [] }, permissive = { ...policy, assumptions: /** @type {const} */ ('allow_low_impact') };
  const view = deliveryReadinessView(permissive, subject, state);
  assert.equal(view.passed, false); assert.deepEqual(view.proposals.map(item => item.status), ['policy_permitted', 'proposed', 'proposed']);
  assert.throws(() => decideReadinessProposal(state, subject, { assessmentId: original.id, proposalId: 'unanswered', outcome: 'accepted', reason: 'Assume yes', operationId: 'op' }, at), /blocking questions/);
  const rejection = decideReadinessProposal(state, subject, { assessmentId: original.id, proposalId: 'wording', outcome: 'rejected', reason: 'Preserve exact source order.', operationId: 'no' }, at);
  assert.equal(deliveryReadinessView(permissive, subject, { ...state, decisions: [rejection] }).proposals[0].status, 'rejected');
});
test('decisions and assessments expire with input, policy or later assessment, while estimates and references remain separate', () => {
  const state = { assessments: [assessment()], decisions: [] };
  const decision = decideReadinessProposal(state, subject, { assessmentId: 'assessment', proposalId: 'wording', outcome: 'accepted', reason: 'Approved by the team.', operationId: 'yes' }, at);
  assert.equal(deliveryReadinessView(policy, subject, { ...state, decisions: [decision] }).proposals[0].status, 'accepted');
  for (const patch of [{ inputRevision: 2 }, { inputHash: 'c'.repeat(64) }, { policyDigest: 'c'.repeat(64) }]) {
    assert.equal(deliveryReadinessView(policy, { ...subject, ...patch }, state).passed, false);
    assert.throws(() => decideReadinessProposal(state, { ...subject, ...patch }, { assessmentId: 'assessment', proposalId: 'wording', outcome: 'accepted', reason: 'Stale', operationId: 'yes' }, at), /earlier assessment/);
  }
  const later = { ...assessment(), id: 'later' };
  assert.equal(deliveryReadinessView(policy, subject, { assessments: [assessment(), later], decisions: [decision] }).proposals[0].status, 'proposed');
  const baseline = 'd'.repeat(40), reference = { path: 'docs/design.md', baseline, status: /** @type {const} */ ('available'), reason: 'Worker read the committed reference.', sha256: 'e'.repeat(64), observedAt: at };
  const required = { ...policy, requiredReferences: [reference.path] };
  assert.equal(deliveryReadinessView(required, subject, state, [reference], baseline).passed, true);
  assert.equal(deliveryReadinessView(required, subject, state, [reference], 'f'.repeat(40)).passed, false);
  for (const estimatedMinutes of [null, 61]) assert.equal(deliveryReadinessView(policy, subject, { assessments: [{ ...assessment(), result: { ...result(), estimatedMinutes } }], decisions: [] }).passed, false);
});
async function readyFixture(t) {
  const { journal } = await fixture(t), configuration = defaultDeliveryProjectPolicy();
  configuration.profiles[0].readiness = structuredClone(policy);
  const snapshot = deliveryPolicySnapshot(configuration, '1'.repeat(40));
  const request = journal.ensure({ owner: { sessionId: 'semantic', rootTurnId: 'root' }, provider, policy: deliveryGatePolicy(defaultGatePolicy(), snapshot), input: { kind: 'chat', title: 'Clarify delivery', message: 'Explain exactly how the accepted delivery works.', criteria: ['Every mandatory gate is visible.'], context: { deliveryPolicy: snapshot } } });
  assert.equal(journal.evaluate(request.id, 'ready').passed, false);
  const intent = journal.queuedReviews()[0]; journal.startReview(request.id, intent.id, 'review-run', dispatch());
  return { journal, request, intent };
}
test('a current typed reviewer result advances the canonical ready gate, and replay never reevaluates or emits new events', async t => {
  const { journal, request, intent } = await readyFixture(t);
  const completion = { summary: 'Judged ready.', findings: [], readiness: result() };
  const ready = journal.completeReview(request.id, intent.id, completion, unknownUsage());
  assert.equal(ready.phase, 'ready'); assert.equal(ready.evaluations.at(-1).readiness.passed, true);
  const events = journal.events(request.id).events;
  journal.completeReview(request.id, intent.id, completion, unknownUsage());
  assert.deepEqual(journal.events(request.id).events, events);
  const command = { action: /** @type {const} */ ('readiness_decision'), requestId: ready.id, expectedRevision: ready.revision, operationId: 'adopt', inputRevision: ready.inputRevision, inputHash: ready.inputHash, assessmentId: intent.id, proposalId: 'wording', decision: /** @type {const} */ ('accepted'), note: 'Team approved this precise interpretation.' };
  assert.equal(journal.command(command).request.readiness.decisions[0].outcome, 'accepted');
  assert.equal(journal.command(command).duplicate, true);
  assert.throws(() => journal.command({ ...command, operationId: 'stale' }), /request changed/);
});
test('an unresolved reviewer question keeps a semantic pass blocked and records one actual clarification cycle', async t => {
  const { journal, request, intent } = await readyFixture(t);
  const completion = { summary: 'Missing product choice.', findings: [{ kind: /** @type {const} */ ('question'), blocking: true, message: 'Should archived records be included?' }], readiness: result() };
  const waiting = journal.completeReview(request.id, intent.id, completion, unknownUsage());
  assert.equal(waiting.phase, 'needs_rework'); assert.equal(waiting.evaluations.at(-1).passed, false);
  const event = journal.events(request.id).events.find(event => event.type === 'review_completed');
  assert.equal(event.measurement.observations.length, 1);
  assert.equal(event.measurement.observations[0].kind, 'clarification');
  assert.equal(event.measurement.observations[0].cycleId, intent.id);
  journal.completeReview(request.id, intent.id, completion, unknownUsage());
  assert.equal(journal.events(request.id).events.filter(event => event.type === 'review_completed').length, 1);
});
test('review protocol requires structured judgments only for configured readiness and keeps candidate text a proposal', () => {
  const configuration = defaultDeliveryProjectPolicy(); configuration.profiles[0].readiness = policy;
  const input = { kind: /** @type {const} */ ('chat'), title: 'Bounded request', message: 'Original accepted intent', criteria: ['Keep explicit scope'], context: { deliveryPolicy: deliveryPolicySnapshot(configuration, '1'.repeat(40)) } };
  const raw = { schemaVersion: 1, findings: [], readiness: result(), candidate: { message: 'Proposed clearer wording' } };
  assert.equal(advisoryResult({ type: 'completed', text: JSON.stringify(raw) }, input, 'ready', 'review').candidate.message, raw.candidate.message);
  assert.equal(input.message, 'Original accepted intent');
  assert.throws(() => advisoryResult({ type: 'completed', text: JSON.stringify({ ...raw, readiness: undefined }) }, input, 'ready', 'review'), /Invalid provider response/);
  assert.throws(() => advisoryResult({ type: 'completed', text: JSON.stringify(raw) }, input, 'done', 'review'), /Invalid provider response/);
});
test('Markdown decisions carry exact subjects and do not mutate semantic requirements', () => {
  const source = extra => `---\nschema: worker.request/v1\nid: FR-42\ntitle: Readiness\nintent: submit\npaths: [src/]\n${extra}---\n## Outcome\n\nImplement the agreed behavior.\n\n## Acceptance criteria\n\n- The value is readable.\n`;
  const metadata = `readiness_decision:\n  command_id: decide-1\n  request_revision: 1\n  input_hash: ${subject.inputHash}\n  assessment_id: assessment\n  proposal_id: wording\n  decision: accepted\n  note: Agreed by the team.\ncriterion_decision:\n  command_id: exempt-1\n  request_revision: 1\n  run_id: run-one\n  candidate_commit: ${'a'.repeat(40)}\n  criterion_id: check:unit\n  kind: not_applicable\n  reason: This criterion does not apply to the approved change.\n`;
  const commands = markdownCommands(parseFeature(source(metadata)));
  assert.deepEqual(commands.map(item => item.action), ['readiness_decision', 'criterion_decision']);
  assert.equal(commands[0].inputHash, subject.inputHash); assert.equal(commands[1].criterionDecision.kind, 'not_applicable');
  assert.equal(featureInputHash(featureInput(parseFeature(source('')), 'claude-cli')), featureInputHash(featureInput(parseFeature(source(metadata)), 'claude-cli')));
  for (const replacement of [metadata.replace('  input_hash: ' + subject.inputHash + '\n', ''), metadata.replace('  request_revision: 1', '  request_revision: 0'), metadata.replace('check:unit', 'check:*')]) assert.throws(() => markdownCommands(parseFeature(source(replacement))));
});

test('ready reviewer callback releases the execution permit before dispatch and never replays a saved result on callback failure', async () => {
  const { reviewerFixture, waitForRequestReview: wait } = await import('./request-review-fixtures.mjs');
  const { RequestReviewManager } = await import('../../src/worker/dist/worker/application/request-review.js');
  const { modelCapabilities } = await import('../../src/worker/dist/worker/application/model-contract.js');
  const f = reviewerFixture(), configuration = defaultDeliveryProjectPolicy(); configuration.profiles[0].readiness = policy;
  f.request.input.context = { deliveryPolicy: deliveryPolicySnapshot(configuration, '1'.repeat(40)) };
  const complete = f.gates.completeReview;
  f.gates.completeReview = (...args) => { complete(...args); f.request.phase = 'ready'; return structuredClone(f.request); };
  let modelCalls = 0, dispatchCalls = 0;
  const manager = new RequestReviewManager({ gates: f.gates, runs: f.runs, executor: f.executor, maxRuntimeMs: () => 1000,
    model: () => ({ configuration: f.intent.provider, capabilities: modelCapabilities, async reply() { throw Error('Legacy path must not run'); }, async execute() { modelCalls++; return { type: 'completed', text: JSON.stringify({ schemaVersion: 1, findings: [], readiness: result() }) }; } }),
    async onReady(id) { assert.equal(id, f.request.id); const release = await f.executor.acquire(f.request.owner.sessionId, AbortSignal.timeout(500)); release(); dispatchCalls++; throw Error('Admission write unavailable'); },
  });
  manager.tick(); await wait(() => manager.snapshot().active === null && dispatchCalls === 1);
  assert.equal(modelCalls, 1); assert.match(manager.snapshot().dispatchError, /assessment is saved/);
  manager.tick(); await manager.close(); assert.equal(modelCalls, 1); assert.equal(dispatchCalls, 1);
});

test('accepted supplements reach the shared dispatch and review context; unapproved and stale proposals do not', async t => {
  const { readinessContextMessages } = await import('../../src/worker/dist/worker/application/delivery-readiness-context.js');
  const { deliveryRequestDetails } = await import('../../src/worker/dist/worker/application/delivery-review-context.js');
  const { journal, request, intent } = await readyFixture(t);
  let ready = journal.completeReview(request.id, intent.id, { summary: 'Ready with an optional interpretation.', findings: [], readiness: result() }, unknownUsage());
  assert.deepEqual(readinessContextMessages(ready), []);
  ready = journal.command({ action: 'readiness_decision', requestId: ready.id, expectedRevision: ready.revision, operationId: 'adopt-context', inputRevision: ready.inputRevision, inputHash: ready.inputHash, assessmentId: intent.id, proposalId: 'wording', decision: 'accepted', note: 'Exact interpretation approved.' }).request;
  const message = readinessContextMessages(ready);
  assert.equal(message.length, 1); assert.match(message[0].text, /Use the current display order/); assert.match(message[0].text, /do not expand approved scope/);
  assert.equal(deliveryRequestDetails(ready).readinessSupplements[0].status, 'accepted');
  const changed = { ...ready, inputRevision: ready.inputRevision + 1 };
  assert.deepEqual(readinessContextMessages(changed), []); assert.deepEqual(deliveryRequestDetails(changed).readinessSupplements, []);
});
test('deterministic readiness clarification records a first actionable cycle once, not a polling counter', async t => {
  const { journal } = await fixture(t), configuration = defaultDeliveryProjectPolicy(), snapshot = deliveryPolicySnapshot(configuration, '1'.repeat(40));
  const policy = deliveryGatePolicy(defaultGatePolicy(), snapshot); policy.reviewer.enabled = false;
  const request = journal.ensure({ owner: { sessionId: 'missing-input', rootTurnId: 'root' }, provider, policy, input: { kind: 'chat', title: 'Missing criteria', message: 'Too short', criteria: [] } });
  journal.evaluate(request.id, 'ready');
  const observations = journal.events(request.id).events.flatMap(item => item.measurement?.observations ?? []);
  assert.ok(observations.some(item => item.kind === 'clarification' && item.cause === 'acceptance_criteria'));
  assert.ok(observations.every(item => item.kind !== 'clarification' || item.cycleId === 'input-1'));
  for (let i = 0; i < 5; i++) journal.evaluate(request.id, 'ready');
  assert.deepEqual(journal.events(request.id).events.flatMap(item => item.measurement?.observations ?? []), observations);
});

test('readiness enums and provenance reject coercible arrays and objects before persistence', () => {
  const malformed = value => [[value], { toString: () => value }];
  for (const value of malformed('explicit')) assert.throws(() => validateDeliveryReadinessPolicy({ ...policy, assumptions: value }));
  for (const [field, valid] of [['outcome', 'pass'], ['id', 'outcome']]) for (const value of malformed(valid)) {
    const raw = result(); Reflect.set(raw.conditions[0], field, value); assert.throws(() => validateDeliveryReadinessResult(raw));
  }
  for (const [field, valid] of [['kind', 'assumption'], ['impact', 'low']]) for (const value of malformed(valid)) {
    const raw = result(); Reflect.set(raw.proposals[0], field, value); assert.throws(() => validateDeliveryReadinessResult(raw));
  }
  for (const value of malformed('available')) assert.throws(() => validateDeliveryReadinessReferences([{ path: 'docs/design.md', baseline: '1'.repeat(40), status: value, sha256: 'a'.repeat(64), observedAt: at, reason: 'Observed.' }]));
  for (const field of ['inputHash', 'policyDigest']) for (const value of malformed(subject[field])) {
    const raw = { ...subject }; Reflect.set(raw, field, value); assert.throws(() => readinessAssessment(result(), raw, { kind: 'model', id: 'reviewer' }, 'assessment', at));
  }
});
