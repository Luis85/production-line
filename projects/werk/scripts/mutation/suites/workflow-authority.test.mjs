import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseAccepted } from '../../../.mutation-build/worker/application/release-view.js';
import { remotePublicationPredecessor } from '../../../.mutation-build/worker/application/remote-delivery-history.js';
import { reviewReworkInput } from '../../../.mutation-build/worker/application/remote-delivery-rework.js';
import { sharedReleaseConfigured, sharedReleasePhase, sharedReleaseProjection, sameSharedRelease } from '../../../.mutation-build/worker/application/shared-release-projection.js';
import { acceptedRequest, reviewRequest, feedbackCommand, publication, target } from './workflow-fixture.mjs';

test('every current acceptance identity and known-outcome condition independently fences release', () => {
  assert.equal(releaseAccepted(acceptedRequest()), true);
  const corruptions = [
    value => { value.attestation = null; }, value => { value.attestation.inputHash = 'bad'; }, value => { value.attestation.outputDigest = 'bad'; },
    value => { value.execution = null; }, value => { value.execution.inputRevision++; }, value => { value.execution.status = 'failed'; }, value => { value.execution.result = { type: 'needs_input' }; },
    value => { value.delivery.review = undefined; }, value => { value.delivery.review.candidate.inputRevision++; }, value => { value.delivery.review.candidate.inputHash = 'bad'; }, value => { value.delivery.review.candidate.policyDigest = 'bad'; },
    value => { value.evaluations = []; }, value => { value.evaluations[0].stage = 'ready'; }, value => { value.evaluations[0].inputRevision++; }, value => { value.evaluations[0].inputHash = 'bad'; }, value => { value.evaluations[0].policyDigest = 'bad'; }, value => { value.evaluations[0].outputDigest = 'bad'; }, value => { value.evaluations[0].passed = false; },
    value => { value.recoveryHold = { code: 'uncertain', at: value.createdAt }; }, value => { value.deliveryHolds = [{ code: 'source', reason: 'Missing canonical source' }]; }, value => { value.delivery.holds = [{ code: 'source', reason: 'Changed canonical source' }]; }, value => { value.delivery.control = { action: 'cancel', operationId: 'cancel', at: value.createdAt }; }, value => { value.phase = 'review'; }, value => { value.delivery.status = 'failed'; },
  ];
  for (const mutate of corruptions) { const value = acceptedRequest(); mutate(value); assert.equal(releaseAccepted(value), false); }
  const newer = acceptedRequest(); newer.evaluations.push({ ...newer.evaluations[0], id: 'new-failure', passed: false }); assert.equal(releaseAccepted(newer), false, 'A later current failure supersedes earlier success');
});

test('only the newest confirmed exact-request exact-target PR receipt authorizes a branch update', () => {
  const request = acceptedRequest(), older = publication(); older.observation.pullRequest.number = 10; older.candidate.candidateCommit = 'a'.repeat(40);
  request.deliveryHistory = [{ ...structuredClone(request.delivery), publications: [older] }];
  const first = remotePublicationPredecessor(request, target); assert.equal(first.pullRequest.number, 17); assert.equal(first.branch, request.delivery.publications[0].observation.branch);
  first.candidate.candidateCommit = 'changed'; first.pullRequest.number = 99;
  assert.equal(request.delivery.publications[0].candidate.candidateCommit, '2'.repeat(40)); assert.equal(request.delivery.publications[0].observation.pullRequest.number, 17);
  for (const mutate of [value => { value.action = 'push'; }, value => { value.status = 'unknown'; }, value => { value.observation = undefined; }, value => { delete value.observation.pullRequest; }, value => { value.candidate.requestId = 'another-request'; }, value => { value.target.repository = 'other/project'; }]) {
    const next = acceptedRequest(); mutate(next.delivery.publications[0]); assert.equal(remotePublicationPredecessor(next, target), undefined);
  }
  request.delivery.publications = []; assert.equal(remotePublicationPredecessor(request, target).pullRequest.number, 10);
  delete request.delivery; assert.equal(remotePublicationPredecessor(request, target).pullRequest.number, 10);
  delete request.deliveryHistory; assert.equal(remotePublicationPredecessor(request, target), undefined);
});

