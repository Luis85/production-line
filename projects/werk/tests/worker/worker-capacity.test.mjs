import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workerCapacitySnapshot } from '../../src/worker/dist/worker/application/worker-capacity.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { createWorkerSessions, createLocalTaskboard } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { WorkerConsumption } from '../../src/worker/dist/worker/application/consumption.js';
import { WorkerConsumptionJournal } from '../../src/worker/dist/worker/infrastructure/journal/consumption.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { buildWorkerCapacityView } = await frontend('src/worker/webview/worker-capacity.ts');

/**
 * @param {Partial<Parameters<typeof workerCapacitySnapshot>[0]>} [changes]
 * @returns {Parameters<typeof workerCapacitySnapshot>[0]}
 */
const input = (changes = {}) => ({ capturedAt: '2026-10-16T12:00:00.000Z', currentSessionId: null, localUsed: 0, settings: { paused: false, queueCapacity: 4, orchestratorQueue: 2 }, remote: { waiting: 0, running: 0 }, consumption: { blocked: false, reason: 'disabled' }, ...changes });
const snapshot = changes => workerCapacitySnapshot(input(changes));

test('capacity separates one execution permit, local admission occupancy and remote accepted assignments', () => {
  const value = snapshot({ currentSessionId: 'remote-a', localUsed: 3, remote: { waiting: 2, running: 1 } });
  assert.deepEqual(value.execution, { limit: 1, inUse: 1, sessionId: 'remote-a' });
  assert.deepEqual(value.local, { limit: 4, used: 3, remaining: 1, overLimit: false });
  assert.deepEqual(value.remote, { waiting: 2, running: 1, accepted: 3, extraQueuePlaces: 2 });
  assert.equal(value.starts.paused, false);
  assert.deepEqual(value.starts.consumption, { blocked: false, reason: 'disabled' });
});

test('lowering local or remote buffer settings reports retained occupancy without dropping or clamping accepted work', () => {
  const value = snapshot({ localUsed: 5, settings: { paused: true, queueCapacity: 2, orchestratorQueue: 0 }, remote: { waiting: 3, running: 1 } });
  assert.deepEqual(value.local, { limit: 2, used: 5, remaining: 0, overLimit: true });
  assert.equal(value.remote.accepted, 4);
  assert.equal(value.remote.extraQueuePlaces, 0);
  assert.equal(value.execution.inUse, 0, 'remote lease records do not establish ownership of the shared permit');
});

test('unknown remote observations stay unknown and the public consumption summary excludes unrelated policy fields', () => {
  const value = snapshot({ remote: { waiting: null, running: 1 }, consumption: { blocked: true, reason: 'unmeasured_usage', policy: { allowance: 100 } } });
  assert.equal(value.remote.accepted, null);
  assert.equal(value.remote.waiting, null);
  assert.deepEqual(value.starts.consumption, { blocked: true, reason: 'unmeasured_usage' });
  assert.equal(snapshot({ consumption: null }).starts.consumption, null);
});

test('presenter distinguishes capacity for admission from permission to start', () => {
  const paused = buildWorkerCapacityView(snapshot({ settings: { paused: true, queueCapacity: 4, orchestratorQueue: 2 } }));
  assert.equal(paused.state, 'paused'); assert.equal(paused.startBlocked, true); assert.equal(paused.admissionAvailable, true);
  const full = buildWorkerCapacityView(snapshot({ localUsed: 4 }));
  assert.equal(full.state, 'available'); assert.equal(full.admissionAvailable, false); assert.equal(full.startBlocked, false);
  assert.match(full.description, /Local admission is full/);
  assert.equal(full.executionLabel, '0 / 1 task slot occupied');
  assert.equal(full.localLabel, '4 / 4 local places used');
  assert.equal(full.remoteLabel, '0 / 3 assignments accepted');
});

for (const reason of ['exhausted', 'insufficient_reservation', 'unmeasured_usage', 'accounting_unavailable']) test('presenter explains ' + reason + ' without claiming the worker can start', () => {
  const view = buildWorkerCapacityView(snapshot({ consumption: { blocked: true, reason } }));
  assert.equal(view.state, 'blocked'); assert.equal(view.startBlocked, true); assert.equal(view.admissionAvailable, true);
  assert.doesNotMatch(view.title, /available/i);
  const active = buildWorkerCapacityView(snapshot({ currentSessionId: 'active', consumption: { blocked: true, reason } }));
  assert.equal(active.state, 'running'); assert.equal(active.startBlocked, true);
  assert.match(active.description, /active model call can finish/);
});

