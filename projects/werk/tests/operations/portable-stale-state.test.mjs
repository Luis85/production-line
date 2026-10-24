import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivate, privateDirectory } from '../../scripts/runtime/config.mjs';
import { start, status, stop } from '../../scripts/runtime/portable/lifecycle.mjs';
import { recoverStale } from '../../scripts/runtime/portable/stale-state.mjs';
import { ownWorkspace, removeWorkspace } from '../helpers/workspace-processes.mjs';
import { ownerRecord, processHost } from '../../src/worker/dist/shared/process/owner.js';

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return child.pid;
}
async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  await new Promise(resolve => server.close(() => resolve(undefined)));
  assert.ok(address && typeof address === 'object');
  return address.port;
}
/** A project worker whose state, lock and feature folder lock were left by `pid` on `host`. */
async function fixture(t, pid, host = processHost) {
  const start = pid === process.pid ? ownerRecord.start : null;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-stale-'))), project = join(root, 'project'), state = join(project, '.werk/worker');
  t.after(() => removeWorkspace(root));
  await privateDirectory(state); await mkdir(join(project, 'requests'));
  await createPrivate(join(project, '.werk/worker-project.json'), { schemaVersion: 1, port: 4100 });
  await createPrivate(join(project, '.werk/worker.json'), { schemaVersion: 1, features: { directory: 'requests' } });
  const files = { record: join(state, 'portable.json'), lock: join(state, 'worker.lock'), feature: join(project, 'requests/_worker.lock') };
  await createPrivate(files.record, { schemaVersion: 1, kind: 'worker', runId: 'a'.repeat(64), controlToken: 'b'.repeat(64), pid, host, start, controlPort: await unusedPort(), children: [], url: 'http://127.0.0.1:4100' });
  await createPrivate(files.lock, { pid, host, start, startedAt: new Date().toISOString() });
  await writeFile(files.feature, JSON.stringify({ pid, host, start, owner: 'owner' }) + '\n', { mode: 0o600 });
  return { root, project, state, files, options: { 'project-dir': project } };
}
const missing = path => assert.rejects(readFile(path), { code: 'ENOENT' });

test('a dead owner is reported as stale and start removes exactly its files before launching', { timeout: 120000 }, async t => {
  const dead = await exitedPid(), f = await fixture(t, dead);
  const stale = await status('worker', f.state, f.options);
  assert.equal(stale.state, 'stale'); assert.equal(stale.pid, dead);
  assert.deepEqual(stale.files, [f.files.record, f.files.lock, f.files.feature]);
  assert.match(stale.action, new RegExp(`PID ${dead}\\b.*no longer running`));
  // A stub app answers the launch handshake, so no worker outlives the test.
  const app = join(f.root, 'app'); await mkdir(app); await ownWorkspace(t, f.root);
  await writeFile(join(app, 'cli.mjs'), "process.send({ ok: true, data: { state: 'running', stub: true } }); process.once('disconnect', () => process.exit(0)); setTimeout(() => process.exit(1), 20000);\n");
  const logged = t.mock.method(console, 'error', () => {});
  assert.deepEqual(await start('worker', f.state, app, [], f.options), { state: 'running', stub: true });
  for (const path of Object.values(f.files)) await missing(path);
  const event = JSON.parse(logged.mock.calls[0].arguments[0]);
  assert.deepEqual(event, { event: 'stale_state_recovered', pid: dead, removed: stale.files, reason: `PID ${dead} is no longer running.` });
});

test('a lock without control metadata naming a dead PID is recovered by stop; a lock of another owner is kept', { timeout: 60000 }, async t => {
  const dead = await exitedPid(), f = await fixture(t, dead);
  await removeWorkspace(f.files.record);
  await writeFile(f.files.feature, JSON.stringify({ ...ownerRecord, owner: 'owner' }) + '\n', { mode: 0o600 });
  const stale = await status('worker', f.state, f.options);
  assert.equal(stale.state, 'stale'); assert.deepEqual(stale.files, [f.files.lock]);
  t.mock.method(console, 'error', () => {});
  assert.deepEqual(await stop('worker', f.state, f.options), { state: 'stopped', kind: 'worker', stateDirectory: f.state, recovered: [f.files.lock] });
  await missing(f.files.lock); assert.ok(await readFile(f.files.feature));
});

