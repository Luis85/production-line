import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalStateDirectory } from '../../src/worker/dist/worker/infrastructure/state-directory.js';
import { ordinaryDirectory } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-state-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'parent'), alias = join(root, 'host-alias'); await mkdir(parent);
  try { await symlink(parent, alias, 'junction'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('This host does not permit directory aliases.'); return; } throw error; }
  return { root, parent, alias };
}

test('worker state canonicalizes host ancestry before composing existing or new private storage', async t => {
  const f = await fixture(t); if (!f) return;
  const selected = join(f.alias, 'state'), canonical = join(await realpath(f.parent), 'state');
  assert.equal(canonicalStateDirectory(selected), canonical, 'the selected root may not exist when workspace services are composed');
  assert.equal(canonicalStateDirectory(join(selected, 'nested')), join(canonical, 'nested'));
  await mkdir(selected);
  assert.equal(canonicalStateDirectory(selected), canonical);
  const storage = join(canonicalStateDirectory(selected), 'shared-git', 'binding', 'worktrees');
  assert.equal(await ordinaryDirectory(storage, true), storage);
});

test('worker state rejects a linked selected root and links inside private shared storage', async t => {
  const f = await fixture(t); if (!f) return;
  assert.throws(() => canonicalStateDirectory(f.alias), /ordinary directory.*symbolic link/);
  const state = join(f.parent, 'state'), outside = join(f.root, 'outside'); await mkdir(state); await mkdir(outside);
  await writeFile(join(outside, 'precious.txt'), 'operator data');
  const canonical = canonicalStateDirectory(join(f.alias, 'state'));
  await symlink(outside, join(canonical, 'shared-git'), 'junction');
  await assert.rejects(ordinaryDirectory(join(canonical, 'shared-git', 'binding', 'worktrees'), true), /ordinary directories/);
  assert.deepEqual(await readdir(outside), ['precious.txt']);
});
