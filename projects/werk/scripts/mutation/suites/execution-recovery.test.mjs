import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialExecutor } from '../../../.mutation-build/worker/application/serial-executor.js';
import { validateExecutionRecoveryCommand, assertExecutionStopObservation, deliveryOwnsRun } from '../../../.mutation-build/worker/application/execution-recovery.js';
const command = () => ({ action: 'confirm_execution_stopped', runId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), expectedRevision: 1, operationId: 'operator-observation', note: 'Inspected the execution and confirmed cessation.' });
/** @returns {import('../../../src/worker/application/run-evidence.ts').WorkerRun} */
const run = () => ({ schemaVersion: 1, id: command().runId, sequence: 1, attempt: 1, outcome: 'failed', sessionId: 'owned-session', taskId: 'owned-task', kind: 'chat', provider: 'claude-cli', model: 'fixture', title: 'Review',
  acceptedAt: '2026-10-20T17:00:00.000Z', before: null, after: null, startedAt: '2026-10-20T17:00:00.000Z', durationMs: null, queueDurationMs: null, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, source: 'unavailable', reason: 'Fixture usage unavailable.' }, resourceDelta: { scope: 'worker_process_between_snapshots', cpuUserMicros: null, cpuSystemMicros: null },
  executionRecovery: { schemaVersion: 1, revision: 1, state: 'unknown', reason: 'process_stop_unconfirmed', detectedAt: '2026-10-20T17:00:00.000Z' } });
/** @returns {import('../../../src/worker/application/execution-recovery.ts').ExecutionStopObservation} */
const observation = () => ({ runId: command().runId, sessionId: 'owned-session', expectedRevision: 1, controllerAbsent: true, ownedProcessesAbsent: true, managedServicesAbsent: true, observedAt: '2026-10-20T17:01:00.000Z' });

test('recovery commands preserve exact run, revision, operation and bounded inspection note', () => {
  const input = command(), { action, ...expected } = input;
  assert.deepEqual(validateExecutionRecoveryCommand(input), expected);
  assert.deepEqual(validateExecutionRecoveryCommand({ ...expected, note: '  Inspected.  ' }), { ...expected, note: 'Inspected.' });
  assert.notEqual(validateExecutionRecoveryCommand(input), input);
  assert.equal(validateExecutionRecoveryCommand({ ...input, operationId: 'x'.repeat(100), note: 'x'.repeat(4000) }).note.length, 4000);
  for (const value of [null, [], { ...input, extra: true }, ...['other', ['confirm_execution_stopped'], 1].map(action => ({ ...input, action })),
    ...['', 'z'.repeat(36), input.runId + 'a', input.runId.slice(1), [input.runId], null].map(runId => ({ ...input, runId })),
    ...[0, -1, 1.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => ({ ...input, expectedRevision })),
    ...['', 'with space', 'x'.repeat(101), ['valid'], null].map(operationId => ({ ...input, operationId })),
    ...['', ' ', 'x'.repeat(4001), ['valid'], null].map(note => ({ ...input, note }))]) assert.throws(() => validateExecutionRecoveryCommand(value), { code: 'invalid_input' });
});
test('cessation requires every trusted observation against the exact still-unknown revision', () => {
  assert.doesNotThrow(() => assertExecutionStopObservation(run(), command(), observation()));
  for (const subject of [{ ...run(), executionRecovery: undefined }, { ...run(), executionRecovery: { ...run().executionRecovery, state: /** @type {const} */ ('operator_confirmed_stopped') } }, { ...run(), executionRecovery: { ...run().executionRecovery, revision: 2 } }])
    assert.throws(() => assertExecutionStopObservation(subject, command(), observation()), { code: 'conflict' });
  for (const observed of [undefined, { ...observation(), runId: 'foreign' }, { ...observation(), sessionId: 'foreign' }, { ...observation(), expectedRevision: 2 },
    ...['controllerAbsent', 'ownedProcessesAbsent', 'managedServicesAbsent'].flatMap(key => [false, 'true', undefined].map(value => ({ ...observation(), [key]: value }))),
    { ...observation(), observedAt: 'invalid' }, { ...observation(), observedAt: 0 }])
    assert.throws(() => assertExecutionStopObservation(run(), command(), /** @type {import('../../../src/worker/application/execution-recovery.ts').ExecutionStopObservation} */ (/** @type {unknown} */ (observed))), { code: 'conflict' });
});
test('delivery reconciliation ownership requires an exact active or historical invocation identity', () => {
  const owned = { ...run(), id: 'owned' }, current = { delivery: { steps: [{ invocationRunId: 'owned' }] } }, historical = { deliveryHistory: [{ steps: [{ invocationRunId: 'owned' }] }] };
  // These projections intentionally isolate ownership fields; composed SQLite tests exercise complete persisted requests.
  const ownedBy = (attempt, request) => deliveryOwnsRun(attempt, /** @type {import('../../../src/worker/application/request-gate-contracts.ts').WorkerRequest} */ (/** @type {unknown} */ (request)));
  for (const request of [current, historical]) {
    assert.equal(ownedBy(owned, request), true);
    assert.equal(ownedBy({ ...run(), id: 'child', parentRunId: 'owned' }, request), true);
    assert.equal(ownedBy({ ...run(), id: 'different', parentRunId: 'different' }, request), false);
    assert.equal(ownedBy({ ...run(), id: 'different' }, request), false);
  }
  assert.equal(ownedBy(owned, undefined), false); assert.equal(ownedBy(owned, {}), false);
});

test('failed uncertainty persistence keeps its original live permit after the caller settles', async () => {
  const executor = new SerialExecutor();
  await executor.run('original', new AbortController().signal, async () => { executor.retainUncertain('original'); });
  assert.equal(executor.has('original'), true); assert.equal(executor.executions.length, 1); assert.equal(executor.busy, true);
  assert.equal(executor.canStart('other'), false); assert.equal(executor.reservedExecutions.length, 0);
});
