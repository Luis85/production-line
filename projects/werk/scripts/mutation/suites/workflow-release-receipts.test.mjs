import test from 'node:test';
import assert from 'node:assert/strict';
import { runReleaseOperation } from '../../../.mutation-build/worker/application/release-runtime.js';
import { requestReleaseResult } from '../../../.mutation-build/worker/infrastructure/journal/requests/release.js';
import { acceptedRequest, publication } from './workflow-fixture.mjs';

/** @param {'merge'|'build'|'publish'} action @returns {import('../../../src/worker/application/release-contracts.ts').ReleaseOperation} */
function operation(action) {
  const saved = publication();
  return { operationId: 'release-one', action, status: 'pending', candidate: saved.candidate, target: { repository: 'example/project', base: 'main', mergeMethod: 'squash', tagPrefix: 'v', prerelease: false, build: { executable: 'node', args: [], timeoutMs: 1000, artifacts: ['out/app.zip'] } }, repositoryId: saved.repositoryId, configurationDigest: saved.configurationDigest, pullRequest: { ...saved.observation.pullRequest, branch: saved.candidate.branch }, createdAt: saved.createdAt, updatedAt: saved.updatedAt, detail: 'Retained intent.', mergeCommit: 'b'.repeat(40), tag: 'v1.0.0' };
}
function receipts(op) {
  const artifacts = [{ name: 'app.zip', bytes: 3, sha256: 'b'.repeat(64) }, { name: 'werk-release-manifest.json', bytes: 30, sha256: 'a'.repeat(64) }, { name: 'SHA256SUMS', bytes: 40, sha256: 'c'.repeat(64) }];
  return { merge: { pullRequest: 17, headCommit: op.candidate.candidateCommit, mergeCommit: op.mergeCommit, url: op.pullRequest.url, mergedAt: op.createdAt }, built: { operationId: op.operationId, commit: op.mergeCommit, manifestDigest: 'a'.repeat(64), builtAt: op.createdAt, artifacts }, published: { tag: op.tag, url: 'https://github.com/example/project/releases/tag/' + op.tag, commit: op.mergeCommit, publishedAt: op.createdAt, assets: structuredClone(artifacts) } };
}
/** @param {'merge'|'build'|'publish'} [action] */
function runtime(action = 'merge') {
  const op = operation(action), calls = [], mutations = [], receipt = receipts(op);
  let pull = { number: 17, url: op.pullRequest.url, branch: op.pullRequest.branch, base: op.target.base, headCommit: op.candidate.candidateCommit, merged: action !== 'merge', closed: action !== 'merge', mergeCommit: op.mergeCommit, mergedAt: op.createdAt };
  /** @type {import('../../../src/worker/application/release-contracts.ts').ReleasePort} */
  const port = { async pullRequest() { calls.push('observe'); return pull; }, async merge() { calls.push('merge'); pull = { ...pull, merged: true, closed: true }; }, async inspectBuild() { return null; }, async build() { calls.push('build'); return receipt.built; }, async inspectRelease() { return null; }, async publish() { calls.push('publish'); } };
  const run = () => runReleaseOperation({ operation: op, mode: 'execute', port, authority: { authorize(_id, _digest, mutation) { mutations.push(mutation); } }, signal: new AbortController().signal });
  return { op, port, calls, mutations, pull, run };
}

test('every remote PR identity dimension is independently required before release mutation', async () => {
  for (const change of [{ number: 18 }, { url: 'https://github.com/example/project/pull/18' }, { branch: 'unrelated' }, { base: 'other' }, { headCommit: 'f'.repeat(40) }]) {
    const h = runtime(); Object.assign(h.pull, change); assert.equal((await h.run()).status, 'failed'); assert.deepEqual(h.calls, ['observe']); assert.equal(h.mutations.includes(true), false);
  }
  for (const change of [{ headCommit: 'f'.repeat(40) }, { branch: 'other' }, { base: 'other' }]) {
    const h = runtime(); const observe = h.port.pullRequest; let reads = 0; h.port.pullRequest = async (...args) => { const value = await observe(...args); return ++reads === 2 ? { ...value, ...change } : value; };
    assert.equal((await h.run()).status, 'failed'); assert.deepEqual(h.calls, ['observe', 'merge', 'observe']);
  }
  const h = runtime(); assert.equal((await h.run()).status, 'confirmed'); assert.deepEqual(h.mutations, [false, false, true, false]);
});

