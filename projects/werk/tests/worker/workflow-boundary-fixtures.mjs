import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { featureRequestReference } from '../../src/worker/dist/worker/application/feature-request-reference.js';

/** Independent retained facts, deliberately not produced by the dashboard under test.
 * @param {string} id @param {{ submittedAt?:string; completedAt?:string; startedAt?:string; release?:boolean; updatedAt?:string; projectId?:string; profileId?:string }} [options]
 * @returns {import('../../src/worker/application/request-gates.ts').WorkerRequest} */
export function boundaryRequest(id, options = {}) {
  const submittedAt = options.submittedAt ?? '2026-12-01T00:00:00.000Z', startedAt = options.startedAt ?? '2026-12-15T00:00:00.000Z';
  const configuration = defaultDeliveryProjectPolicy(); configuration.localMerge = true;
  if (options.release) { configuration.remoteDelivery = { remote: 'origin', repository: 'example/project', base: 'main', push: true, pullRequest: true, draft: false }; configuration.release = { repository: 'example/project', base: 'main', mergeMethod: 'squash', tagPrefix: 'v', prerelease: false, build: { executable: 'node', args: ['build.mjs'], timeoutMs: 30000, artifacts: ['out/app.zip'] } }; }
  const exact = { requestId: id, inputRevision: 1, inputHash: 'a'.repeat(64), runId: 'run-' + id, baseline: 'b'.repeat(40), branch: 'werk/delivery/' + id, candidateCommit: 'c'.repeat(40), tree: 'd'.repeat(40), candidateDigest: 'd'.repeat(64), patchDigest: 'e'.repeat(64), policyDigest: 'f'.repeat(64), checkDefinitionDigest: 'c'.repeat(64), createdAt: startedAt };
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  return /** @type {import('../../src/worker/application/request-gates.ts').WorkerRequest} */ ({ schemaVersion: 1, id, owner: { sessionId: 'session-' + id, rootTurnId: 'turn-' + id, taskId: 'task-' + id }, revision: 1, inputRevision: 1,
    input: { kind: 'patch', title: 'PRIVATE_WORKFLOW_TITLE', message: 'PRIVATE_WORKFLOW_REQUIREMENTS', criteria: ['Known result'], files: [{ path: 'value.txt', bytes: 1 }], context: { repositoryId: options.projectId ?? 'project-one', deliveryPolicy: deliveryPolicySnapshot(configuration, exact.baseline, options.profileId) } },
    inputHash: exact.inputHash, policy, policyDigest: exact.policyDigest, provider: { id: 'fixture', model: 'fixture', instruction: 'fixture' }, phase: 'done', lifecycle: options.completedAt ? 'done' : 'in_progress', assignee: 'operator', createdAt: submittedAt, updatedAt: options.updatedAt ?? options.completedAt ?? '2027-01-04T00:00:00.000Z', reworkCount: 0,
    evaluations: [], findings: [], candidates: [], reviews: [], attestation: { actor: 'operator', inputHash: exact.inputHash, outputDigest: '0'.repeat(64), note: 'PRIVATE_REVIEW_NOTE', at: startedAt },
    execution: { turnId: 'turn-' + id, runId: 'invocation-' + id, inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', text: 'PRIVATE_OUTPUT' }, outputDigest: '0'.repeat(64), facts: {} },
    delivery: { schemaVersion: 1, id: exact.runId, inputRevision: 1, inputHash: exact.inputHash, policyDigest: exact.policyDigest, profile: { schemaVersion: 1, id: 'fixture', version: 1, root: { id: 'root', type: 'selector', children: [] } }, profileDigest: '9'.repeat(64), status: 'completed', phase: 'packaging', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2, startedAt, finishedAt: startedAt,
      steps: [{ id: 'implement', phase: 'implementing', status: 'completed', turnId: null, invocationRunId: null, startedAt, finishedAt: startedAt, detail: 'Known implementation.' }], decision: { profileId: 'fixture', profileVersion: 1, selectedNode: 'review', selectedAction: 'review', reason: 'Known', waitingFor: null, conditions: [] }, allowedControls: [],
      review: { schemaVersion: 1, candidate: exact, criteria: [], results: [], checks: [], markdown: 'PRIVATE_REVIEW_MARKDOWN', publication: 'local_only' },
      ...(options.completedAt ? options.release ? { release: { operations: [], published: { tag: 'v1.0.0', url: 'https://github.com/example/project/releases/tag/v1.0.0', commit: 'e'.repeat(40), assets: [], publishedAt: options.completedAt } } } : { localMerge: { operations: [], merged: { branch: 'main', previousHead: 'b'.repeat(40), candidateCommit: exact.candidateCommit, mergeCommit: 'e'.repeat(40), tree: exact.tree, mergedAt: options.completedAt } } } : {}),
    },
  });
}
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request
 * @param {number} sequence @param {string} at @param {string} type
 * @param {import('../../src/worker/application/request-gates.ts').RequestPhase} phase
 * @param {import('../../src/worker/application/delivery-contracts.ts').DeliveryLifecycle} lifecycle
 * @returns {import('../../src/worker/application/request-gates.ts').RequestEvent} */
export function boundaryEvent(request, sequence, at, type, phase, lifecycle) {
  return { schemaVersion: 1, id: request.id + '-event-' + sequence, sequence, requestId: request.id, revision: sequence, type, phase, at, inputRevision: 1,
    measurement: { projectId: 'project-one', profileId: 'feature', lifecycle, blockers: [] } };
}
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request @param {string|null} submittedAt
 * @returns {import('../../src/worker/application/feature-intake-measurement.ts').FeatureIntakeMeasurement} */
export function boundaryIntake(request, submittedAt) {
  const feature = featureRequestReference({ id: request.id, source: 'folder', scope: '/fixture/features', sourcePath: request.id + '.md', repositoryId: 'project-one' });
  request.owner.featureId = feature.key;
  return { feature, projectId: 'project-one', profileId: 'feature', submittedAt, observedAt: submittedAt ?? '2026-12-01T00:00:00.000Z', complete: submittedAt !== null, sessionId: request.owner.sessionId, events: [] };
}
