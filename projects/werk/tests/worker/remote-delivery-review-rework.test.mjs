import test from 'node:test';
import assert from 'node:assert/strict';
import { continueReviewRework } from '../../src/worker/dist/worker/status/workspace-review-rework.js';
import { fixture } from './request-gate-fixtures.mjs';
import { readyPublication } from './remote-delivery-fixtures.mjs';
import { parseFeature, featureInput } from '../../src/worker/dist/worker/infrastructure/features/document.js';

/** Real journal plus injected canonical-source writer/dispatch; no provider is invoked.
 * @param {import('node:test').TestContext} t */
async function rework(t) {
  const { journal } = await fixture(t); const initial = readyPublication(journal), candidate = initial.delivery.review.candidate;
  const command = { action: /** @type {const} */ ('request_changes'), requestId: initial.id, expectedRevision: initial.revision, operationId: 'review-feedback',
    inputRevision: initial.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest, note: 'Please correct the visible value.' };
  journal.command(command);
  const calls = [];
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    sessions: { requests: journal }, board: { async executeRequest(id) { calls.push(['execute', id]); } },
    featureProjects: { forSession() {}, sharedForTask() {} },
  }));
  return { journal, initial, command, workspace, calls };
}

test('direct request feedback retains the old candidate and clears acceptance before a new generation dispatch', async t => {
  const h = await rework(t);
  await continueReviewRework(h.workspace, h.command);
  const current = h.journal.get(h.initial.id);
  assert.equal(current.id, h.initial.id); assert.equal(current.inputRevision, h.initial.inputRevision + 1);
  assert.match(current.input.message, /Please correct the visible value/); assert.deepEqual(current.input.context, h.initial.input.context);
  assert.equal(current.attestation, null); assert.equal(current.execution, null);
  assert.deepEqual(current.deliveryHistory.at(-1).review.candidate, h.initial.delivery.review.candidate);
  assert.deepEqual(h.calls, [['execute', h.initial.id]]);
  await continueReviewRework(h.workspace, h.command);
  assert.equal(h.calls.length, 1, 'Replayed source generation is not dispatched twice');
});

test('folder feedback is written with its current file revision and the ordinary watcher owns revision dispatch', async t => {
  const h = await rework(t);
  let markdown = '---\nschema: worker.request/v1\nid: FR-1\ntitle: Feature\nintent: submit\npaths: [value.txt]\n---\n## Outcome\n\nKeep the author text.\n', revision = 'revision-one';
  const original = markdown; let writes = 0, scans = 0;
  const features = /** @type {import('../../src/worker/application/feature-requests.ts').FeatureRequests} */ (/** @type {unknown} */ ({
    async action(body) {
      if (body.action === 'get') return { name: 'request.md', markdown, revision };
      assert.equal(body.action, 'edit'); assert.equal(body.revision, revision); assert.equal(body.name, 'request.md');
      writes++; markdown = body.markdown; revision = 'revision-two'; return { name: body.name, markdown, revision };
    },
    async tick(force) {
      assert.equal(force, true); scans++;
      const current = h.journal.get(h.initial.id), parsed = featureInput(parseFeature(markdown), 'claude-cli');
      h.journal.reviseInput(current.id, { ...current.input, message: parsed.message });
    },
  }));
  h.workspace.featureProjects.forSession = () => /** @type {ReturnType<import('../../src/worker/status/workspace-projects.ts').WorkspaceProjectIntakes['forSession']>} */ ({
    project: { features }, reference: { sourcePath: 'request.md' },
  });
  await continueReviewRework(h.workspace, h.command);
  assert.ok(markdown.startsWith(original.trimEnd())); assert.match(markdown, /## Review feedback/); assert.match(markdown, /werk-review-feedback:review-feedback/);
  assert.equal(writes, 1); assert.equal(scans, 1); assert.equal(h.calls.length, 0, 'Composition does not bypass canonical watcher dispatch');
  const current = h.journal.get(h.initial.id); assert.equal(current.inputRevision, h.initial.inputRevision + 1);
  assert.match(current.input.message, /Please correct the visible value/);
  await continueReviewRework(h.workspace, h.command); assert.equal(writes, 1); assert.equal(scans, 1);
});

test('a failed canonical save keeps feedback held and a repeated command safely retries the same file update', async t => {
  const h = await rework(t); let edits = 0;
  const features = /** @type {import('../../src/worker/application/feature-requests.ts').FeatureRequests} */ (/** @type {unknown} */ ({
    async action(body) {
      if (body.action === 'get') return { name: 'request.md', revision: 'latest', markdown: '---\nschema: worker.request/v1\nid: FR-1\nintent: submit\n---\nUser text.' };
      edits++; throw Error('Concurrent author edit; guarded write refused.');
    },
  }));
  h.workspace.featureProjects.forSession = () => /** @type {ReturnType<import('../../src/worker/status/workspace-projects.ts').WorkspaceProjectIntakes['forSession']>} */ ({ project: { features }, reference: { sourcePath: 'request.md' } });
  await assert.rejects(continueReviewRework(h.workspace, h.command), /guarded write refused/);
  assert.equal(h.journal.get(h.initial.id).phase, 'needs_rework'); assert.equal(h.journal.get(h.initial.id).inputRevision, h.initial.inputRevision);
  assert.equal(h.calls.length, 0); assert.equal(edits, 1);
});

test('shared feedback is forwarded to the owned Git lifecycle before journal scope can change', async t => {
  const h = await rework(t);
  let forwarded = 0;
  h.workspace.featureProjects.sharedForTask = () => /** @type {ReturnType<import('../../src/worker/status/workspace-projects.ts').WorkspaceProjectIntakes['sharedForTask']>} */ ({ project: { sharedRuntime: { intake: { async reviewFeedback(taskId, command) { assert.equal(taskId, h.initial.owner.taskId); assert.deepEqual(command, h.command); forwarded++; } } } }, reference: {} });
  await continueReviewRework(h.workspace, h.command);
  assert.equal(forwarded, 1);
  const request = h.journal.get(h.initial.id);
  assert.equal(request.phase, 'needs_rework'); assert.equal(request.inputRevision, h.initial.inputRevision);
  assert.equal(request.deliveryHolds.find(hold => hold.code === 'review_changes').reason, h.command.note);
  assert.equal(h.calls.length, 0);
});