test('malformed merge evidence independently blocks builds and never invokes the build adapter', async () => {
  for (const change of [{ merged: false }, { mergeCommit: null }, { mergeCommit: 'g'.repeat(40) }, { mergeCommit: 'x' + 'b'.repeat(40) }, { mergeCommit: 'b'.repeat(40) + 'x' }, { mergeCommit: 'g'.repeat(64) }, { mergedAt: null }, { mergedAt: 'invalid-time' }, { mergeCommit: 'c'.repeat(40) }]) {
    const h = runtime('build'); Object.assign(h.pull, change); assert.equal((await h.run()).status, 'failed'); assert.equal(h.calls.includes('build'), false);
  }
  const h = runtime('build'); assert.equal((await h.run()).status, 'confirmed'); assert.deepEqual(h.mutations, [false, false, false, true]);
});

/** @param {'merge'|'build'|'publish'} action */
function journal(action) {
  const request = acceptedRequest(), op = operation(action), receipt = receipts(op), saves = [];
  if (action === 'publish') op.build = receipt.built;
  request.delivery.release = { operations: [op] };
  const store = /** @type {import('../../../src/worker/infrastructure/journal/requests/store.ts').RequestStore} */ (/** @type {unknown} */ ({ save(_request, event) { saves.push(event); } }));
  /** @type {import('../../../src/worker/application/release-contracts.ts').ReleaseResult} */
  const result = { status: 'confirmed', detail: 'Exact successful receipt.', [action === 'merge' ? 'merge' : action === 'build' ? 'built' : 'published']: receipt[action === 'merge' ? 'merge' : action === 'build' ? 'built' : 'published'] };
  const apply = value => requestReleaseResult(store, request, { action: 'release_result', deliveryRunId: request.delivery.id, operationId: op.operationId, result: value });
  return { request, op, receipt, result, saves, apply };
}

test('merge and build receipts require each immutable identity and cannot mix success types', () => {
  for (const [action, field, changes] of /** @type {const} */ ([['merge', 'merge', [{ pullRequest: 18 }, { headCommit: 'f'.repeat(40) }, { url: 'foreign' }, { mergeCommit: 'g'.repeat(40) }, { mergedAt: 'invalid' }]], ['build', 'built', [{ operationId: 'foreign' }, { commit: 'f'.repeat(40) }, { manifestDigest: 'g'.repeat(64) }, { builtAt: 'invalid' }]]])) {
    for (const change of changes) { const h = journal(action); Object.assign(h.result[field], change); assert.throws(() => h.apply(h.result)); assert.equal(h.saves.length, 0); }
    for (const other of ['merge', 'built', 'published'].filter(value => value !== field)) { const h = journal(action); h.result[other] = h.receipt[other]; assert.throws(() => h.apply(h.result)); }
    const h = journal(action); h.apply(h.result); assert.equal(h.saves.length, 1); h.apply(h.result); assert.equal(h.saves.length, 1); assert.notEqual(h.request.delivery.release[field === 'built' ? 'build' : field], h.result[field]);
    assert.throws(() => h.apply({ ...h.result, detail: 'Altered settled receipt' }), { code: 'conflict' });
  }
});

test('artifact manifests require exact configured names, unique safe assets, sizes and checksums', () => {
  const mutations = [value => { value.artifacts = []; }, value => { value.artifacts.push(structuredClone(value.artifacts[0])); }, value => { value.artifacts[0].name = '../app.zip'; }, value => { value.artifacts[0].name = 'other.zip'; }, value => { value.artifacts[0].bytes = -1; }, value => { value.artifacts[0].bytes = 1.5; }, value => { value.artifacts[0].bytes = 67108865; }, value => { value.artifacts[0].sha256 = 'g'.repeat(64); }, value => { value.artifacts[1].sha256 = 'b'.repeat(64); }, value => { value.artifacts.pop(); }];
  for (const mutate of mutations) { const h = journal('build'); mutate(h.result.built); assert.throws(() => h.apply(h.result)); assert.equal(h.saves.length, 0); }
  const h = journal('build'); h.result.built.artifacts[0].bytes = 0; h.apply(h.result); assert.equal(h.request.delivery.release.build.artifacts[0].bytes, 0);
});

test('published release cannot reach done with another tag, commit, URL, time or asset set', () => {
  for (const change of [{ tag: 'v2.0.0' }, { commit: 'f'.repeat(40) }, { url: 'https://github.com/foreign/project/releases/tag/v1.0.0' }, { publishedAt: 'invalid' }]) {
    const h = journal('publish'); Object.assign(h.result.published, change); assert.throws(() => h.apply(h.result)); assert.equal(h.saves.length, 0);
  }
  for (const mutate of [value => { value.assets[0].sha256 = 'f'.repeat(64); }, value => { value.assets[0].bytes++; }, value => { value.assets.pop(); }]) {
    const h = journal('publish'); mutate(h.result.published); assert.throws(() => h.apply(h.result)); assert.equal(h.saves.length, 0);
  }
  const h = journal('publish'); h.request.phase = 'review'; h.result.published.assets.reverse(); h.apply(h.result); assert.equal(h.request.phase, 'done'); assert.equal(h.saves.length, 1);
});
