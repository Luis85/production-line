import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
import { publication } from '../../worker/remote-delivery-fixtures.mjs';
import { defaultGatePolicy } from '../../../src/worker/dist/worker/application/request-gates.js';
const { publicationLink } = await frontend('src/worker/webview/delivery-publication-view.ts');
const { releaseCommand, releaseLink, releaseTagIssue } = await frontend('src/worker/webview/delivery-release-view.ts');
const { workflowTimeline, workflowReleaseNextStep } = await frontend('src/worker/webview/workflow-timeline.ts');
const { managedProjectCommand, emptyManagedProjectDraft } = await frontend('src/worker/webview/managed-project-view.ts');
const { readFeaturePriority } = await frontend('src/worker/webview/feature-priority.ts');
const { readFeatureDetails, writeFeatureDetail } = await frontend('src/worker/webview/feature-authoring-fields.ts');
/** @returns {import('../../../src/worker/application/request-gates').WorkerRequest} */
function requestFixture() {
  const candidate = publication().candidate;
  return { schemaVersion: 1, id: candidate.requestId, owner: { sessionId: 'session', rootTurnId: 'turn' }, revision: 4, inputRevision: candidate.inputRevision,
    input: { kind: 'patch', title: 'Ship the feature', message: 'Implement the accepted feature and publish verified assets.' }, inputHash: candidate.inputHash, policy: defaultGatePolicy(), policyDigest: candidate.policyDigest,
    provider: { id: 'claude-cli', model: 'example-model', instruction: 'Implement accepted scope.' }, phase: 'done', assignee: 'operator', lifecycle: 'done', createdAt: candidate.createdAt, updatedAt: candidate.createdAt, reworkCount: 0,
    evaluations: [], findings: [], candidates: [], reviews: [], execution: { turnId: 'turn', runId: 'provider-run', inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', text: 'The model says release succeeded.' }, outputDigest: 'output', facts: {} },
    attestation: { actor: 'operator', inputHash: candidate.inputHash, outputDigest: 'output', note: 'Reviewed current behavior.', at: candidate.createdAt },
    delivery: { schemaVersion: 1, id: candidate.runId, inputRevision: candidate.inputRevision, inputHash: candidate.inputHash, policyDigest: candidate.policyDigest,
      profile: { schemaVersion: 1, id: 'feature', version: 1, root: { id: 'review', type: 'action', action: 'review', reason: 'Review required.' } }, profileDigest: 'profile', status: 'completed', phase: 'packaging', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2, startedAt: candidate.createdAt, finishedAt: candidate.createdAt, steps: [],
      decision: { profileId: 'feature', profileVersion: 1, selectedNode: 'review', selectedAction: 'review', reason: 'Review required.', waitingFor: null, conditions: [] }, allowedControls: [],
      review: { schemaVersion: 1, candidate, criteria: [], results: [], checks: [], markdown: '# Review', publication: 'local_only' } } };
}
/** @param {import('../../../src/worker/application/request-gates').WorkerRequest} request @returns {import('../../../src/worker/application/release-contracts').ReleaseView} */
function viewFixture(request) {
  return { configured: true, authorized: true, reason: null, candidate: request.delivery.review.candidate,
    target: { repository: 'example/project', base: 'main', mergeMethod: 'squash', tagPrefix: 'v', prerelease: false, build: { executable: 'node', args: ['build.mjs'], timeoutMs: 30000, artifacts: ['release/application.zip'] } },
    state: { operations: [] }, canMerge: true, canBuild: false, canPublish: false, canReconcile: false, canConfirmStopped: false };
}
/** @param {import('../../../src/worker/application/release-contracts').ReleaseView} view @returns {import('../../../src/worker/application/release-contracts').ReleaseOperation} */
function operationFixture(view) {
  return { operationId: 'build-one', action: 'build', status: 'unknown', candidate: view.candidate, target: view.target, repositoryId: 'project', configurationDigest: 'policy', pullRequest: { number: 4, branch: 'feature', url: 'https://github.com/example/project/pull/4' }, createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z', detail: 'The build outcome is not confirmed.' };
}
test('release controls carry exact candidate identity and reject stale input, mismatched candidates and missing authority', () => {
  const request = requestFixture(), view = viewFixture(request), command = releaseCommand(request, view, 'merge_candidate');
  assert.deepEqual(command, { action: 'merge_candidate', deliveryRunId: request.delivery.id, inputRevision: request.inputRevision, candidateCommit: request.delivery.review.candidate.candidateCommit, candidateDigest: request.delivery.review.candidate.candidateDigest });
  assert.equal(releaseCommand(request, { ...view, authorized: false }, 'merge_candidate'), null);
  assert.equal(releaseCommand(request, { ...view, candidate: { ...view.candidate, tree: 'another-tree' } }, 'merge_candidate'), null);
  request.inputRevision++; assert.equal(releaseCommand(request, view, 'merge_candidate'), null);
});
test('uncertain release operations retain their saved identity and stopped-build confirmations require an observation', () => {
  const request = requestFixture(), view = viewFixture(request), receipt = operationFixture(view);
  view.state.operations = [receipt]; view.canReconcile = true;
  assert.equal(releaseCommand(request, view, 'reconcile_release', { receipt })?.releaseOperationId, receipt.operationId);
  assert.equal(releaseCommand(request, view, 'reconcile_release', { receipt: { ...receipt, operationId: 'unrelated' } }), null);
  assert.equal(releaseCommand(request, view, 'confirm_release_stopped', { receipt, note: 'Stopped processes.' }), null);
  view.canConfirmStopped = true;
  assert.equal(releaseCommand(request, view, 'confirm_release_stopped', { receipt, note: ' ' }), null);
  assert.equal(releaseCommand(request, view, 'confirm_release_stopped', { receipt, note: ' Inspected worker and stopped the build. ' })?.note, 'Inspected worker and stopped the build.');
  assert.equal(releaseCommand(request, view, 'confirm_release_stopped', { receipt: { ...receipt, action: 'publish' }, note: 'Inspected.' }), null);
});
test('publishing needs current permission and a selected tag; transport never invents either', () => {
  const request = requestFixture(), view = viewFixture(request);
  assert.equal(releaseCommand(request, view, 'publish_release', { tag: 'v1.0.0' }), null);
  view.canPublish = true;
  assert.equal(releaseCommand(request, view, 'publish_release', { tag: ' ' }), null);
  assert.equal(releaseCommand(request, view, 'publish_release', { tag: ' v1.0.0 ' })?.releaseTag, 'v1.0.0');
});
test('workflow completion follows matching merge, build and release receipts, never a model completion claim', () => {
  const request = requestFixture();
  let stages = workflowTimeline(request);
  assert.equal(stages.length, 8); assert.equal(stages[4].state, 'complete');
  assert.deepEqual(stages.slice(5).map(stage => stage.state), ['pending', 'pending', 'pending']);
  const release = { operations: [], merge: { pullRequest: 4, headCommit: request.delivery.review.candidate.candidateCommit, mergeCommit: '9'.repeat(40), url: 'https://github.com/example/project/pull/4', mergedAt: request.createdAt } };
  request.delivery.release = release;
  assert.equal(workflowTimeline(request)[5].state, 'complete');
  release.build = { operationId: 'build', commit: '8'.repeat(40), artifacts: [{ name: 'application.zip', bytes: 5, sha256: 'f'.repeat(64) }], manifestDigest: 'a'.repeat(64), builtAt: request.createdAt };
  assert.equal(workflowTimeline(request)[6].state, 'pending', 'another commit cannot establish this merge build');
  release.build.commit = release.merge.mergeCommit;
  release.published = { tag: 'v1', url: 'https://github.com/example/project/releases/tag/v1', commit: release.build.commit, assets: release.build.artifacts, publishedAt: request.createdAt };
  assert.deepEqual(workflowTimeline(request).slice(5).map(stage => stage.state), ['complete', 'complete', 'complete']);
  request.inputHash = 'changed'; assert.ok(workflowTimeline(request).every(stage => stage.state === 'unknown'));
});
test('release URL appears only for the matching repository, merged build commit and nonempty asset receipt', () => {
  const request = requestFixture(), view = viewFixture(request);
  view.state.merge = { pullRequest: 4, headCommit: view.candidate.candidateCommit, mergeCommit: '9'.repeat(40), url: 'https://github.com/example/project/pull/4', mergedAt: request.createdAt };
  view.state.build = { operationId: 'build', commit: view.state.merge.mergeCommit, artifacts: [{ name: 'application.zip', bytes: 5, sha256: 'f'.repeat(64) }], manifestDigest: 'a'.repeat(64), builtAt: request.createdAt };
  view.state.published = { tag: 'v1', url: 'https://github.com/example/project/releases/tag/v1', commit: view.state.build.commit, assets: view.state.build.artifacts, publishedAt: request.createdAt };
  assert.equal(releaseLink(view), view.state.published.url);
  for (const url of ['https://example.com/example/project/releases/tag/v1', 'https://github.com/other/project/releases/tag/v1', 'https://secret@github.com/example/project/releases/tag/v1']) { view.state.published.url = url; assert.equal(releaseLink(view), null); }
  view.state.published.url = 'https://github.com/example/project/releases/tag/v1'; view.state.published.assets = [];
  assert.equal(releaseLink(view), null);
});
test('managed registration trims a frozen operation while adoption sends only its explicit checkout', () => {
  const draft = { ...emptyManagedProjectDraft(), id: ' app ', name: ' Application ', repository: ' https://github.com/example/app.git ' };
  const command = managedProjectCommand(draft, 'operation-one');
  draft.id = 'changed'; assert.equal(command.id, 'app'); assert.equal(command.operationId, 'operation-one'); assert.equal(command.branch, 'main');
  const adopted = managedProjectCommand({ ...draft, mode: 'adopt', path: ' C:\\Projects\\app ' }, 'operation-two');
  assert.equal(adopted.action, 'adopt'); assert.equal(adopted.path, 'C:\\Projects\\app'); assert.equal('repository' in adopted, false);
});
test('three-level priority editing preserves legacy ranks and canonical string formats', () => {
  assert.deepEqual(['high', 'normal', 'low', 'urgent'].map(priority => readFeaturePriority({ priority })), [1, 2, 3, 0]);
  assert.equal(readFeaturePriority({ priority: 2 }), 1, 'legacy numeric rank two is high');
  assert.equal(readFeaturePriority({ priority: 1 }), 2, 'legacy numeric rank one is medium');
  assert.equal(readFeaturePriority({ priority: 3, priority_scale: 'three-level/v1' }), 3);
  const markdown = '---\nschemaVersion: 1\npriority: 2\n---\n# Goal\nDo work.\n## Context\nContext.\n## Acceptance criteria\n- [ ] Works.\n## Verification plan\nRun tests.\n';
  const low = writeFeatureDetail(markdown, 'priority', '3'); assert.match(low, /priority_scale: three-level\/v1/); assert.equal(readFeatureDetails(low).priority, 3);
  const canonical = writeFeatureDetail(markdown.replace('schemaVersion: 1', 'schema: worker.request/v1'), 'priority', '1'); assert.match(canonical, /priority: high/); assert.doesNotMatch(canonical, /priority_scale/);
});

test('release next action advances only after exact human acceptance and honors unknown operations', () => {
  const request = requestFixture(), view = viewFixture(request);
  assert.equal(workflowReleaseNextStep(request), null);
  request.input.context = { deliveryPolicy: { schemaVersion: 1, baseline: '1'.repeat(40), configurationDigest: 'policy', profile: { id: 'feature', maxRepairAttempts: 2, verificationInputs: ['tests/'] }, configuration: { reviewDirectory: 'reviews', release: view.target } } };
  assert.equal(workflowReleaseNextStep(request)?.title, 'Merge the reviewed candidate');
  const operation = operationFixture(view); operation.action = 'merge';
  request.delivery.release = { operations: [operation] };
  assert.equal(workflowReleaseNextStep(request)?.title, 'Reconcile the saved merge outcome');
  request.attestation.outputDigest = 'earlier-output';
  assert.equal(workflowReleaseNextStep(request), null);
});

test('rework publication links retain the owned remote branch while candidates use another local branch', () => {
  const receipt = publication('pull_request');
  receipt.status = 'confirmed';
  receipt.predecessor = { candidate: { ...receipt.candidate, candidateCommit: '1'.repeat(40) }, branch: 'werk/original-branch', pullRequest: { number: 4, url: 'https://github.com/example/project/pull/4', state: 'open' } };
  receipt.observation = { branch: receipt.predecessor.branch, commit: receipt.candidate.candidateCommit, pullRequest: receipt.predecessor.pullRequest };
  assert.equal(publicationLink(receipt), receipt.predecessor.pullRequest.url);
  receipt.observation.branch = 'unrelated-branch'; assert.equal(publicationLink(receipt), null);
});

test('release-pending lifecycle retains its completed current candidate and human acceptance', () => {
  const request = requestFixture(), view = viewFixture(request);
  request.input.context = { deliveryPolicy: { schemaVersion: 1, baseline: '1'.repeat(40), configurationDigest: 'policy', profile: { id: 'feature', maxRepairAttempts: 2, verificationInputs: ['tests/'] }, configuration: { reviewDirectory: 'reviews', release: view.target } } };
  request.lifecycle = 'in_progress';
  assert.equal(workflowTimeline(request)[4].state, 'complete');
  assert.equal(workflowReleaseNextStep(request)?.title, 'Merge the reviewed candidate');
  assert.equal(releaseCommand(request, view, 'merge_candidate')?.action, 'merge_candidate');
});

test('release version feedback rejects invalid tags before offering publication', () => {
  const request = requestFixture(), view = viewFixture(request); view.canPublish = true;
  assert.match(releaseTagIssue('1.0.0', 'v'), /Start the release tag/);
  assert.match(releaseTagIssue('v1..0', 'v'), /Avoid repeated dots/);
  assert.equal(releaseTagIssue('v1.0.0', 'v'), '');
  assert.equal(releaseCommand(request, view, 'publish_release', { tag: 'v1..0' }), null);
});
