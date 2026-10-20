import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { workerStatus } from '../helpers/worker-status.mjs';
import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import { workspaceContext, taskboardRuntime } from './runtime-fixtures.mjs';

// Establish native process readiness separately from the bounded admission/service scenario.
// Allow 45 s for native initialization and 5 s for cancellation cleanup.
before(async t => prepareProcessRuntime(process.cwd(), t.signal), { timeout: 50000 });

async function fixture(t, repositoryAlias = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-service-workspace-'))), repository = join(directory, 'repository'), state = join(directory, 'state');
  await mkdir(repository); await mkdir(state);
  const assignedRepository = repositoryAlias ? join(directory, 'repository-alias') : repository;
  if (repositoryAlias) await symlink(repository, assignedRepository, process.platform === 'win32' ? 'junction' : 'dir');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); await writeFile(join(repository, 'approved.txt'), 'original\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const worker = new WorkerWorkspace({ stateDir: state, projectDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus); await worker.init();
  const server = await statusServer(workerStatus, '127.0.0.1', 0, undefined, worker);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker.close(); journal.close(); await rm(directory, { recursive: true, force: true }); });
  await worker.updateSettings({ board: { paused: true }, provider: { id: 'openai-api', apiKey: 'never-sent-fixture-secret', model: 'fixture' }, repositories: { items: [{ id: 'project', path: assignedRepository, remote: 'origin', watch: false }] } });
  const policy = worker.settings.toolPolicy();
  await worker.updateToolAccess({ expectedRevision: policy.revision, builtins: policy.builtins, mcp: [], services: { enabled: true, maxActive: 2, presets: [{ id: 'dev', name: 'Preview', enabled: true, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], ttlMs: 30000, startupTimeoutMs: 1000, restart: { maxAttempts: 1, backoffMs: 100 } }] } });
  await worker.board.create({ title: 'Service integration', instruction: 'Inspect the approved file', repository: 'project', paths: ['approved.txt'], provider: 'openai-api' });
  const task = worker.board.detail(worker.board.view().tasks[0].id), context = workspaceContext(worker);
  assert.ok(task.feature && task.worktree && task.worktreeIdentity && task.runId && context.processes);
  const scope = { featureRequestKey: task.feature.key, sessionId: task.sessionId, taskId: task.id, runId: task.runId, worktree: task.worktree, worktreeIdentity: task.worktreeIdentity };
  const base = 'http://127.0.0.1:' + testListeningAddress(server).port;
  const headers = { Authorization: 'Bearer ' + (await readFile(join(state, 'webview-token'), 'utf8')).trim(), 'Content-Type': 'application/json' };
  const api = async body => { const response = await fetch(base + '/api/processes', { headers, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  return { worker, context, task, scope, base, api, state, assignedRepository, directory, owner: context.processes, start: (operationId = 'start-service') => context.processes.start({ operationId, presetId: 'dev', scope }) };
}

test('process API authenticates, exposes measured ownership without command secrets, and replays guarded control', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/processes')).status, 401);
  assert.equal((await fetch(f.base + '/api/processes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', id: 'anything' }) })).status, 401);
  assert.equal((await f.api({ action: 'start', preset: 'dev' })).status, 400);
  const row = await f.start(); assert.equal(row.state, 'running');
  const view = await f.api(); assert.equal(view.status, 200);
  assert.equal(view.value.services.services[0].featureRequestKey, f.scope.featureRequestKey);
  assert.equal(view.value.services.services[0].controls.stop, true); assert.equal(view.value.services.services[0].controls.restart, true);
  assert.equal(view.value.executions.scope, 'worker_launched_finite_processes');
  assert.doesNotMatch(JSON.stringify(view.value), /never-sent-fixture-secret|setInterval|executable|worktreeIdentity|"pid"/);
  const logs = await f.api({ action: 'logs', id: row.id, after: 0, limit: 128 }); assert.equal(logs.status, 200); assert.deepEqual(logs.value.entries, []); assert.equal(logs.value.gap, false);
  for (const body of [{ action: 'logs', id: row.id, limit: 129 }, { action: 'logs', id: row.id, after: -1 }, { action: 'stop', id: row.id, expectedRevision: row.revision, operationId: 'bad', argv: [] }]) assert.equal((await f.api(body)).status, 400);
  const command = { action: 'restart', id: row.id, expectedRevision: row.revision, operationId: 'restart-once' };
  const next = await f.api(command); assert.equal(next.status, 200); assert.equal(next.value.service.generation, 2);
  const replay = await f.api(command); assert.equal(replay.status, 200); assert.equal(replay.value.service.generation, 2);
  assert.equal(replay.value.service.controls.restart, false); assert.match(replay.value.service.controls.restartUnavailableReason, /restart/i);
  assert.equal((await f.api({ action: 'stop', id: row.id, expectedRevision: row.revision, operationId: 'stale' })).status, 409);
  const stopped = await f.api({ action: 'stop', id: row.id, expectedRevision: replay.value.service.revision, operationId: 'stop-once' }); assert.equal(stopped.status, 200); assert.equal(stopped.value.service.state, 'stopped');
});

test('cancelling the canonical queued task drains retained services before acknowledging', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start();
  await f.worker.taskboardAction({ action: 'cancel', id: f.task.id });
  assert.equal(f.owner.status().capacity.active, 0);
  await assert.rejects(f.start('after-cancel'), /eligible pinned worktree/);
});

