import { workerStatus } from '../helpers/worker-status.mjs';
import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
const policy = { enabled: true, period: 'daily', allowance: 1000, workerPercent: 50, perRunReservation: 100 };
/** @type {import('../../src/worker/application/run-evidence.js').ProviderUsage} */
const usage = { inputTokens: 350, outputTokens: 150, cacheReadTokens: 100, cacheWriteTokens: null, providerReportedCostUsd: null, source: 'provider_reported', reason: null };
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'werk-consumption-settings-')); cleanup(t, () => rm(path, { recursive: true, force: true })); return path; }

test('existing settings migrate to disabled consumption tracking without losing saved credentials', async t => {
  const root = await directory(t), settings = new WorkerSettings(root); await settings.init();
  await settings.update({ provider: { id: 'openai-api', apiKey: 'private-fixture', model: 'fixture' } });
  const path = join(root, 'workspace-settings.json'), saved = JSON.parse(await readFile(path, 'utf8')); delete saved.consumption;
  await writeFile(path, JSON.stringify(saved));
  const migrated = new WorkerSettings(root); await migrated.init();
  assert.equal(migrated.publicView().consumption.enabled, false);
  assert.equal(migrated.provider('openai-api').apiKey, 'private-fixture');
  assert.doesNotMatch(JSON.stringify(migrated.publicView()), /private-fixture/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).consumption.workerPercent, 50);
});

test('consumption policy saves atomically, persists and rejects invalid or concurrent stale changes', async t => {
  const root = await directory(t), settings = new WorkerSettings(root); await settings.init();
  const baseline = settings.publicView().consumption;
  const [first, second] = await Promise.allSettled([
    settings.update({ consumption: policy, expectedConsumption: baseline }),
    settings.update({ consumption: { ...policy, allowance: 2000 }, expectedConsumption: baseline }),
  ]);
  assert.equal(first.status, 'fulfilled'); assert.equal(second.status, 'rejected'); assert.equal(second.reason.code, 'conflict');
  for (const bad of [{ ...policy, allowance: -1 }, { ...policy, workerPercent: 0 }, { ...policy, perRunReservation: 501 }, { ...policy, extra: true }]) {
    await assert.rejects(settings.update({ consumption: bad, board: { paused: true } }));
    assert.equal(settings.value.board.paused, false); assert.deepEqual(settings.publicView().consumption, policy);
  }
  await assert.rejects(settings.update({ expectedConsumption: policy }), /requires/);
  const restarted = new WorkerSettings(root); await restarted.init(); assert.deepEqual(restarted.publicView().consumption, policy);
});

test('authenticated budget API retains queued work, resumes after a policy change and preserves spend across restart', async t => {
  const root = await directory(t), journal = new SnapshotJournal(root, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = workerStatus({ activeTasks: [], queuedTasks: [] }), config = { stateDir: root, projectDir: root, pollMs: 1000, timeoutMs: 60000 };
  const workspace = new WorkerWorkspace(config, journal, () => current); await workspace.init();
  const server = await statusServer(() => current, '127.0.0.1', 0, undefined, workspace);
  cleanup(t, async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await workspace.close(); journal.close(); });
  const base = 'http://127.0.0.1:' + testListeningAddress(server).port, token = (await readFile(join(root, 'webview-token'), 'utf8')).trim();
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const post = body => fetch(base + '/api/settings', { method: 'POST', headers, body: JSON.stringify(body) });
  const denied = await fetch(base + '/api/consumption'); assert.equal(denied.status, 401); await denied.arrayBuffer();
  let response = await post({ consumption: policy }); assert.equal(response.status, 200); await response.json();
  const attempt = workspace.consumption.begin('openai-api'); workspace.consumption.observe(attempt.id, usage); workspace.consumption.finish(attempt.id, usage);
  const snapshot = await (await fetch(base + '/api/consumption', { headers })).json();
  assert.equal(snapshot.workerAllowance, 500); assert.equal(snapshot.measuredTokens, 500); assert.equal(snapshot.blocked, true);
  const stop = new AbortController(); let granted = false;
  const queued = workspace.executor.acquire('waiting-for-budget', stop.signal).then(release => { granted = true; release(); });
  await Promise.resolve(); assert.equal(granted, false); assert.equal(workspace.executor.waiting, 1);
  response = await post({ consumption: { ...policy, allowance: 2000 }, expectedConsumption: policy }); assert.equal(response.status, 200); await response.json(); await queued;
  assert.equal(granted, true); assert.equal(workspace.consumption.status().measuredTokens, 500);
  await workspace.close();
  const reopened = new WorkerWorkspace(config, journal, () => current); await reopened.init();
  try { assert.equal(reopened.consumption.status().measuredTokens, 500); assert.equal(reopened.consumption.status().remainingTokens, 500); }
  finally { await reopened.close(); }
});
