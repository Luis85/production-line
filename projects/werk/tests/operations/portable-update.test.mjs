import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createPrivate } from '../../scripts/runtime/config.mjs';
import { verifyBackup } from '../../scripts/runtime/maintenance/snapshot.mjs';
import { processHost } from '../../src/worker/dist/shared/process/owner.js';
import { applyUpdate, checkUpdate, rollbackUpdate } from '../../scripts/runtime/portable/update.mjs';
import { appVersion, extracted, filesystemFault, githubRelease, installed, invoke, leftovers, project, workspace } from '../helpers/portable-update.mjs';

// Portable self-update operates on copied app folders; fixtures live in tests/helpers/portable-update.mjs.

test('check discovers the latest or a pinned release from SHA256SUMS without changing the app', async t => {
  const { app } = await workspace(t, 'update check');
  const latest = await githubRelease('99.0.0');
  assert.deepEqual(await checkUpdate('worker', app, {}, { fetcher: latest.fetcher }), { ok: true, application: 'worker', current: installed, target: '99.0.0', available: true, source: 'github', release: 'https://github.com/Luis85/production-line/releases/tag/v99.0.0' });
  assert.deepEqual(latest.urls, ['https://github.com/Luis85/production-line/releases/latest/download/SHA256SUMS']);
  const pinned = await githubRelease('99.0.0');
  assert.equal((await checkUpdate('worker', app, { version: '99.0.0' }, { fetcher: pinned.fetcher })).target, '99.0.0');
  assert.deepEqual(pinned.urls, ['https://github.com/Luis85/production-line/releases/download/v99.0.0/SHA256SUMS']);
  await assert.rejects(checkUpdate('worker', app, { version: '99.0.0-rc.1' }), /stable semantic version/);
  await assert.rejects(checkUpdate('worker', project, {}), /Source checkouts update with Git/);
  assert.equal(await appVersion(app), installed);
});

test('verified download replaces a stopped app atomically, keeps the previous folder and leaves no staging', async t => {
  const { app, cwd } = await workspace(t, 'update download');
  const state = join(cwd, '.werk', 'worker');
  const release = await githubRelease('99.0.0');
  // init creates an empty state directory before the first start: nothing to back up.
  await mkdir(state, { recursive: true });
  const result = await applyUpdate('worker', app, state, {}, release);
  assert.equal(result.updated, true); assert.equal(result.version, '99.0.0'); assert.equal(result.previous, installed);
  assert.equal(result.method, 'swap'); assert.equal(result.inPlace, null);
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
  await assert.rejects(applyUpdate('worker', app, state, {}, await githubRelease('99.0.0', { corrupt: true })), /checksum mismatch/);
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(cwd, '97.0.0', { tamper: true }) }), /not a verified extracted release/);
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(join(cwd, '..'), '96.0.0', { stateFormat: 2 }) }), /state format 1/);
  await assert.rejects(applyUpdate('worker', app, state, { version: '96.0.0', from: await extracted(join(cwd, '..'), '95.0.0') }), /differs from the --from release/);
  assert.equal(await appVersion(app), installed);
  assert.deepEqual(await leftovers(app), []);
  assert.deepEqual((await readdir(dirname(app))).sort(), ['.worker-update', 'worker']);
});

test('a running worker is refused, then stopped, backed up, replaced, restarted and rolled back', { timeout: 240000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update running');
  const releaseRoot = await extracted(directory, '99.0.0');
  cleanup(() => invoke(cwd, ['stop', '--state-dir', '.werk/worker-a']).catch(() => {}));
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
  assert.equal((await invoke(cwd, ['update', 'apply', '--in-place', '--in-place'])).code, 2);
  assert.equal((await invoke(cwd, ['update', 'check', '--in-place'])).code, 2);
  assert.equal((await invoke(cwd, ['update', 'upgrade'])).code, 2);
  await assert.rejects(applyUpdate('worker', project, join(directory, 'state'), { from: directory }), /Source checkouts update with Git/);
  const help = (await invoke(cwd, ['schema'])).data.update;
  assert.match(help.apply, /--stop.*--in-place/); assert.match(help.rollback, /--in-place/);
});


test('invalid update history is rejected before stopping or replacing a running worker', { timeout: 120000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update invalid history');
  const state = join(cwd, 'custom-state'), home = join(dirname(app), '.worker-update');
  cleanup(() => invoke(cwd, ['stop', '--state-dir', state]).catch(() => {}));
  const started = await invoke(cwd, ['start', '--state-dir', state, '--port', '0']);
  assert.equal(started.code, 0, started.stderr);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'history.json'), 'invalid history', { mode: 0o600 });
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0'), stop: true }), /invalid JSON/);
  assert.equal(await appVersion(app), installed);
  assert.equal((await invoke(cwd, ['status', '--state-dir', state])).data.runId, started.data.runId);
  assert.deepEqual(await leftovers(app), []);
});

