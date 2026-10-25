import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../../.mutation-build/worker/application/delivery-policy.js';
import { requestPublicationCommand, requestPublicationResult } from '../../../.mutation-build/worker/infrastructure/journal/requests/publication.js';
import { requestReleaseCommand, requestReleaseResult } from '../../../.mutation-build/worker/infrastructure/journal/requests/release.js';
import { remotePublicationPredecessor } from '../../../.mutation-build/worker/application/remote-delivery-history.js';
import { createHash } from 'node:crypto';
import { acceptedRequest, publication, target } from './workflow-fixture.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** An independently accepted request: only the boundary under test creates new publication/release authority. */
function request() {
  const value = acceptedRequest(), configuration = defaultDeliveryProjectPolicy();
  configuration.remoteDelivery = structuredClone(target);
  configuration.release = { repository: target.repository, base: target.base, mergeMethod: 'squash', tagPrefix: 'v', prerelease: false,
    build: { executable: 'node', args: ['build.mjs'], timeoutMs: 1000, artifacts: ['out/app.zip'] } };
  value.input.context = { repositoryId: 'repo-one', deliveryPolicy: deliveryPolicySnapshot(configuration, value.delivery.review.candidate.baseline) };
  value.policyDigest = fingerprint(value.policy); value.delivery.policyDigest = value.policyDigest; value.delivery.review.candidate.policyDigest = value.policyDigest;
  for (const evaluation of value.evaluations) evaluation.policyDigest = value.policyDigest;
  value.delivery.publications[0].candidate = structuredClone(value.delivery.review.candidate);
  return value;
}
function store() {
  const events = [];
  const port = /** @type {import('../../../src/worker/infrastructure/journal/requests/store.ts').RequestStore} */ (/** @type {unknown} */ ({ save(_request, event) { events.push(event); } }));
  return { port, events };
}
/** @param {ReturnType<typeof request>} value @param {string} action */
function command(value, action) {
  const exact = value.delivery.review.candidate;
  return /** @type {import('../../../src/worker/application/request-gates.ts').RequestCommand} */ ({ action, requestId: value.id, expectedRevision: value.revision, operationId: 'new-operation', deliveryRunId: value.delivery.id,
    inputRevision: value.inputRevision, candidateCommit: exact.candidateCommit, candidateDigest: exact.candidateDigest, releaseTag: 'v2.0.0' });
}
function retained(number, state = 'open') {
  const value = publication(); value.operationId = 'prior-' + number;
  value.observation.pullRequest = { number, state: /** @type {'open'|'closed'|'merged'} */ (state), url: 'https://github.com/example/project/pull/' + number };
  value.observation.branch = 'werk/pr-' + number;
  return value;
}

for (const action of ['push_candidate', 'create_pull_request']) test('retained PR admission for ' + action + ' requires the existing PR to remain open', () => {
  for (const state of ['open', 'closed', 'merged']) {
    const value = request(), history = retained(17, state), h = store();
    value.deliveryHistory = [{ ...structuredClone(value.delivery), publications: [history] }]; value.delivery.publications = [];
    if (action === 'create_pull_request') value.delivery.publications.push({ ...publication(), action: 'push', candidate: structuredClone(value.delivery.review.candidate), observation: { branch: value.delivery.review.candidate.branch, commit: value.delivery.review.candidate.candidateCommit } });
    const before = structuredClone(value);
    if (state !== 'open') { assert.throws(() => requestPublicationCommand(h.port, value, command(value, action)), { code: 'conflict' }); assert.deepEqual(value, before); assert.equal(h.events.length, 0); }
    else {
      requestPublicationCommand(h.port, value, command(value, action));
      const saved = value.delivery.publications.at(-1); assert.equal(saved.status, 'pending'); assert.equal(saved.predecessor.pullRequest.number, 17); assert.equal(saved.predecessor.branch, history.observation.branch);
      assert.equal(h.events.length, 1); saved.predecessor.pullRequest.number = 99; assert.equal(history.observation.pullRequest.number, 17, 'Retained identity is copied, never modified in place.');
    }
  }
});

