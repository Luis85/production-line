import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { deliveryHumanOutcomes, deliveryHumanReviewReady, humanReviewDraftKey } = await frontend('src/worker/webview/delivery-human-review.ts');
const { deliveryControlNotice, deliveryNextStep } = await frontend('src/worker/webview/delivery-view.ts');
const { acceptedDeliveryPolicy } = await frontend('src/worker/webview/delivery-policy-view.ts');
const { readRequestSummaries } = await frontend('src/worker/webview/request-summary-reader.ts');
/** @returns {import('../../../src/worker/application/delivery-review-contracts').DeliveryReviewPackage} */
function review() {
  return {
    schemaVersion: 1, candidate: { requestId: 'request', inputRevision: 2, inputHash: 'input', runId: 'delivery', baseline: 'base', branch: 'branch', candidateCommit: 'candidate', tree: 'tree', candidateDigest: 'digest', patchDigest: 'patch', policyDigest: 'policy', checkDefinitionDigest: 'checks', createdAt: '2026-10-20T10:00:00Z' },
    criteria: [{ id: 'human:behavior', description: 'Inspect the behavior', mandatory: true, evaluator: 'human' }, { id: 'check:test', description: 'Required test', mandatory: true, evaluator: 'check', checkId: 'test' }],
    results: [{ criterionId: 'human:behavior', status: 'pending_human', evidenceRefs: [] }, { criterionId: 'check:test', status: 'passed', evidenceRefs: ['receipt'] }],
    checks: [], markdown: '# Review', publication: 'local_only',
  };
}
test('human review requires observed passing outcomes and current check evidence, not a general acceptance note', () => {
  const value = review(), drafts = new Map(), read = key => drafts.get(key) ?? '';
  assert.equal(deliveryHumanReviewReady(value, read), false);
  drafts.set(humanReviewDraftKey(value, 'human:behavior', 'outcome'), 'passed');
  assert.equal(deliveryHumanReviewReady(value, read), false, 'an unexplained pass is not a human observation');
  drafts.set(humanReviewDraftKey(value, 'human:behavior', 'reason'), 'Observed equal-date ordering.');
  assert.equal(deliveryHumanReviewReady(value, read), true);
  for (const status of ['unknown', 'stale', 'failed', 'not_applicable', 'pending_human']) {
    value.results[1].status = /** @type {import('../../../src/worker/application/delivery-review-contracts').DeliveryCriterionStatus} */ (status);
    assert.equal(deliveryHumanReviewReady(value, read), false, status + ' cannot pass a mandatory check');
  }
});
test('review observations are candidate-scoped and never manufacture actor identity or exemption authority', () => {
  const value = review(), drafts = new Map(), read = key => drafts.get(key) ?? '';
  drafts.set(humanReviewDraftKey(value, 'human:behavior', 'outcome'), 'passed');
  drafts.set(humanReviewDraftKey(value, 'human:behavior', 'reason'), '  Inspected behavior.  ');
  assert.deepEqual(deliveryHumanOutcomes(value, read), [{ criterionId: 'human:behavior', outcome: 'passed', reason: 'Inspected behavior.' }]);
  const changed = structuredClone(value); changed.candidate.candidateCommit = 'new-commit';
  assert.deepEqual(deliveryHumanOutcomes(changed, read), []);
  drafts.set(humanReviewDraftKey(value, 'human:behavior', 'outcome'), 'exempted');
  assert.deepEqual(deliveryHumanOutcomes(value, read), []);
  drafts.set(humanReviewDraftKey(value, 'human:behavior', 'outcome'), 'failed');
  assert.equal(deliveryHumanReviewReady(value, read), false);
  assert.equal(deliveryHumanOutcomes(value, read)[0].outcome, 'failed');
});
/** @returns {import('../../../src/worker/application/delivery-contracts').DeliveryRun} */
function run() {
  return { schemaVersion: 1, id: 'delivery', inputRevision: 1, inputHash: 'input', policyDigest: 'policy', profile: { schemaVersion: 1, id: 'profile', version: 1, root: { type: 'action', id: 'pause', action: 'wait', reason: 'Pause recorded' } }, profileDigest: 'profile', status: 'pause_pending', phase: 'implementing', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2, startedAt: '2026-10-20T10:00:00Z', finishedAt: null, steps: [], decision: { profileId: 'profile', profileVersion: 1, selectedNode: 'pause', selectedAction: 'wait', reason: 'Pause recorded', waitingFor: 'A safe boundary', conditions: [] }, allowedControls: ['interrupt', 'cancel'] };
}
test('control feedback distinguishes pending effects, unknown outcomes and completed work', () => {
  const value = run();
  assert.match(deliveryControlNotice(value), /may still be running/);
  assert.equal(deliveryNextStep(value).actor, 'worker');
  value.status = 'interrupting'; assert.match(deliveryControlNotice(value), /confirm.*stopped/);
  value.status = 'outcome_unknown'; value.allowedControls = [];
  assert.equal(deliveryNextStep(value).action, undefined);
  assert.match(deliveryNextStep(value).description, /must wait for reconciliation/);
  value.status = 'paused'; value.allowedControls = ['resume'];
  assert.equal(deliveryNextStep(value).action.kind, 'delivery_controls');
  value.status = 'completed'; assert.equal(deliveryNextStep(value), null, 'completion still needs the review decision path');
});
test('overview follows pagination and rejects a stuck cursor instead of silently truncating requests', async () => {
  const calls = [];
  const rows = [{ id: 'first' }, { id: 'second' }];
  const read = async (_path, _method, body) => { calls.push(body); return body.offset === 0 ? { rows: [rows[0]], nextOffset: 100 } : { rows: [rows[1]], nextOffset: null }; };
  assert.deepEqual(await readRequestSummaries(read), rows);
  assert.deepEqual(calls.map(call => call.offset), [0, 100]);
  await assert.rejects(readRequestSummaries(async () => ({ rows: [], nextOffset: 0 })), /cursor did not advance/);
  await assert.rejects(readRequestSummaries(async () => ({ nextOffset: null })), /summaries are unavailable/);
});
test('accepted policy display remains absent for legacy or malformed retained context', () => {
  for (const context of [null, [], {}, { deliveryPolicy: {} }, { deliveryPolicy: { schemaVersion: 1, baseline: 'base', configurationDigest: 'digest', profile: { id: 'feature', maxRepairAttempts: 2, verificationInputs: [null] }, configuration: { reviewDirectory: 'reviews' } } }])
    assert.equal(acceptedDeliveryPolicy(context), null);
  const context = { deliveryPolicy: { schemaVersion: 1, baseline: 'base', configurationDigest: 'digest', profile: { id: 'feature', maxRepairAttempts: 2, verificationInputs: ['tests/'] }, configuration: { reviewDirectory: 'reviews' } } };
  assert.equal(acceptedDeliveryPolicy(context), context.deliveryPolicy);
});
