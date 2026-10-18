import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { digest } from '../../scripts/runtime/update/remote.mjs';
import { applyUpdate, rollbackUpdate } from '../../scripts/runtime/portable/update.mjs';
import { appVersion, extracted, files, filesystemFault, installed, invoke, leftovers, workspace } from '../helpers/portable-update.mjs';

// --in-place replaces files inside an app folder that another process holds open,
// so the folder itself must never be renamed on these paths.
const tree = async directory => Object.fromEntries(await Promise.all((await files(directory)).map(async path => [path, digest(await readFile(join(directory, ...path.split('/'))))])));
const history = async app => JSON.parse(await readFile(join(dirname(app), '.worker-update', 'history.json'), 'utf8')).entries;
function folderNeverRenamed(t, app) {
  filesystemFault(t, 'rename', async (original, from, to) => {
    if (from === app || to === app) throw Object.assign(Error('the app folder must not be renamed'), { code: 'EIO' });
    return original(from, to);
  });
}

test('in-place update rewrites a running worker inside its folder, verifies it, keeps a copy, records history and restarts', { timeout: 240000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update in place');
  const state = join(cwd, 'state'), held = join(app, 'dropped', 'held');
  cleanup(() => invoke(cwd, ['stop', '--state-dir', state]).catch(() => {}));
  const started = await invoke(cwd, ['start', '--state-dir', state, '--port', '0']);
  assert.equal(started.code, 0, started.stderr);
  // An operator file and a folder the release does not contain; another process keeps the folder open.
  await writeFile(join(app, 'operator-note.txt'), 'note');
  await mkdir(held, { recursive: true }); await writeFile(join(held, 'old.js'), 'old');
  folderNeverRenamed(t, app);
  filesystemFault(t, 'rmdir', async (original, path, ...args) => {
    if (path === held) throw Object.assign(Error('injected directory handle'), { code: 'EBUSY' });
    return original(path, ...args);
  });
  const releaseRoot = await extracted(directory, '99.0.0');
  const result = await applyUpdate('worker', app, state, { from: releaseRoot, stop: true, 'in-place': true });

  assert.equal(result.method, 'in-place'); assert.equal(result.version, '99.0.0'); assert.equal(result.previous, installed);
  assert.deepEqual(result.inPlace.emptyDirectoriesLeft, ['dropped/held', 'dropped'], 'held empty directories are reported, not fatal');
  assert.equal(result.inPlace.removed, 2); assert.ok(result.inPlace.written >= 1);
  const manifest = JSON.parse(await readFile(join(releaseRoot, 'release-manifest.json'), 'utf8')).files
    .filter(file => file.path.startsWith('bin/apps/worker/')).map(file => [file.path.slice('bin/apps/worker/'.length), file.sha256]);
  assert.deepEqual(await tree(app), Object.fromEntries(manifest), 'the folder equals the release manifest byte for byte');
  assert.deepEqual(await readdir(held), []);
  assert.equal(await appVersion(result.retained), installed);
  assert.equal(await readFile(join(result.retained, 'operator-note.txt'), 'utf8'), 'note');
  assert.equal(await readFile(join(result.retained, 'dropped', 'held', 'old.js'), 'utf8'), 'old');
  assert.ok(result.backup, 'state is backed up as for a folder swap');
  const entry = (await history(app)).at(-1);
  assert.deepEqual(entry, { operation: 'apply', at: entry.at, from: installed, to: '99.0.0', retained: basename(result.retained), backup: result.backup, method: 'in-place' });
  assert.equal(result.restart.restarted, true, result.restart.error);
  const running = await invoke(cwd, ['status', '--state-dir', state]);
  assert.equal(running.data.state, 'running'); assert.notEqual(running.data.runId, started.data.runId);
  assert.deepEqual(await leftovers(app), []);
  assert.match(result.next, /update rollback --in-place/);
});

