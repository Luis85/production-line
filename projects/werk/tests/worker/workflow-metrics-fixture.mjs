import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
/** @returns {import('../../src/worker/application/request-gates.ts').WorkerRequest} */
export function workflowRequest(id = 'request-one', projectId = 'project-one') {
  return { schemaVersion: 1, id, owner: { sessionId: id, rootTurnId: 'turn', taskId: id }, policy: defaultGatePolicy(), revision: 1, inputRevision: 1, inputHash: 'input', policyDigest: 'policy',
    input: { kind: 'patch', title: 'Private requested outcome', message: 'Private instructions must not enter an aggregate report.', context: { repositoryId: projectId, deliveryPolicy: { profile: { id: 'feature' }, configuration: { localMerge: true } } } },
    provider: { id: 'claude-cli', model: '', instruction: '' }, phase: 'ready', lifecycle: 'ready', assignee: 'llm', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    reworkCount: 0, evaluations: [], findings: [], candidates: [], reviews: [], execution: null, attestation: null };
}

/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request
 * @returns {import('../../src/worker/application/delivery-contracts.ts').DeliveryRun} */
export function workflowRun(request) {
  return { schemaVersion: 1, id: request.id + '-run', inputRevision: 1, inputHash: request.inputHash, policyDigest: request.policyDigest,
    profile: { schemaVersion: 1, id: 'behavior', version: 1, root: { id: 'wait', type: 'action', action: 'wait', reason: 'Wait' } }, profileDigest: 'behavior',
    status: 'running', phase: 'implementing', control: null, holds: [], repairAttempts: 0, maxRepairAttempts: 2, startedAt: '2026-10-19T01:00:00.000Z', finishedAt: null, steps: [],
    decision: { profileId: 'behavior', profileVersion: 1, selectedNode: 'wait', selectedAction: 'wait', reason: 'Wait', waitingFor: null, conditions: [] }, allowedControls: [] };
}
/** @param {string} id @param {import('../../src/worker/application/delivery-contracts.ts').DeliveryPhase} phase @param {string} startedAt
 * @param {string} [finishedAt] @param {import('../../src/worker/application/delivery-contracts.ts').DeliveryStep['status']} [status]
 * @returns {import('../../src/worker/application/delivery-contracts.ts').DeliveryStep} */
export function workflowStep(id, phase, startedAt, finishedAt = startedAt, status = 'completed') {
  return { id, phase, status, startedAt, finishedAt, turnId: null, invocationRunId: null, detail: null };
}
/** @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request @param {number} sequence @param {string} type @param {string} at
 * @param {import('../../src/worker/application/request-gates.ts').RequestPhase} phase @param {Partial<import('../../src/worker/application/request-gates.ts').RequestEvent>} [extra]
 * @returns {import('../../src/worker/application/request-gates.ts').RequestEvent} */
export function workflowEvent(request, sequence, type, at, phase, extra = {}) {
  return { schemaVersion: 1, id: request.id + '-event-' + sequence, requestId: request.id, revision: sequence, inputRevision: 1, sequence, type, at, phase,
    measurement: { projectId: 'project-one', profileId: 'feature', lifecycle: phase === 'review' ? 'in_review' : phase === 'ready' ? 'ready' : 'in_progress', blockers: [] }, ...extra };
}
