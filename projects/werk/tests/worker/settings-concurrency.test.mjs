import { workerStatus } from '../helpers/worker-status.mjs';
import { testErrorCode, testErrorMessage, testListeningAddress } from '../helpers/typed-boundaries.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
const queue = settings => { const { queueCapacity, orchestratorQueue, order } = settings.publicView().board; return { queueCapacity, orchestratorQueue, order }; };
const duration = settings => ({ maxRuntimeMs: settings.value.execution.maxRuntimeMs, longRunningMs: settings.value.resources.longRunningMs });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-settings-concurrency-')); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const previous = process.env.WERK_WORKER_MAX_RUNTIME_MS;
  cleanup(t, () => { if (previous === undefined) delete process.env.WERK_WORKER_MAX_RUNTIME_MS; else process.env.WERK_WORKER_MAX_RUNTIME_MS = previous; });
  delete process.env.WERK_WORKER_MAX_RUNTIME_MS;
  const settings = new WorkerSettings(directory); await settings.init(); return { directory, settings };
}

test('concurrent queue editors reject the stale save and preserve independent pause state', async t => {
  const { directory, settings } = await fixture(t), baseline = queue(settings);
  const [pause, edit] = await Promise.allSettled([
    settings.update({ board: { paused: true } }),
    settings.update({ board: { queueCapacity: 24, orchestratorQueue: 2, order: 'priority' }, expectedBoard: baseline }),
  ]);
  assert.equal(pause.status, 'fulfilled'); assert.equal(edit.status, 'fulfilled');
  assert.equal(settings.value.board.paused, true);
  await assert.rejects(settings.update({ board: { queueCapacity: 32 }, expectedBoard: baseline, resources: { longRunningMs: 2000 } }), error => testErrorCode(error) === 'conflict' && /Reload the current queue settings/.test(testErrorMessage(error)));
  assert.deepEqual(queue(settings), { queueCapacity: 24, orchestratorQueue: 2, order: 'priority' });
  assert.equal(settings.value.resources.longRunningMs, 3600000);
  await settings.update({ board: { paused: false } }); assert.equal(settings.value.board.paused, false);
  assert.deepEqual(queue(settings), { queueCapacity: 24, orchestratorQueue: 2, order: 'priority' });
  const restarted = new WorkerSettings(directory); await restarted.init(); assert.deepEqual(restarted.value.board, settings.value.board);
});