test('a folder held open suggests the explicit in-place update and replaces nothing', { timeout: 180000 }, async t => {
  const { app, cwd, directory } = await workspace(t, 'update held folder');
  const state = join(cwd, 'state');
  await mkdir(state, { recursive: true });
  const releaseRoot = await extracted(directory, '99.0.0');
  filesystemFault(t, 'rename', async (original, from, to) => {
    if (from === app) throw Object.assign(Error('injected directory handle'), { code: 'EPERM' });
    return original(from, to);
  });
  // Lock classification is Windows behavior; emulate the platform for this call only.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let error;
  try { await applyUpdate('worker', app, state, { from: releaseRoot }); }
  catch (value) { error = value; }
  finally { Object.defineProperty(process, 'platform', platform); }
  assert.match(error?.message ?? '', /holds a file or directory open inside it.*Nothing was replaced\. .*run update apply --stop --in-place to replace the files inside the folder/);
  assert.equal(error.code, 'EPERM');
  assert.equal(await appVersion(app), installed);
  assert.deepEqual(await leftovers(app), []);
  await assert.rejects(readFile(join(dirname(app), '.worker-update', 'history.json')), { code: 'ENOENT' });
});

test('an in-place result that fails verification restores the previous files and records nothing', async t => {
  const { app, cwd, directory } = await workspace(t, 'update in place mismatch');
  const state = join(cwd, 'state'), home = join(dirname(app), '.worker-update');
  await mkdir(state, { recursive: true });
  await writeFile(join(app, 'operator-note.txt'), 'note');
  const before = await tree(app);
  const releaseRoot = await extracted(directory, '99.0.0');
  folderNeverRenamed(t, app);
  filesystemFault(t, 'copyFile', async (original, from, to, ...args) => {
    await original(from, to, ...args);
    if (to === join(app, 'package.json') && from.includes(`${sep}next-`)) await fs.appendFile(to, 'corrupted in transit');
  });
  let error;
  try { await applyUpdate('worker', app, state, { from: releaseRoot, 'in-place': true }); }
  catch (value) { error = value; }
  assert.match(error?.message ?? '', /previous app files were restored and verified\. Updated app integrity mismatch: package\.json/);
  assert.equal(error.recoveryUnsafe, undefined);
  assert.deepEqual(await tree(app), before, 'the previous tree, including operator files, is back');
  await assert.rejects(readFile(join(home, 'history.json')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(home)).filter(name => name.startsWith(installed + '-')), [], 'the redundant copy is removed once the restore is verified');
  assert.deepEqual(await leftovers(app), []);
  assert.deepEqual(await readdir(state), []);
});

test('rollback in place restores the retained files inside the folder and can be repeated', async t => {
  const { app, cwd, directory } = await workspace(t, 'rollback in place');
  const state = join(cwd, 'state');
  await mkdir(state, { recursive: true });
  const before = await tree(app);
  const updated = await applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0'), 'in-place': true });
  const after = await tree(app);
  folderNeverRenamed(t, app);

  const rolledBack = await rollbackUpdate('worker', app, state, { 'in-place': true });
  assert.equal(rolledBack.version, installed); assert.equal(rolledBack.previous, '99.0.0'); assert.equal(rolledBack.method, 'in-place');
  assert.deepEqual(await tree(app), before);
  assert.deepEqual(await tree(rolledBack.retained), after, 'the replaced version is retained for the next rollback');
  assert.deepEqual(await tree(updated.retained), before, 'the copy source stays in place');
  const last = (await history(app)).at(-1);
  assert.equal(last.operation, 'rollback'); assert.equal(last.method, 'in-place'); assert.equal(last.retained, basename(rolledBack.retained));

  const again = await rollbackUpdate('worker', app, state, { 'in-place': true });
  assert.equal(again.version, '99.0.0');
  assert.deepEqual(await tree(app), after);
  assert.deepEqual(await readdir(state), [], 'rollback never changes state');
  assert.deepEqual(await leftovers(app), []);
});