test('scope revalidation rejects cancellation during awaited repository checks without launching', { timeout: 30000 }, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const check = f.context.repositoryDiscovery.assertAllowed.bind(f.context.repositoryDiscovery);
  f.context.repositoryDiscovery.assertAllowed = async path => { entered.resolve(); await release.promise; await check(path); };
  const start = f.start(); const rejected = assert.rejects(start, /eligible pinned worktree/); await entered.promise;
  const cancel = f.worker.taskboardAction({ action: 'cancel', id: f.task.id });
  for (let i = 0; i < 200 && f.worker.board.detail(f.task.id).status !== 'cancelled'; i++) await delay(5);
  assert.equal(f.worker.board.detail(f.task.id).status, 'cancelled'); release.resolve();
  await Promise.all([cancel, rejected]); assert.equal(f.owner.status().services.length, 0);
});

test('background reconciliation stops a failed request and a revoked service grant without webview polling', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start();
  await taskboardRuntime(f.worker.board).change(tasks => { tasks.find(task => task.id === f.task.id).status = 'failed'; });
  for (let i = 0; i < 300 && f.owner.status().capacity.active; i++) await delay(10);
  assert.equal(f.owner.status().capacity.active, 0);
  await taskboardRuntime(f.worker.board).change(tasks => { tasks.find(task => task.id === f.task.id).status = 'review'; });
  await f.start('new-after-review');
  const policy = f.worker.settings.toolPolicy();
  await f.worker.settings.updateToolAccess({ expectedRevision: policy.revision, builtins: policy.builtins, mcp: [], services: { enabled: false, maxActive: 2, presets: policy.services.presets } });
  await f.owner.reconcileGrants(); assert.equal(f.owner.status().capacity.active, 0);
});

test('an attached model can start its named service and retain it through a question in the same FR', { timeout: 30000 }, async t => {
  const f = await fixture(t); let started;
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const model = (connection, directory, transport, options) => ({
    configuration: { id: connection.id, model: connection.model, instruction: connection.instruction ?? '' }, capabilities: modelCapabilities,
    get toolManifest() { return options.tools().manifest; },
    toolManifestFor(policy) { return options.tools(policy).manifest; },
    async reply() { throw Error('Expected the structured worker model dispatch'); },
    async execute(request, signal) {
      const runtime = options.tools(request.policy);
      try { const result = await runtime.call('werk_service_start', { preset: 'dev', operationId: 'model-start' }, signal); assert.equal(result.isError, undefined); started = JSON.parse(result.content[0].text); }
      finally { await runtime.close(); }
      return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'The development preview is available. Continue?' } };
    },
  });
  taskboardRuntime(f.worker.board).model = workspaceModelFactory(f.state, f.worker.settings, model, f.worker.consumption, f.worker.sessions.runs, { supervisor: () => f.owner, observations: f.context.processObservations });
  await f.worker.updateSettings({ board: { paused: false } }); await f.worker.board.tick();
  for (let i = 0; i < 500 && f.worker.board.detail(f.task.id).status !== 'waiting_input'; i++) { const status = f.worker.board.detail(f.task.id).status; if (status === 'failed') break; await delay(10); }
  const detail = f.worker.board.detail(f.task.id); assert.equal(detail.status, 'waiting_input', detail.error ?? undefined); assert.ok(started);
  const record = f.owner.status().services[0]; assert.equal(record.state, 'running'); assert.equal(record.featureRequestKey, f.task.feature.key); assert.equal(record.taskId, f.task.id); assert.equal(record.runId, detail.runId);
  await f.worker.taskboardAction({ action: 'cancel', id: f.task.id }); assert.equal(f.owner.status().capacity.active, 0);
});

test('a configured repository alias resolves to its pinned repository and retargeting revokes the service', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  assert.notEqual(f.worker.settings.value.repositories.items[0].path, f.task.repository);
  assert.equal(await realpath(f.assignedRepository), f.task.repository);
  const row = await f.start(); assert.equal(row.state, 'running');
  const replacement = join(f.directory, 'different-project'); await mkdir(replacement);
  await rm(f.assignedRepository); await symlink(replacement, f.assignedRepository, process.platform === 'win32' ? 'junction' : 'dir');
  await f.owner.reconcileGrants(); assert.equal(f.owner.status().capacity.active, 0);
  await assert.rejects(f.start('after-alias-retarget'), /eligible pinned worktree/);
});

for (const change of ['retarget', 'remove', 'replace-path', 'change-config']) test(`scope revalidation rejects repository ${change} during awaited checks`, { timeout: 30000 }, async t => {
  const f = await fixture(t, true), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const check = f.context.repositoryDiscovery.assertAllowed.bind(f.context.repositoryDiscovery);
  f.context.repositoryDiscovery.assertAllowed = async path => { entered.resolve(); await release.promise; await check(path); };
  const rejected = assert.rejects(f.start(), /eligible pinned worktree/); await entered.promise;
  try {
    if (change === 'retarget') {
      const replacement = join(f.directory, 'different-project'); await mkdir(replacement);
      await rm(f.assignedRepository); await symlink(replacement, f.assignedRepository, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      // Exercise the final validator boundary independently of the outer settings admission guard.
      const items = structuredClone(f.worker.settings.value.repositories.items);
      if (change === 'remove') items.splice(0);
      if (change === 'replace-path') items[0].path = f.task.repository;
      if (change === 'change-config') items[0].remote = 'upstream';
      await f.worker.settings.update({ repositories: { items } });
    }
  } finally { release.resolve(); }
  await rejected; assert.equal(f.owner.status().services.length, 0);
});
