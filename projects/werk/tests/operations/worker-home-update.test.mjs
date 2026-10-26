import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, lstat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { createHash } from 'node:crypto';
import { apply, preview, rollback, homeUpdateStatus } from '../../scripts/runtime/home-update/transaction.mjs';
import { withHomeRuntimeLock, withHomeRuntimeLease } from '../../scripts/runtime/home-update/guard.mjs';
import { verifyRelease } from '../../scripts/release/verify.mjs';
import { ordinary, withStoppedRuntime } from '../../scripts/runtime/home-update/ownership.mjs';
import { applyUpdate, checkUpdate } from '../../scripts/runtime/portable/update.mjs';
import { homeUpdate } from '../../scripts/runtime/home-update.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-home-update-'))); t.after(() => rm(root, { recursive: true, force: true }));
  async function release(name, version) {
    const path = join(root, name); await mkdir(path);
    const files = [];
    for (const [file, text] of Object.entries({ 'worker.mjs': `// worker ${version}`, 'werk.mjs': `// system ${version}`, 'runtime/bin/apps/worker/cli.mjs': `// cli ${version}`, 'docs/index.md': `Version ${version}` })) {
      await mkdir(dirname(join(path, file)), { recursive: true }); await writeFile(join(path, file), text); files.push({ path: file, bytes: Buffer.byteLength(text), sha256: sha(text), mode: '644' });
    }
    await writeFile(join(path, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'werk', version, layout: 'werk-home-v1', updateProtocol: 2, stateFormat: 1, files }));
    return path;
  }
  const home = await release('Home', '1.0.0'), candidate = await release('Candidate', '1.1.0');
  await mkdir(join(home, 'projects/company/.git'), { recursive: true }); await writeFile(join(home, 'projects/company/precious.txt'), 'uncommitted user work');
  await mkdir(join(home, 'state/worker'), { recursive: true }); await writeFile(join(home, 'state/worker/identity.json'), 'retained private identity');
  await writeFile(join(home, 'my-notes.txt'), 'user-owned root note');
  const retained = async () => { assert.equal(await readFile(join(home, 'projects/company/precious.txt'), 'utf8'), 'uncommitted user work'); assert.equal(await readFile(join(home, 'state/worker/identity.json'), 'utf8'), 'retained private identity'); assert.equal(await readFile(join(home, 'my-notes.txt'), 'utf8'), 'user-owned root note'); };
  return { root, home, candidate, retained, release };
}
test('Home update applies exact preview, retains mutable Home paths and rolls back only verified release files', async t => {
  const { home, candidate, retained } = await fixture(t), plan = await preview(home, candidate);
  const confirmed = await apply(home, candidate, { ifMatch: plan.id }); assert.equal(confirmed.status, 'confirmed');
  assert.equal((await verifyRelease(home)).version, '1.1.0'); await retained();
  assert.equal((await homeUpdate(home, ['status'])).status, 'confirmed'); assert.equal((await homeUpdate(home, ['status'])).before, undefined);
  assert.equal((await apply(home, candidate)).status, 'already_current');
  assert.equal((await rollback(home)).status, 'rolled_back'); assert.equal((await verifyRelease(home)).version, '1.0.0'); await retained();
  assert.equal((await rollback(home)).status, 'rolled_back');
});
test('stale preview, changed candidate and modified owned payload never overwrite user data', async t => {
  const { home, candidate, retained } = await fixture(t), plan = await preview(home, candidate);
  await assert.rejects(apply(home, candidate, { ifMatch: '0'.repeat(64) }), /changed since preview/);
  await writeFile(join(candidate, 'worker.mjs'), 'tampered'); await assert.rejects(apply(home, candidate, { ifMatch: plan.id }), /integrity mismatch/);
  await retained(); assert.equal((await homeUpdateStatus(home)).status, 'none');
});
test('explicit stop is honored and exclusive runner ownership prevents raw startup during replacement', async t => {
  const { home, candidate } = await fixture(t); let running = true, stops = 0;
  const inspectWorker = async () => ({ state: running ? 'running' : 'stopped' });
  await apply(home, candidate, { inspectWorker, stop: true, stopWorker: async () => { stops++; running = false; } });
  assert.equal(stops, 1); assert.equal((await verifyRelease(home)).version, '1.1.0');
  // The same lock used by actual Home startup excludes the entire update.
  await withHomeRuntimeLock(home, async () => {
    await assert.rejects(rollback(home), /Another Home startup or update/);
    assert.equal((await verifyRelease(home)).version, '1.1.0');
  });
});
test('a raw runner winning admission blocks replacement without killing or replacing its lock', async t => {
  const { home, candidate, retained } = await fixture(t), lock = join(home, 'state/worker/worker.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(apply(home, candidate), /runtime still owns/);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
  assert.equal((await verifyRelease(home)).version, '1.0.0'); await retained();
  assert.equal((await homeUpdateStatus(home)).status, 'none'); await rm(lock); assert.equal((await apply(home, candidate)).status, 'confirmed');
});
test('restart reconciliation restores an interrupted rename using retained immutable manifests', async t => {
  const { home, candidate, retained } = await fixture(t);
  const confirmed = await apply(home, candidate), backup = join(home, 'state/updates', confirmed.id, 'backup');
  // Simulate a process dying after retaining old runtime and before activation; no live lock remains.
  const displaced = join(home, 'state/updates', confirmed.id, 'lost-ack-runtime');
  await rename(join(home, 'runtime'), displaced);
  const record = JSON.parse(await readFile(join(home, 'state/updates/latest.json'), 'utf8'));
  record.status = 'pending'; record.intent = { action: 'activate_new', name: 'runtime' };
  await writeFile(join(home, 'state/updates/latest.json'), JSON.stringify(record));
  assert.equal((await homeUpdate(home, ['status'])).status, 'pending');
  await assert.rejects(apply(home, candidate), /ENOENT|Missing release/);
  assert.ok((await lstat(join(backup, 'runtime'))).isDirectory());
  assert.equal((await rollback(home)).status, 'rolled_back'); assert.equal((await verifyRelease(home)).version, '1.0.0'); await retained();
});
test('rollback preserves an externally modified new payload and refuses forged retained paths', async t => {
  const { home, candidate, retained } = await fixture(t); await apply(home, candidate);
  await writeFile(join(home, 'runtime/bin/apps/worker/cli.mjs'), 'operator edit');
  await assert.rejects(rollback(home), /changed after the update/);
  assert.equal(await readFile(join(home, 'runtime/bin/apps/worker/cli.mjs'), 'utf8'), 'operator edit'); await retained();
  const path = join(home, 'state/updates/latest.json'), record = JSON.parse(await readFile(path, 'utf8'));
  record.names.push('projects'); await writeFile(path, JSON.stringify(record)); await assert.rejects(rollback(home), /metadata is invalid/); await retained();
});
test('Home verifier ignores mutable symlinks but updater rejects owned payload and state-directory aliases', async t => {
  const { home, candidate, root } = await fixture(t);
  try { await symlink(join(root, 'missing'), join(home, 'projects/company/ignored-link')); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await verifyRelease(home);
  await mkdir(join(home, 'state/updates')); await rm(join(home, 'state/updates'), { recursive: true }); await symlink(root, join(home, 'state/updates'), 'dir');
  await assert.rejects(apply(home, candidate), /ordinary directories/);
});
test('unknown Home update arguments and legacy candidates fail without downloading or mutating Home', async t => {
  const { home, candidate, retained } = await fixture(t);
  await assert.rejects(homeUpdate(home, ['apply', '--from', candidate, '--in-place']), /Unknown/);
  const manifest = JSON.parse(await readFile(join(candidate, 'release-manifest.json'), 'utf8')); delete manifest.layout; manifest.updateProtocol = 1;
  await writeFile(join(candidate, 'release-manifest.json'), JSON.stringify(manifest));
  await assert.rejects(preview(home, candidate), /legacy project installations/); await retained();
});

test('corrupt retained backup refuses rollback before displacing any healthy current release part', async t => {
  const { home, candidate, retained } = await fixture(t), receipt = await apply(home, candidate);
  const manifest = await readFile(join(home, 'release-manifest.json'));
  await writeFile(join(home, 'state/updates', receipt.id, 'backup/runtime/bin/apps/worker/cli.mjs'), 'corrupt backup');
  await assert.rejects(rollback(home), /retained previous release/);
  assert.deepEqual(await readFile(join(home, 'release-manifest.json')), manifest);
  assert.equal((await verifyRelease(home)).version, '1.1.0'); await retained();
});
test('update admission reserves actual runner locks until the mutation completes', async t => {
  const { home } = await fixture(t), lock = join(home, 'state/worker/worker.lock');
  await withStoppedRuntime(home, {}, async () => {
    await assert.rejects(writeFile(lock, 'raw runner', { flag: 'wx' }), { code: 'EEXIST' });
  });
  await writeFile(lock, 'raw runner', { flag: 'wx' }); assert.equal(await readFile(lock, 'utf8'), 'raw runner');
});

test('a Home-owned portable app refuses the legacy updater before network or payload mutation', async t => {
  const { home, retained } = await fixture(t), app = join(home, 'runtime/bin/apps/worker');
  const fetcher = async () => { assert.fail('Home updater refusal must precede release discovery'); };
  await assert.rejects(checkUpdate('worker', app, {}, { fetcher }), /belongs to Werk Home/);
  await assert.rejects(applyUpdate('worker', app, join(home, 'state/worker'), {}, { fetcher }), /belongs to Werk Home/);
  assert.equal((await verifyRelease(home)).version, '1.0.0'); await retained();
});
test('protocol-one copied-app recovery refuses a flat Home candidate without replacing the legacy app', async t => {
  const { root, candidate } = await fixture(t), legacy = join(root, 'legacy/bin/apps/worker');
  await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'package.json'), JSON.stringify({ name: '@werk/worker-portable', version: '1.0.0' }));
  await writeFile(join(legacy, 'cli.mjs'), 'legacy runtime');
  await assert.rejects(applyUpdate('worker', legacy, join(root, 'legacy-state'), { from: candidate }), /not compatible with update protocol/);
  assert.equal(await readFile(join(legacy, 'cli.mjs'), 'utf8'), 'legacy runtime'); assert.equal((await verifyRelease(candidate)).version, '1.1.0');
});

