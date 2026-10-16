import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RepositoryManager } from '../../src/worker/dist/worker/infrastructure/repositories.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';

const signal = () => AbortSignal.timeout(300000);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = path => lstat(path).then(() => true, () => false);
const registered = (repository, path) => git(repository, 'worktree', 'list', '--porcelain', '-z').split('\0').includes('worktree ' + path.replaceAll('\\', '/'));

async function repository(t, prefix, cleanup = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix))), remote = join(root, 'remote.git'), path = join(root, 'repo');
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', '--config', 'core.autocrlf=false', '--', remote, path);
  await writeFile(join(path, 'file.txt'), 'initial\n');
  git(path, 'add', 'file.txt'); git(path, 'commit', '-m', 'Initial fixture'); git(path, 'push', 'origin', 'main');
  return { root, path, item: { id: 'repo', path, remote: 'origin', branch: 'main', watch: false } };
}
function manager(t, item, worktreeDirectory) {
  const value = new RepositoryManager({ pollMs: 60000, items: [item], ...(worktreeDirectory ? { worktreeDirectory } : {}) });
  t.after(() => value.close());
  return value;
}

test('removal keeps changed, committed, locked and linked worktrees and cleans clean, interrupted and missing ones', async t => {
  const { root, path: repo, item } = await repository(t, 'werk-worktree-removal-');
  const repositories = manager(t, item), remove = (taskKey, options) => repositories.removeWorktree('repo', { taskKey }, signal(), options);
  const worktrees = {};
  for (const key of ['clean', 'dirty', 'committed', 'linked', 'locked', 'interrupted', 'missing'])
    worktrees[key] = await repositories.prepareWorktree('repo', key, signal());
  const marker = key => join(repo, '.git', 'werk-worktrees', basename(worktrees[key].path) + '.json');

  const preview = await remove('clean', { dryRun: true });
  assert.equal(preview.outcome, 'would_remove');
  assert.equal(await exists(worktrees.clean.path), true, 'A dry run changes nothing.');
  await assert.rejects(remove('clean', { expect: { taskKey: 'clean', path: worktrees.clean.path, baseCommit: '0'.repeat(40) } }), /ownership does not match/);
  assert.equal((await remove('clean')).outcome, 'removed');
  assert.equal(await exists(worktrees.clean.path), false);
  assert.equal(await exists(marker('clean')), false);
  assert.equal(registered(repo, worktrees.clean.path), false);
  await assert.rejects(remove('clean'), /not managed/);

  await writeFile(join(worktrees.dirty.path, 'notes.txt'), 'operator notes\n');
  const keptDirty = await remove('dirty');
  assert.equal(keptDirty.outcome, 'kept'); assert.match(keptDirty.reason, /uncommitted or untracked/); assert.equal(keptDirty.changes, 1);
  assert.equal(await readFile(join(worktrees.dirty.path, 'notes.txt'), 'utf8'), 'operator notes\n');
  assert.equal((await remove('dirty', { discardChanges: true })).outcome, 'removed');
  assert.equal(await exists(worktrees.dirty.path), false);

  await writeFile(join(worktrees.committed.path, 'file.txt'), 'task commit\n');
  git(worktrees.committed.path, 'commit', '-am', 'Work only on the detached task HEAD');
  const keptCommit = await remove('committed', { discardChanges: true });
  assert.equal(keptCommit.outcome, 'kept'); assert.match(keptCommit.reason, /commits/);

  // Git for Windows deletes through junctions, even without --force for ignored paths.
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'precious\n');
  await symlink(outside, join(worktrees.linked.path, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const keptLink = await remove('linked', { discardChanges: true });
  assert.equal(keptLink.outcome, 'kept'); assert.match(keptLink.reason, /links or junctions/);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'precious\n');
  assert.equal(await exists(worktrees.linked.path), true);

  git(repo, 'worktree', 'lock', '--reason', 'operator review', worktrees.locked.path);
  const keptLock = await remove('locked', { discardChanges: true });
  assert.equal(keptLock.outcome, 'kept'); assert.match(keptLock.reason, /locked/);

  git(repo, 'worktree', 'lock', '--reason', 'initializing', worktrees.interrupted.path);
  await rm(worktrees.missing.path, { recursive: true, force: true });
  const listed = Object.fromEntries((await repositories.worktrees(signal()))[0].worktrees.map(entry => [entry.taskKey, entry]));
  assert.deepEqual(Object.keys(listed).sort(), ['committed', 'interrupted', 'linked', 'locked', 'missing']);
  assert.equal(listed.interrupted.state, 'incomplete');
  assert.equal(listed.locked.state, 'locked');
  assert.equal(listed.missing.state, 'missing');
  assert.equal(listed.linked.state, 'present');
  assert.equal(listed.linked.location, 'repository');
  assert.match((await remove('interrupted')).reason, /interrupted/);
  assert.equal((await remove('interrupted', { discardChanges: true })).outcome, 'removed');
  assert.equal(registered(repo, worktrees.interrupted.path), false);
  assert.equal((await remove('missing')).outcome, 'removed');
  assert.equal(registered(repo, worktrees.missing.path), false, 'A missing directory is unregistered from Git.');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'The main checkout is untouched.');
});