test('manual pause and consumption blockers remain visible together while active work retains the permit', () => {
  const changes = { settings: { paused: true, queueCapacity: 4, orchestratorQueue: 2 }, consumption: { blocked: true, reason: 'exhausted' } };
  const paused = buildWorkerCapacityView(snapshot(changes));
  assert.equal(paused.state, 'paused'); assert.match(paused.description, /Resume removes the manual pause/); assert.match(paused.description, /exhausted/);
  const active = buildWorkerCapacityView(snapshot({ ...changes, currentSessionId: 'current' }));
  assert.equal(active.state, 'running'); assert.match(active.description, /New starts are paused/); assert.match(active.description, /exhausted/);
});

test('missing or stale snapshots never imply availability and stale values are explicitly historical', () => {
  assert.equal(buildWorkerCapacityView(null).state, 'unknown');
  for (const freshness of ['stale', 'unknown']) {
    const view = buildWorkerCapacityView(snapshot({ currentSessionId: 'old', localUsed: 2 }), freshness);
    assert.equal(view.state, 'unknown'); assert.equal(view.admissionAvailable, null); assert.equal(view.startBlocked, null);
    assert.equal(view.stale, true); assert.match(view.title, /refresh/); assert.match(view.executionLabel, /^Last reported: 1/); assert.match(view.localLabel, /^Last reported: 2/);
  }
  const incomplete = buildWorkerCapacityView(snapshot({ consumption: null }));
  assert.equal(incomplete.state, 'unknown'); assert.equal(incomplete.startBlocked, null);
  assert.equal(incomplete.admissionAvailable, true, 'unknown start policy does not erase known local admission space');
});

async function workspace(t, prepare) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-capacity-'));
  const repository = join(directory, 'project'); await mkdir(repository); await writeFile(join(repository, 'task.txt'), 'original\n');
  const settings = new WorkerSettings(directory); await settings.init(); await settings.update({ board: { paused: true, queueCapacity: 2, orchestratorQueue: 2 } });
  let board;
  const remote = { waiting: 3, running: 0 };
  const consumption = new WorkerConsumption(new WorkerConsumptionJournal(directory), () => settings.value.consumption);
  await consumption.init();
  const model = () => ({
    configuration: { id: 'fixture', model: 'fixture', instruction: '' },
    capabilities: modelCapabilities,
    async reply() { throw Error('Paused fixture must not execute'); },
    async execute() { throw Error('Paused fixture must not execute'); },
  });
  const sessions = createWorkerSessions(directory, settings, model, undefined, () => board?.active ?? 0, consumption, { remote: () => remote });
  await sessions.init();
  board = createLocalTaskboard(directory, settings, sessions, model, prepare ? { prepareWorktree: prepare } : undefined);
  await board.init();
  t.after(async () => { await board.close(); await sessions.close(); consumption.close(); await rm(directory, { recursive: true, force: true }); });
  return { settings, sessions, board, repository, remote, create: () => board.create({ title: 'A file task', instruction: 'Update this approved file.', repository, paths: ['task.txt'] }) };
}

test('session capacity includes preparation reservations before a task is visible and releases failed admission', async t => {
  const { promise: prepared, resolve: entered } = Promise.withResolvers();
  const { promise: preparation, reject: rejectPreparation } = Promise.withResolvers();
  const f = await workspace(t, () => { entered(undefined); return preparation; });
  await f.settings.update({ board: { queueCapacity: 1 } });
  const admission = assert.rejects(f.create(), /Preparation failed/);
  await prepared;
  assert.equal(f.board.view().tasks.length, 0);
  assert.equal(f.sessions.view().capacity.local.used, 1);
  assert.equal(f.sessions.view().capacity.local.remaining, 0);
  await assert.rejects(f.sessions.start('A competing chat request'), /queue is full/);
  rejectPreparation(Error('Preparation failed')); await admission;
  assert.equal(f.sessions.view().capacity.local.used, 0);
  assert.equal(f.sessions.view().capacity.local.remaining, 1);
  assert.equal(f.sessions.view().capacity.remote.accepted, 3, 'remote leases do not use local places');
});

test('session capacity counts accepted file backlog beyond the executor wait list and occupied chat admission', async t => {
  const f = await workspace(t);
  await f.create(); await f.create();
  assert.equal(f.sessions.executor.waiting, 0);
  assert.equal(f.sessions.view().capacity.local.used, 2);
  await f.settings.update({ board: { queueCapacity: 3 } });
  await f.sessions.start('A queued chat request');
  assert.equal(f.sessions.view().capacity.local.used, 3);
  assert.equal(f.sessions.view().capacity.execution.inUse, 0);
  assert.equal(f.sessions.view().capacity.starts.paused, true);
  assert.equal(f.sessions.executor.waiting, 1);
  await f.settings.update({ board: { queueCapacity: 1 } });
  assert.equal(f.sessions.view().capacity.local.overLimit, true);
  assert.equal(f.sessions.view().capacity.local.used, 3);
  assert.equal(f.sessions.view().capacity.local.remaining, 0);
  assert.equal(f.board.view().tasks.length, 2);
});
