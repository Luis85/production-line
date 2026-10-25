import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseRequest, closeReleases } from '../../src/worker/dist/worker/status/workspace-release.js';
import { fixture } from './request-gate-fixtures.mjs';
import { readyRelease, acceptRelease, releaseCommand, buildReceipt } from './release-fixtures.mjs';

async function harness(t) {
  const { journal, directory } = await fixture(t), initial = acceptRelease(journal, readyRelease(journal)), calls = [];
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    acceptingTasks: true, nativeWorkState: 'ready', sessions: { requests: journal }, config: { stateDir: directory }, repositoryStop: new AbortController(),
    board: { async verifyDelivery(requestId, revision) { assert.equal(requestId, initial.id); assert.equal(revision, journal.get(initial.id).revision); calls.push('verify-candidate'); },
      executionDetail() { return { requestId: initial.id, repositoryId: 'repo-one', repository: process.cwd() }; } },
  }));
  let merged = false, built = null, published = null;
  /** @type {import('../../src/worker/application/release-contracts.ts').ReleasePort} */
  const port = {
    pullRequest: async operation => ({ number: 17, url: operation.pullRequest.url, branch: operation.pullRequest.branch, base: operation.target.base, headCommit: operation.candidate.candidateCommit,
      closed: merged, merged, mergeCommit: merged ? 'b'.repeat(40) : null, mergedAt: merged ? operation.createdAt : null }),
    merge: async operation => { assert.equal(journal.get(initial.id).delivery.release.operations.at(-1).status, 'pending'); assert.equal(operation.candidate.candidateCommit, initial.delivery.review.candidate.candidateCommit); calls.push('merge'); merged = true; },
    inspectBuild: async () => built,
    build: async operation => { assert.equal(journal.get(initial.id).delivery.release.operations.at(-1).status, 'pending'); calls.push('build'); built = buildReceipt(operation); return built; },
    inspectRelease: async () => published,
    publish: async operation => { assert.equal(journal.get(initial.id).delivery.release.operations.at(-1).status, 'pending'); calls.push('publish'); published = { tag: operation.tag, url: 'https://github.com/example/project/releases/tag/' + operation.tag, commit: operation.mergeCommit, assets: operation.build.artifacts, publishedAt: operation.createdAt }; },
  };
  /** @type {import('../../src/worker/application/release-contracts.ts').ReleaseAuthority} */
  const authority = { authorize(id, digest) { assert.equal(id, 'repo-one'); assert.match(digest, /^[a-f0-9]{64}$/); } };
  return { workspace, journal, initial, port, authority, calls };
}
test('workspace persists each release intent before execution and completes one request through published exact assets', async t => {
  const h = await harness(t); let request = h.initial;
  for (const [action, operationId] of /** @type {const} */ ([['merge_candidate', 'merge'], ['build_release', 'build'], ['publish_release', 'publish']])) {
    const command = { ...releaseCommand(request, action, operationId), ...(action === 'publish_release' ? { releaseTag: 'v1.0.0' } : {}) };
    const observed = await releaseRequest(h.workspace, command, h); request = observed.request;
    assert.equal(observed.duplicate, false); assert.equal(request.delivery.release.operations.at(-1).status, 'confirmed');
    assert.equal((await releaseRequest(h.workspace, command, h)).duplicate, true);
  }
  assert.equal(request.lifecycle, 'done'); assert.equal(request.delivery.release.published.commit, 'b'.repeat(40));
  assert.deepEqual(h.calls.filter(call => call !== 'verify-candidate'), ['merge', 'build', 'publish']);
  await closeReleases(h.workspace);
});
test('one project operation owns release execution and shutdown drains the retained outcome', async t => {
  const h = await harness(t), { promise: entered, resolve: start } = Promise.withResolvers(), { promise: released, resolve: finish } = Promise.withResolvers();
  h.port.merge = async () => { start(undefined); await released; };
  const command = releaseCommand(h.initial, 'merge_candidate', 'slow-merge'), pending = releaseRequest(h.workspace, command, h); await entered;
  await assert.rejects(releaseRequest(h.workspace, { ...command, operationId: 'overlap' }, h), /release operation is active/);
  let closed = false; const closing = closeReleases(h.workspace).then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  h.workspace.repositoryStop.abort(); finish(undefined); const result = await pending; await closing;
  assert.equal(closed, true); assert.equal(result.request.delivery.release.operations[0].status, 'unknown');
});
test('revoked authority at a mutation boundary prevents merge while retaining its failed intent', async t => {
  const h = await harness(t);
  h.authority.authorize = (_id, _digest, mutation) => { if (mutation) throw new Error('Revoked private connection detail'); };
  const result = await releaseRequest(h.workspace, releaseCommand(h.initial, 'merge_candidate', 'revoked-merge'), h);
  assert.equal(result.request.delivery.release.operations[0].status, 'unknown'); assert.equal(h.calls.includes('merge'), false);
  assert.doesNotMatch(result.request.delivery.release.operations[0].detail, /private connection detail/);
});

test('a canonical source hold arriving during observation blocks the following merge mutation', async t => {
  const h = await harness(t), observe = h.port.pullRequest; let held = false;
  h.port.pullRequest = async (operation, signal) => {
    const observation = await observe(operation, signal);
    if (!held) { held = true; h.journal.deliveryUpdate(h.initial.id, { action: 'hold', code: 'source_missing', reason: 'The canonical Feature Request disappeared during observation.' }); }
    return observation;
  };
  const result = await releaseRequest(h.workspace, releaseCommand(h.initial, 'merge_candidate', 'hold-race'), h);
  assert.equal(result.request.delivery.release.operations[0].status, 'failed'); assert.equal(h.calls.includes('merge'), false);
});
