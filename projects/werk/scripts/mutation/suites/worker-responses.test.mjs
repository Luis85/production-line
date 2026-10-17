import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { responseRecord, assignmentResponse, acknowledgeSnapshot, acknowledgeCompletion, acknowledgeAbandonment, contextIdentity } from '../../../.mutation-build/worker/infrastructure/responses.js';

const context = () => ({ sha256: 'a'.repeat(64), commit: 'b'.repeat(40), featureId: 'feature', path: 'features/one.md' });
/** @returns {import('../../../src/shared/domain.js').Task} */
const task = () => ({ id: 'task', project: 'demo', workerId: 'worker', profile: 'profile', lease: 'lease', attempt: 1, expiresAt: 1000, createdAt: 0, status: 'running', title: 'Task', criteria: ['Done'], wikilinks: [], provider: 'claude', priority: 1, executionMode: 'mock' });
/** @param {unknown} value */
const rejectsAssignment = value => assert.throws(() => assignmentResponse(value), { message: 'Invalid orchestrator assignment', retryable: false });

test('assignments preserve complete authority, optional context and future response extensions', () => {
  const value = { ...task(), repository: 'repo', context: context(), extension: { version: 2 } };
  assert.equal(assignmentResponse(value), value);
  for (const id of ['a', 'a_b-0', 'z'.repeat(100)]) assert.equal(assignmentResponse({ ...task(), id, lease: id }).id, id);
  for (const attempt of [1, Number.MAX_SAFE_INTEGER]) assert.equal(assignmentResponse({ ...task(), attempt }).attempt, attempt);
  for (const key of ['createdAt', 'expiresAt']) for (const value of [0, Number.MAX_SAFE_INTEGER]) assert.equal(assignmentResponse({ ...task(), [key]: value })[key], value);
});

test('assignments reject malformed identity, authority, incomplete intake and untrusted context', () => {
  for (const value of [null, [], false, 0, 'task']) assert.throws(() => responseRecord(value), { message: 'Invalid orchestrator response', retryable: false });
  const record = { extension: true }; assert.equal(responseRecord(record), record);
  for (const key of ['id', 'lease']) for (const value of ['', 'a'.repeat(101), 'bad/path', 'space ', 'a\nb', 1, null]) rejectsAssignment({ ...task(), [key]: value });
  for (const key of ['attempt', 'expiresAt', 'createdAt']) for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) rejectsAssignment({ ...task(), [key]: value });
  rejectsAssignment({ ...task(), attempt: 0 });
  for (const key of ['project', 'workerId', 'profile', 'repository']) for (const value of ['', ' padded ', 'bad/path', null]) rejectsAssignment({ ...task(), [key]: value });
  for (const key of ['title', 'criteria', 'wikilinks', 'provider', 'priority']) { const value = { ...task() }; delete value[key]; rejectsAssignment(value); }
  for (const key of ['title', 'criteria', 'wikilinks', 'provider', 'priority', 'context', 'requestGate']) rejectsAssignment({ ...task(), [key]: { secret: 'do not disclose' } });
  for (const status of ['queued', 'review', null, undefined]) rejectsAssignment({ ...task(), status });
  for (const key of ['executionMode', 'requirementRef', 'source']) rejectsAssignment({ ...task(), [key]: { invalid: true } });
});

/** @returns {import('../../../src/shared/snapshots.js').Snapshot} */
function snapshot() {
  return {
    schemaVersion: 1, id: 'pair-before', pairId: 'pair', phase: 'before', capturedAt: '2026-10-12T12:00:00.000Z', workerId: 'worker', project: 'demo', taskId: 'task', attempt: 1, profileId: 'profile', provider: 'claude', mode: 'mock', configuration: { maxParallel: 2 },
    runtime: { processInstanceId: 'process', node: 'v24.0.0', platform: 'linux', arch: 'x64', workerVersion: '0.11.0', adapterVersion: 'mock-1' },
    execution: { outcome: 'pending', durationMs: null, timingSource: 'monotonic', error: null },
    resources: { scope: 'worker_process', rssBytes: 100, heapUsedBytes: 50, peakRssBytes: 120, cpuUserMicros: 3, cpuSystemMicros: 2, cpuDeltaMicros: null, uptimeSeconds: 1.5, hostLoad1m: 0.2 },
    health: { serverLastContactAt: null, heartbeatErrors: 0, eventLoopDelayP95Ms: null, recoveredAfterCrash: false },
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, estimatedCostUsd: null, subscriptionAllocatedCostUsd: null, subscriptionRemaining: null, source: 'unavailable_mock', reason: 'Provider did not run' },
    quality: { build: 'not_run', tests: 'not_run', testsTotal: null, testsPassed: null, coveragePercent: null, lintErrors: null, securityFindings: null, gate: 'not_evaluated' },
    provenance: { repoBaseCommit: null, testedCommit: null, contextManifestHash: null, skillsVersion: null, iterationId: null, featureId: null, sourceCommit: null, policyVersion: 'mock-only-1', configurationHash: 'default', systemPromptHash: 'prompt', artifactPath: '.factory/runs/task/attempt-1/pair/before.json' },
  };
}