test('saved feedback cannot transfer between candidate hashes, revisions, notes or frozen authority', () => {
  const request = reviewRequest(), command = feedbackCommand(), before = structuredClone(request);
  const revised = reviewReworkInput(request, command); assert.equal(revised.message, request.input.message + '\n\n## Review feedback\n\n' + command.note);
  assert.deepEqual(revised.context, before.input.context); assert.deepEqual(revised.files, before.input.files); assert.deepEqual(revised.criteria, before.input.criteria); assert.deepEqual(request, before);
  for (const change of [{ candidateCommit: 'f'.repeat(40) }, { candidateDigest: '0'.repeat(64) }, { inputRevision: 2 }, { note: 'Different feedback' }]) assert.throws(() => reviewReworkInput(request, { ...command, ...change }), { code: 'conflict' });
  assert.equal(reviewReworkInput(request, { ...command, action: 'execute' }), null);
  const absent = reviewRequest(); absent.deliveryHolds = []; assert.equal(reviewReworkInput(absent, command), null);
  const tooLarge = reviewRequest(); tooLarge.input.message = 'x'.repeat(64000); assert.throws(() => reviewReworkInput(tooLarge, command), /bound/);
});

test('public release projection preserves complete receipts without exposing operation authority and never invents done', () => {
  const request = acceptedRequest(); assert.equal(sharedReleaseConfigured(request), true); assert.equal(sharedReleaseConfigured(null), false);
  assert.equal(sharedReleasePhase(null), null); assert.equal(sharedReleasePhase({ ...request, input: { ...request.input, context: {} } }), null);
  assert.equal(sharedReleasePhase(request), 'accepted'); request.attestation = null; assert.equal(sharedReleasePhase(request), null); request.attestation = acceptedRequest().attestation;
  for (const mutate of [value => { value.recoveryHold = { code: 'stop', at: value.createdAt }; }, value => { value.deliveryHolds = [{ code: 'source', reason: 'Missing' }]; }, value => { value.delivery.holds = [{ code: 'scope', reason: 'Changed' }]; }, value => { value.delivery.control = { action: 'cancel', operationId: 'cancel', at: value.createdAt }; }]) {
    const held = acceptedRequest(); mutate(held); assert.equal(sharedReleasePhase(held), 'release_blocked');
  }
  for (const [action, status, expected] of [['merge', 'pending', 'merging'], ['build', 'pending', 'building'], ['publish', 'pending', 'publishing_release'], ['build', 'unknown', 'release_outcome_unknown'], ['build', 'failed', 'release_failed'], ['publish', 'not_observed', 'release_failed']]) {
    request.delivery.release = /** @type {import('../../../src/worker/application/release-contracts.ts').DeliveryRelease} */ (/** @type {unknown} */ ({ operations: [{ operationId: 'release-one', action, status, detail: 'Observed.', target: { secret: 'private' } }] }));
    assert.equal(sharedReleasePhase(request), expected); assert.deepEqual(sharedReleaseProjection(request.delivery.release).operations, [{ operationId: 'release-one', action, status, detail: 'Observed.' }]);
  }
  const merge = { pullRequest: 17, headCommit: '2'.repeat(40), mergeCommit: '3'.repeat(40), url: 'https://github.com/example/project/pull/17', mergedAt: request.createdAt };
  const build = { operationId: 'build-one', commit: merge.mergeCommit, artifacts: [{ name: 'app.zip', bytes: 10, sha256: 'b'.repeat(64) }], manifestDigest: 'a'.repeat(64), builtAt: request.createdAt };
  request.delivery.release = { operations: [], merge }; assert.equal(sharedReleasePhase(request), 'merged');
  request.delivery.release.build = build; assert.equal(sharedReleasePhase(request), 'built');
  const published = { tag: 'v1.0.0', url: 'https://github.com/example/project/releases/tag/v1.0.0', commit: merge.mergeCommit, assets: build.artifacts, publishedAt: request.createdAt };
  request.delivery.release.published = published; assert.equal(sharedReleasePhase(request), 'done');
  assert.deepEqual(sharedReleaseProjection(request.delivery.release), request.delivery.release);
  assert.deepEqual(sharedReleaseProjection(undefined), { operations: [] }); assert.equal(sameSharedRelease(undefined, { operations: [] }), true);
  assert.equal(sameSharedRelease(undefined, sharedReleaseProjection(request.delivery.release)), false);
});
