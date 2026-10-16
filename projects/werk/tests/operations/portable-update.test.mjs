import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, writeFile, rm } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createArchives } from '../../scripts/release/archives.mjs';
import { digest } from '../../scripts/runtime/update/remote.mjs';
import { verifyBackup } from '../../scripts/runtime/maintenance/snapshot.mjs';
import { applyUpdate, checkUpdate, rollbackUpdate } from '../../scripts/runtime/portable/update.mjs';

// Portable self-update operates on copied app folders; every fixture lives in a
// temporary project with no source checkout, npm install or network access.
const project = fileURLToPath(new URL('../../', import.meta.url));
const built = join(project, 'bin/apps/worker');
const installed = JSON.parse(await readFile(join(built, 'package.json'), 'utf8')).version;

function invoke(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cwd, 'bin/apps/worker/cli.mjs'), ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => stdout += part); child.stderr.on('data', part => stderr += part);
    child.once('error', reject);
    const timeout = setTimeout(() => { child.kill(); reject(Error('CLI deadline: ' + args.join(' '))); }, 90000);
    child.once('close', code => { clearTimeout(timeout); let data; try { data = JSON.parse(stdout); } catch {} resolve({ code, stdout, stderr, data }); });
  });
}
async function files(root, path = '') {
  const found = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(root, child)); else found.push(child);
  }
  return found;
}
async function workspace(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `werk ${label} `));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'project'), app = join(cwd, 'bin/apps/worker');
  await mkdir(dirname(app), { recursive: true }); await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
  await cp(built, app, { recursive: true });
  return { directory, cwd, app };
}
/** A release payload containing the built worker app relabelled as `version`, plus its verifier. */
const memo = new Map();
const once = (key, create) => { if (!memo.has(key)) memo.set(key, create()); return memo.get(key); };
const releasePayload = (version, { stateFormat = 1, tamper = false } = {}) => once(JSON.stringify(['payload', version, stateFormat, tamper]), async () => {
  const payload = [];
  for (const path of await files(built)) {
    let content = await readFile(join(built, ...path.split('/')));
    if (path === 'package.json') content = Buffer.from(content.toString('utf8').replace(`"version": "${installed}"`, `"version": "${version}"`));
    payload.push({ path: `bin/apps/worker/${path}`, content, mode: 0o644 });
  }
  payload.push({ path: 'scripts/release/verify.mjs', content: await readFile(join(project, 'scripts/release/verify.mjs')), mode: 0o644 });
  const manifest = { schemaVersion: 1, name: 'werk', version, updateProtocol: 1, stateFormat, files: payload.map(file => ({ path: file.path, bytes: file.content.length, sha256: digest(file.content) })) };
  if (tamper) payload.find(file => file.path === 'bin/apps/worker/README.md').content = Buffer.from('changed after signing');
  return [...payload, { path: 'release-manifest.json', content: Buffer.from(JSON.stringify(manifest)), mode: 0o644 }];
});
async function extracted(directory, version, options) {
  const root = join(directory, `werk-${version}`);
  for (const file of await releasePayload(version, options)) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.content); }
  return root;
}
async function published(version, options) {
  const { tarGzip } = await once(JSON.stringify(['archive', version]), async () => createArchives((await releasePayload(version)).map(file => ({ ...file, path: `werk-${version}/${file.path}` }))));
  const sums = `${digest(tarGzip)}  werk-${version}.tar.gz\n${'a'.repeat(64)}  werk-${version}.zip\n${'b'.repeat(64)}  install.mjs\n`;
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    if (url.endsWith('/releases/latest/download/SHA256SUMS') || url.endsWith(`/download/v${version}/SHA256SUMS`)) return new Response(sums);
    if (url.endsWith(`/download/v${version}/werk-${version}.tar.gz`)) return new Response(options?.corrupt ? Buffer.from('corrupt') : tarGzip);
    return new Response('', { status: 404 });
  };
  return { fetcher, urls };
}
const appVersion = async app => JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).version;
const leftovers = async app => (await readdir(join(dirname(app), '.worker-update'))).filter(name => name.startsWith('next-') || name === 'update.lock');

