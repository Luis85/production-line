import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { runReleaseOperation } from '../../src/worker/dist/worker/application/release-runtime.js';
import { releaseView } from '../../src/worker/dist/worker/application/release-view.js';
import { fixture } from './request-gate-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import { readyRelease, acceptRelease, releaseCommand, buildReceipt } from './release-fixtures.mjs';

const result = (journal, request, operationId, value) => journal.deliveryUpdate(request.id, { action: 'release_result', deliveryRunId: request.delivery.id, operationId, result: value });
const mergeReceipt = request => ({ pullRequest: 17, headCommit: request.delivery.review.candidate.candidateCommit, mergeCommit: 'b'.repeat(40), url: 'https://github.com/example/project/pull/17', mergedAt: '2026-10-25T00:00:00.000Z' });

test('release requires current human acceptance, retains one exact intent and protects settled receipts', async t => {
  const { journal } = await fixture(t); let request = readyRelease(journal);
  assert.equal(releaseView(request, true).canMerge, false);
  assert.throws(() => journal.command(releaseCommand(request, 'merge_candidate', 'not-accepted')), /human acceptance/);
  request = acceptRelease(journal, request); assert.equal(request.lifecycle, 'in_progress'); assert.equal(releaseView(request, true).canMerge, true);
  request = journal.deliveryUpdate(request.id, { action: 'hold', code: 'source_missing', reason: 'The canonical source needs reconciliation.' });
  assert.equal(releaseView(request, true).canMerge, false);
  assert.throws(() => journal.command(releaseCommand(request, 'merge_candidate', 'held-merge')), /human acceptance/);
  request = journal.deliveryUpdate(request.id, { action: 'clear_hold', code: 'source_missing' });
  assert.equal(releaseView(request, true).canMerge, true);
  const command = releaseCommand(request, 'merge_candidate', 'merge-once');
  request = journal.command(command).request; assert.equal(request.delivery.release.operations[0].status, 'pending');
  assert.equal(journal.command(command).duplicate, true); assert.equal(journal.get(request.id).delivery.release.operations.length, 1);
  assert.throws(() => journal.command({ ...command, candidateCommit: 'f'.repeat(40) }), /different input/);
  const wrong = { ...mergeReceipt(request), headCommit: 'f'.repeat(40) };
  assert.throws(() => result(journal, request, 'merge-once', { status: 'confirmed', detail: 'Wrong head.', merge: wrong }), /accepted head/);
  request = result(journal, request, 'merge-once', { status: 'confirmed', detail: 'Merged accepted head.', merge: mergeReceipt(request) });
  assert.equal(request.lifecycle, 'in_progress'); assert.equal(releaseView(request, true).canBuild, true);
  assert.throws(() => journal.command({ action: 'reopen', requestId: request.id, expectedRevision: request.revision, operationId: 'reopen-merged', deliveryRunId: request.delivery.id, inputRevision: request.inputRevision }), /already merged/);
  assert.throws(() => result(journal, request, 'merge-once', { status: 'failed', detail: 'Rewrite merged result.' }), /immutable/);
});
test('restart preserves unknown merge intent and blocks new work until read-only reconciliation', async t => {
  const { journal, directory } = await fixture(t); let request = acceptRelease(journal, readyRelease(journal));
  request = journal.command(releaseCommand(request, 'merge_candidate', 'lost-merge')).request;
  journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(t, () => recovered.close());
  request = recovered.get(request.id); assert.equal(request.delivery.release.operations[0].status, 'unknown');
  assert.equal(recovered.hasActiveReview(request.owner.sessionId), true);
  assert.throws(() => recovered.deleteSession(request.owner.sessionId), /retained release/);
  assert.throws(() => recovered.command(releaseCommand(request, 'merge_candidate', 'retry-merge')), /Reconcile/);
  request = recovered.command({ ...releaseCommand(request, 'reconcile_release', 'observe-merge'), releaseOperationId: 'lost-merge' }).request;
  request = result(recovered, request, 'lost-merge', { status: 'confirmed', detail: 'Observed after restart.', merge: mergeReceipt(request) });
  assert.equal(request.delivery.release.operations.length, 1); assert.equal(request.delivery.release.merge.mergeCommit, 'b'.repeat(40));
});
test('an unknown build needs operator stop attestation before separate retry, and build does not imply publication', async t => {
  const { journal } = await fixture(t); let request = acceptRelease(journal, readyRelease(journal));
  request = journal.command(releaseCommand(request, 'merge_candidate', 'merge')).request;
  request = result(journal, request, 'merge', { status: 'confirmed', detail: 'Merged.', merge: mergeReceipt(request) });
  request = journal.command(releaseCommand(request, 'build_release', 'build-unknown')).request;
  request = result(journal, request, 'build-unknown', { status: 'unknown', detail: 'Stopped before receipt.' });
  assert.equal(releaseView(request, true).canConfirmStopped, true);
  assert.throws(() => journal.command({ ...releaseCommand(request, 'confirm_release_stopped', 'missing-note'), releaseOperationId: 'build-unknown' }), /inspection note/);
  request = journal.command({ ...releaseCommand(request, 'confirm_release_stopped', 'stop-confirmed'), releaseOperationId: 'build-unknown', note: 'Inspected and stopped the owned process tree; retained its worktree.' }).request;
  request = journal.command(releaseCommand(request, 'build_release', 'build-retry')).request;
  const operation = request.delivery.release.operations.at(-1);
  request = result(journal, request, 'build-retry', { status: 'confirmed', detail: 'Build captured.', built: buildReceipt(operation) });
  assert.equal(request.lifecycle, 'in_progress'); assert.equal(releaseView(request, true).canPublish, true);
  assert.equal(releaseView(request, false, 'Approval revoked.').canPublish, false);
  assert.throws(() => journal.command({ ...releaseCommand(request, 'publish_release', 'invalid-tag'), releaseTag: '../outside' }), /Release tags/);
  request = journal.command({ ...releaseCommand(request, 'publish_release', 'publish'), releaseTag: 'v1.0.0' }).request;
  const receipt = { tag: 'v1.0.0', url: 'https://github.com/example/project/releases/tag/v1.0.0', commit: 'b'.repeat(40), assets: request.delivery.release.build.artifacts, publishedAt: '2026-10-25T00:00:00.000Z' };
  assert.throws(() => result(journal, request, 'publish', { status: 'confirmed', detail: 'Missing assets.', published: { ...receipt, assets: [] } }), /Release artifacts/);
  request = result(journal, request, 'publish', { status: 'confirmed', detail: 'Exact release observed.', published: receipt });
  assert.equal(request.lifecycle, 'done'); assert.equal(request.delivery.release.published.commit, 'b'.repeat(40)); assert.equal(releaseView(request, true).canPublish, false);
});
test('one persisted request completes merge, build and publish through the application engine without duplicate mutations', async t => {
  const { journal } = await fixture(t); let request = acceptRelease(journal, readyRelease(journal));
  const calls = []; let merged = false, built = null, published = null;
  /** @type {import('../../src/worker/application/release-contracts.ts').ReleasePort} */
  const port = {
    pullRequest: async operation => ({ number: 17, url: operation.pullRequest.url, branch: operation.pullRequest.branch, base: operation.target.base, headCommit: operation.candidate.candidateCommit, closed: merged, merged,
      mergeCommit: merged ? 'b'.repeat(40) : null, mergedAt: merged ? operation.createdAt : null }),
    merge: async () => { calls.push('merge'); merged = true; }, inspectBuild: async () => built,
    build: async operation => { calls.push('build'); built = buildReceipt(operation); return built; }, inspectRelease: async () => published,
    publish: async operation => { calls.push('publish'); published = { tag: operation.tag, url: 'https://github.com/example/project/releases/tag/' + operation.tag, commit: operation.mergeCommit, assets: operation.build.artifacts, publishedAt: operation.createdAt }; },
  };
  for (const [action, id] of /** @type {const} */ ([['merge_candidate', 'e2e-merge'], ['build_release', 'e2e-build'], ['publish_release', 'e2e-publish']])) {
    const command = { ...releaseCommand(request, action, id), ...(action === 'publish_release' ? { releaseTag: 'v1.0.0' } : {}) };
    request = journal.command(command).request;
    const operation = request.delivery.release.operations.at(-1);
    const observed = await runReleaseOperation({ operation, mode: 'execute', port, authority: { authorize() {} }, signal: new AbortController().signal });
    assert.equal(observed.status, 'confirmed'); request = result(journal, request, id, observed);
    assert.equal(journal.command(command).duplicate, true);
    assert.equal((await runReleaseOperation({ operation: request.delivery.release.operations.at(-1), mode: 'reconcile', port, authority: { authorize() {} }, signal: new AbortController().signal })).status, 'confirmed');
  }
  assert.deepEqual(calls, ['merge', 'build', 'publish']); assert.equal(request.lifecycle, 'done'); assert.equal(request.delivery.release.published.assets[0].sha256, 'b'.repeat(64));
});
