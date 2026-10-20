import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { submitFeature, submitSharedFeature } from '../../src/worker/dist/worker/status/workspace-features.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

prepareNativeProcessFixture();

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** @returns {PromiseWithResolvers<void>} */
const deferred = () => Promise.withResolvers();
/** @param {WorkerWorkspace} workspace @returns {import('../../src/worker/status/workspace-context.js').WorkspaceContext} */
const internals = workspace => Reflect.get(workspace, 'context');
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-prune-gate-'))), repository = join(root, 'repo'), stateDir = join(root, 'state');
  await mkdir(repository); await mkdir(stateDir); git(repository, 'init', '--initial-branch=main');
  await writeFile(join(repository, 'file.txt'), 'initial\n'); git(repository, 'add', 'file.txt'); git(repository, 'commit', '-m', 'Fixture');
  const journal = new SnapshotJournal(stateDir, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const workspace = new WorkerWorkspace({ stateDir, projectDir: repository, pollMs: 1000, timeoutMs: 60000 }, journal, () => workerStatus({ activeTasks: [], queuedTasks: [] }));
  await workspace.init();
  t.after(async () => { await workspace.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  const assignment = { id: 'repo', path: repository, remote: 'origin', branch: 'main', watch: false };
  await workspace.updateSettings({ repositories: { items: [assignment] }, board: { paused: true }, provider: { id: 'openai-api', model: 'fixture', apiKey: 'fixture-key-never-sent' } });
  const command = id => ({ action: 'create', id, title: 'Prepare approved change', message: 'Implement the approved change and preserve all unrelated files.', provider: 'openai-api', files: { repository: 'repo', paths: ['file.txt'] }, background: true });
  return { workspace, repository, assignment, command };
}

test('prune holds an exclusive admission gate while listing and removing, including shared and folder intake', { timeout: 240000 }, async t => {
  const f = await fixture(t), ws = f.workspace;
  const orphan = await ws.repositories.prepareWorktree('repo', 'abandoned-admission', t.signal);
  const entered = deferred(), release = deferred(), original = ws.repositories.worktrees.bind(ws.repositories);
  ws.repositories.worktrees = async signal => { entered.resolve(); await release.promise; return original(signal); };
  const pruning = ws.pruneWorktrees({ action: 'prune' });
  try {
    await entered.promise;
    assert.equal(internals(ws).configurationUpdating, true, 'The reservation precedes the first asynchronous list.');
    await assert.rejects(ws.task(f.command('during-prune')), /configuration|profile change/i);
    await assert.rejects(ws.withRepositoryAdmission(() => ws.board.create({ title: 'Legacy', instruction: 'Change approved text.', provider: 'openai-api', repository: 'repo', paths: ['file.txt'], background: true })), /configuration/i);
    // @ts-expect-error The configuration fence must reject before inspecting an incomplete intake payload.
    await assert.rejects(submitSharedFeature(internals(ws), { accepted: { title: 'Shared', message: 'Change approved text.', provider: 'openai-api', paths: ['file.txt'] }, binding: { repositoryId: 'repo' }, workflow: {}, taskId: 'shared-during-prune', inputHash: 'b'.repeat(64) }), /configuration/i);
    // @ts-expect-error The admission fence must reject before inspecting incomplete folder metadata.
    await assert.rejects(submitFeature(internals(ws), { input: { mode: 'patch', priority: 1, title: 'Folder', message: 'Change approved text.', provider: 'openai-api', paths: ['file.txt'] }, taskId: 'folder-during-prune', inputHash: 'c'.repeat(64) }), /configuration/i);
    // @ts-expect-error Observe the private admission callback while the real prune gate is held.
    assert.equal(ws.sharedRuntime.intake.ports.canAdmit(), false, 'Shared intake cannot claim work during prune.');
    await assert.rejects(ws.updateSettings({ repositories: { items: [f.assignment] } }), /profile change/i);
    await assert.rejects(ws.pruneWorktrees({ action: 'prune' }), /configuration/i);
    assert.equal(ws.board.view().tasks.length, 0); assert.deepEqual(ws.board.view().preparations, []);
    assert.equal(await exists(orphan.path), true, 'No removal begins until the gated list is released.');
  } finally { release.resolve(); }
  const result = await pruning;
  assert.deepEqual(result.results.map(item => item.outcome), ['removed']); assert.equal(await exists(orphan.path), false);
  assert.equal(internals(ws).configurationUpdating, false); assert.equal(internals(ws).repositoryPreparations, 0);
  const created = await ws.task({ ...f.command('after-prune'), background: false });
  assert.ok('session' in created, 'Synchronous task creation returns its session.');
  const task = ws.board.view().tasks.find(item => item.sessionId === created.session.id);
  assert.ok(task); assert.notEqual(task.worktree, orphan.path); assert.equal(await exists(task.worktree), true, 'A later admission owns a live worktree.');
});

test('prune rejects a preparation already in progress before attempting its listing', { timeout: 240000 }, async t => {
  const f = await fixture(t), ws = f.workspace, entered = deferred(), release = deferred();
  const original = ws.repositories.prepareWorktree.bind(ws.repositories);
  ws.repositories.prepareWorktree = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  let listed = 0; const list = ws.repositories.worktrees.bind(ws.repositories);
  ws.repositories.worktrees = (...args) => { listed++; return list(...args); };
  await ws.task(f.command('already-preparing'));
  try {
    await entered.promise; assert.ok(internals(ws).repositoryPreparations > 0); assert.equal(ws.board.active, 1);
    await assert.rejects(ws.pruneWorktrees({ action: 'prune' }), /queued and running tasks/);
    assert.equal(listed, 0); assert.equal(internals(ws).configurationUpdating, false);
  } finally { release.resolve(); }
  // Wait for the observable admission result; a private queue implementation is not a completion API.
  const deadline = Date.now() + 30000;
  while (ws.board.preparation('already-preparing')) {
    assert.ok(Date.now() < deadline, 'Background admission should finish.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const task = ws.board.view().tasks[0]; assert.equal(task.id, 'already-preparing'); assert.equal(await exists(task.worktree), true);
});

test('prune preserves an existing shared-intake or configuration reservation and releases its own gate on list failure', { timeout: 240000 }, async t => {
  const f = await fixture(t), ws = f.workspace;
  // @ts-expect-error Deliberately hold the private configuration reservation for this race.
  ws.sharedRuntime.intake.configuring = true;
  await assert.rejects(ws.pruneWorktrees({ action: 'prune' }), /queued and running tasks/);
  assert.equal(internals(ws).configurationUpdating, false);
  // @ts-expect-error Release the same private reservation after observing the guard.
  ws.sharedRuntime.intake.configuring = false;
  const entered = deferred(), release = deferred();
  const updating = ws.withIdleConfiguration(async () => { entered.resolve(); await release.promise; });
  try { await entered.promise; await assert.rejects(ws.pruneWorktrees({ action: 'prune' }), /configuration/); assert.equal(internals(ws).configurationUpdating, true); }
  finally { release.resolve(); await updating; }
  const original = ws.repositories.worktrees.bind(ws.repositories); ws.repositories.worktrees = async () => { throw Error('Fixture listing failed'); };
  await assert.rejects(ws.pruneWorktrees({ action: 'prune' }), /Fixture listing failed/);
  assert.equal(internals(ws).configurationUpdating, false); assert.equal(internals(ws).repositoryPreparations, 0); ws.repositories.worktrees = original;
  assert.deepEqual((await ws.pruneWorktrees({ action: 'prune' })).results, []);
});
