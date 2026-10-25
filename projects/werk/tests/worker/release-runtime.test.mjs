import test from 'node:test';
import assert from 'node:assert/strict';
import { runReleaseOperation } from '../../src/worker/dist/worker/application/release-runtime.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { releaseOperation, buildReceipt } from './release-fixtures.mjs';

/** @param {'merge'|'build'|'publish'} [action] */
function fixture(action = 'merge') {
  const operation = releaseOperation(action), calls = [];
  let merged = action !== 'merge', built = null, published = null, changed = false, closed = false, denied = false;
  /** @type {import('../../src/worker/application/release-contracts.ts').ReleasePort} */
  const port = {
    pullRequest: async () => ({ number: 17, url: operation.pullRequest.url, branch: operation.pullRequest.branch, base: operation.target.base,
      headCommit: changed ? 'f'.repeat(40) : operation.candidate.candidateCommit, closed: closed || merged, merged, mergeCommit: merged ? 'b'.repeat(40) : null, mergedAt: merged ? operation.createdAt : null }),
    merge: async () => { calls.push('merge'); merged = true; },
    inspectBuild: async () => { calls.push('inspect-build'); return built; },
    build: async () => { calls.push('build'); return built = buildReceipt(operation); },
    inspectRelease: async () => { calls.push('inspect-release'); return published; },
    publish: async () => { calls.push('publish'); published = { tag: operation.tag, url: 'https://github.com/example/project/releases/tag/' + operation.tag, commit: operation.mergeCommit, assets: operation.build.artifacts, publishedAt: operation.createdAt }; },
  };
  const run = mode => runReleaseOperation({ operation, mode, port, authority: { authorize: async (_id, _digest, mutation) => { if (mutation && denied) throw new DomainError('conflict', 'Approval revoked.'); } }, signal: new AbortController().signal });
  return { operation, calls, port, run, change: () => { changed = true; }, close: () => { closed = true; }, deny: () => { denied = true; } };
}
test('merge observes exact accepted head and records actual squash commit; lost acknowledgement is reconciled', async () => {
  const f = fixture(); f.port.merge = async () => { f.calls.push('merge'); f.port.pullRequest = async () => ({ number: 17, url: f.operation.pullRequest.url, branch: f.operation.pullRequest.branch, base: 'main', headCommit: f.operation.candidate.candidateCommit, closed: true, merged: true, mergeCommit: 'b'.repeat(40), mergedAt: f.operation.createdAt }); throw Error('Lost acknowledgement'); };
  const result = await f.run('execute'); assert.equal(result.status, 'confirmed'); assert.equal(result.merge.headCommit, f.operation.candidate.candidateCommit); assert.equal(result.merge.mergeCommit, 'b'.repeat(40));
  assert.equal((await f.run('reconcile')).status, 'confirmed'); assert.deepEqual(f.calls, ['merge']);
});
test('stale heads, unmerged closed requests and revoked authority prevent mutation', async () => {
  for (const change of ['change', 'close', 'deny']) { const f = fixture(); f[change](); assert.equal((await f.run('execute')).status, 'failed'); assert.deepEqual(f.calls, []); }
});
test('read-only reconciliation never retries merge, build or publish', async () => {
  for (const action of /** @type {const} */ (['merge', 'build', 'publish'])) {
    const f = fixture(action); if (action === 'publish') { f.operation.tag = 'v1.0.0'; f.operation.build = buildReceipt(f.operation); }
    const result = await f.run('reconcile'); assert.equal(result.status, action === 'build' ? 'unknown' : 'not_observed');
    assert.ok(f.calls.every(call => call.startsWith('inspect-')));
  }
});
test('build uses actual merged commit and publish reuses retained immutable asset set', async () => {
  const f = fixture('build'); const built = await f.run('execute'); assert.equal(built.status, 'confirmed'); assert.equal(built.built.commit, 'b'.repeat(40));
  assert.equal((await f.run('reconcile')).status, 'confirmed'); assert.equal(f.calls.filter(call => call === 'build').length, 1);
  f.operation.action = 'publish'; f.operation.tag = 'v1.0.0'; f.operation.build = built.built;
  assert.equal((await f.run('execute')).status, 'confirmed'); assert.equal((await f.run('reconcile')).status, 'confirmed'); assert.equal(f.calls.filter(call => call === 'publish').length, 1);
});
test('build failure remains distinct from implementation and transport failure stays unknown', async () => {
  const f = fixture('build'); f.port.build = async () => { throw new DomainError('conflict', 'Build failed.'); };
  assert.equal((await f.run('execute')).status, 'failed');
  f.port.inspectBuild = async () => { throw Error('Network private detail'); };
  const unknown = await f.run('reconcile'); assert.equal(unknown.status, 'unknown'); assert.doesNotMatch(unknown.detail, /private detail/);
});