test('failed history commit restores the old app and restarts the selected environment-defined state with its lock intact', { timeout: 180000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update history failure');
  const state = join(cwd, 'custom-state'), history = join(dirname(app), '.worker-update/history.json');
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.WERK_WORKER_STATE_DIR;
  cleanup(() => invoke(cwd, ['stop', '--state-dir', state], cleanEnvironment).catch(() => {}));
  cleanup(() => invoke(cwd, ['stop', '--state-dir', join(cwd, '.werk/worker')], cleanEnvironment).catch(() => {}));
  const started = await invoke(cwd, ['start', '--port', '0'], { ...cleanEnvironment, WERK_WORKER_STATE_DIR: state });
  assert.equal(started.code, 0, started.stderr);
  const token = await readFile(join(state, 'webview-token'));
  // Exercise migration of a pre-fix launch record that held raw arguments only.
  const identityPath = join(state, 'portable.json'), identity = JSON.parse(await readFile(identityPath, 'utf8'));
  identity.launch.args = ['--port', '0'];
  await writeFile(identityPath, JSON.stringify(identity), { mode: 0o600 });
  const restore = filesystemFault(t, 'rename', async (original, from, to) => {
    if (to === history) throw Object.assign(Error('injected history commit failure'), { code: 'EIO' });
    return original(from, to);
  });
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0'), stop: true }), /previous app folder was restored.*previous version was restarted/);
  restore();
  assert.equal(await appVersion(app), installed);
  const running = await invoke(cwd, ['status', '--state-dir', state], cleanEnvironment);
  assert.equal(running.data.state, 'running');
  assert.notEqual(running.data.runId, started.data.runId);
  assert.ok(await fs.stat(join(state, 'worker.lock')), 'finally must not delete the restarted worker lock');
  assert.deepEqual(await readFile(join(state, 'webview-token')), token);
  assert.equal((await invoke(cwd, ['status', '--state-dir', join(cwd, '.werk/worker')], cleanEnvironment)).data.state, 'stopped');
  await assert.rejects(readFile(history), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(app), []);
});

test('a failed rollback history commit restores the active version and preserves the existing rollback record', async t => {
  const { app, cwd, directory } = await workspace(t, 'rollback history failure');
  const state = join(cwd, 'state'), history = join(dirname(app), '.worker-update/history.json');
  await mkdir(state, { mode: 0o700 });
  const updated = await applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0') });
  const previousHistory = await readFile(history);
  filesystemFault(t, 'rename', async (original, from, to) => {
    if (to === history) throw Object.assign(Error('injected history commit failure'), { code: 'EIO' });
    return original(from, to);
  });
  await assert.rejects(rollbackUpdate('worker', app, state), /previous app folder was restored/);
  assert.equal(await appVersion(app), '99.0.0');
  assert.equal(await appVersion(updated.retained), installed);
  assert.deepEqual(await readFile(history), previousHistory);
  assert.deepEqual(await readdir(state), []);
  assert.deepEqual(await leftovers(app), []);
});

