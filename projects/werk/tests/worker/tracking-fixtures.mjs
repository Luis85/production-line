import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { defaultFeatureWorkflow, defaultFeatureCheck } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { defaultSharedIntakeConfig } from '../../src/worker/dist/worker/application/shared-feature-state.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { sharedInput, workspaceFixture } from './contract-fixtures.mjs';

const trackingAt = '2026-10-16T12:00:00.000Z';
/** @param {string} [id] @returns {import('../../src/worker/application/interactions.js').InteractionView} */
export function interactionView(id = 'task-one') {
  return { schemaVersion: 1, sessionId: id, revision: 0, phase: 'idle', pending: null, latestTurn: null, turns: [], totalTurns: 0 };
}
/** @param {string} [id] @param {Partial<import('../../src/worker/application/feature-tracking.js').FeatureTrackingInput['session']>} [extra]
 * @returns {import('../../src/worker/application/feature-tracking.js').FeatureTrackingInput['session']} */
export function trackingSession(id = 'task-one', extra = {}) {
  return { id, taskId: id, title: 'Improve worker interaction', provider: 'codex-cli', kind: 'chat', status: 'draft', createdAt: trackingAt, archived: false, messages: 0, busy: false, interaction: interactionView(id), ...extra };
}
/** @param {import('../../src/worker/application/conversation.js').ChatMessage['role']} role @param {string} text
 * @param {Partial<import('../../src/worker/application/conversation.js').ChatMessage>} [extra]
 * @returns {import('../../src/worker/application/conversation.js').ChatMessage} */
export function trackingMessage(role, text, extra = {}) {
  return { id: role + '-one', role, text, at: trackingAt, state: 'complete', ...extra };
}
/** Private prompt is deliberately complete so projection tests exercise valid saved dispatches.
 * @param {'chat' | 'patch'} [operation] @param {boolean} [development] */
export function trackingDispatch(operation = 'chat', development = false) {
  const model = { async reply() { throw Error('Projection must not execute a provider.'); },
    configuration: { id: 'openai-api', model: 'fixture', instruction: 'PRIVATE_PROMPT' },
    ...(development ? { toolManifest: { revision: 1, tools: [{ name: 'werk_candidate_apply', description: 'Approved candidate', inputSchema: { type: 'object' } }] } } : {}),
  };
  return prepareModelRequest(model, [], operation);
}
/** @param {Partial<import('../../src/worker/application/interactions.js').InteractionTurn>} [extra]
 * @returns {import('../../src/worker/application/interactions.js').InteractionTurn} */
export function trackingTurn(extra = {}) {
  return { schemaVersion: 1, id: 'turn-one', sessionId: 'task-one', kind: 'message', status: 'completed', createdAt: trackingAt, finishedAt: trackingAt, priorTurnId: null, runId: 'run-one', input: 'Make the interface clearer.', context: { secret: 'PRIVATE_CONTEXT' }, dispatch: trackingDispatch(), dispatchDigest: null, result: { type: 'completed', text: '**Completed result**' }, usage: null, errorCode: null, ...extra };
}
/** @param {Partial<import('../../src/worker/application/request-gates.js').WorkerRequest>} [extra]
 * @returns {import('../../src/worker/application/request-gates.js').WorkerRequest} */
export function trackingRequest(extra = {}) {
  return { schemaVersion: 1, id: 'request-one', owner: { sessionId: 'task-one', rootTurnId: 'turn-one', taskId: 'task-one' }, revision: 1, inputRevision: 1,
    input: { kind: 'patch', title: 'Implement feature', message: 'Implement the approved feature.', criteria: ['Observable feature behavior'] },
    inputHash: 'input', policy: defaultGatePolicy(), policyDigest: 'policy', provider: { id: 'openai-api', model: 'fixture', instruction: '' }, phase: 'review', assignee: 'operator',
    createdAt: trackingAt, updatedAt: trackingAt, reworkCount: 0, evaluations: [], findings: [], candidates: [], reviews: [], execution: null, attestation: null, ...extra };
}
/** @param {Partial<import('../../src/worker/application/run-evidence.js').WorkerRun>} [extra]
 * @returns {import('../../src/worker/application/run-evidence.js').WorkerRun} */
export function trackingRun(extra = {}) {
  return { schemaVersion: 1, id: 'run-one', sequence: 1, attempt: 1, outcome: 'completed', sessionId: 'task-one', taskId: 'task-one', kind: 'chat', title: 'Implement feature', provider: 'openai-api', model: 'fixture',
    acceptedAt: trackingAt, before: null, after: null, startedAt: null, durationMs: null, queueDurationMs: null, usage: unknownUsage(), resourceDelta: { scope: 'worker_process_between_snapshots', cpuUserMicros: null, cpuSystemMicros: null }, ...extra };
}
/** @param {Partial<import('../../src/worker/application/local-task-contracts.js').LocalTask>} [extra]
 * @returns {import('../../src/worker/application/local-task-contracts.js').LocalTask} */
export function trackingTask(extra = {}) {
  return { id: 'task-one', title: 'Implement feature', instruction: 'Implement the approved feature.', sessionId: 'task-one', provider: 'openai-api', model: 'fixture', repository: '/project', files: [], status: 'review', priority: 0, createdAt: trackingAt, finishedAt: trackingAt, error: null, summary: 'Implemented feature', patch: null, archived: false, ...extra };
}
/** @param {Partial<import('../../src/worker/application/feature-workflow.js').FeatureWorkflowSnapshot>} [extra]
 * @returns {import('../../src/worker/application/feature-workflow.js').FeatureWorkflowSnapshot} */
export function trackingWorkflow(extra = {}) {
  const configuration = defaultFeatureWorkflow();
  const file = path => ({ path, sha256: 'a'.repeat(64) });
  return { schemaVersion: 1, commit: 'a'.repeat(40), configuration, readyCheck: defaultFeatureCheck('ready'), doneCheck: defaultFeatureCheck('done'), policy: defaultGatePolicy(), policyDigest: 'policy', template: '# Feature request',
    files: { configuration: file('.werk/feature-workflow.json'), readyCheck: file(configuration.readyCheck), doneCheck: file(configuration.doneCheck), template: file(configuration.template), base: file(configuration.base) }, ...extra };
}
/** @param {Partial<import('../../src/worker/application/shared-feature-state.js').SharedFeatureRecord>} [extra]
 * @returns {import('../../src/worker/application/shared-feature-state.js').SharedFeatureRecord} */
export function trackingSharedRecord(extra = {}) {
  return { id: 'feature-one', name: 'feature.md', title: 'Implement feature', status: 'queued', owner: 'worker', isLocal: true, sourceCommit: 'a'.repeat(40), updatedAt: trackingAt,
    ready: null, done: null, featureBranch: null, reviewNote: null, publication: 'synced', error: null, taskId: 'task-one', binding: defaultSharedIntakeConfig(), sourcePath: 'features/feature.md', sourceMarkdown: '# Implement feature', remoteRevision: 'a'.repeat(64), accepted: sharedInput({}), inputHash: 'input', workflow: trackingWorkflow(), claimed: true, submitted: true, ...extra };
}
/** Actual composition with isolated journals; tests override only the boundary they observe.
 * @param {import('node:test').TestContext} t */
export async function trackingWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-tracking-view-'));
  const workspace = await workspaceFixture(t, directory);
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  await workspace.init();
  return { workspace, directory };
}
