import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSubject, releaseView } from '../../../.mutation-build/worker/application/release-view.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../../.mutation-build/worker/application/delivery-policy.js';
import { acceptedRequest, target } from './workflow-fixture.mjs';

function request() {
  const value = acceptedRequest(), configuration = defaultDeliveryProjectPolicy();
  configuration.remoteDelivery = structuredClone(target);
  configuration.release = { repository: target.repository, base: target.base, mergeMethod: 'squash', tagPrefix: 'v', prerelease: false,
    build: { executable: 'node', args: ['build.mjs'], timeoutMs: 30000, artifacts: ['out/app.zip'] } };
  value.input.context = { repositoryId: 'repo-one', deliveryPolicy: deliveryPolicySnapshot(configuration, value.delivery.review.candidate.baseline) };
  return value;
}
function operation(action, status) {
  return /** @type {import('../../../src/worker/application/release-contracts.ts').ReleaseOperation} */ (/** @type {unknown} */ ({ operationId: 'operation-one', action, status, detail: 'Retained result.' }));
}
function stages(value) { return [value.canMerge, value.canBuild, value.canPublish]; }
const merge = { pullRequest: 17, headCommit: '2'.repeat(40), mergeCommit: '8'.repeat(40), url: 'https://github.com/example/project/pull/17', mergedAt: '2026-10-25T00:00:00.000Z' };
const build = { operationId: 'build-one', commit: merge.mergeCommit, artifacts: [{ name: 'app.zip', bytes: 3, sha256: 'a'.repeat(64) }], manifestDigest: 'b'.repeat(64), builtAt: merge.mergedAt };

test('release destination requires exact current request identity independently of matching publication evidence', () => {
  const original = request(), subject = releaseSubject(original);
  assert.equal(subject.repositoryId, 'repo-one'); assert.deepEqual(subject.target, (/** @type {{deliveryPolicy:import('../../../src/worker/application/delivery-policy.ts').DeliveryPolicySnapshot}} */ (original.input.context)).deliveryPolicy.configuration.release);
  assert.deepEqual(subject.candidate, original.delivery.review.candidate);
  assert.deepEqual(subject.pullRequest, { number: 17, url: merge.url, branch: original.delivery.review.candidate.branch });
  for (const [name, change] of /** @type {[string, (value:ReturnType<typeof request>)=>void][]} */ ([
    ['run', value => { value.delivery.review.candidate.runId = 'different-run'; }],
    ['request', value => { value.delivery.review.candidate.requestId = 'different-request'; }],
    ['revision', value => { value.delivery.review.candidate.inputRevision++; }],
    ['input', value => { value.delivery.review.candidate.inputHash = '0'.repeat(64); }],
    ['policy', value => { value.delivery.review.candidate.policyDigest = '0'.repeat(64); }],
  ])) {
    const value = request(); change(value);
    value.delivery.publications[0].candidate = structuredClone(value.delivery.review.candidate);
    assert.throws(() => releaseSubject(value), { code: 'conflict' }, name);
  }
  for (const change of [value => { delete value.input.context; }, value => { delete value.input.context.deliveryPolicy; }, value => { value.input.context.repositoryId = 7; }, value => { delete value.delivery; }, value => { delete value.delivery.review; }]) {
    const value = request(); change(value); assert.throws(() => releaseSubject(value), { code: 'conflict' });
  }
  const absent = request(), configuration = defaultDeliveryProjectPolicy();
  absent.input.context = { repositoryId: 'repo-one', deliveryPolicy: deliveryPolicySnapshot(configuration, '1'.repeat(40)) };
  assert.throws(() => releaseSubject(absent), { code: 'conflict' });
});

test('only confirmed exact-candidate PR publication for the configured destination authorizes release', () => {
  for (const change of [
    value => { delete value.delivery.publications; }, value => { value.delivery.publications = []; },
    value => { value.delivery.publications[0].action = 'push'; }, value => { value.delivery.publications[0].status = 'unknown'; },
    value => { delete value.delivery.publications[0].observation; }, value => { delete value.delivery.publications[0].observation.pullRequest; },
    value => { value.delivery.publications[0].candidate.candidateDigest = '0'.repeat(64); },
    value => { value.delivery.publications[0].target.repository = 'other/project'; }, value => { value.delivery.publications[0].target.base = 'other'; },
  ]) { const value = request(); change(value); assert.throws(() => releaseSubject(value), { code: 'conflict' }); }
  const casing = request(); casing.delivery.publications[0].target.repository = 'EXAMPLE/PROJECT';
  assert.equal(releaseSubject(casing).pullRequest.number, 17);
  const latest = request(); latest.delivery.publications.push({ ...structuredClone(latest.delivery.publications[0]), status: 'unknown' });
  assert.equal(releaseSubject(latest).pullRequest.number, 17);
});

