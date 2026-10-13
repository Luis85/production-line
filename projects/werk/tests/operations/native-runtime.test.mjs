import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, lstat, symlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as netServer } from 'node:net';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setup, loadSetup, createPrivate, readPrivate, validateConfig } from '../../scripts/runtime/config.mjs';
import { openBrowser } from '../../scripts/runtime/browser.mjs';
import { createControl, controlRequest, stopRuntime } from '../../scripts/runtime/control.mjs';
import { runtimeEnvironment } from '../../scripts/runtime/supervisor.mjs';
import { main, parse } from '../../scripts/runtime/cli.mjs';
const source = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'werk-native-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function freePort() { const server = netServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function launch(root, args) {
  const child = spawn(process.execPath, [join(root, 'werk.mjs'), ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  return { child, done, get output() { return stdout; }, get errors() { return stderr; } };
}
async function cli(root, args) { return launch(root, args).done; }
async function until(predicate, label, timeoutMs = 15000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(50); } throw Error('Timed out: ' + label); }

// Setup is a private idempotent filesystem operation, not a credential rotation command.
test('setup preserves existing credentials/configuration and completes interrupted first setup without rotation', async t => {
  const root = await directory(t), stateDir = join(root, 'state');
  const first = await setup({ stateDir, project: 'example', port: 33000, workerPort: 33001, workers: 2 });
  const before = await readFile(join(stateDir, 'credentials.json'), 'utf8');
  assert.equal(first.created, true); assert.equal((await setup({ stateDir })).created, false);
  assert.equal(await readFile(join(stateDir, 'credentials.json'), 'utf8'), before);
  await assert.rejects(setup({ stateDir, port: 33005 }), /preserved/);
  assert.equal((await loadSetup(stateDir)).config.orchestratorPort, 33000);
  const partial = join(root, 'partial'); await mkdir(partial, { mode: 0o700 });
  const saved = { WERK_ADMIN_TOKEN: 'a'.repeat(64), WERK_ENROLLMENT_TOKEN: 'b'.repeat(64) };
  await createPrivate(join(partial, 'credentials.json'), saved); await setup({ stateDir: partial });
  assert.deepEqual((await loadSetup(partial)).credentials, saved);
  if (process.platform !== 'win32') assert.equal((await lstat(join(stateDir, 'credentials.json'))).mode & 0o077, 0);
});