test('a configured worktree directory keeps new task copies outside the checkout and still verifies retained ones', async t => {
  const { root, path: repo, item } = await repository(t, 'werk-worktree-location-');
  const retained = await manager(t, item).prepareWorktree('repo', 'before-setting', signal());
  assert.ok(retained.path.startsWith(join(repo, '.werk', 'worktrees')));
  const outside = join(root, 'task-worktrees'), configured = manager(t, item, outside);
  const created = await configured.prepareWorktree('repo', 'after-setting', signal());
  assert.equal(created.path, join(outside, basename(created.path)));
  assert.equal(git(created.path, 'rev-parse', 'HEAD'), retained.baseCommit);
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');
  const reused = await configured.prepareWorktree('repo', 'before-setting', signal());
  assert.equal(reused.reused, true); assert.equal(reused.path, retained.path, 'Retained worktrees stay at their recorded location.');
  assert.equal((await configured.verifyWorktree('repo', 'after-setting', signal(), created.baseCommit)).path, created.path);
  await assert.rejects(configured.verifyWorktree('repo', 'never-created', signal()), /missing/);
  const listed = (await configured.worktrees(signal()))[0].worktrees;
  assert.deepEqual(listed.map(entry => [entry.taskKey, entry.location, entry.state]).sort(), [['after-setting', 'external', 'present'], ['before-setting', 'repository', 'present']]);
  // Switching back still finds the worktree in the previously configured directory.
  assert.equal((await manager(t, item).prepareWorktree('repo', 'after-setting', signal())).path, created.path);
  await assert.rejects(manager(t, item, join(repo, 'nested-worktrees')).prepareWorktree('repo', 'inside', signal()), /outside the repository/);
  if (process.platform === 'win32')
    await assert.rejects(manager(t, item, join(root, 'w'.repeat(Math.max(1, 230 - root.length)))).prepareWorktree('repo', 'long', signal()), /shorter task worktree directory/);
});

async function worker(t) {
  const { root, path: repo, item } = await repository(t, 'werk-worktree-api-', false), state = join(root, 'state'); await mkdir(state);
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = { activeTasks: [], queuedTasks: [] };
  const workspace = new WorkerWorkspace({ stateDir: state, pollMs: 1000, timeoutMs: 60000 }, journal, () => current); await workspace.init();
  const server = await statusServer(() => current, '127.0.0.1', 0, undefined, workspace);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await workspace.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, token = (await readFile(join(state, 'webview-token'), 'utf8')).trim();
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const call = async (path, body) => { const response = await fetch(base + path, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, value: await response.json() }; };
  return { root, repo, item, workspace, call, base };
}
async function until(predicate, message, limit = 120000) {
  const deadline = Date.now() + limit;
  while (!await predicate()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 100)); }
}

