import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RepositoryManager, prepareRepositoryWorktree } from '../../src/worker/dist/worker/infrastructure/repositories.js';
import { repositoryGit } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';

prepareNativeProcessFixture();

const signal = () => new AbortController().signal;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixtures(t, count = 1) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-repositories-'))), repositories = [];
  const managers = [];
  t.after(async () => { for (const manager of managers) await manager.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < count; i++) {
    const id = `repo-${i}`, remote = join(directory, `${id}.git`), producer = join(directory, `${id}-producer`), path = join(directory, id);
    git(directory, 'init', '--bare', '--initial-branch=main', remote);
    git(directory, 'clone', '--config', 'core.autocrlf=false', '--', remote, producer);
    await writeFile(join(producer, 'file.txt'), 'initial\n');
    git(producer, 'add', 'file.txt'); git(producer, 'commit', '-m', 'Initial fixture'); git(producer, 'push', 'origin', 'main');
    git(directory, 'clone', '--config', 'core.autocrlf=false', '--', remote, path);
    repositories.push({ id, path, remote: 'origin', branch: 'main', watch: true, producer, remotePath: remote });
  }
  const configuration = (items = repositories, pollMs = 1000) => ({ pollMs, items: items.map(({ id, path, remote, branch, watch }) => ({ id, path, remote, branch, watch })) });
  const manager = (items = repositories, options) => { const value = new RepositoryManager(configuration(items), options); managers.push(value); return value; };
  async function publish(index, content) {
    const item = repositories[index]; await writeFile(join(item.producer, 'file.txt'), content);
    git(item.producer, 'add', 'file.txt'); git(item.producer, 'commit', '-m', `Remote update ${content.trim()}`); git(item.producer, 'push', 'origin', 'main');
    return git(item.producer, 'rev-parse', 'HEAD');
  }
  return { directory, repositories, manager, configuration, publish };
}
async function until(predicate, limit = 5000) {
  const deadline = Date.now() + limit;
  while (!await predicate()) { if (Date.now() >= deadline) assert.fail('Timed out waiting for repository observation.'); await delay(25); }
}

test('one worker fetches and fast-forwards multiple repositories independently', async t => {
  const f = await fixtures(t, 2), manager = f.manager(); await manager.init();
  const heads = await Promise.all([f.publish(0, 'first update\n'), f.publish(1, 'second update\n')]);
  const result = await manager.sync();
  assert.deepEqual(result.map(item => item.state), ['ready', 'ready']);
  assert.deepEqual(result.map(item => item.head), heads); assert.ok(result.every(item => item.lastPulledAt && item.lastCheckedAt));
  for (const [index, item] of f.repositories.entries()) assert.equal(git(item.path, 'rev-parse', 'HEAD'), heads[index]);
  git(f.repositories[0].path, 'remote', 'set-url', 'origin', join(f.directory, 'missing-remote'));
  const next = await f.publish(1, 'healthy remote still updates\n'); await manager.sync();
  assert.equal(manager.view()[0].state, 'error'); assert.equal(manager.view()[1].head, next);
  assert.doesNotMatch(manager.view()[0].error, /missing-remote/);
  assert.throws(() => manager.resolve(f.directory), /assigned/);
  assert.equal(manager.resolve(f.repositories[1].path).id, f.repositories[1].id);
  await assert.rejects(manager.prepareWorktree(f.directory, 'unknown', signal()), /assigned/);
});

test('dirty, ahead, divergent and wrong-branch base checkouts are never overwritten', async t => {
  const f = await fixtures(t, 3), manager = f.manager(), [dirty, ahead, diverged] = f.repositories;
  const original = git(dirty.path, 'rev-parse', 'HEAD');
  await writeFile(join(dirty.path, 'file.txt'), 'human uncommitted edit\n');
  await f.publish(0, 'remote changed same file\n');
  for (const item of [ahead, diverged]) { await writeFile(join(item.path, 'local.txt'), 'human commit\n'); git(item.path, 'add', 'local.txt'); git(item.path, 'commit', '-m', 'Human local commit'); }
  const localAhead = git(ahead.path, 'rev-parse', 'HEAD'), localDiverged = git(diverged.path, 'rev-parse', 'HEAD');
  await f.publish(2, 'remote divergent update\n'); await manager.sync();
  assert.deepEqual(manager.view().map(item => item.state), ['dirty', 'ahead', 'diverged']);
  assert.equal(git(dirty.path, 'rev-parse', 'HEAD'), original); assert.equal(await readFile(join(dirty.path, 'file.txt'), 'utf8'), 'human uncommitted edit\n');
  assert.equal(git(ahead.path, 'rev-parse', 'HEAD'), localAhead); assert.equal(git(diverged.path, 'rev-parse', 'HEAD'), localDiverged);
  const workspace = await manager.prepareWorktree(dirty.id, 'dirty-base-task', signal());
  assert.equal(await readFile(join(workspace.path, 'file.txt'), 'utf8'), 'initial\n'); assert.equal(workspace.baseCommit, original);
  git(ahead.path, 'checkout', '-b', 'other'); await manager.sync(ahead.id);
  assert.equal(manager.view()[1].state, 'error'); assert.match(manager.view()[1].error, /different branch/);
  await assert.rejects(manager.prepareWorktree(ahead.id, 'wrong-branch-task', signal()), /assigned branch/);
});