test('setup refuses orphan state, SQLite sidecars, Docker markers and unknown settings without creating credentials', async t => {
  const root = await directory(t);
  for (const name of ['orchestrator.sqlite', 'orchestrator.sqlite-wal', 'orchestrator.sqlite-shm', 'supervisor.json', 'runtime.lock', 'docker-volume.json', 'logs']) {
    const stateDir = join(root, name.replaceAll('.', '-')); await mkdir(stateDir, { mode: 0o700 }); await writeFile(join(stateDir, name), 'preserve', { mode: 0o600 });
    await assert.rejects(setup({ stateDir }), /State exists without configuration/);
    await assert.rejects(readFile(join(stateDir, 'credentials.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(stateDir, name), 'utf8'), 'preserve');
  }
  const stateDir = join(root, 'invalid'); await assert.rejects(setup({ stateDir, port: 4100, workerPort: 4100 }), /overlap/);
  await assert.rejects(readFile(join(stateDir, 'credentials.json')), { code: 'ENOENT' });
  assert.throws(() => validateConfig({ schemaVersion: 1, runtime: 'native', mode: 'mock', project: 'demo', orchestratorPort: 3000, workerPort: 4100, workers: 1, statePath: '../escape' }), /Invalid runtime configuration/);
});

test('setup contention and native/Docker mode boundaries preserve existing state', async t => {
  const stateDir = join(await directory(t), 'state'); await mkdir(stateDir, { mode: 0o700 }); await createPrivate(join(stateDir, 'setup.lock'), { pid: process.pid });
  await assert.rejects(setup({ stateDir }), /Another setup/); await rm(join(stateDir, 'setup.lock'));
  await setup({ stateDir, runtime: 'docker' }); const output = [];
  assert.equal(await main(['start', '--state-dir', stateDir, '--json'], { stdout: value => output.push(JSON.parse(value)) }), 2);
  assert.match(output[0].error.message, /Docker/); assert.equal((await loadSetup(stateDir)).config.runtime, 'docker');
  await assert.rejects(setup({ stateDir }), /preserved/);
});

test('malformed private JSON never reflects credential bytes and oversized/symlink/special files fail boundedly', async t => {
  const root = await directory(t), file = join(root, 'credentials.json'), marker = 'private-credential-marker';
  await writeFile(file, marker, { mode: 0o600 });
  await assert.rejects(readPrivate(file), error => /invalid JSON/.test(error.message) && !error.message.includes(marker) && !error.message.includes('private-cr'));
  await writeFile(file, 'x'.repeat(65537), { mode: 0o600 }); await assert.rejects(readPrivate(file), /Invalid/);
  if (process.platform !== 'win32') {
    const alias = join(root, 'alias'); await symlink(file, alias); await assert.rejects(readPrivate(alias), /regular file/);
    const fifo = join(root, 'fifo'); await exec('mkfifo', [fifo]);
    const started = Date.now(); await assert.rejects(readPrivate(fifo), /regular file/); assert.ok(Date.now() - started < 1000);
  }
});

test('runtime parser rejects ambiguous flags and service environments exclude inherited credentials and Node injection', () => {
  for (const args of [['start', '--workers', '2'], ['setup', '--port', '0x1000'], ['setup', '--json', '--json'], ['start', '--state-dir'], ['stop', '--force']]) assert.throws(() => parse(args));
  assert.deepEqual(runtimeEnvironment({ PATH: '/bin', HOME: '/tmp/home', WERK_ADMIN_TOKEN: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require malicious', PRIVATE_KEY: 'secret' }), { PATH: '/bin', HOME: '/tmp/home' });
});

test('browser opening uses bounded platform commands without a shell or token-bearing URL', async () => {
  for (const [platform, executable] of [['linux', 'xdg-open'], ['darwin', 'open'], ['win32', 'rundll32.exe']]) {
    let called;
    const result = await openBrowser('http://127.0.0.1:3000/', { platform, launch(command, args, options) { called = { command, args, options }; const child = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.emit('close', 0)); return child; } });
    assert.equal(result.opened, true); assert.equal(called.command, executable); assert.equal(called.options.shell, false); assert.ok(called.args.includes('http://127.0.0.1:3000/'));
  }
  let killed = false;
  assert.equal((await openBrowser('http://127.0.0.1:3000/', { timeoutMs: 10, launch() { const child = new EventEmitter(); child.kill = () => { killed = true; }; return child; } })).opened, false);
  assert.equal(killed, true);
  for (const url of ['https://example.com/', 'http://127.0.0.1:3000/#token=secret', 'http://secret@127.0.0.1:3000/']) await assert.rejects(openBrowser(url));
});

test('malformed control authorization cannot crash the supervisor and valid authenticated control still works', async t => {
  const runId = 'a'.repeat(64), controlToken = 'b'.repeat(64); let stops = 0;
  const snapshot = () => ({ runId, state: 'running', project: 'demo', mode: 'mock', url: 'http://127.0.0.1:3000/', workers: [] });
  const server = await createControl({ runId, controlToken, snapshot, stop: () => { stops++; } });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const raw = headers => new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path: '/status', headers }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); req.once('error', reject); req.end(); });
  assert.equal(await raw({ Authorization: 'Bearer ' + 'é'.repeat(64), 'X-Werk-Run': runId }), 401);
  assert.equal(await raw({ Authorization: 'Bearer ' + controlToken, 'X-Werk-Run': 'wrong' }), 401);
  assert.equal(await raw(['Host', '127.0.0.1', 'Authorization', 'Bearer ' + controlToken, 'X-Werk-Run', runId, 'X-Werk-Run', runId]), 401);
  const record = { schemaVersion: 1, runId, controlToken, pid: process.pid, controlPort: port, children: [] };
  assert.equal((await controlRequest(record)).state, 'running'); assert.equal((await controlRequest(record, 'stop')).state, 'stopping'); assert.equal(stops, 1);
});

test('authenticated status and stop preserve mock, live and mixed execution modes', async t => {
  const runId = 'e'.repeat(64), controlToken = 'f'.repeat(64); let mode = 'mock';
  const server = await createControl({ runId, controlToken,
    snapshot: () => ({ runId, state: 'running', project: 'example', mode, url: 'http://127.0.0.1:3000/', workers: [] }), stop() {} });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const record = { schemaVersion: 1, runId, controlToken, pid: process.pid, controlPort: server.address().port, children: [] };
  for (mode of ['mock', 'cli', 'mixed']) {
    assert.equal((await controlRequest(record)).mode, mode);
    assert.equal((await controlRequest(record, 'stop')).mode, mode);
  }
  for (mode of [undefined, 'unknown', { mode: 'cli' }]) await assert.rejects(controlRequest(record), /Invalid supervisor execution mode/);
});

test('stale supervisor metadata refuses PID-based stopping and incomplete startup remains actionable', async t => {
  const stateDir = join(await directory(t), 'state'); await setup({ stateDir });
  await createPrivate(join(stateDir, 'runtime.lock'), { pid: process.pid, runId: 'c'.repeat(64) });
  await assert.rejects(stopRuntime(stateDir, 100), /lock exists/);
  await createPrivate(join(stateDir, 'supervisor.json'), { schemaVersion: 1, runId: 'c'.repeat(64), controlToken: 'd'.repeat(64), pid: process.pid, controlPort: await freePort(), children: [] });
  await assert.rejects(stopRuntime(stateDir, 100), /No stored PID was signalled/);
  assert.ok(await readPrivate(join(stateDir, 'runtime.lock')));
});

test('extracted prebuilt release starts healthy services without npm, survives stop/restart and rejects a second owner', { timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'werk-extracted-')), stateDir = join(root, 'private-state'), children = [];
  try {
    await cp(join(source, 'werk.mjs'), join(root, 'werk.mjs')); await cp(join(source, 'scripts/runtime'), join(root, 'scripts/runtime'), { recursive: true });
    for (const app of ['orchestrator', 'worker']) await cp(join(source, 'src', app, 'dist'), join(root, 'src', app, 'dist'), { recursive: true });
    await assert.rejects(lstat(join(root, 'node_modules')), { code: 'ENOENT' }); await assert.rejects(lstat(join(root, 'package.json')), { code: 'ENOENT' });
    const port = await freePort(); let workerPort = await freePort(); while (workerPort === port) workerPort = await freePort();
    const configured = await cli(root, ['setup', '--state-dir', stateDir, '--project', 'release-test', '--port', String(port), '--worker-port', String(workerPort), '--json']);
    assert.equal(configured.code, 0, configured.stderr); assert.equal(JSON.parse(configured.stdout).created, true);
    const credentials = JSON.parse(await readFile(join(stateDir, 'credentials.json'), 'utf8'));
    let priorIdentity;
    for (let round = 0; round < 2; round++) {
      const owner = launch(root, ['start', '--state-dir', stateDir, '--no-open', '--json']); children.push(owner);
      await until(() => { if (owner.child.exitCode !== null) throw Error(owner.output + owner.errors); return owner.output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.event === 'ready'); }, 'release readiness');
      const status = await cli(root, ['status', '--state-dir', stateDir, '--json']); assert.equal(status.code, 0, status.stdout); assert.equal(JSON.parse(status.stdout).state, 'running');
      const doctor = await cli(root, ['doctor', '--state-dir', stateDir, '--json']); assert.equal(doctor.code, 0, doctor.stdout);
      const identity = JSON.parse(await readFile(join(stateDir, 'workers/worker-1/identity.json'), 'utf8'));
      if (priorIdentity) assert.deepEqual(identity, priorIdentity); priorIdentity = identity;
      if (round === 0) {
        const second = await cli(root, ['start', '--state-dir', stateDir, '--no-open', '--json']); assert.equal(second.code, 2, second.stdout); assert.match(second.stdout, /metadata already exists|lock already exists/);
      }
      // Maintenance authenticates with the independent supervisor capability, so damaged
      // application credentials must not prevent status, browser opening or safe shutdown.
      if (round === 0) await writeFile(join(stateDir, 'credentials.json'), 'private-corrupt-credential-marker', { mode: 0o600 });
      else await rm(join(stateDir, 'credentials.json'));
      const maintenance = await cli(root, ['status', '--state-dir', stateDir, '--json']); assert.equal(maintenance.code, 0, maintenance.stdout);
      const damagedDoctor = await cli(root, ['doctor', '--state-dir', stateDir, '--json']); assert.equal(damagedDoctor.code, 1); assert.ok(!damagedDoctor.stdout.includes('private-corrupt'));
      const opened = [];
      assert.equal(await main(['open', '--state-dir', stateDir, '--json'], { stdout: value => opened.push(JSON.parse(value)), opener: async url => ({ opened: true, url }) }), 0);
      assert.equal(opened[0].url, `http://127.0.0.1:${port}/`);
      const stopped = await cli(root, ['stop', '--state-dir', stateDir, '--json']); assert.equal(stopped.code, 0, stopped.stdout);
      await writeFile(join(stateDir, 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
      const result = await owner.done; assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse((await cli(root, ['status', '--state-dir', stateDir, '--json'])).stdout).state, 'stopped');
      assert.equal(JSON.parse(await readFile(join(stateDir, 'workers/worker-1/status.json'), 'utf8')).state, 'stopped');
      const text = [configured.stdout, owner.output, owner.errors, status.stdout, doctor.stdout, stopped.stdout, await readFile(join(stateDir, 'logs/runtime.jsonl'), 'utf8')].join('\n');
      for (const secret of [...Object.values(credentials), identity.token]) assert.ok(!text.includes(secret), 'credentials must not enter runtime stdout/status/logs');
    }
  } finally {
    for (const owner of children) if (owner.child.exitCode === null) owner.child.kill('SIGTERM');
    await Promise.allSettled(children.map(owner => owner.done)); await rm(root, { recursive: true, force: true });
  }
});