test('check discovers the latest or a pinned release from SHA256SUMS without changing the app', async t => {
  const { app } = await workspace(t, 'update check');
  const latest = await published('99.0.0');
  assert.deepEqual(await checkUpdate('worker', app, {}, { fetcher: latest.fetcher }), { ok: true, application: 'worker', current: installed, target: '99.0.0', available: true, source: 'github', release: 'https://github.com/Luis85/production-line/releases/tag/v99.0.0' });
  assert.deepEqual(latest.urls, ['https://github.com/Luis85/production-line/releases/latest/download/SHA256SUMS']);
  const pinned = await published('99.0.0');
  assert.equal((await checkUpdate('worker', app, { version: '99.0.0' }, { fetcher: pinned.fetcher })).target, '99.0.0');
  assert.deepEqual(pinned.urls, ['https://github.com/Luis85/production-line/releases/download/v99.0.0/SHA256SUMS']);
  await assert.rejects(checkUpdate('worker', app, { version: '99.0.0-rc.1' }), /stable semantic version/);
  await assert.rejects(checkUpdate('worker', project, {}), /Source checkouts update with Git/);
  assert.equal(await appVersion(app), installed);
});

test('verified download replaces a stopped app atomically, keeps the previous folder and leaves no staging', async t => {
  const { app, cwd } = await workspace(t, 'update download');
  const state = join(cwd, '.werk', 'worker');
  const release = await published('99.0.0');
  // init creates an empty state directory before the first start: nothing to back up.
  await mkdir(state, { recursive: true });
  const result = await applyUpdate('worker', app, state, {}, release);
  assert.equal(result.updated, true); assert.equal(result.version, '99.0.0'); assert.equal(result.previous, installed);
  assert.equal(result.backup, null, 'an empty state directory has nothing to back up');
  assert.deepEqual(await readdir(state), [], 'the held lock is released');
  assert.deepEqual(result.restart, { restarted: false, reason: 'not_running' });
  assert.equal(await appVersion(app), '99.0.0');
  assert.equal(await appVersion(result.retained), installed);
  assert.deepEqual(await leftovers(app), []);
  assert.equal(release.urls.filter(url => url.endsWith('.tar.gz')).length, 1);
  assert.equal((await applyUpdate('worker', app, state, {}, release)).updated, false, 'the current version is a no-op');
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(join(cwd, '..'), '98.0.0') }), /older than the installed 99\.0\.0.*rollback/);
});

test('checksum mismatch, tampered payload and incompatible state format never replace the app', async t => {
  const { app, cwd } = await workspace(t, 'update refusal');
  const state = join(cwd, '.werk', 'worker');
  await assert.rejects(applyUpdate('worker', app, state, {}, await published('99.0.0', { corrupt: true })), /checksum mismatch/);
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(cwd, '97.0.0', { tamper: true }) }), /not a verified extracted release/);
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(join(cwd, '..'), '96.0.0', { stateFormat: 2 }) }), /state format 1/);
  await assert.rejects(applyUpdate('worker', app, state, { version: '96.0.0', from: await extracted(join(cwd, '..'), '95.0.0') }), /differs from the --from release/);
  assert.equal(await appVersion(app), installed);
  assert.deepEqual(await leftovers(app), []);
  assert.deepEqual((await readdir(dirname(app))).sort(), ['.worker-update', 'worker']);
});

