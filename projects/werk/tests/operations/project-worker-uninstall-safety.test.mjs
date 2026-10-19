import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRepositoryWorktree, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { cli, exists, git, project, temporary } from './project-worker-uninstall-fixture.mjs';

test('tracking ignores case where Git does, so committed files under a differently cased folder stay', { timeout: 180000 }, async t => {
  const cwd = await project(t);
  await git(cwd, 'config', 'core.ignorecase', 'true');
  // The index spells the folder Features/ while init created features/ on disk.
  for (const path of ['features/team-request.md', 'features/_templates/feature-request.md']) {
    const blob = (await git(cwd, 'hash-object', '-w', '--', path)).stdout.trim();
    await git(cwd, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path.replace(/^features/, 'Features')}`);
  }
  await git(cwd, 'commit', '-q', '-m', 'requests with another folder case');
  const listed = (await cli(cwd, 'footprint')).groups.authoring.find(entry => entry.path === 'features/_templates/feature-request.md');
  assert.equal(listed.tracked, true);
  await writeFile(join(cwd, 'features/local-draft.md'), '---\ntitle: Local\n---\n');
  const result = await cli(cwd, 'uninstall', '--confirm', '--include-requests');
  assert.equal(await exists(join(cwd, 'features/team-request.md')), true);
  assert.equal(await exists(join(cwd, 'features/_templates/feature-request.md')), true);
  assert.equal(await exists(join(cwd, 'features/local-draft.md')), false);
  assert.ok(result.kept.some(item => item.path === 'features/_templates/feature-request.md' && /Tracked by Git/.test(item.reason)));
});

test('a nested Git repository inside a removed folder is kept and reported', { timeout: 180000 }, async t => {
  const cwd = await project(t), vault = join(cwd, 'features/vault');
  await mkdir(vault); await git(vault, 'init', '-q'); await writeFile(join(vault, 'note.md'), 'private\n');
  const result = await cli(cwd, 'uninstall', '--confirm', '--include-requests');
  assert.equal(await readFile(join(vault, 'note.md'), 'utf8'), 'private\n');
  assert.deepEqual(result.kept.find(item => item.repositories)?.repositories, ['features/vault']);
});

test('ignore rules and the project marker stay while worker state could not be removed', { timeout: 180000 }, async t => {
  const cwd = await project(t), outside = await temporary(t, 'werk-uninstall-outside-');
  await writeFile(join(outside, 'keep.txt'), 'outside\n');
  await writeFile(join(cwd, '.werk/worker/webview-token'), 'a'.repeat(64));
  await symlink(outside, join(cwd, '.werk/worker/linked'), 'junction');
  const result = await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside\n', 'Links are never followed.');
  assert.equal(await exists(join(cwd, '.werk/worker/webview-token')), false);
  for (const path of ['.werk/.gitignore', '.werk/worker-project.json']) {
    assert.equal(await exists(join(cwd, path)), true, path);
    assert.match(result.kept.find(item => item.path === path).reason, /Kept while .*worker still exists/);
  }
  assert.equal(await exists(join(cwd, '.werk/worker.lock')) || await exists(join(cwd, '.werk/worker/worker.lock')), false, 'The lock is released.');
});

test('a state directory without worker state files is kept, whatever --state-dir names', { timeout: 180000 }, async t => {
  const cwd = await project(t);
  await mkdir(join(cwd, 'data')); await writeFile(join(cwd, 'data/notes.txt'), 'unrelated\n');
  const listed = (await cli(cwd, 'footprint', '--state-dir', 'data')).groups.state.find(entry => entry.path === 'data');
  assert.equal(listed.workerState, false);
  const result = await cli(cwd, 'uninstall', '--confirm', '--state-dir', 'data');
  assert.equal(await readFile(join(cwd, 'data/notes.txt'), 'utf8'), 'unrelated\n');
  assert.match(result.kept.find(item => item.path === 'data').reason, /no worker state files/);
  assert.equal(await exists(join(cwd, 'data/worker.lock')), false, 'The lock is released.');
});

test('a state directory that holds other project files, such as .werk, is kept', { timeout: 180000 }, async t => {
  const cwd = await project(t);
  await writeFile(join(cwd, '.werk/webview-token'), 'b'.repeat(64));
  const result = await cli(cwd, 'uninstall', '--confirm', '--state-dir', '.werk');
  assert.match(result.kept.find(item => item.path === '.werk').reason, /contains other project files/);
  assert.equal(await exists(join(cwd, '.werk/webview-token')), true);
});

test('a folder holding a task worktree that stays is never removed', { timeout: 180000 }, async t => {
  const cwd = await project(t), other = await temporary(t, 'werk-uninstall-repo-');
  await git(other, 'init', '-q'); await writeFile(join(other, 'README.md'), 'other\n'); await git(other, 'add', 'README.md'); await git(other, 'commit', '-q', '-m', 'init');
  const storage = join(cwd, '.werk/worker/tasks');
  await mkdir(storage); await writeFile(join(cwd, '.werk/worker/webview-token'), 'c'.repeat(64));
  const config = JSON.parse(await readFile(join(cwd, '.werk/worker.json'), 'utf8'));
  await writeFile(join(cwd, '.werk/worker.json'), JSON.stringify({ ...config, repositories: { items: [{ id: 'other', path: other }], worktreeDirectory: storage } }), { mode: 0o600 });
  const changed = await createRepositoryWorktree(await repositoryRoot(other, AbortSignal.timeout(30000)), 'other', 'changed-task', AbortSignal.timeout(60000), undefined, 30000, { directory: storage });
  await writeFile(join(changed.path, 'draft.txt'), 'unsaved\n');
  const preview = await cli(cwd, 'uninstall', '--dry-run');
  assert.match(preview.keep.find(item => item.path === '.werk/worker').reason, /task worktree that stays/);
  const result = await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await readFile(join(changed.path, 'draft.txt'), 'utf8'), 'unsaved\n');
  assert.equal(await exists(join(cwd, '.werk/worker/webview-token')), true);
  assert.match(result.kept.find(item => item.path === '.werk/worker').reason, /task worktree that stays/);
});

test('an oversized generated file cannot be compared and is kept as edited', { timeout: 180000 }, async t => {
  const cwd = await project(t);
  await writeFile(join(cwd, 'fr-ready-check.json'), 'x'.repeat(4 * 1024 * 1024 + 1));
  const listed = (await cli(cwd, 'footprint')).groups.authoring.find(entry => entry.path === 'fr-ready-check.json');
  assert.equal(listed.managed, false);
  await cli(cwd, 'uninstall', '--confirm');
  assert.equal(await exists(join(cwd, 'fr-ready-check.json')), true);
});