test('publication admission cannot transfer one current review candidate across run, revision, commit or digest', () => {
  for (const change of [{ deliveryRunId: 'another-run' }, { inputRevision: 2 }, { candidateCommit: 'f'.repeat(40) }, { candidateDigest: '0'.repeat(64) }]) {
    const value = request(), h = store(); value.delivery.publications = []; const before = structuredClone(value);
    assert.throws(() => requestPublicationCommand(h.port, value, { ...command(value, 'push_candidate'), ...change }), { code: 'conflict' });
    assert.deepEqual(value, before); assert.equal(h.events.length, 0);
  }
  const valid = request(), h = store(); valid.delivery.publications = [];
  requestPublicationCommand(h.port, valid, command(valid, 'push_candidate')); assert.equal(valid.delivery.publications[0].action, 'push'); assert.equal(h.events.length, 1);
});

/** @param {'push'|'pull_request'} action */
function publicationResult(action) {
  const value = request(), h = store(), saved = publication(); saved.action = action; saved.status = 'pending'; delete saved.observation; value.delivery.publications = [saved];
  const observation = { branch: saved.candidate.branch, commit: saved.candidate.candidateCommit, ...(action === 'pull_request' ? { pullRequest: { number: 1, state: /** @type {const} */ ('open'), url: 'https://github.com/example/project/pull/1' } } : {}) };
  const apply = result => requestPublicationResult(h.port, value, { action: 'publication_result', deliveryRunId: value.delivery.id, operationId: saved.operationId, result });
  return { value, saved, ...h, observation, apply };
}

test('publication result schemas distinguish unknown outcomes, successful receipts and exact diagnostic bounds', () => {
  for (const action of /** @type {const} */ (['push', 'pull_request'])) {
    const valid = publicationResult(action); valid.apply({ status: 'confirmed', detail: 'x'.repeat(4000), observation: valid.observation });
    assert.equal(valid.saved.status, 'confirmed'); assert.equal(valid.events.length, 1); assert.equal(valid.saved.detail.length, 4000);
    for (const change of [{ status: 'pending', detail: 'Not an outcome.' }, { status: 'failed', detail: '' }, { status: 'unknown', detail: ' ' }, { status: 'not_observed', detail: null }, { status: 'failed', detail: 'x'.repeat(4001) }]) {
      const h = publicationResult(action), before = structuredClone(h.value);
      assert.throws(() => h.apply(change), { code: 'invalid_input' }); assert.deepEqual(h.value, before); assert.equal(h.events.length, 0);
    }
    for (const status of ['failed', 'not_observed', 'unknown']) {
      const h = publicationResult(action), before = structuredClone(h.value);
      assert.throws(() => h.apply({ status, detail: 'Remote outcome is not confirmed.', observation: h.observation }), { code: 'invalid_input' }); assert.deepEqual(h.value, before); assert.equal(h.events.length, 0);
    }
    const observed = publicationResult(action); observed.apply({ status: 'not_observed', detail: 'Complete read-only absence observed.', recoveryEvidence: action === 'push' ? 'single_remote_ref' : 'complete_pull_request_lookup' });
    assert.equal(observed.saved.status, 'not_observed'); assert.equal(observed.saved.observation, undefined);
  }
  const push = publicationResult('push'); assert.throws(() => push.apply({ status: 'confirmed', detail: 'A push cannot invent a PR.', observation: { ...push.observation, pullRequest: { number: 1, state: 'open', url: 'https://github.com/example/project/pull/1' } } }), { code: 'conflict' }); assert.equal(push.events.length, 0);
});

