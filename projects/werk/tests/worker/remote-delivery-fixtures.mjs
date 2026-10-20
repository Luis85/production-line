import assert from 'node:assert/strict';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { provider } from './request-gate-fixtures.mjs';

/** @type {import('../../src/worker/application/remote-delivery-policy.ts').RemoteDeliveryPolicy} */
export const target = { remote: 'origin', repository: 'example/project', base: 'main', push: true, pullRequest: true, draft: true };
/** @returns {import('../../src/worker/application/delivery-review-contracts.ts').DeliveryCandidate} */
function candidate() {
  return { requestId: 'request-one', inputRevision: 1, inputHash: 'a'.repeat(64), runId: 'delivery-one', baseline: '1'.repeat(40),
    branch: 'werk/delivery/candidate-one', candidateCommit: '2'.repeat(40), tree: '3'.repeat(40), candidateDigest: '4'.repeat(64),
    patchDigest: '5'.repeat(64), policyDigest: '6'.repeat(64), checkDefinitionDigest: '7'.repeat(64), createdAt: '2026-10-20T00:00:00.000Z' };
}
/** @param {'push'|'pull_request'} [action] @returns {import('../../src/worker/application/remote-delivery-contracts.ts').RemotePublication} */
export function publication(action = 'push') {
  return { operationId: 'publication-one', action, candidate: candidate(), target: structuredClone(target), repositoryId: 'repo-one',
    configurationDigest: '8'.repeat(64), status: 'pending', detail: 'Saved intent.', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' };
}
/** Trusted package fixture tests journal authority, not Git or provider execution.
 * @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal */
export function readyPublication(journal) {
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  const config = defaultDeliveryProjectPolicy(); config.remoteDelivery = structuredClone(target);
  const snapshot = deliveryPolicySnapshot(config, '1'.repeat(40));
  const request = journal.ensure({ owner: { sessionId: 'session-remote', rootTurnId: 'turn-remote', taskId: 'task-remote' }, provider, policy,
    input: { kind: 'patch', title: 'Publish a bounded candidate', message: 'Implement the accepted value change with separate publication and human review.',
      criteria: ['The visible value is two.'], context: { implementation: { schemaVersion: 1, mode: 'worktree', baseCommit: '1'.repeat(40), approvedPaths: ['value.txt'], checks: [{ id: 'unit', name: 'Unit tests', fingerprint: '9'.repeat(64) }] }, repositoryId: 'repo-one', deliveryPolicy: snapshot }, files: [{ path: 'value.txt', bytes: 2 }] } });
  assert.equal(journal.evaluate(request.id, 'ready').passed, true);
  journal.bindTurn(request.id, 'turn-remote');
  const prepared = journal.prepareExecution(request.id, 'turn-remote', 'invocation-remote');
  const exact = { ...candidate(), requestId: request.id, runId: prepared.delivery.id, inputRevision: request.inputRevision, inputHash: request.inputHash, policyDigest: request.policyDigest };
  journal.deliveryUpdate(request.id, { action: 'review', deliveryRunId: exact.runId, review: { schemaVersion: 1, publication: 'local_only', candidate: exact,
    markdown: '## Change summary\n\nChanged the visible value.\n\n## Approved scope\n\nvalue.txt', checks: [],
    criteria: [{ id: 'human:1:0123456789ab', description: 'The visible value is two.', mandatory: true, evaluator: 'human' }],
    results: [{ criterionId: 'human:1:0123456789ab', status: 'pending_human', evidenceRefs: [] }] } });
  journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: exact.runId, stepId: 'package-candidate', phase: 'packaging' });
  journal.deliveryUpdate(request.id, { action: 'finish', deliveryRunId: exact.runId, stepId: 'package-candidate', status: 'completed', detail: 'Trusted test package was retained.' });
  journal.startExecution(request.id, 'turn-remote', 'invocation-remote');
  const result = journal.recordResult(request.id, 'turn-remote', 'invocation-remote', { type: 'completed', text: 'Known implementation result.' },
    { 'output.nonEmpty': true, 'output.protocolValid': true, 'output.patchPresent': true, 'output.verificationPassed': true, 'output.requiredCheckCount': 1, 'output.candidateDigest': exact.candidateDigest });
  assert.equal(result.phase, 'review'); assert.equal(result.delivery.status, 'completed');
  return result;
}
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request
 * @param {import('../../src/worker/application/remote-delivery-contracts.ts').RemotePublicationCommand} action @param {string} operationId
 * @returns {import('../../src/worker/application/request-gates.ts').RequestCommand} */
export function publicationCommand(request, action, operationId) {
  const exact = request.delivery.review.candidate;
  return { action, operationId, requestId: request.id, expectedRevision: request.revision, deliveryRunId: exact.runId, inputRevision: exact.inputRevision,
    candidateCommit: exact.candidateCommit, candidateDigest: exact.candidateDigest };
}
