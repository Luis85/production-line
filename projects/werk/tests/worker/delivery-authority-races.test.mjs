import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertToolWorkspace } from '../../src/worker/dist/worker/application/local-task-worktree.js';
import { observeTaskBaseline } from '../../src/worker/dist/worker/application/local-task-baseline.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { defaultDeliveryRetention } from '../../src/worker/dist/worker/application/delivery-retention.js';
import { initProcesses, closeProcesses } from '../../src/worker/dist/worker/status/workspace-processes.js';
import { cleanup } from './fixture-cleanup.mjs';
const signal = () => new AbortController().signal;
const identity = { dev: '1', ino: '2', birthtimeMs: 3 };

// These fixtures revoke the exact grant inside awaited inspection, after its initial approval check.
test('worktree inspection rechecks approval after asynchronous identity validation; read-only inspection remains available', async () => {
  let approved = true, identities = 0;
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  const task = /** @type {Parameters<typeof assertToolWorkspace>[1]} */ (/** @type {unknown} */ ({ id: 'task', repository: '/repo', repositoryId: 'project', worktree: '/owned', baseCommit: 'a'.repeat(40), worktreeIdentity: identity }));
  const host = /** @type {Parameters<typeof assertToolWorkspace>[0]} */ (/** @type {unknown} */ ({
    settings: { value: { execution: {}, repositories: { items: [{ id: 'project' }] } }, toolPolicy: () => policy },
    files: { async identity() { if (++identities === 2) approved = false; return identity; } },
    workspaces: { async prepareWorktree() { return { repository: task.repository, repositoryId: task.repositoryId, path: task.worktree, baseCommit: task.baseCommit, reused: true }; } },
    authorizeDelivery() { if (!approved) throw Error('Project policy approval was revoked during inspection.'); },
  }));
  await assert.rejects(assertToolWorkspace(host, task, signal()), /revoked during inspection/);
  await assertToolWorkspace(host, task, signal(), true);
});

test('baseline verification refuses revoked authority after workspace inspection before any check runs', async () => {
  let approved = true, checks = 0;
  const task = /** @type {Parameters<typeof observeTaskBaseline>[1]} */ (/** @type {unknown} */ ({ id: 'task', repository: '/repo', worktree: '/candidate' }));
  const options = /** @type {Parameters<typeof observeTaskBaseline>[2]} */ (/** @type {unknown} */ ({ scope: { schemaVersion: 1, mode: 'worktree', baseCommit: 'a'.repeat(40), approvedPaths: ['source'], checks: [{ id: 'unit', name: 'Unit', executable: process.execPath, args: [], fingerprint: 'b'.repeat(64) }] } }));
  const host = /** @type {Parameters<typeof observeTaskBaseline>[0]} */ (/** @type {unknown} */ ({
    files: { async identity() { return identity; } },
    workspaces: {
      async prepareWorktree() { return { repository: '/repo', path: '/baseline', baseCommit: options.scope.baseCommit, reused: false }; },
      async verifyWorktree() { approved = false; return { repository: '/repo', path: '/baseline', baseCommit: options.scope.baseCommit, reused: true }; },
    },
    authorizeDelivery() { if (!approved) throw Error('Project policy approval was revoked during baseline inspection.'); },
    development(configuration) { return { async capture(bounded) { await configuration.verifyWorkspace(bounded); return { digest: 'c'.repeat(64), changedPaths: [] }; }, async check() { checks++; throw Error('Check must not run.'); } }; },
  }));
  const observed = await observeTaskBaseline(host, task, options, signal());
  assert.equal(observed.status, 'unavailable'); assert.match(observed.reason, /revoked during baseline inspection/); assert.equal(checks, 0);
  assert.equal(observed.retainedWorktree, '/baseline');
});

test('service launch rechecks policy after its final asynchronous repository inspection', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-policy-race-'))), worktree = join(directory, 'worktree'); await mkdir(worktree);
  const info = await lstat(worktree), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  const policy = deliveryPolicySnapshot({ ...defaultDeliveryProjectPolicy(), retention: defaultDeliveryRetention() }, 'a'.repeat(40));
  const feature = { key: 'fr-' + 'a'.repeat(64) }, assignment = { id: 'project', path: directory, remote: 'origin', watch: false };
  const task = { id: 'task', sessionId: 'session', repositoryId: 'project', repository: directory, worktree, worktreeIdentity, worktreeKey: 'owned', baseCommit: policy.baseline, status: 'running', feature, deliveryPolicy: policy };
  const toolPolicy = defaultToolPolicy(); toolPolicy.services = { enabled: true, maxActive: 1, presets: [{ id: 'dev', name: 'Development', enabled: true, executable: process.execPath, args: ['-e', 'process.exit(0)'], ttlMs: 10000, startupTimeoutMs: 1000, restart: { maxAttempts: 0, backoffMs: 100 } }] };
  let approved = true, inspections = 0;
  const workspace = /** @type {Parameters<typeof initProcesses>[0]} */ (/** @type {unknown} */ ({
    acceptingTasks: true, config: { stateDir: directory }, settings: { value: { repositories: { items: [assignment] } }, toolPolicy: () => toolPolicy },
    board: { view: () => ({ tasks: [task] }), executionDetail: () => task }, sessions: { view: () => ({ records: [{ id: 'session', status: 'running', feature }] }) },
    repositories: { resolve: () => assignment }, deliveryApprovals: { view: () => ({ approvals: approved ? [{ repositoryId: 'project', configurationDigest: policy.configurationDigest }] : [] }) },
    repositoryDiscovery: { async assertAllowed() { if (++inspections === 3) approved = false; } },
  }));
  cleanup(t, async () => { await closeProcesses(workspace); await rm(directory, { recursive: true, force: true }); });
  await initProcesses(workspace);
  clearInterval(workspace.processReconciliation); workspace.processReconciliation = undefined;
  const result = await workspace.processes.start({ operationId: 'service-revocation-race', presetId: 'dev', scope: { taskId: 'task', sessionId: 'session', featureRequestKey: feature.key, worktree, worktreeIdentity } });
  assert.equal(result.state, 'failed'); assert.equal(result.startedAt, null); assert.match(result.error, /approval/);
});
