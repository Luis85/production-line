import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { FeatureGitIo, removeLinks } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Link Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = path => lstat(path).then(() => true, () => false);
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-publication-links-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository'); await mkdir(repository);
  git(repository, 'init', '--initial-branch=main'); await writeFile(join(repository, 'selected.txt'), 'selected\n');
  git(repository, 'add', 'selected.txt'); git(repository, 'commit', '-m', 'Fixture');
  const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'precious.txt'), 'operator data\n');
  const io = new FeatureGitIo({ repository, remote: 'origin', stateDirectory: join(directory, 'state') });
  return { directory, repository, outside, io, root: await repositoryRoot(repository, t.signal), head: git(repository, 'rev-parse', 'HEAD') };
}
// Junctions need no privilege on Windows; elsewhere the type is ignored and a directory symlink is made.
async function link(t, target, path) {
  try { await symlink(target, path, 'junction'); return true; }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('This host does not permit creating directory links.'); return false; } throw error; }
}
const registered = repository => git(repository, 'worktree', 'list', '--porcelain');

for (const outcome of ['succeeds', 'fails']) test(`publication cleanup removes links without deleting their targets when the action ${outcome}`, async t => {
  const f = await fixture(t);
  let worktree, linked = false;
  const run = f.io.worktree(f.root, f.head, t.signal, async path => {
    worktree = path;
    await mkdir(join(path, 'nested', 'deep'), { recursive: true });
    linked = await link(t, f.outside, join(path, 'linked')) && await link(t, f.outside, join(path, 'nested', 'deep', 'linked'));
    if (outcome === 'fails') throw new Error('publication action failed');
    return 'published';
  });
  if (outcome === 'fails') await assert.rejects(run, /publication action failed/); else assert.equal(await run, 'published');
  if (!linked) return;
  assert.deepEqual(await readdir(f.outside), ['precious.txt'], 'Git must never delete files outside the publication worktree');
  assert.equal(await readFile(join(f.outside, 'precious.txt'), 'utf8'), 'operator data\n');
  assert.equal(await exists(worktree), false, 'a link-free publication worktree is removed');
  assert.doesNotMatch(registered(f.repository), /p-/);
});

test('publication cleanup keeps a locked worktree with a reason when a link cannot be removed', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'Needs POSIX directory permissions that also bind the owner.' : false }, async t => {
  const f = await fixture(t);
  let worktree, sealed;
  t.after(async () => { if (sealed) await chmod(sealed, 0o700).catch(() => {}); });
  await f.io.worktree(f.root, f.head, t.signal, async path => {
    worktree = path; sealed = join(path, 'sealed');
    await mkdir(sealed); await symlink(f.outside, join(sealed, 'linked'));
    await chmod(sealed, 0o500);
  });
  assert.deepEqual(await readdir(f.outside), ['precious.txt']);
  assert.equal(await exists(join(worktree, 'sealed', 'linked')), true, 'an unsafe worktree is retained for review');
  await chmod(sealed, 0o700);
  assert.match(registered(f.repository), /locked Werk kept this publication worktree because it contains symbolic links or junctions/);
});

test('link removal stops at its entry bound instead of walking an unbounded tree', async t => {
  const f = await fixture(t), tree = join(f.directory, 'tree');
  await mkdir(join(tree, 'a'), { recursive: true }); await writeFile(join(tree, 'a', 'one.txt'), '1'); await writeFile(join(tree, 'two.txt'), '2');
  assert.equal(await removeLinks(tree, 2), null);
  assert.equal(await removeLinks(tree), 0);
});