/** @param {'merge'|'build'|'publish'} [action] */
function releaseResult(action = 'publish') {
  const value = request(), h = store(), exact = value.delivery.review.candidate;
  const artifacts = [{ name: 'app.zip', bytes: 3, sha256: 'b'.repeat(64) }, { name: 'werk-release-manifest.json', bytes: 30, sha256: 'a'.repeat(64) }, { name: 'SHA256SUMS', bytes: 40, sha256: 'c'.repeat(64) }];
  const merge = { pullRequest: 17, headCommit: exact.candidateCommit, mergeCommit: '8'.repeat(40), url: 'https://github.com/example/project/pull/17', mergedAt: value.createdAt };
  const built = { operationId: 'release-one', commit: merge.mergeCommit, manifestDigest: 'a'.repeat(64), builtAt: value.createdAt, artifacts };
  const published = { tag: 'v1.0.0', url: 'https://github.com/example/project/releases/tag/v1.0.0', commit: merge.mergeCommit, publishedAt: value.createdAt, assets: structuredClone(artifacts) };
  const configuration = /** @type {{deliveryPolicy:import('../../../src/worker/application/delivery-policy.ts').DeliveryPolicySnapshot}} */ (value.input.context).deliveryPolicy;
  /** @type {import('../../../src/worker/application/release-contracts.ts').ReleaseOperation} */
  const op = { operationId: 'release-one', action, status: 'pending', candidate: structuredClone(exact), target: structuredClone(configuration.configuration.release), repositoryId: 'repo-one', configurationDigest: configuration.configurationDigest,
    pullRequest: { number: 17, url: merge.url, branch: exact.branch }, createdAt: value.createdAt, updatedAt: value.createdAt, detail: 'Retained release intent.', mergeCommit: merge.mergeCommit, tag: published.tag, ...(action === 'publish' ? { build: built } : {}) };
  value.delivery.release = { operations: [op], merge, build: built };
  const apply = result => requestReleaseResult(h.port, value, { action: 'release_result', deliveryRunId: value.delivery.id, operationId: op.operationId, result });
  return { value, op, ...h, merge, built, published, apply };
}

test('release outcomes cannot combine successful stage receipts or attach them to uncertain states', () => {
  for (const action of /** @type {const} */ (['merge', 'build', 'publish'])) {
    const selected = action === 'build' ? 'built' : action === 'publish' ? 'published' : 'merge';
    for (const other of ['merge', 'built', 'published'].filter(field => field !== selected)) {
      const h = releaseResult(action), before = structuredClone(h.value);
      assert.throws(() => h.apply({ status: 'confirmed', detail: 'Mixed successful stages are not one receipt.', [selected]: h[selected], [other]: h[other] }), { code: 'conflict' }); assert.deepEqual(h.value, before); assert.equal(h.events.length, 0);
    }
    for (const status of ['unknown', 'not_observed', 'failed']) for (const field of ['merge', 'built', 'published']) {
      const h = releaseResult(action), before = structuredClone(h.value);
      assert.throws(() => h.apply({ status, detail: 'No confirmed stage.', [field]: h[field] }), { code: 'invalid_input' }); assert.deepEqual(h.value, before); assert.equal(h.events.length, 0);
    }
    const h = releaseResult(action); h.apply({ status: 'confirmed', detail: 'x'.repeat(4000), [selected]: h[selected] }); assert.equal(h.op.status, 'confirmed'); assert.equal(h.events.length, 1);
  }
});