test('task worktrees remain isolated and retain immutable bases and edits across synchronization and restart', async t => {
  const f = await fixtures(t), manager = f.manager(), repo = f.repositories[0];
  const first = await manager.prepareWorktree(repo.id, 'first task', signal());
  assert.equal(first.reused, false); assert.equal(git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD'), first.branch); assert.match(first.branch, /^werk\/workspaces\//);
  assert.equal((await lstat(join(first.path, '.git'))).isFile(), true);
  await writeFile(join(first.path, 'file.txt'), 'work in progress\n');
  const freshCommit = await f.publish(0, 'latest base\n'); await manager.sync();
  assert.equal(manager.view()[0].state, 'ready'); assert.equal(git(repo.path, 'status', '--porcelain'), '');
  assert.equal(await readFile(join(first.path, 'file.txt'), 'utf8'), 'work in progress\n');
  const second = await manager.prepareWorktree(repo.path, 'second task', signal());
  assert.notEqual(first.path, second.path); assert.equal(second.baseCommit, freshCommit);
  assert.equal(await readFile(join(second.path, 'file.txt'), 'utf8'), 'latest base\n');
  await manager.close();
  assert.equal(await readFile(join(first.path, 'file.txt'), 'utf8'), 'work in progress\n');
  const restarted = f.manager(), reused = await restarted.prepareWorktree(repo.id, 'first task', signal());
  assert.equal(reused.reused, true); assert.equal(reused.path, first.path); assert.equal(reused.baseCommit, first.baseCommit);
  const pinned = await restarted.prepareWorktree(repo.id, 'explicit old base', signal(), first.baseCommit);
  assert.equal(pinned.baseCommit, first.baseCommit); assert.equal(await readFile(join(pinned.path, 'file.txt'), 'utf8'), 'initial\n');
  await assert.rejects(restarted.prepareWorktree(repo.id, 'first task', signal(), freshCommit), /ownership/);
  git(first.path, 'add', 'file.txt'); git(first.path, 'commit', '-m', 'Unexpected task commit');
  await assert.rejects(restarted.prepareWorktree(repo.id, 'first task', signal()), /base changed/);
});

test('unknown directories, tampered metadata and symlink worktree storage are never adopted', async t => {
  const f = await fixtures(t, 3), manager = f.manager(), [repo, symlinkRepo, trackedRepo] = f.repositories;
  const task = 'preexisting-task', name = `${repo.id}-${createHash('sha256').update(task).digest('hex').slice(0, 32)}`;
  const unknown = join(repo.path, '.werk', 'worktrees', name); await mkdir(unknown, { recursive: true }); await writeFile(join(unknown, 'human.txt'), 'keep me');
  await assert.rejects(manager.prepareWorktree(repo.id, task, signal()), /without ownership/);
  assert.equal(await readFile(join(unknown, 'human.txt'), 'utf8'), 'keep me');
  const good = await manager.prepareWorktree(repo.id, 'owned-task', signal());
  const marker = join(repo.path, '.git', 'werk-worktrees', `${basename(good.path)}.json`), owner = JSON.parse(await readFile(marker, 'utf8'));
  await writeFile(marker, JSON.stringify({ ...owner, taskKey: 'someone else' }));
  await assert.rejects(manager.prepareWorktree(repo.id, 'owned-task', signal()), /ownership/);
  await symlink(f.directory, join(symlinkRepo.path, '.werk'), 'dir');
  await assert.rejects(manager.prepareWorktree(symlinkRepo.id, 'symlink-task', signal()), /ordinary directories/);
  await mkdir(join(trackedRepo.path, '.werk', 'worktrees'), { recursive: true });
  await writeFile(join(trackedRepo.path, '.werk', 'worktrees', 'tracked.txt'), 'tracked'); git(trackedRepo.path, 'add', '.werk/worktrees/tracked.txt');
  await assert.rejects(manager.prepareWorktree(trackedRepo.id, 'tracked-task', signal()), /tracked files/);
});

test('a remote failure allows committed local work; legacy Git paths also get managed worktrees', async t => {
  const f = await fixtures(t), repo = f.repositories[0], manager = f.manager();
  git(repo.path, 'remote', 'remove', 'origin'); await manager.init();
  assert.equal(manager.view()[0].state, 'error'); assert.match(manager.view()[0].error, /remote does not exist/);
  const assigned = await manager.prepareWorktree(repo.id, 'offline', signal()); assert.equal(assigned.baseCommit, git(repo.path, 'rev-parse', 'HEAD'));
  const legacy = await prepareRepositoryWorktree(repo.path, 'legacy', signal());
  assert.equal(legacy.repository, repo.path); assert.equal(legacy.repositoryId, 'local');
  assert.equal(git(repo.path, 'status', '--porcelain'), '');
  assert.equal((await readFile(join(repo.path, '.git', 'info', 'exclude'), 'utf8')).split('/.werk/worktrees/').length, 2);
});

test('maximum-length assignment IDs use bounded worktree names with full, collision-safe identities', async t => {
  const f = await fixtures(t), repo = f.repositories[0], fullId = 'a'.repeat(100), otherId = 'a'.repeat(99) + 'b';
  const manager = f.manager([{ ...repo, id: fullId }]), otherManager = f.manager([{ ...repo, id: otherId }]);
  const taskKey = 'long-assignment-id';
  const first = await manager.prepareWorktree(fullId, taskKey, signal());
  const other = await otherManager.prepareWorktree(otherId, taskKey, signal());
  assert.equal(first.repositoryId, fullId); assert.equal(other.repositoryId, otherId);
  assert.ok(basename(first.path).length <= 58); assert.ok(basename(other.path).length <= 58);
  assert.notEqual(first.path, other.path, 'IDs sharing their readable prefix must not share worktrees.');
  const shortId = fullId.slice(0, 24), shortManager = f.manager([{ ...repo, id: shortId }]);
  const short = await shortManager.prepareWorktree(shortId, JSON.stringify([fullId, taskKey]), signal());
  assert.notEqual(first.path, short.path, 'A short ID and chosen task key must not alias a long identity.');
  const marker = join(repo.path, '.git', 'werk-worktrees', `${basename(first.path)}.json`);
  const owner = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(owner.repositoryId, fullId); assert.equal(owner.taskKey, taskKey);
  await writeFile(join(first.path, 'file.txt'), 'retained long-ID work\n');
  const reused = await manager.prepareWorktree(fullId, taskKey, signal());
  assert.equal(reused.reused, true); assert.equal(reused.path, first.path);
  assert.equal(await readFile(join(reused.path, 'file.txt'), 'utf8'), 'retained long-ID work\n');
  await writeFile(marker, JSON.stringify({ ...owner, repositoryId: otherId }));
  await assert.rejects(manager.prepareWorktree(fullId, taskKey, signal()), /ownership/);
});

test('watching honors per-repository pause, reconfiguration and shutdown', async t => {
  const f = await fixtures(t, 2), manager = f.manager([{ ...f.repositories[0], watch: true }, { ...f.repositories[1], watch: false }]);
  await manager.init(); manager.start();
  const initialSecond = git(f.repositories[1].path, 'rev-parse', 'HEAD');
  const first = await f.publish(0, 'watched update\n'), second = await f.publish(1, 'manual only update\n');
  await until(() => manager.view()[0].head === first);
  assert.equal(git(f.repositories[1].path, 'rev-parse', 'HEAD'), initialSecond);
  await manager.sync(f.repositories[1].id); assert.equal(git(f.repositories[1].path, 'rev-parse', 'HEAD'), second);
  await manager.configure(f.configuration([f.repositories[1]])); assert.equal(manager.view().length, 1); assert.equal(manager.view()[0].id, f.repositories[1].id);
  await manager.close(); await f.publish(1, 'after stop\n'); await delay(1100);
  assert.equal(git(f.repositories[1].path, 'rev-parse', 'HEAD'), second);
  await assert.rejects(manager.sync(), /stopped/);
});

test('cancellation and timeouts stop a slow remote and keep diagnostics private', { skip: process.platform === 'win32' }, async t => {
  const f = await fixtures(t), repo = f.repositories[0], marker = join(f.directory, 'transport-started'), transport = join(f.directory, 'slow-transport');
  await writeFile(transport, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.stderr.write('credential=must-not-leak'); setInterval(() => {}, 1000);\n`); await chmod(transport, 0o700);
  git(repo.path, 'config', 'core.sshCommand', transport); git(repo.path, 'remote', 'set-url', 'origin', 'ssh://example.invalid/project.git');
  const manager = f.manager(undefined, { commandTimeoutMs: 10000 }), pending = manager.sync();
  await until(async () => !!await lstat(marker).catch(() => null));
  const stoppedAt = Date.now(); await manager.close(); await pending;
  assert.ok(Date.now() - stoppedAt < 3000); assert.equal(manager.view()[0].state, 'error'); assert.match(manager.view()[0].error, /cancelled/);
  assert.doesNotMatch(JSON.stringify(manager.view()), /must-not-leak/);
  const controller = new AbortController(); const command = repositoryGit(repo.path, ['fetch', 'origin'], controller.signal, 200); await assert.rejects(command, /timed out/);
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(prepareRepositoryWorktree(repo.path, 'cancelled', cancelled.signal), /abort/i);
  assert.equal(await lstat(join(repo.path, '.werk')).catch(() => null), null);
});


test('remote tracked files cannot replace ignored task worktrees or their parent directory', async t => {
  const f = await fixtures(t), manager = f.manager(), repo = f.repositories[0];
  const owned = await manager.prepareWorktree(repo.id, 'retain-through-remote', signal());
  await writeFile(join(owned.path, 'file.txt'), 'precious task edit\n');
  const incoming = join(repo.producer, '.werk', 'worktrees', basename(owned.path));
  await mkdir(incoming, { recursive: true }); await writeFile(join(incoming, 'file.txt'), 'remote replacement\n');
  git(repo.producer, 'add', '.werk'); git(repo.producer, 'commit', '-m', 'Track reserved task storage'); git(repo.producer, 'push', 'origin', 'main');
  await manager.sync();
  assert.equal(manager.view()[0].state, 'error'); assert.match(manager.view()[0].error, /worktree storage/);
  assert.equal(git(repo.path, 'rev-parse', 'HEAD'), owned.baseCommit); assert.equal(await readFile(join(owned.path, 'file.txt'), 'utf8'), 'precious task edit\n');
  git(repo.producer, 'rm', '-r', '.werk'); await symlink('/tmp', join(repo.producer, '.werk'));
  git(repo.producer, 'add', '.werk'); git(repo.producer, 'commit', '-m', 'Replace storage parent with symlink'); git(repo.producer, 'push', 'origin', 'main');
  await manager.sync();
  assert.equal(manager.view()[0].state, 'error'); assert.match(manager.view()[0].error, /worktree storage/);
  assert.equal((await lstat(join(repo.path, '.werk'))).isSymbolicLink(), false); assert.equal(await readFile(join(owned.path, 'file.txt'), 'utf8'), 'precious task edit\n');
});

test('worktree registration uses native paths and refuses a registration retargeted elsewhere', async t => {
  const f = await fixtures(t), manager = f.manager(), repo = f.repositories[0];
  const worktree = await manager.prepareWorktree(repo.id, 'registration-identity', signal());
  const listed = git(repo.path, 'worktree', 'list', '--porcelain', '-z').split('\0');
  assert.ok(listed.includes('worktree ' + worktree.path.split(sep).join('/')), 'Git reports registered worktree paths with forward slashes.');
  assert.equal((await manager.prepareWorktree(repo.id, 'registration-identity', signal())).reused, true);
  await writeFile(join(worktree.path, 'file.txt'), 'retain task edits\n');
  const administration = git(worktree.path, 'rev-parse', '--absolute-git-dir');
  await writeFile(join(administration, 'gitdir'), join(f.directory, 'unrelated', '.git') + '\n');
  await assert.rejects(manager.prepareWorktree(repo.id, 'registration-identity', signal()), /not registered/);
  assert.equal(await readFile(join(worktree.path, 'file.txt'), 'utf8'), 'retain task edits\n');
});


test('shared-bound watchers fetch without moving clean checkouts while ordinary assignments still fast-forward', async t => {
  const f = await fixtures(t, 2), [shared, ordinary] = f.repositories; let preserve = true;
  const manager = f.manager(undefined, { preserveCheckout: assignment => preserve && assignment.id === shared.id });
  const original = git(shared.path, 'rev-parse', 'HEAD');
  const [sharedHead, ordinaryHead] = await Promise.all([f.publish(0, 'shared remote update\n'), f.publish(1, 'ordinary remote update\n')]);
  await manager.init();
  assert.deepEqual(manager.view().map(item => item.state), ['behind', 'ready']);
  assert.deepEqual(manager.view().map(item => item.checkoutPreserved), [true, false]);
  assert.equal(manager.view()[0].behind, 1); assert.equal(manager.view()[0].lastPulledAt, null);
  assert.equal(git(shared.path, 'rev-parse', 'HEAD'), original);
  assert.equal(await readFile(join(shared.path, 'file.txt'), 'utf8'), 'initial\n');
  assert.equal(git(ordinary.path, 'rev-parse', 'HEAD'), ordinaryHead);
  preserve = false; await manager.sync(shared.id);
  assert.equal(git(shared.path, 'rev-parse', 'HEAD'), sharedHead); assert.equal(manager.view()[0].state, 'ready');
  assert.equal(manager.view()[0].checkoutPreserved, false);
});

test('shared pinned worktrees preserve a developer branch, dirty file and exact staging index without another fetch', async t => {
  const f = await fixtures(t), repo = f.repositories[0], manager = f.manager(undefined, { preserveCheckout: () => true });
  const original = git(repo.path, 'rev-parse', 'HEAD');
  git(repo.path, 'checkout', '-b', 'developer-topic');
  await writeFile(join(repo.path, 'file.txt'), 'staged developer edit\n'); git(repo.path, 'add', 'file.txt');
  await writeFile(join(repo.path, 'file.txt'), 'unstaged developer edit\n');
  const indexBefore = await readFile(join(repo.path, '.git', 'index'));
  const source = await f.publish(0, 'frozen remote source\n');
  await manager.sync();
  assert.equal(manager.view()[0].state, 'dirty'); assert.equal(manager.view()[0].behind, 1);
  assert.deepEqual(await readFile(join(repo.path, '.git', 'index')), indexBefore);
  const checkedAt = manager.view()[0].lastCheckedAt;
  git(repo.path, 'remote', 'set-url', 'origin', join(f.directory, 'offline-remote'));
  const workspace = await manager.prepareWorktree(repo.id, 'shared-pinned-task', signal(), source);
  assert.equal(workspace.baseCommit, source); assert.equal(await readFile(join(workspace.path, 'file.txt'), 'utf8'), 'frozen remote source\n');
  assert.equal(manager.view()[0].lastCheckedAt, checkedAt, 'Pinned admission does not start another repository sync.');
  assert.equal(git(repo.path, 'rev-parse', 'HEAD'), original); assert.equal(git(repo.path, 'branch', '--show-current'), 'developer-topic');
  assert.equal(await readFile(join(repo.path, 'file.txt'), 'utf8'), 'unstaged developer edit\n');
  assert.deepEqual(await readFile(join(repo.path, '.git', 'index')), indexBefore);
});


test('recovery evidence rejects ignored, untracked and hidden tracked changes without modifying worktrees', async t => {
  const f = await fixtures(t), manager = f.manager(), repo = f.repositories[0];
  const worktree = await manager.prepareWorktree(repo.id, 'recovery-evidence', signal());
  const inspect = () => manager.prepareWorktree(repo.id, 'recovery-evidence', signal());
  assert.equal((await inspect()).pristine, true);
  await writeFile(join(worktree.path, 'untracked.txt'), 'keep untracked content\n');
  assert.equal((await inspect()).pristine, false);
  await rm(join(worktree.path, 'untracked.txt'));
  await writeFile(join(worktree.path, 'ignored.txt'), 'keep ignored content\n');
  git(worktree.path, 'config', 'core.excludesFile', join(f.directory, 'recovery-excludes'));
  await writeFile(join(f.directory, 'recovery-excludes'), 'ignored.txt\n');
  assert.equal(git(worktree.path, 'status', '--porcelain'), '');
  assert.equal((await inspect()).pristine, false);
  assert.equal(await readFile(join(worktree.path, 'ignored.txt'), 'utf8'), 'keep ignored content\n');
  await rm(join(worktree.path, 'ignored.txt'));
  git(worktree.path, 'update-index', '--assume-unchanged', 'file.txt');
  await writeFile(join(worktree.path, 'file.txt'), 'hidden local edit\n');
  assert.equal(git(worktree.path, 'status', '--porcelain'), '');
  assert.equal((await inspect()).pristine, false);
  assert.equal(await readFile(join(worktree.path, 'file.txt'), 'utf8'), 'hidden local edit\n');
});
