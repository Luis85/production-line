import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, sourcePath, source } from './shared-feature-fixture.mjs';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { acceptedSharedBody, sharedProgressSection } from '../../src/worker/dist/worker/infrastructure/features/shared-progress.js';
import { sharedLocalMergePhase } from '../../src/worker/dist/worker/application/shared-local-merge-projection.js';
import { localMergeProjection, validLocalMergeProjection } from '../../src/worker/dist/worker/application/local-merge-markdown.js';

const merged = { mergeCommit: '2'.repeat(40), tree: '3'.repeat(40), previousHead: '4'.repeat(40), candidateCommit: '1'.repeat(40), branch: 'main', mergedAt: '2026-10-25T00:00:00.000Z' };
/** @param {Awaited<ReturnType<typeof fixture>>} h @param {import('../../src/worker/application/local-merge-contracts.ts').LocalMergeState} state */
function observe(h, state) {
  h.controls.inspect = execution => ({ ...execution, request: { ...execution.request, phase: 'done', lifecycle: state.merged ? 'done' : 'in_progress',
    attestation: { actor: 'operator', inputHash: execution.request.inputHash, outputDigest: execution.request.execution.outputDigest, note: 'Fixture acceptance.', at: merged.mergedAt },
    input: { ...execution.request.input, context: { deliveryPolicy: { configuration: { localMerge: true } } } },
    delivery: { ...execution.request.delivery, holds: [], localMerge: state },
  } });
}

test('shared Git-only request advances from review through explicit merge and settles with unchanged author scope', async t => {
  const h = await fixture(t); await h.intake.sync(); await h.complete(); await h.intake.sync();
  assert.equal(h.intake.view().requests[0].status, 'ready_for_review');
  for (const [state, expected] of /** @type {[import('../../src/worker/application/local-merge-contracts.ts').LocalMergeState,string][]} */ ([[{ operations: [] }, 'accepted'], [{ operations: [], merged }, 'done']])) {
    observe(h, state); await h.intake.sync();
    const row = h.intake.view().requests[0], markdown = h.repositories.get('shared').files.get(sourcePath);
    assert.equal(row.status, expected); assert.equal(row.publication, 'synced');
    assert.match(markdown, /Main checkout integration/);
    assert.equal(acceptedSharedBody(parseFeature(markdown)), parseFeature(source).body);
    if (expected === 'done') assert.match(markdown, new RegExp('Confirmed merge: ' + merged.mergeCommit));
    else assert.match(markdown, /Main checkout merge: not confirmed/);
  }
  const writes = h.lifecycleAttempts.length; await h.intake.sync();
  assert.equal(h.lifecycleAttempts.length, writes, 'A settled merge does not republish or readmit the request');
  assert.equal(h.submits.length, 1);
});

test('unknown merge is visible without exporting checkout paths or executable authority', async t => {
  const h = await fixture(t); await h.intake.sync(); await h.complete(); await h.intake.sync();
  const operation = { operationId: 'merge-one', status: 'unknown', detail: 'Read-only reconciliation required.', checkoutPath: '/private/main', candidate: { authority: 'private-token' } };
  observe(h, /** @type {import('../../src/worker/application/local-merge-contracts.ts').LocalMergeState} */ (/** @type {unknown} */ ({ operations: [operation] })));
  await h.intake.sync();
  assert.equal(h.intake.view().requests[0].status, 'merge_outcome_unknown');
  const markdown = h.repositories.get('shared').files.get(sourcePath);
  assert.match(markdown, /merge-one/); assert.doesNotMatch(markdown, /private-token|private\/main|Confirmed merge:/);
  assert.deepEqual(localMergeProjection(undefined), { operations: [] });
  assert.deepEqual(localMergeProjection({ operations: [], merged: { ...merged, metadataPaths: ['private/metadata.md'] } }).merged, merged, 'Public receipts retain exact commits without private merge exception inventories');
});

test('malformed repository-authored local merge projections cannot crash or counterfeit a receipt', () => {
  const base = { schemaVersion: 1, summary: 'Waiting', sourceBodyHash: 'a'.repeat(64), task: null, review: null };
  for (const value of [{ operations: [null] }, { operations: [{ operationId: 'm', status: 'unknown', detail: 42 }] }, { operations: [], merged: {} }, { operations: [], merged: { ...merged, mergeCommit: 'fake' } }, { operations: [], merged: { ...merged, branch: 'main\nInjected' } }, { operations: [], merged: { ...merged, metadataPaths: ['../secret'] } }, { operations: [], checkoutPath: '/private' }]) {
    assert.equal(validLocalMergeProjection(value), false);
    assert.equal(sharedProgressSection({ ...base, localMergeJson: JSON.stringify(value) }), '');
  }
  assert.equal(validLocalMergeProjection({ operations: [], merged }), true);
  assert.match(sharedProgressSection({ ...base, localMergeJson: JSON.stringify({ operations: [], merged }) }), /Confirmed merge:/);
});


test('early human acceptance cannot bypass the actual Git branch and Markdown review handoff', async t => {
  const h = await fixture(t); await h.intake.sync(); await h.complete();
  observe(h, { operations: [] });
  await h.intake.sync();
  let row = h.intake.view().requests[0];
  assert.ok(['ready_for_review', 'accepted'].includes(row.status)); assert.equal(h.featureCommits, 1); assert.ok(row.reviewNote);
  assert.match(h.repositories.get('shared').files.get(row.reviewNote), /type: PullRequest/);
  await h.intake.sync(); row = h.intake.view().requests[0];
  assert.equal(row.status, 'accepted'); assert.equal(h.featureCommits, 1); assert.equal(h.submits.length, 1);
});


test('preacceptance provider holds retain implementation status instead of claiming merge failure', () => {
  const request = /** @type {import('../../src/worker/application/request-gates.ts').WorkerRequest} */ (/** @type {unknown} */ ({ phase: 'running', input: { context: { deliveryPolicy: { configuration: { localMerge: true } } } }, delivery: { holds: [{ code: 'provider_authentication_required' }] } }));
  assert.equal(sharedLocalMergePhase(request), null);
});