test('a live or unrecorded owner stays unreachable with its files and a concrete check', { timeout: 60000 }, async t => {
  const f = await fixture(t, process.pid);
  const live = await status('worker', f.state, f.options);
  assert.equal(live.state, 'unreachable'); assert.deepEqual(live.files, [f.files.record, f.files.lock]);
  assert.ok(live.action.startsWith('Control identity could not be verified.'));
  assert.ok(live.action.includes(f.files.record) && live.action.includes(f.files.lock));
  assert.ok(live.action.endsWith(`Confirm PID ${process.pid} is not running (Windows: Get-Process -Id ${process.pid}; POSIX: ps -p ${process.pid}).`));
  await assert.rejects(stop('worker', f.state, f.options), error => error instanceof Error && error.message === live.action);
  for (const path of Object.values(f.files)) assert.ok(await readFile(path));
  // An empty lock (startup between create and write) proves nothing.
  await removeWorkspace(f.files.record); await writeFile(f.files.lock, '');
  const starting = await status('worker', f.state, f.options);
  assert.equal(starting.state, 'unreachable'); assert.equal(starting.pid, undefined);
  assert.equal(starting.action, `Startup may be in progress. After a crash, verify the old process has exited before removing its lock. Files: ${f.files.lock}.`);
});

test('a PID recorded in a container or on another host never proves the owner dead', { timeout: 60000 }, async t => {
  const dead = await exitedPid(), f = await fixture(t, dead, 'container-1 pid:[4026532000]');
  const foreign = await status('worker', f.state, f.options);
  assert.equal(foreign.state, 'unreachable'); assert.equal(foreign.pid, dead);
  assert.ok(foreign.action.endsWith(`PID ${dead} was recorded on container-1 pid:[4026532000], not on this host (${processHost}). If this machine was renamed or the worker runs in Docker (docker compose ps), verify that process has exited before removing the listed files.`));
  await assert.rejects(stop('worker', f.state, f.options), error => error instanceof Error && error.message === foreign.action);
  for (const path of Object.values(f.files)) assert.ok(await readFile(path));
});

test('each listed file is proven dead on its own, and recovery keeps a file a live owner wrote meanwhile', { timeout: 60000 }, async t => {
  const dead = await exitedPid(), f = await fixture(t, dead);
  // A lock left by another dead process (for example a crashed update apply) is stale in its own right.
  await writeFile(f.files.lock, JSON.stringify({ maintenance: 'update', pid: await exitedPid(), host: processHost }));
  const stale = await status('worker', f.state, f.options);
  assert.equal(stale.state, 'stale'); assert.deepEqual(stale.files, [f.files.record, f.files.lock, f.files.feature]);
  // A live owner replaces the lock between status and recovery: it is kept and nothing is logged for it.
  await writeFile(f.files.lock, JSON.stringify(ownerRecord));
  const logged = t.mock.method(console, 'error', () => {});
  await assert.rejects(recoverStale(stale), { message: `${f.files.lock} changed during recovery. Inspect status before retrying.` });
  assert.equal(await readFile(f.files.lock, 'utf8'), JSON.stringify(ownerRecord)); assert.ok(await readFile(f.files.feature));
  assert.equal(logged.mock.callCount(), 0);
  assert.equal((await status('worker', f.state, f.options)).state, 'unreachable');
  // Nothing left to remove logs nothing.
  assert.deepEqual(await recoverStale({ ...stale, files: [join(f.root, 'absent.lock')] }), []); assert.equal(logged.mock.callCount(), 0);
});