test('release view exposes one next mutation and isolates retained observations from callers', () => {
  const value = request(), first = releaseView(value, true);
  assert.deepEqual(stages(first), [true, false, false]); assert.equal(first.configured, true); assert.equal(first.authorized, true); assert.equal(first.reason, null);
  assert.equal(first.target.repository, target.repository); assert.deepEqual(first.candidate, value.delivery.review.candidate);
  assert.deepEqual(first.state, { operations: [] }); assert.equal(first.canReconcile, false); assert.equal(first.canConfirmStopped, false);
  value.delivery.release = { operations: [], merge };
  assert.deepEqual(stages(releaseView(value, true)), [false, true, false]);
  value.delivery.release.build = build;
  assert.deepEqual(stages(releaseView(value, true)), [false, false, true]);
  const copy = releaseView(value, true); copy.state.merge.mergeCommit = 'changed'; copy.state.build.artifacts[0].bytes = 99;
  assert.equal(value.delivery.release.merge.mergeCommit, '8'.repeat(40)); assert.equal(value.delivery.release.build.artifacts[0].bytes, 3);
  value.delivery.release.published = { tag: 'v1', url: 'https://github.com/example/project/releases/tag/v1', commit: merge.mergeCommit, assets: build.artifacts, publishedAt: merge.mergedAt };
  assert.deepEqual(stages(releaseView(value, true)), [false, false, false]);
});

test('unapproved, stale, held or busy views cannot expose mutations at any release milestone', () => {
  for (const state of [{ operations: [] }, { operations: [], merge }, { operations: [], merge, build }]) {
    const value = request(); value.delivery.release = state;
    for (const [authorized, reason, busy] of /** @type {[boolean, string|null, boolean][]} */ ([[false, null, false], [true, 'The canonical source changed.', false], [true, null, true]])) {
      const view = releaseView(value, authorized, reason, busy); assert.deepEqual(stages(view), [false, false, false]);
      assert.equal(view.authorized, authorized); assert.ok(reason === null || view.reason === reason);
    }
    value.attestation = null; const view = releaseView(value, true);
    assert.deepEqual(stages(view), [false, false, false]); assert.match(view.reason, /human acceptance/i);
  }
  const absent = request(); delete absent.input.context;
  const view = releaseView(absent, true); assert.equal(view.configured, false); assert.equal(view.authorized, false);
  assert.equal(view.target, null); assert.equal(view.candidate, null); assert.deepEqual(stages(view), [false, false, false]);
  assert.ok(view.reason.length > 0); assert.equal(view.canReconcile, false); assert.equal(view.canConfirmStopped, false);
});

test('unknown outcomes enable only their guarded recovery and never another release mutation', () => {
  for (const action of ['merge', 'build', 'publish']) for (const status of ['pending', 'unknown', 'failed', 'confirmed', 'not_observed']) {
    const value = request(); value.delivery.release = { operations: [operation(action, status)], merge, build };
    const pending = status === 'pending' || status === 'unknown', view = releaseView(value, true);
    assert.equal(view.canReconcile, pending, action + '/' + status);
    assert.equal(view.canConfirmStopped, action === 'build' && status === 'unknown', action + '/' + status);
    assert.deepEqual(stages(view), pending ? [false, false, false] : [false, false, true]);
    if (pending) assert.match(view.reason, /reconcile/i);
    const missing = structuredClone(value); delete missing.input.context;
    const unavailable = releaseView(missing, true);
    assert.equal(unavailable.canReconcile, false); assert.equal(unavailable.canConfirmStopped, false);
    for (const [authorized, busy] of [[false, false], [true, true]]) {
      const blocked = releaseView(value, authorized, null, busy);
      assert.equal(blocked.canReconcile, false); assert.equal(blocked.canConfirmStopped, false);
      assert.deepEqual(stages(blocked), [false, false, false]);
    }
  }
});