test('retag evidence proves a conflicting foreign object before a publish attempt, never an owned or mixed result', () => {
  const evidence = { kind: 'preflight_tag_conflict', tag: 'v1.0.0', refObject: 'c'.repeat(64), objectType: 'tag', release: 'absent' };
  for (const change of [{ kind: 'unknown' }, { tag: 'v2.0.0' }, { refObject: 'x' + 'c'.repeat(40) }, { refObject: 'c'.repeat(40) + 'x' }, { refObject: 'g'.repeat(64) }, { refObject: 'c' }, { objectType: 'blob' }, { release: 'owned' }]) {
    const h = releaseResult(), before = structuredClone(h.value);
    assert.throws(() => h.apply({ status: 'failed', detail: 'Conflicting tag inspection.', retagEvidence: { ...evidence, ...change } }), { code: 'invalid_input' }); assert.deepEqual(h.value, before); assert.equal(h.events.length, 0);
  }
  for (const action of /** @type {const} */ (['merge', 'build'])) {
    const h = releaseResult(action); assert.throws(() => h.apply({ status: 'failed', detail: 'Wrong stage.', retagEvidence: evidence }), { code: 'invalid_input' }); assert.equal(h.events.length, 0);
  }
  for (const status of ['unknown', 'not_observed', 'confirmed']) {
    const h = releaseResult(); assert.throws(() => h.apply({ status, detail: 'Not a preflight failure.', retagEvidence: evidence }), { code: 'invalid_input' }); assert.equal(h.events.length, 0);
  }
  const same = releaseResult(); assert.throws(() => same.apply({ status: 'failed', detail: 'This commit is already ours.', retagEvidence: { ...evidence, objectType: 'commit', refObject: same.op.mergeCommit } }), { code: 'invalid_input' });
  for (const change of [{ objectType: 'commit', release: 'foreign', refObject: 'c'.repeat(40) }, {}]) {
    const h = releaseResult(); h.apply({ status: 'failed', detail: 'Foreign ref established before publication.', retagEvidence: { ...evidence, ...change } });
    assert.equal(h.op.status, 'failed'); assert.deepEqual(h.op.retagEvidence, { ...evidence, ...change }); assert.equal(h.value.delivery.release.published, undefined);
  }
});

test('retagging a retained build requires every earlier different-tag attempt to be a proven preflight failure', () => {
  for (const [status, proven, allowed] of /** @type {const} */ ([['failed', true, true], ['failed', false, false], ['not_observed', true, false]])) {
    const h = releaseResult(); h.op.status = status; if (proven) h.op.retagEvidence = { kind: 'preflight_tag_conflict', tag: h.op.tag, refObject: 'c'.repeat(40), objectType: 'commit', release: 'foreign' };
    const before = structuredClone(h.value), next = command(h.value, 'publish_release');
    if (allowed) { requestReleaseCommand(h.port, h.value, next); assert.equal(h.value.delivery.release.operations.at(-1).tag, 'v2.0.0'); assert.equal(h.events.length, 1); }
    else { assert.throws(() => requestReleaseCommand(h.port, h.value, next), { code: 'conflict' }); assert.deepEqual(h.value, before); assert.equal(h.events.length, 0); }
  }
  const history = releaseResult(); history.op.status = 'failed';
  const later = structuredClone(history.op); later.operationId = 'later-safe-preflight'; later.retagEvidence = { kind: 'preflight_tag_conflict', tag: later.tag, refObject: 'c'.repeat(40), objectType: 'commit', release: 'absent' };
  history.value.delivery.release.operations.push(later);
  assert.throws(() => requestReleaseCommand(history.port, history.value, command(history.value, 'publish_release')), { code: 'conflict' }); assert.equal(history.events.length, 0);
  const sameTag = releaseResult(); sameTag.op.status = 'failed'; const retry = command(sameTag.value, 'publish_release'); retry.releaseTag = sameTag.op.tag;
  requestReleaseCommand(sameTag.port, sameTag.value, retry); assert.equal(sameTag.value.delivery.release.operations.at(-1).tag, 'v1.0.0');
});

test('retained PR lookup uses append order across runs and within each run without mutating history', () => {
  const value = request(), first = retained(10), second = retained(11), third = retained(12), fourth = retained(13);
  value.deliveryHistory = [{ ...structuredClone(value.delivery), publications: [first, second] }, { ...structuredClone(value.delivery), publications: [third] }];
  value.delivery.publications = [fourth, retained(14), { ...retained(15), status: 'unknown' }];
  const before = structuredClone(value);
  assert.equal(remotePublicationPredecessor(value, target).pullRequest.number, 14); assert.deepEqual(value, before);
  delete value.delivery.publications; assert.equal(remotePublicationPredecessor(value, target).pullRequest.number, 12);
  value.deliveryHistory.pop(); assert.equal(remotePublicationPredecessor(value, target).pullRequest.number, 11);
  value.deliveryHistory.push({ ...structuredClone(value.delivery), publications: undefined });
  assert.equal(remotePublicationPredecessor(value, target).pullRequest.number, 11, 'Legacy runs without publication history cannot hide an older retained PR.');
});
