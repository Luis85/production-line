import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RepositoryManager } from '../../src/worker/dist/worker/infrastructure/repositories.js';

prepareNativeProcessFixture();

const signal = () => AbortSignal.timeout(300000);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function fixture(t, count = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-storage-'))), items = [], managers = [];
  t.after(async () => { for (const manager of managers) await manager.close(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < count; index++) {
    const id = 'repo-' + index, path = join(root, id);
    await mkdir(path); git(path, 'init', '--initial-branch=main');
    await writeFile(join(path, 'file.txt'), 'initial\n');
    git(path, 'add', 'file.txt'); git(path, 'commit', '-m', 'Initial storage fixture');
    items.push({ id, path, remote: 'origin', branch: 'main', watch: false });
  }
  const configuration = (worktreeDirectory, assignments = items) => ({ pollMs: 60000, items: assignments, ...(worktreeDirectory ? { worktreeDirectory } : {}) });
  const manager = (worktreeDirectory, assignments) => {
    // Pinned local commits exercise real worktree admission without requiring a remote.
    const value = new RepositoryManager(configuration(worktreeDirectory, assignments), { preserveCheckout: () => true });
    managers.push(value); return value;
  };
  const prepare = (manager, taskKey, item = items[0]) => manager.prepareWorktree(item.id, taskKey, signal(), git(item.path, 'rev-parse', 'HEAD'));
  return { root, items, configuration, manager, prepare };
}

for (const external of [false, true]) {
  test('retained ' + (external ? 'external' : 'in-repository') + ' work survives an unavailable new storage parent', async t => {
    const f = await fixture(t), [item] = f.items;
    const manager = f.manager(external ? join(f.root, 'initial-storage') : undefined);
    const created = await f.prepare(manager, 'retained');
    const marker = join(item.path, '.git', 'werk-worktrees', basename(created.path) + '.json');
    const originalOwner = await readFile(marker, 'utf8');
    const unavailableParent = join(f.root, 'unavailable'), newStorage = join(unavailableParent, 'tasks');
    await manager.configure(f.configuration(newStorage));

    const verified = await manager.verifyWorktree(item.id, 'retained', signal(), created.baseCommit);
    assert.equal(verified.path, created.path); assert.equal(verified.reused, true); assert.equal(verified.pristine, true);
    await writeFile(join(created.path, 'file.txt'), 'unfinished task edits\n');
    const reused = await f.prepare(manager, 'retained');
    assert.equal(reused.path, created.path); assert.equal(reused.reused, true); assert.equal(reused.pristine, false);
    assert.equal(await readFile(join(created.path, 'file.txt'), 'utf8'), 'unfinished task edits\n');
    assert.equal(await readFile(marker, 'utf8'), originalOwner, 'Retained ownership is never rewritten to the new location.');
    assert.equal(await exists(unavailableParent), false);
    assert.equal(await readFile(join(item.path, 'file.txt'), 'utf8'), 'initial\n', 'The developer checkout is unchanged.');

    await writeFile(join(created.path, 'file.txt'), 'initial\n');
    git(created.path, 'update-index', '--assume-unchanged', 'file.txt');
    assert.equal((await manager.verifyWorktree(item.id, 'retained', signal())).pristine, false, 'A hidden index entry must never claim pristine work.');
    git(created.path, 'update-index', '--no-assume-unchanged', 'file.txt');
    await writeFile(marker, JSON.stringify({ ...JSON.parse(originalOwner), taskKey: 'another-task' }));
    await assert.rejects(manager.verifyWorktree(item.id, 'retained', signal()), /ownership does not match/);
    assert.equal(await exists(unavailableParent), false, 'Ownership failure must not resolve or create new storage.');
  });
}

test('verifying a missing task creates no storage or ownership records', async t => {
  const f = await fixture(t), [item] = f.items, manager = f.manager();
  const availableStorage = join(f.root, 'external'), unavailableParent = join(f.root, 'missing-parent');
  const initialListing = git(item.path, 'worktree', 'list', '--porcelain');
  const initialExclude = await readFile(join(item.path, '.git', 'info', 'exclude'), 'utf8');
  for (const directory of [undefined, availableStorage, join(unavailableParent, 'tasks')]) {
    await manager.configure(f.configuration(directory));
    await assert.rejects(manager.verifyWorktree(item.id, 'never-created', signal()), /retained task worktree is missing/);
    assert.equal(await exists(join(item.path, '.werk')), false);
    assert.equal(await exists(join(item.path, '.git', 'werk-worktrees')), false);
    assert.equal(await exists(availableStorage), false);
    assert.equal(await exists(unavailableParent), false);
    assert.equal(git(item.path, 'worktree', 'list', '--porcelain'), initialListing);
    assert.equal(await readFile(join(item.path, '.git', 'info', 'exclude'), 'utf8'), initialExclude);
  }
});

for (const variant of ['other checkout', 'assignment alias', 'storage alias', 'other checkout ..cache', 'own checkout ..cache']) {
  test('new worktree storage rejects ' + variant + ' before creating folders', async t => {
    const f = await fixture(t, 2), [source, other] = f.items;
    const alias = join(f.root, 'checkout-alias');
    let assignments = f.items, storageParent = other.path;
    if (variant.includes('alias')) {
      await symlink(other.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
      if (variant === 'assignment alias') assignments = [source, { ...other, path: alias }];
      else storageParent = alias;
    }
    if (variant === 'own checkout ..cache') storageParent = source.path;
    const name = variant.includes('..cache') ? '..cache' : 'task-storage';
    const configuredStorage = join(storageParent, name), realStorage = join(variant === 'own checkout ..cache' ? source.path : other.path, name);
    const manager = f.manager(configuredStorage, assignments);
    await assert.rejects(f.prepare(manager, 'rejected'), /outside the repository checkout/);
    assert.equal(await exists(configuredStorage), false);
    assert.equal(await exists(realStorage), false, 'Validation precedes any storage mkdir, including through aliases.');
    for (const item of f.items) {
      assert.equal(await exists(join(item.path, '.werk')), false);
      assert.equal(await exists(join(item.path, '.git', 'werk-worktrees')), false);
      assert.equal(git(item.path, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(git(item.path, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
    }
  });
}
