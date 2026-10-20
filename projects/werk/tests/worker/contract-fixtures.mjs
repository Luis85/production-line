import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import assert from 'node:assert/strict';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { workerStatus } from '../helpers/worker-status.mjs';

/**
 * Narrow a real union response only after checking its distinguishing field.
 * @template T
 * @template {PropertyKey} K
 * @param {T} value
 * @param {K} key
 * @returns {Extract<T, Record<K, unknown>>}
 */
export function resultWith(value, key) {
  assert.ok(value && typeof value === 'object' && key in value, `Expected result field ${String(key)}`);
  return /** @type {Extract<T, Record<K, unknown>>} */ (value);
}

/** @param {Partial<import('../../src/worker/application/ports.js').WorkerClient>} [overrides] */
export function workerClient(overrides = {}) {
  const unexpected = async () => { throw Error('Unexpected worker-client operation'); };
  return {
    currentAssignments: unexpected, claim: unexpected, heartbeat: unexpected,
    publishSnapshot: unexpected, complete: unexpected, abandon: unexpected,
    ...overrides,
  };
}

/** @param {import('node:test').TestContext} t @param {string} directory */
export async function workspaceFixture(t, directory) {
  const journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64));
  await journal.init();
  t.after(() => journal.close());
  return new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 1000 }, journal, workerStatus);
}

/** @param {Partial<import('../../src/worker/application/feature-workflow.js').SharedFeatureInput>} overrides
 * @returns {import('../../src/worker/application/feature-workflow.js').SharedFeatureInput} */
export function sharedInput(overrides) {
  return {
    id: 'feature-1', templateId: 'feature-request', title: 'Review the feature',
    mode: 'chat', provider: 'claude-cli', message: 'Review the approved request.', priority: 0,
    criteria: ['Review acceptance criteria'], metadata: {},
    sections: { goal: 'Review the feature', context: 'Fixture input', verificationPlan: 'Inspect the review' },
    ...overrides,
  };
}

/** Complete deterministic snapshot; tests override evidence for the boundary being exercised.
 * @param {Partial<import('../../src/shared/snapshots.js').Snapshot>} [overrides]
 * @returns {import('../../src/shared/snapshots.js').Snapshot} */
export function snapshotFixture(overrides = {}) {
  return {
    schemaVersion: 1, id: 'lease-1-before', pairId: 'lease-1', phase: 'before',
    capturedAt: '2026-10-17T00:00:00.000Z', workerId: 'worker-1', project: 'demo', taskId: 'task-1',
    attempt: 1, profileId: 'claude-1', provider: 'claude', mode: 'mock', configuration: {},
    runtime: { processInstanceId: 'process-1', node: 'v24.0.0', platform: 'linux', arch: 'x64', workerVersion: '0.11.0', adapterVersion: 'mock-1' },
    execution: { outcome: 'pending', durationMs: null, timingSource: 'monotonic', error: null },
    resources: { scope: 'worker_process', rssBytes: 100, heapUsedBytes: 50, peakRssBytes: 120, cpuUserMicros: 3, cpuSystemMicros: 2, cpuDeltaMicros: null, uptimeSeconds: 1.5, hostLoad1m: 0.2 },
    health: { serverLastContactAt: null, heartbeatErrors: 0, eventLoopDelayP95Ms: null, recoveredAfterCrash: false },
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, estimatedCostUsd: null, subscriptionAllocatedCostUsd: null, subscriptionRemaining: null, source: 'unavailable_mock', reason: 'Provider did not run' },
    quality: { build: 'not_run', tests: 'not_run', testsTotal: null, testsPassed: null, coveragePercent: null, lintErrors: null, securityFindings: null, gate: 'not_evaluated' },
    provenance: { repoBaseCommit: null, testedCommit: null, contextManifestHash: null, skillsVersion: null, iterationId: null, featureId: null, sourceCommit: null, policyVersion: 'mock-only-1', configurationHash: 'default', systemPromptHash: 'prompt', artifactPath: '.factory/runs/task-1/attempt-1/lease-1/before.json' },
    ...overrides,
  };
}

/** Adapt a deterministic text fixture through the complete structured provider contract.
 * @param {import('../../src/worker/application/provider-contract.js').ProviderConnection} connection
 * @param {import('../../src/worker/application/conversation.js').ConversationModel['reply']} reply
 * @returns {import('../../src/worker/application/model-contract.js').StructuredModel} */
export function structuredReply(connection, reply) {
  return {
    configuration: { id: connection.id, model: connection.model, authenticationMode: connection.authenticationMode, effort: connection.effort, instruction: connection.instruction ?? '' },
    capabilities: modelCapabilities, reply,
    async execute(request, signal, usage) {
      return { type: 'completed', text: await reply(request.messages, signal, usage) };
    },
  };
}