test('failed worker startup drains its owned orchestrator, preserves identity and releases lifecycle metadata', { timeout: 15000 }, async t => {
  const stateDir = join(await directory(t), 'state'), port = await freePort(); let workerPort = await freePort(); while (workerPort === port) workerPort = await freePort();
  await setup({ stateDir, port, workerPort });
  const workerDirectory = join(stateDir, 'workers/worker-1'); await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  const identity = { id: 'previous-worker', project: 'demo', token: 'private-old-worker-token', url: 'http://127.0.0.1:1', configHash: 'old-config' };
  await createPrivate(join(workerDirectory, 'identity.json'), identity);
  const failed = await cli(source, ['start', '--state-dir', stateDir, '--no-open', '--json']);
  assert.equal(failed.code, 1, failed.stdout); assert.match(failed.stdout, /worker exited unexpectedly/);
  assert.ok(!failed.stdout.includes(identity.token)); assert.ok(!failed.stderr.includes(identity.token));
  assert.deepEqual(await readPrivate(join(workerDirectory, 'identity.json')), identity);
  await assert.rejects(lstat(join(stateDir, 'runtime.lock')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(stateDir, 'supervisor.json')), { code: 'ENOENT' });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }));
  await assert.rejects(fetch(`http://127.0.0.1:${workerPort}/healthz`, { signal: AbortSignal.timeout(500) }));
  const logs = (await readFile(join(stateDir, 'logs/runtime.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(logs.some(event => event.event === 'child_exited' && event.role === 'orchestrator'));
});
