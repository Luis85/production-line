import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryAccepted } from '../../../.mutation-build/worker/application/delivery-acceptance.js';
import { sharedLocalMergePhase } from '../../../.mutation-build/worker/application/shared-local-merge-projection.js';
import { localMergeBaselineHold } from '../../../.mutation-build/worker/application/local-merge-baseline.js';
import { localRequest } from './workflow-local-fixture.mjs';

/** @typedef {ReturnType<typeof localRequest>} Request */
/** Independently retained Git observation; neither a phase label nor a successful command creates it.
 * @returns {import('../../../src/worker/application/local-merge-contracts.ts').LocalMergeReceipt} */
function mergeReceipt() {
  return { branch: 'main', previousHead: '1'.repeat(40), candidateCommit: '2'.repeat(40), mergeCommit: 'b'.repeat(40), tree: 'c'.repeat(40), mergedAt: '2026-10-25T00:01:00.000Z' };
}
/** @param {Request} request @param {import('../../../src/worker/application/local-merge-contracts.ts').LocalMergeOperation['status']} status
 * @returns {import('../../../src/worker/application/local-merge-contracts.ts').LocalMergeOperation} */
function operation(request, status) {
  return { operationId: 'local-projection', status, repositoryId: 'repo-one', checkoutPath: '/assigned/project', mainBranch: 'main', mainHead: '1'.repeat(40), candidate: structuredClone(request.delivery.review.candidate), createdAt: request.createdAt, updatedAt: request.updatedAt, detail: 'Retained main checkout observation.' };
}
/** @type {Array<[string, (request: Request) => void]>} */
const holds = [
  ['process recovery', request => { request.recoveryHold = { code: 'interrupted', at: request.updatedAt }; }],
  ['canonical source', request => { request.deliveryHolds = [{ code: 'source_changed', reason: 'The accepted source changed.' }]; }],
  ['delivery prerequisite', request => { request.delivery.holds = [{ code: 'provider', reason: 'Provider sign-in is required.' }]; }],
  ['operator control', request => { request.delivery.control = { action: 'cancel', operationId: 'cancel-request', at: request.updatedAt }; }],
];

// A copied attestation and a terminal gate are independent retained facts.
test('shared acceptance needs both a done gate and an attestation, without inventing a main checkout merge', () => {
  assert.equal(sharedLocalMergePhase(localRequest()), 'accepted');
  const doneWithoutAttestation = localRequest(); doneWithoutAttestation.attestation = null;
  assert.equal(sharedLocalMergePhase(doneWithoutAttestation), null);
  const missingAttestation = localRequest(); Reflect.deleteProperty(missingAttestation, 'attestation');
  assert.equal(sharedLocalMergePhase(missingAttestation), null);
  const attestedBeforeDone = localRequest(); attestedBeforeDone.phase = 'review';
  assert.ok(attestedBeforeDone.attestation); assert.equal(sharedLocalMergePhase(attestedBeforeDone), null);
  const heldBeforeDone = localRequest(); heldBeforeDone.phase = 'running'; holds[0][1](heldBeforeDone);
  assert.equal(sharedLocalMergePhase(heldBeforeDone), null, 'an unresolved pre-acceptance request is not presented as an active merge');
});

test('every active merge hold outranks operation status while a request is not yet integrated', () => {
  const statuses = /** @type {const} */ (['pending', 'unknown', 'failed', 'not_observed', 'confirmed']);
  for (const [name, hold] of holds) {
    const accepted = localRequest(); hold(accepted);
    assert.equal(sharedLocalMergePhase(accepted), 'merge_blocked', name + ' blocks an accepted request without an operation');
    for (const status of statuses) {
      const request = localRequest(); request.phase = 'review'; request.attestation = null;
      request.delivery.localMerge = { operations: [operation(request, status)] }; hold(request);
      assert.equal(sharedLocalMergePhase(request), 'merge_blocked', name + ' blocks a retained ' + status + ' operation independently of acceptance');
    }
  }
});