test('competing queue saves compare their baseline inside the serialized write', async t => {
  const { settings } = await fixture(t), expectedBoard = queue(settings);
  const results = await Promise.allSettled([
    settings.update({ board: { queueCapacity: 20 }, expectedBoard }),
    settings.update({ board: { order: 'priority' }, expectedBoard }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'conflict');
  assert.equal(settings.value.board.queueCapacity, 20); assert.equal(settings.value.board.order, 'fifo');
  const current = queue(settings);
  for (const body of [
    { expectedBoard: current },
    { expectedBoard: { queueCapacity: 20 }, board: { order: 'priority' } },
    { expectedBoard: { ...current, queueCapacity: 0 }, board: { order: 'priority' } },
    { expectedBoard: current, board: { queueCapacity: 21, paused: true } },
  ]) await assert.rejects(settings.update(body), error => testErrorCode(error) === 'invalid_input');
  assert.deepEqual(queue(settings), current); assert.equal(settings.value.board.paused, false);
  await settings.update({ board: { queueCapacity: 21 } }); assert.equal(settings.value.board.queueCapacity, 21, 'legacy clients remain compatible');
});

test('duration editors guard warning and execution limit together without partial saves', async t => {
  const { settings } = await fixture(t), expectedDuration = duration(settings);
  const results = await Promise.allSettled([
    settings.update({ execution: { maxRuntimeMs: 7200000 }, resources: { longRunningMs: 1800000 }, expectedDuration }),
    settings.update({ execution: { maxRuntimeMs: 10800000 }, resources: { longRunningMs: 2700000 }, expectedDuration }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'conflict');
  assert.deepEqual(duration(settings), { maxRuntimeMs: 7200000, longRunningMs: 1800000 });
  const current = duration(settings);
  await settings.update({ resources: { longRunningMs: 1200000 } });
  await assert.rejects(settings.update({ execution: { maxRuntimeMs: 14400000 }, expectedDuration: current }), error => testErrorCode(error) === 'conflict' && /Reload the current duration settings/.test(testErrorMessage(error)));
  assert.deepEqual(duration(settings), { maxRuntimeMs: 7200000, longRunningMs: 1200000 });
  for (const body of [
    { expectedDuration: duration(settings) },
    { expectedDuration: { maxRuntimeMs: 7200000 }, resources: { longRunningMs: 1000 } },
    { expectedDuration: { ...duration(settings), longRunningMs: 0 }, execution: { maxRuntimeMs: 2000 } },
    { expectedDuration: duration(settings), execution: { maxRuntimeMs: 999 }, resources: { longRunningMs: 1000 } },
  ]) await assert.rejects(settings.update(body), error => testErrorCode(error) === 'invalid_input');
  assert.deepEqual(duration(settings), { maxRuntimeMs: 7200000, longRunningMs: 1200000 });
});

test('environment execution override allows guarded warning edits and retains the underlying saved limit', async t => {
  const { directory, settings } = await fixture(t);
  await settings.update({ execution: { maxRuntimeMs: 7200000 } });
  process.env.WERK_WORKER_MAX_RUNTIME_MS = '10800000';
  const overridden = new WorkerSettings(directory); await overridden.init();
  const expectedDuration = duration(overridden);
  await overridden.update({ resources: { longRunningMs: 900000 }, expectedDuration });
  assert.deepEqual(duration(overridden), { maxRuntimeMs: 10800000, longRunningMs: 900000 });
  await assert.rejects(overridden.update({ resources: { longRunningMs: 600000 }, expectedDuration }), error => testErrorCode(error) === 'conflict');
  await assert.rejects(overridden.update({ execution: { maxRuntimeMs: 3600000 }, resources: { longRunningMs: 600000 }, expectedDuration: duration(overridden) }), /environment override/);
  assert.equal(overridden.value.resources.longRunningMs, 900000);
  assert.equal(JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution.maxRuntimeMs, 7200000);
});

test('authenticated settings API returns actionable 409 responses for stale queue and duration editors', async t => {
  const { directory } = await fixture(t), journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64)); await journal.init(); cleanup(t, () => journal.close());
  const state = workerStatus({ queuedTasks: [] }), workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => state); await workspace.init(); cleanup(t, () => workspace.close());
  const server = await statusServer(() => state, '127.0.0.1', 0, undefined, workspace); cleanup(t, async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const token = (await readFile(join(directory, 'webview-token'), 'utf8')).trim(), endpoint = 'http://127.0.0.1:' + testListeningAddress(server).port + '/api/settings';
  const post = body => fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const expectedBoard = queue(workspace.settings), expectedDuration = duration(workspace.settings);
  for (const body of [{ board: { queueCapacity: 24 }, expectedBoard }, { execution: { maxRuntimeMs: 7200000 }, resources: { longRunningMs: 1800000 }, expectedDuration }]) {
    const response = await post(body); assert.equal(response.status, 200); await response.json();
  }
  for (const [body, message] of [[{ board: { queueCapacity: 32 }, expectedBoard }, 'queue'], [{ resources: { longRunningMs: 1000 }, expectedDuration }, 'duration']]) {
    const response = await post(body); assert.equal(response.status, 409); const payload = await response.json(); assert.match(JSON.stringify(payload), new RegExp('Reload the current ' + message + ' settings'));
  }
  assert.equal(workspace.settings.value.board.queueCapacity, 24); assert.equal(workspace.settings.value.resources.longRunningMs, 1800000);
});


test('tool budgets reject stale atomic saves and remain editable under a duration environment override', async t => {
  const { directory, settings } = await fixture(t);
  const budget = value => ({ maxToolCalls: value.value.execution.maxToolCalls, commandTimeoutMs: value.value.execution.commandTimeoutMs });
  const expectedToolBudget = budget(settings), expectedDuration = duration(settings);
  assert.deepEqual(expectedToolBudget, { maxToolCalls: 128, commandTimeoutMs: 300000 });
  const savedDefaults = JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution;
  assert.equal(savedDefaults.maxToolCalls, undefined); assert.equal(savedDefaults.commandTimeoutMs, undefined);
  await settings.update({ execution: { maxToolCalls: 256, commandTimeoutMs: 600000 }, expectedToolBudget });
  await assert.rejects(settings.update({ execution: { maxRuntimeMs: 7200000, maxToolCalls: 10 }, resources: { longRunningMs: 1000 }, expectedDuration, expectedToolBudget }), error => testErrorCode(error) === 'conflict');
  assert.deepEqual(duration(settings), expectedDuration); assert.deepEqual(budget(settings), { maxToolCalls: 256, commandTimeoutMs: 600000 });
  for (const body of [{ expectedToolBudget: budget(settings) }, { execution: { maxToolCalls: 10 }, expectedToolBudget: { maxToolCalls: 256 } }, { execution: { maxToolCalls: 513 }, expectedToolBudget: budget(settings) }, { execution: { commandTimeoutMs: 999 }, expectedToolBudget: budget(settings) }]) await assert.rejects(settings.update(body), error => testErrorCode(error) === 'invalid_input');
  process.env.WERK_WORKER_MAX_RUNTIME_MS = '10800000';
  const overridden = new WorkerSettings(directory); await overridden.init();
  assert.deepEqual(budget(overridden), { maxToolCalls: 256, commandTimeoutMs: 600000 });
  await overridden.update({ execution: { maxToolCalls: 64, commandTimeoutMs: 120000 }, expectedToolBudget: budget(overridden) });
  assert.equal(overridden.value.execution.maxRuntimeMs, 10800000); assert.equal(overridden.publicView().executionSource, 'environment');
  assert.equal(JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution.maxRuntimeMs, expectedDuration.maxRuntimeMs);
  const restarted = new WorkerSettings(directory); await restarted.init(); assert.deepEqual(budget(restarted), { maxToolCalls: 64, commandTimeoutMs: 120000 });
  delete process.env.WERK_WORKER_MAX_RUNTIME_MS;
  const restored = new WorkerSettings(directory); await restored.init(); assert.equal(restored.value.execution.maxRuntimeMs, expectedDuration.maxRuntimeMs);
  await restored.update({ execution: expectedToolBudget });
  const reset = JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution;
  assert.equal(reset.maxToolCalls, undefined); assert.equal(reset.commandTimeoutMs, undefined);
});


const inspection = settings => { const { candidateSourceMaxBytes, candidateSourceMaxFiles, candidateFileMaxBytes } = settings.value.execution; return { candidateSourceMaxBytes, candidateSourceMaxFiles, candidateFileMaxBytes }; };
test('repository inspection editors compare complete baselines inside the serialized save without partial writes', async t => {
  const { directory, settings } = await fixture(t), expectedCandidateInspection = inspection(settings), expectedDuration = duration(settings);
  const outcomes = await Promise.allSettled([
    settings.update({ execution: { candidateSourceMaxFiles: 30000 }, expectedCandidateInspection }),
    settings.update({ execution: { candidateSourceMaxBytes: 128 * 1048576, maxToolCalls: 64 }, resources: { longRunningMs: 1000 }, expectedCandidateInspection }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected'); assert.equal(outcomes[1].reason.code, 'conflict');
  assert.deepEqual(inspection(settings), { ...expectedCandidateInspection, candidateSourceMaxFiles: 30000 });
  assert.deepEqual(duration(settings), expectedDuration); assert.equal(settings.value.execution.maxToolCalls, 128);
  const restarted = new WorkerSettings(directory); await restarted.init(); assert.deepEqual(inspection(restarted), inspection(settings));
  for (const body of [
    { expectedCandidateInspection: inspection(settings) },
    { execution: { maxToolCalls: 64 }, expectedCandidateInspection: inspection(settings) },
    { execution: { candidateSourceMaxFiles: 40000 }, expectedCandidateInspection: { candidateSourceMaxFiles: 30000 } },
    { execution: { candidateSourceMaxFiles: 40000 }, expectedCandidateInspection: { ...inspection(settings), candidateFileMaxBytes: 128 * 1048576 } },
    { execution: { candidateFileMaxBytes: 128 * 1048576 }, expectedCandidateInspection: inspection(settings) },
  ]) await assert.rejects(settings.update(body), error => testErrorCode(error) === 'invalid_input');
  assert.deepEqual(inspection(settings), { ...expectedCandidateInspection, candidateSourceMaxFiles: 30000 });
  await settings.update({ execution: { candidateSourceMaxFiles: 40000 } }); assert.equal(settings.value.execution.candidateSourceMaxFiles, 40000, 'Existing clients can still send partial execution patches.');
});

test('guarded inspection saves remain editable under environment duration without changing unrelated limits or grants', async t => {
  const { directory, settings } = await fixture(t);
  await settings.update({ execution: { maxRuntimeMs: 7200000, maxToolCalls: 64, commandTimeoutMs: 600000 } });
  const tools = settings.toolAccess(); process.env.WERK_WORKER_MAX_RUNTIME_MS = '10800000';
  const overridden = new WorkerSettings(directory); await overridden.init();
  await overridden.update({ execution: { candidateSourceMaxBytes: 128 * 1048576, candidateSourceMaxFiles: 40000, candidateFileMaxBytes: 16 * 1048576 }, expectedCandidateInspection: inspection(overridden) });
  assert.equal(overridden.value.execution.maxRuntimeMs, 10800000); assert.equal(overridden.value.execution.maxToolCalls, 64); assert.equal(overridden.value.execution.commandTimeoutMs, 600000);
  assert.deepEqual(overridden.toolAccess(), tools);
  const saved = JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution;
  assert.equal(saved.maxRuntimeMs, 7200000); assert.equal(saved.candidateSourceMaxBytes, 128 * 1048576);
  const restarted = new WorkerSettings(directory); await restarted.init(); assert.deepEqual(inspection(restarted), inspection(overridden));
});


test('configured worker parallelism survives restart and rejects stale or incomplete capacity edits', async t => {
  const { directory, settings } = await fixture(t), expectedBoard = { ...queue(settings), maxParallel: 1 };
  await settings.update({ board: { maxParallel: 3 }, expectedBoard });
  assert.equal(settings.value.board.maxParallel, 3);
  await assert.rejects(settings.update({ board: { maxParallel: 4 }, expectedBoard }), /changed in another session/);
  await assert.rejects(settings.update({ board: { maxParallel: 4 }, expectedBoard: queue(settings) }), /complete queue settings baseline/);
  const restarted = new WorkerSettings(directory); await restarted.init(); assert.equal(restarted.value.board.maxParallel, 3);
  for (const maxParallel of [0, 9, 1.5]) await assert.rejects(settings.update({ board: { maxParallel } }), /concurrency/);
});