test('a state lock error after shutdown restarts the unchanged worker', { timeout: 180000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update lock failure');
  const state = join(cwd, 'state');
  cleanup(() => invoke(cwd, ['stop', '--state-dir', state]).catch(() => {}));
  const started = await invoke(cwd, ['start', '--state-dir', state, '--port', '0']);
  assert.equal(started.code, 0, started.stderr);
  filesystemFault(t, 'open', async (original, path, ...args) => {
    if (path === join(state, 'worker.lock')) throw Object.assign(Error('injected lock open failure'), { code: 'EIO' });
    return original(path, ...args);
  });
  await assert.rejects(applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0'), stop: true }), /injected lock open failure.*previous version was restarted/);
  assert.equal(await appVersion(app), installed);
  const running = await invoke(cwd, ['status', '--state-dir', state]);
  assert.equal(running.data.state, 'running');
  assert.notEqual(running.data.runId, started.data.runId);
  assert.ok(await fs.stat(join(state, 'worker.lock')));
  assert.deepEqual(await leftovers(app), []);
});

test('failed activation recovery leaves the app stopped and names the retained previous folder', { timeout: 180000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update recovery failure');
  const state = join(cwd, 'state'), home = join(dirname(app), '.worker-update');
  cleanup(() => invoke(cwd, ['stop', '--state-dir', state]).catch(() => {}));
  const started = await invoke(cwd, ['start', '--state-dir', state, '--port', '0']);
  assert.equal(started.code, 0, started.stderr);
  filesystemFault(t, 'rename', async (original, from, to) => {
    if (to === join(home, 'history.json') || to === app && dirname(from) === home && !from.includes('next-')) throw Object.assign(Error('injected recovery failure'), { code: 'EIO' });
    return original(from, to);
  });
  let error;
  try { await applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0'), stop: true }); }
  catch (value) { error = value; }
  assert.match(error?.message ?? '', /history could not be saved and automatic recovery failed.*app remains stopped/);
  assert.doesNotMatch(error.message, /previous version was restarted/);
  const retained = (await readdir(home)).find(name => name.startsWith(installed + '-'));
  assert.ok(retained); assert.ok(error.message.includes(join(home, retained)));
  assert.equal(await appVersion(join(home, retained)), installed);
  await assert.rejects(fs.stat(join(state, 'worker.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(state, 'portable.json')), { code: 'ENOENT' });
});

test('a failed folder move names the failure, replaces nothing and restarts the previous version', { timeout: 180000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update move failure');
  const state = join(cwd, 'state'), home = join(dirname(app), '.worker-update');
  cleanup(() => invoke(cwd, ['stop', '--state-dir', state]).catch(() => {}));
  const started = await invoke(cwd, ['start', '--state-dir', state, '--port', '0']);
  assert.equal(started.code, 0, started.stderr);
  filesystemFault(t, 'rename', async (original, from, to) => {
    if (from === app && dirname(to) === home) throw Object.assign(Error('injected move failure'), { code: 'EIO' });
    return original(from, to);
  });
  let error;
  try { await applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0'), stop: true }); }
  catch (value) { error = value; }
  assert.match(error?.message ?? '', /Could not move .* \(EIO\)\. Nothing was replaced\. The previous version was restarted\./);
  assert.doesNotMatch(error.message, /holds a file|keeps running/);
  assert.equal(error.code, 'EIO');
  assert.equal(await appVersion(app), installed);
  assert.equal((await invoke(cwd, ['status', '--state-dir', state])).data.state, 'running');
  assert.deepEqual(await leftovers(app), []);
});

test('update preserves effective launch settings supplied only by the original shell environment', { timeout: 180000 }, async t => {
  const { app, cwd, directory, cleanup } = await workspace(t, 'update launch settings');
  const state = join(cwd, 'custom-state'), config = join(cwd, 'custom-worker.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1 }));
  const cleanEnvironment = { ...process.env };
  for (const key of ['WERK_WORKER_STATE_DIR', 'WERK_WORKER_HOST', 'WERK_WORKER_PORT', 'WERK_WORKER_CONFIG', 'WERK_WORKER_MAX_RUNTIME_MS']) delete cleanEnvironment[key];
  cleanup(() => invoke(cwd, ['stop', '--state-dir', state], cleanEnvironment).catch(() => {}));
  const started = await invoke(cwd, ['start'], { ...cleanEnvironment, WERK_WORKER_STATE_DIR: state, WERK_WORKER_HOST: '127.0.0.1', WERK_WORKER_PORT: '0', WERK_WORKER_CONFIG: config, WERK_WORKER_MAX_RUNTIME_MS: '000060000' });
  assert.equal(started.code, 0, started.stderr);
  const inspectLaunch = async duration => {
    const launch = JSON.parse(await readFile(join(state, 'portable.json'), 'utf8')).launch;
    const options = Object.fromEntries(Array.from({ length: launch.args.length / 2 }, (_, index) => [launch.args[index * 2], launch.args[index * 2 + 1]]));
    assert.equal(options['--state-dir'], await realpath(state));
    assert.equal(options['--config'], config);
    assert.equal(options['--host'], '127.0.0.1');
    assert.equal(options['--port'], '0');
    assert.deepEqual(launch.environment, { WERK_WORKER_MAX_RUNTIME_MS: duration });
  };
  await inspectLaunch('000060000');
  const result = await applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0'), stop: true });
  assert.equal(result.restart.restarted, true, result.restart.error);
  assert.equal(result.restart.stateDirectory, await realpath(state));
  await inspectLaunch('60000');
});

test('a crashed worker is not running: update apply recovers its stale files and does not restart it', { timeout: 180000 }, async t => {
  const { app, cwd, directory } = await workspace(t, 'update stale');
  const state = join(cwd, '.werk', 'worker'), child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise(resolve => child.once('close', resolve));
  await mkdir(state, { recursive: true });
  // No control endpoint answers for this run on port 9, as after a reboot.
  await createPrivate(join(state, 'portable.json'), { schemaVersion: 1, kind: 'worker', runId: 'a'.repeat(64), controlToken: 'b'.repeat(64), pid: child.pid, host: processHost, controlPort: 9, children: [], url: 'http://127.0.0.1:4100' });
  await createPrivate(join(state, 'worker.lock'), { pid: child.pid, host: processHost, startedAt: new Date().toISOString() });
  const logged = t.mock.method(console, 'error', () => {});
  const result = await applyUpdate('worker', app, state, { from: await extracted(directory, '99.0.0') });
  assert.equal(result.updated, true); assert.deepEqual(result.restart, { restarted: false, reason: 'not_running' });
  assert.deepEqual(await readdir(state), []);
  assert.deepEqual(JSON.parse(logged.mock.calls[0].arguments[0]).removed, [join(state, 'portable.json'), join(state, 'worker.lock')]);
});