test('foreground components coexist with Home startup but their durable leases exclude payload updates', async t => {
  const { home, candidate, retained } = await fixture(t);
  await withHomeRuntimeLease(home, () => withHomeRuntimeLease(home, async () => {
    await withHomeRuntimeLock(home, async () => { assert.equal((await verifyRelease(home)).version, '1.0.0'); });
    await assert.rejects(apply(home, candidate), /foreground Home component/);
    assert.equal((await homeUpdateStatus(home)).status, 'none'); await retained();
  }));
  assert.equal((await apply(home, candidate)).status, 'confirmed');
});

test('private directory creation validates existing filesystem roots without recreating drive ancestors', async t => {
  const { root } = await fixture(t), filesystemRoot = parse(root).root;
  assert.equal(await ordinary(filesystemRoot, true), filesystemRoot);
  const nested = join(root, 'existing/new/private'); await mkdir(join(root, 'existing'));
  assert.equal(await ordinary(nested, true), nested); assert.equal((await lstat(nested)).isDirectory(), true);
  await writeFile(join(nested, 'retained'), 'preserved'); await ordinary(nested, true); assert.equal(await readFile(join(nested, 'retained'), 'utf8'), 'preserved');
  await writeFile(join(root, 'ordinary-file'), 'user data'); await assert.rejects(ordinary(join(root, 'ordinary-file'), true), /ordinary directories/); assert.equal(await readFile(join(root, 'ordinary-file'), 'utf8'), 'user data');
});