test('a confirmed operation alone cannot claim integration, and later holds do not erase a retained merge receipt', () => {
  const unobserved = localRequest(); unobserved.delivery.localMerge = { operations: [operation(unobserved, 'confirmed')] };
  assert.equal(sharedLocalMergePhase(unobserved), 'merge_failed', 'successful operation metadata without the merge receipt is incomplete evidence');
  for (const [name, hold] of holds) {
    const integrated = localRequest(); integrated.delivery.localMerge = { operations: [], merged: mergeReceipt() }; hold(integrated);
    assert.equal(sharedLocalMergePhase(integrated), 'done', name + ' changes future authority without undoing the observed checkout merge');
  }
});

test('legacy accepted gate notes without a delivery history stay readable but never authorize integration', () => {
  for (const absent of [undefined, null]) {
    const request = localRequest(); Reflect.set(request, 'delivery', absent);
    assert.equal(sharedLocalMergePhase(request), 'accepted', 'the retained gate may be accepted without claiming a confirmed merge');
    assert.equal(deliveryAccepted(request), false, 'missing delivery provenance cannot grant merge or release authority');
    request.attestation = null;
    assert.equal(sharedLocalMergePhase(request), null);
  }
});

test('missing invocation and partial legacy attestation records fail closed without throwing', () => {
  assert.equal(deliveryAccepted(localRequest()), true);
  for (const absent of [undefined, null]) {
    const request = localRequest(); Reflect.set(request, 'execution', absent);
    assert.equal(deliveryAccepted(request), false, 'an attestation cannot substitute for the invocation record');
    const partialReceipt = localRequest(); Reflect.deleteProperty(partialReceipt.attestation, 'outputDigest'); Reflect.set(partialReceipt, 'execution', absent);
    assert.equal(deliveryAccepted(partialReceipt), false, 'a partial historical attestation and absent execution do not establish exact-output acceptance');
  }
});

test('a completed invocation with no result or no current candidate remains unavailable for integration', () => {
  for (const absent of [undefined, null]) {
    const missingResult = localRequest(); Reflect.set(missingResult.execution, 'result', absent);
    assert.equal(deliveryAccepted(missingResult), false, 'completion metadata alone cannot replace the saved model result');
    const missingRun = localRequest(); Reflect.set(missingRun, 'delivery', absent);
    assert.equal(deliveryAccepted(missingRun), false);
    const missingReview = localRequest(); Reflect.set(missingReview.delivery, 'review', absent);
    assert.equal(deliveryAccepted(missingReview), false);
    const missingCandidate = localRequest(); Reflect.set(missingCandidate.delivery.review, 'candidate', absent);
    assert.equal(deliveryAccepted(missingCandidate), false);
  }
});

test('partial legacy baseline records neither block unrelated projects nor invent an ancestry observation', async () => {
  const rows = [];
  for (const absent of [undefined, null]) {
    const missingContext = localRequest(); Reflect.set(missingContext.input, 'context', absent); missingContext.delivery.localMerge = { operations: [operation(missingContext, 'unknown')] }; rows.push(missingContext);
    const missingDelivery = localRequest(); Reflect.set(missingDelivery, 'delivery', absent); rows.push(missingDelivery);
    const missingState = localRequest(); Reflect.set(missingState.delivery, 'localMerge', absent); rows.push(missingState);
  }
  const noContext = localRequest(); Reflect.deleteProperty(noContext.input, 'context'); rows.push(noContext);
  const noDelivery = localRequest(); Reflect.deleteProperty(noDelivery, 'delivery'); rows.push(noDelivery);
  const noState = localRequest(); Reflect.deleteProperty(noState.delivery, 'localMerge'); rows.push(noState);
  const observations = [];
  const contains = async (commit, baseline) => { observations.push([commit, baseline]); return true; };
  const before = structuredClone(rows);
  assert.equal(await localMergeBaselineHold(rows, 'repo-one', 'd'.repeat(40), contains), null);
  assert.deepEqual(observations, [], 'missing or unowned history never prompts a Git lookup'); assert.deepEqual(rows, before, 'observing legacy state never repairs or mutates it');
  const merged = localRequest(); merged.delivery.localMerge = { operations: [], merged: mergeReceipt() };
  assert.equal(await localMergeBaselineHold([...rows, merged], 'repo-one', 'd'.repeat(40), contains), null);
  assert.deepEqual(observations, [['b'.repeat(40), 'd'.repeat(40)]], 'legacy gaps do not hide another request’s real merge ancestry');
  assert.match(await localMergeBaselineHold([...rows, merged], 'repo-one', 'd'.repeat(40), async () => false), /Publish or synchronize/);
});
