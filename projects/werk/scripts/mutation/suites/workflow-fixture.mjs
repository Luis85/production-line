const at = '2026-10-25T00:00:00.000Z';
export const target = { remote: 'origin', repository: 'example/project', base: 'main', push: true, pullRequest: true, draft: false };
/** @returns {import('../../../src/worker/application/delivery-review-contracts.ts').DeliveryCandidate} */
function candidate() {
  return { requestId: 'request-one', inputRevision: 1, inputHash: 'a'.repeat(64), runId: 'run-one', baseline: '1'.repeat(40), branch: 'werk/delivery/one',
    candidateCommit: '2'.repeat(40), tree: '3'.repeat(40), candidateDigest: 'd'.repeat(64), patchDigest: 'e'.repeat(64), policyDigest: 'f'.repeat(64), checkDefinitionDigest: 'c'.repeat(64), createdAt: at };
}
/** @returns {import('../../../src/worker/application/remote-delivery-contracts.ts').RemotePublication} */
export function publication() {
  return { operationId: 'publish-one', action: 'pull_request', candidate: candidate(), target: structuredClone(target), repositoryId: 'repo-one', configurationDigest: 'b'.repeat(64), status: 'confirmed',
    createdAt: at, updatedAt: at, detail: 'Exact observed fixture.', observation: { branch: candidate().branch, commit: candidate().candidateCommit, pullRequest: { number: 17, url: 'https://github.com/example/project/pull/17', state: 'open' } } };
}
/** Deliberately independent accepted state; no target implementation creates its own test authority.
 * @returns {import('../../../src/worker/application/request-gates.ts').WorkerRequest} */
export function acceptedRequest() {
  const exact = candidate(), policy = { schemaVersion: 1, id: 'fixture', version: 1, ready: { chat: [], patch: [] }, done: { chat: [], patch: [] }, reviewer: { enabled: false, provider: 'fixture', maxAttempts: 1 }, rework: { maxAttempts: 2 } };
  return /** @type {import('../../../src/worker/application/request-gates.ts').WorkerRequest} */ ({ schemaVersion: 1, id: exact.requestId, owner: { sessionId: 'session-one', rootTurnId: 'turn-one', taskId: 'task-one' }, revision: 4, inputRevision: 1,
    input: { kind: 'patch', title: 'Verified feature', message: 'Implement the accepted feature.', criteria: ['The behavior is correct.'], files: [{ path: 'src/value.ts', bytes: 4 }], context: { deliveryPolicy: { configuration: { release: {} } } } },
    inputHash: exact.inputHash, policy, policyDigest: exact.policyDigest, provider: { id: 'fixture', model: 'fixture', instruction: 'No inference' }, phase: 'done', assignee: 'operator', createdAt: at, updatedAt: at, reworkCount: 0,
    evaluations: [{ id: 'done-one', stage: 'done', inputRevision: 1, inputHash: exact.inputHash, policyDigest: exact.policyDigest, outputDigest: '0'.repeat(64), at, passed: true, facts: {}, rules: [] }], findings: [], candidates: [], reviews: [],
    attestation: { actor: 'operator', inputHash: exact.inputHash, outputDigest: '0'.repeat(64), note: 'Inspected this exact candidate.', at },
    execution: { turnId: 'turn-one', runId: 'invoke-one', inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', text: 'Known result' }, outputDigest: '0'.repeat(64), facts: {} },
    delivery: { schemaVersion: 1, id: exact.runId, inputRevision: 1, inputHash: exact.inputHash, policyDigest: exact.policyDigest, profile: { schemaVersion: 1, id: 'fixture', version: 1, root: { id: 'root', type: 'selector', children: [] } }, profileDigest: '9'.repeat(64), status: 'completed', phase: 'packaging', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2, startedAt: at, finishedAt: at, steps: [], decision: { profileId: 'fixture', profileVersion: 1, selectedNode: 'review', selectedAction: 'review', reason: 'Verified.', waitingFor: null }, allowedControls: [],
      review: { schemaVersion: 1, candidate: exact, criteria: [], results: [], checks: [], markdown: 'Verified.', publication: 'local_only' }, publications: [publication()] },
  });
}
/** @returns {import('../../../src/worker/application/request-gates.ts').RequestCommand} */
export function feedbackCommand() {
  const exact = candidate();
  return { action: 'request_changes', requestId: exact.requestId, expectedRevision: 4, operationId: 'feedback-one', inputRevision: 1, candidateCommit: exact.candidateCommit, candidateDigest: exact.candidateDigest, note: 'Repair the accepted behavior.' };
}
export function reviewRequest() {
  const request = acceptedRequest(); request.phase = 'needs_rework'; request.attestation = null;
  request.deliveryHolds = [{ code: 'review_changes', reason: feedbackCommand().note }]; request.delivery.holds = structuredClone(request.deliveryHolds);
  return request;
}