test('worker API admits file tasks in the background, lists their worktrees and removes them with the task or by prune', async t => {
  const f = await worker(t), outside = join(f.root, 'external-worktrees');
  assert.equal((await fetch(f.base + '/api/worktrees')).status, 401);
  assert.equal((await f.call('/api/settings', { repositories: { items: [f.item], worktreeDirectory: outside }, board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-key-never-sent', model: 'fixture-model' } })).status, 200);
  const task = { title: 'Background task', instruction: 'Change text', repository: 'repo', paths: ['file.txt'], provider: 'openai-api' };
  const accepted = await f.call('/api/taskboard', { ...task, background: true });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.value.tasks.length, 0, 'The response does not wait for the worktree.');
  assert.equal(accepted.value.preparations[0].id, accepted.value.preparationId);
  await until(async () => (await f.call('/api/taskboard')).value.tasks.length === 1, 'Background task was not admitted.');
  const detail = (await f.call('/api/taskboard/detail', { id: accepted.value.preparationId })).value;
  assert.equal(detail.status, 'queued'); assert.ok(detail.worktree.startsWith(outside));
  assert.deepEqual((await f.call('/api/taskboard')).value.preparations, []);

  const listing = (await f.call('/api/worktrees')).value;
  assert.equal(listing.worktreeDirectory, outside);
  assert.deepEqual(listing.repositories[0].worktrees.map(entry => [entry.taskId, entry.location, entry.state]), [[detail.id, 'external', 'present']]);
  const busy = await f.call('/api/worktrees', { action: 'prune' });
  assert.equal(busy.status, 409); assert.match(busy.value.error, /dry run/);
  assert.deepEqual((await f.call('/api/worktrees', { action: 'prune', dryRun: true })).value.results, [], 'A worktree used by a task is never a prune candidate.');
  const targeted = (await f.call('/api/worktrees', { action: 'prune', dryRun: true, id: listing.repositories[0].worktrees[0].name })).value.results[0];
  assert.equal(targeted.outcome, 'kept'); assert.match(targeted.reason, /Delete the task/);
  assert.equal((await f.call('/api/worktrees', { action: 'prune', dryRun: 'yes' })).status, 400);

  assert.equal((await f.call('/api/taskboard/action', { id: detail.id, action: 'cancel' })).status, 200);
  const deleted = await f.call('/api/taskboard/action', { id: detail.id, action: 'delete' });
  assert.equal(deleted.status, 200); assert.deepEqual(deleted.value.worktree, { outcome: 'removed' });
  assert.equal(await exists(detail.worktree), false);
  assert.equal(registered(f.repo, detail.worktree), false);

  // An interrupted admission leaves an ownership record and worktree that no task uses.
  const orphan = await f.workspace.repositories.prepareWorktree('repo', 'interrupted-admission', signal());
  const dry = (await f.call('/api/worktrees', { action: 'prune', dryRun: true })).value;
  assert.deepEqual(dry.results.map(entry => [entry.taskKey, entry.outcome]), [['interrupted-admission', 'would_remove']]);
  assert.equal(await exists(orphan.path), true);
  const pruned = (await f.call('/api/worktrees', { action: 'prune' })).value;
  assert.deepEqual(pruned.results.map(entry => [entry.taskKey, entry.outcome]), [['interrupted-admission', 'removed']]);
  assert.equal(await exists(orphan.path), false);
  assert.equal((await f.call('/api/worktrees', { action: 'prune', id: basename(orphan.path) })).status, 404);
});

test('worktree preparation failures report their specific reason in the background and in the foreground', async t => {
  const f = await worker(t);
  assert.equal((await f.call('/api/settings', { repositories: { items: [f.item], worktreeDirectory: join(f.repo, 'inside') }, board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-key-never-sent', model: 'fixture-model' } })).status, 200);
  const task = { title: 'Misplaced worktrees', instruction: 'Change text', repository: 'repo', paths: ['file.txt'], provider: 'openai-api' };
  const accepted = await f.call('/api/taskboard', { ...task, background: true });
  assert.equal(accepted.status, 202);
  await until(async () => (await f.call('/api/taskboard')).value.preparations[0]?.state === 'failed', 'Preparation did not fail.');
  const failed = (await f.call('/api/taskboard')).value.preparations[0];
  assert.equal(failed.error, 'Place the task worktree directory outside the repository checkout.');
  const foreground = await f.call('/api/taskboard', task);
  assert.equal(foreground.status, 409); assert.equal(foreground.value.error, failed.error);
  assert.equal((await f.call('/api/taskboard/action', { id: failed.id, action: 'delete' })).status, 200);
  assert.deepEqual((await f.call('/api/taskboard')).value.preparations, []);
  assert.equal((await f.call('/api/taskboard')).value.tasks.length, 0);
});