test('snapshot acknowledgements bind both durable snapshot identity and complete payload digest', () => {
  const value = snapshot(), sha256 = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(acknowledgeSnapshot({ id: value.id, sha256 }, value), undefined);
  for (const acknowledgement of [{ id: 'other', sha256 }, { id: value.id, sha256: 'a'.repeat(64) }, {}, null]) assert.throws(() => acknowledgeSnapshot(acknowledgement, value));
  assert.throws(() => acknowledgeSnapshot({ id: value.id, sha256 }, { ...value, attempt: 2 }), /identity or digest mismatch/);
});

test('completion only accepts the exact assignment, execution result and immutable context pin', () => {
  for (const executionMode of /** @type {const} */ (['mock', 'cli'])) {
    const assignment = { ...task(), executionMode, context: context() };
    const accepted = { ...assignment, status: executionMode === 'cli' ? 'review' : 'simulated', expiresAt: null };
    assert.equal(acknowledgeCompletion(accepted, assignment), undefined);
    for (const key of ['id', 'project', 'attempt', 'lease', 'workerId', 'profile', 'status', 'expiresAt']) assert.throws(() => acknowledgeCompletion({ ...accepted, [key]: undefined }, assignment), /Invalid task completion acknowledgement/);
    for (const key of ['sha256', 'commit', 'featureId', 'path']) {
      const changed = { ...context(), [key]: key === 'sha256' ? 'c'.repeat(64) : key === 'commit' ? 'd'.repeat(40) : key === 'path' ? 'features/other.md' : 'other' };
      assert.throws(() => acknowledgeCompletion({ ...accepted, context: changed }, assignment), /Invalid task completion acknowledgement/);
    }
    assert.throws(() => acknowledgeCompletion({ ...accepted, context: undefined }, assignment), /Invalid task completion acknowledgement/);
  }
  assert.equal(acknowledgeCompletion({ ...task(), status: 'simulated', expiresAt: null }, task()), undefined);
});

test('abandonment requires released ownership unless an idempotent replay observes a newer attempt', () => {
  const assignment = { ...task(), context: context() };
  const released = { ...assignment, status: 'queued', workerId: null, profile: null, lease: null, expiresAt: null };
  for (const status of ['queued', 'blocked']) assert.equal(acknowledgeAbandonment({ ...released, status }, assignment), undefined);
  for (const status of ['queued', 'blocked', 'running', 'simulated', 'review']) assert.equal(acknowledgeAbandonment({ ...assignment, attempt: 2, status }, assignment), undefined);
  for (const key of ['workerId', 'profile', 'lease', 'expiresAt']) assert.throws(() => acknowledgeAbandonment({ ...released, [key]: assignment[key] }, assignment), /did not release this assignment/);
  for (const status of ['running', 'simulated', 'review']) assert.throws(() => acknowledgeAbandonment({ ...released, status }, assignment), /did not release this assignment/);
  for (const key of ['id', 'project', 'context']) assert.throws(() => acknowledgeAbandonment({ ...released, [key]: undefined }, assignment), /Invalid task abandonment acknowledgement/);
  for (const attempt of [0, 0.5, NaN, Infinity, '2', null]) assert.throws(() => acknowledgeAbandonment({ ...released, attempt }, assignment), /Invalid task abandonment acknowledgement/);
  for (const status of ['failed', '', null]) assert.throws(() => acknowledgeAbandonment({ ...released, attempt: 2, status }, assignment), /Invalid task abandonment acknowledgement/);
});

test('context comparison is stable across field order and validates the whole pin', () => {
  const pin = context();
  assert.equal(contextIdentity(undefined), null);
  assert.equal(contextIdentity(pin), [pin.sha256, pin.commit, pin.featureId, pin.path].join('\n'));
  assert.equal(contextIdentity({ path: pin.path, featureId: pin.featureId, commit: pin.commit, sha256: pin.sha256 }), contextIdentity(pin));
  for (const value of [null, {}, { ...pin, path: '../outside' }, { ...pin, sha256: 'x' }]) assert.throws(() => contextIdentity(value));
});