test('a running worker is refused, then stopped, backed up, replaced, restarted and rolled back', { timeout: 240000 }, async t => {
  const { app, cwd, directory } = await workspace(t, 'update running');
  const releaseRoot = await extracted(directory, '99.0.0');
  t.after(() => invoke(cwd, ['stop', '--state-dir', '.werk/worker-a']).catch(() => {}));
  const started = await invoke(cwd, ['start', '--state-dir', '.werk/worker-a', '--port', '0']);
  assert.equal(started.code, 0, started.stderr);
  const state = await realpath(started.data.stateDirectory), token = await readFile(join(state, 'webview-token'));

  const refused = await invoke(cwd, ['update', 'apply', '--from', releaseRoot, '--state-dir', '.werk/worker-a']);
  assert.equal(refused.code, 2); assert.match(refused.stderr, /running.*--stop/);
  assert.equal(await appVersion(app), installed);
  assert.equal((await invoke(cwd, ['status', '--state-dir', '.werk/worker-a'])).data.runId, started.data.runId);

  const updated = await invoke(cwd, ['update', 'apply', '--from', releaseRoot, '--state-dir', '.werk/worker-a', '--stop']);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(updated.data.version, '99.0.0'); assert.equal(updated.data.restart.restarted, true);
  assert.notEqual(updated.data.restart.runId, started.data.runId);
  assert.equal(await appVersion(app), '99.0.0');
  assert.deepEqual(await readFile(join(state, 'webview-token')), token, 'state is preserved in place');
  // The backup is a complete, verified stopped-state snapshot that excludes the held lock.
  assert.match(relative(state + '.updates', updated.data.backup), new RegExp(`^backups\\${sep}\\d{8}T\\d{6}Z-${installed.replaceAll('.', '\\.')}$`));
  assert.ok((await verifyBackup(updated.data.backup)).files > 0);
  assert.deepEqual(await readFile(join(updated.data.backup, 'state', 'webview-token')), token);
  assert.equal(await readFile(join(state + '.updates', '.gitignore'), 'utf8'), '*\n');
  const running = await invoke(cwd, ['status', '--state-dir', '.werk/worker-a']);
  assert.equal(running.data.state, 'running'); assert.equal(running.data.runId, updated.data.restart.runId);

  const restored = await invoke(cwd, ['update', 'restore', '--from', updated.data.backup, '--to', join(directory, 'restored')]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(await readFile(join(directory, 'restored', 'webview-token')), token);

  const status = await invoke(cwd, ['update', 'status', '--state-dir', '.werk/worker-a']);
  assert.equal(status.data.current, '99.0.0'); assert.equal(status.data.last.operation, 'apply');
  assert.deepEqual(status.data.retained.map(entry => entry.version), [installed]);

  const rolledBack = await invoke(cwd, ['update', 'rollback', '--state-dir', '.werk/worker-a', '--stop', '--no-restart']);
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(rolledBack.data.version, installed); assert.equal(rolledBack.data.backup, updated.data.backup);
  assert.deepEqual(rolledBack.data.restart, { restarted: false, reason: 'no_restart' });
  assert.equal(await appVersion(app), installed);
  assert.equal((await invoke(cwd, ['status', '--state-dir', '.werk/worker-a'])).data.state, 'stopped');
  assert.deepEqual(await readFile(join(state, 'webview-token')), token);
  // A second rollback swaps the newer folder back in: each step retains what it replaced.
  assert.equal((await rollbackUpdate('worker', app, state, {})).version, '99.0.0');
  assert.equal(await appVersion(app), '99.0.0');
});

test('update runs from the project directory and refuses source checkouts and unknown switches', async t => {
  const { app, cwd, directory } = await workspace(t, 'update guards');
  const inside = await new Promise(resolve => {
    const child = spawn(process.execPath, ['cli.mjs', 'update', 'apply', '--from', directory, '--state-dir', join(cwd, '.werk/worker')], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', part => stderr += part); child.once('close', code => resolve({ code, stderr }));
  });
  assert.equal(inside.code, 2); assert.match(inside.stderr, /project directory/);
  assert.equal((await invoke(cwd, ['update', 'check', '--stop'])).code, 2);
  assert.equal((await invoke(cwd, ['update', 'apply', '--stop', '--stop'])).code, 2);
  assert.equal((await invoke(cwd, ['update', 'upgrade'])).code, 2);
  await assert.rejects(applyUpdate('worker', project, join(directory, 'state'), { from: directory }), /Source checkouts update with Git/);
  assert.match((await invoke(cwd, ['schema'])).data.update.apply, /--stop/);
});
