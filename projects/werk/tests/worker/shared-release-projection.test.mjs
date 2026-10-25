import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, sourcePath, source } from './shared-feature-fixture.mjs';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { acceptedSharedBody } from '../../src/worker/dist/worker/infrastructure/features/shared-progress.js';
import { featureSourceHold } from '../../src/worker/dist/worker/status/workspace-delivery.js';
import { sharedReleasePhase, sharedReleaseProjection } from '../../src/worker/dist/worker/application/shared-release-projection.js';

const merge = { pullRequest: 17, headCommit: '1'.repeat(40), mergeCommit: '2'.repeat(40), url: 'https://github.com/example/project/pull/17', mergedAt: '2026-10-25T00:00:00.000Z' };
const assets = [{ name: 'app.zip', bytes: 10, sha256: 'a'.repeat(64) }];
const build = { operationId: 'build-one', commit: merge.mergeCommit, artifacts: assets, manifestDigest: 'b'.repeat(64), builtAt: merge.mergedAt };
const published = { tag: 'v1.0.0', url: 'https://github.com/example/project/releases/tag/v1.0.0', commit: merge.mergeCommit, assets, publishedAt: merge.mergedAt };

/** @param {Awaited<ReturnType<typeof fixture>>} h @param {import('../../src/worker/application/release-contracts.ts').DeliveryRelease} release */
function observe(h, release) {
  h.controls.inspect = execution => ({ ...execution, request: { ...execution.request, phase: 'done', lifecycle: release.published ? 'done' : 'in_progress',
    attestation: { actor: 'operator', inputHash: execution.request.inputHash, outputDigest: execution.request.execution.outputDigest, note: 'Fixture accepted candidate.', at: merge.mergedAt },
    input: { ...execution.request.input, context: { deliveryPolicy: { configuration: { release: {} } } } },
    delivery: { ...execution.request.delivery, holds: [], release },
  } });
}

test('shared canonical notes advance beyond ready_for_review and report done only after confirmed release publication', async t => {
  const h = await fixture(t); await h.intake.sync(); await h.complete(); await h.intake.sync();
  assert.equal(h.intake.view().requests[0].status, 'ready_for_review');
  for (const [release, expected] of /** @type {[import('../../src/worker/application/release-contracts.ts').DeliveryRelease, string][]} */ ([
    [{ operations: [] }, 'accepted'], [{ operations: [], merge }, 'merged'], [{ operations: [], merge, build }, 'built'], [{ operations: [], merge, build, published }, 'done'],
  ])) {
    observe(h, release); await h.intake.sync();
    const row = h.intake.view().requests[0], markdown = h.repositories.get('shared').files.get(sourcePath);
    assert.equal(row.status, expected); assert.equal(row.publication, 'synced');
    assert.match(markdown, /Merge, build and release/);
    assert.equal(acceptedSharedBody(parseFeature(markdown)), parseFeature(source).body, 'Release projection cannot modify accepted author scope');
    if (expected !== 'done') assert.doesNotMatch(markdown, /Published release: https:/);
    else { assert.match(markdown, /Published release: https:\/\/github.com\/example\/project/); assert.match(markdown, /app.zip/); assert.match(markdown, /SHA-256/); }
  }
  const writes = h.lifecycleAttempts.length; await h.intake.sync(); assert.equal(h.lifecycleAttempts.length, writes, 'Settled release source does not republish unchanged observations');
});

test('pending, unknown and failed release operations remain visible in the same shared source', async t => {
  const h = await fixture(t); await h.intake.sync(); await h.complete(); await h.intake.sync();
  const operation = { operationId: 'build-one', action: /** @type {const} */ ('build'), candidate: {}, target: { build: { executable: '/private/tool', args: ['private-token'] } },
    repositoryId: 'repo', configurationDigest: 'c'.repeat(64), pullRequest: {}, createdAt: merge.mergedAt, updatedAt: merge.mergedAt, detail: 'A bounded build observation.' };
  for (const [status, expected] of /** @type {const} */ ([['pending', 'building'], ['unknown', 'release_outcome_unknown'], ['failed', 'release_failed']])) {
    observe(h, /** @type {import('../../src/worker/application/release-contracts.ts').DeliveryRelease} */ (/** @type {unknown} */ ({ operations: [{ ...operation, status }], merge })));
    await h.intake.sync();
    assert.equal(h.intake.view().requests[0].status, expected);
    const markdown = h.repositories.get('shared').files.get(sourcePath);
    assert.match(markdown, /build-one/); assert.doesNotMatch(markdown, /private-token|private\/tool/);
    assert.doesNotMatch(markdown, /Published release: https:/);
  }
});

test('changed canonical shared source prevents downstream release progression and is never overwritten', async t => {
  const h = await fixture(t); await h.intake.sync(); await h.complete(); await h.intake.sync();
  observe(h, { operations: [], merge });
  const repository = h.repositories.get('shared'), authored = repository.files.get(sourcePath) + '\nA teammate changed the accepted source.\n';
  h.commitFiles('shared', { [sourcePath]: authored });
  const writes = h.lifecycleAttempts.length; await h.intake.sync();
  assert.equal(h.lifecycleAttempts.length, writes); assert.equal(repository.files.get(sourcePath), authored);
  assert.match(h.intake.view().requests[0].error, /canonical shared Feature Request/);
});

test('public release projection excludes runtime authority while preserving exact build and publication receipts', () => {
  const release = /** @type {import('../../src/worker/application/release-contracts.ts').DeliveryRelease} */ (/** @type {unknown} */ ({ operations: [{ operationId: 'publish-one', action: 'publish', status: 'confirmed', detail: 'Verified assets.', target: { private: 'secret' }, candidate: { localPath: '/private/worktree' } }], merge, build, published }));
  const projection = sharedReleaseProjection(release);
  assert.doesNotMatch(JSON.stringify(projection), /secret|private\/worktree/);
  assert.deepEqual(projection.merge, merge); assert.deepEqual(projection.build, build); assert.deepEqual(projection.published, published);
  assert.equal(sharedReleasePhase(null), null);
});


test('accepted but unpublished local work still receives canonical-source holds', async () => {
  const current = { id: 'request-one', phase: 'done', lifecycle: 'in_progress' }, updates = [];
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({ sessions: { requests: {
    forSession() { return current; }, deliveryUpdate(id, update) { updates.push({ id, update }); },
  } } }));
  const record = /** @type {import('../../src/worker/application/feature-requests.ts').FeatureRecord} */ (/** @type {unknown} */ ({ sessionId: 'session-one' }));
  await featureSourceHold(workspace, record, { code: 'missing_source', reason: 'Restore the canonical note.' });
  assert.deepEqual(updates, [{ id: current.id, update: { action: 'hold', code: 'source', reason: 'Restore the canonical note.' } }]);
  current.lifecycle = 'done'; await featureSourceHold(workspace, record, { code: 'missing_source', reason: 'Post-release author edit.' });
  assert.equal(updates.length, 1, 'A completed published request remains historical');
});
