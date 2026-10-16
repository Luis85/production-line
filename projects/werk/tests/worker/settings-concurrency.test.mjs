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
  await assert.rejects(settings.update({ board: { queueCapacity: 32 }, expectedBoard: baseline, resources: { longRunningMs: 2000 } }), error => error.code === 'conflict' && /Reload the current queue settings/.test(error.message));
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
  ]) await assert.rejects(settings.update(body), error => error.code === 'invalid_input');
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
  await assert.rejects(settings.update({ execution: { maxRuntimeMs: 14400000 }, expectedDuration: current }), error => error.code === 'conflict' && /Reload the current duration settings/.test(error.message));
  assert.deepEqual(duration(settings), { maxRuntimeMs: 7200000, longRunningMs: 1200000 });
  for (const body of [
    { expectedDuration: duration(settings) },
    { expectedDuration: { maxRuntimeMs: 7200000 }, resources: { longRunningMs: 1000 } },
    { expectedDuration: { ...duration(settings), longRunningMs: 0 }, execution: { maxRuntimeMs: 2000 } },
    { expectedDuration: duration(settings), execution: { maxRuntimeMs: 999 }, resources: { longRunningMs: 1000 } },
  ]) await assert.rejects(settings.update(body), error => error.code === 'invalid_input');
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
  await assert.rejects(overridden.update({ resources: { longRunningMs: 600000 }, expectedDuration }), error => error.code === 'conflict');
  await assert.rejects(overridden.update({ execution: { maxRuntimeMs: 3600000 }, resources: { longRunningMs: 600000 }, expectedDuration: duration(overridden) }), /environment override/);
  assert.equal(overridden.value.resources.longRunningMs, 900000);
  assert.equal(JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution.maxRuntimeMs, 7200000);
});

test('authenticated settings API returns actionable 409 responses for stale queue and duration editors', async t => {
  const { directory } = await fixture(t), journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64)); await journal.init(); cleanup(t, () => journal.close());
  const state = { activeTasks: [], queuedTasks: [] }, workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => state); await workspace.init(); cleanup(t, () => workspace.close());
  const server = await statusServer(() => state, '127.0.0.1', 0, undefined, workspace); cleanup(t, async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const token = (await readFile(join(directory, 'webview-token'), 'utf8')).trim(), endpoint = 'http://127.0.0.1:' + server.address().port + '/api/settings';
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
