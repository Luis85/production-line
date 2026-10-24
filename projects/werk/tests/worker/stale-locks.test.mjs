import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { ownerRecord, processHost } from '../../src/worker/dist/shared/process/owner.js';

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return child.pid;
}
async function directory(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-stale-lock-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const check = pid => `Confirm PID ${pid} is not running (Windows: Get-Process -Id ${pid}; POSIX: ps -p ${pid}).`;

test('a feature folder lock left by a dead worker is reclaimed; a live owner is refused with its lock and PID', { timeout: 60000 }, async t => {
  const root = await directory(t), features = join(root, 'features'), lock = join(features, '_worker.lock');
  const folder = () => new MarkdownFeatureFolder(features, join(root, 'state'), 'codex-cli', root);
  const first = folder(); await first.open('owner'); await first.close();
  const dead = await exitedPid();
  await writeFile(lock, JSON.stringify({ pid: dead, host: processHost, owner: 'owner' }) + '\n');
  const reclaimed = folder(); await reclaimed.open('owner');
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), { ...ownerRecord, owner: 'owner' });
  await assert.rejects(folder().open('owner'), error => error instanceof Error && error.message === `Feature folder is locked. Stop its other worker; after a crash verify the process is stopped before removing _worker.lock. Lock: ${lock}; recorded PID: ${process.pid}. ${check(process.pid)}`);
  await reclaimed.close();
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
});

test('a state lock left by a dead worker is reclaimed and recorded as JSON; a live owner is refused', { timeout: 60000 }, async t => {
  const stateDir = await directory(t), lock = join(stateDir, 'worker.lock');
  const config = { ...await configuration({}), stateDir, url: '', enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 };
  await writeFile(lock, JSON.stringify(ownerRecord));
  await assert.rejects(runWorker(config, new AbortController().signal), error => error instanceof Error && error.message === `State directory is locked. After a crash, verify the old process is stopped before deleting worker.lock. Lock: ${lock}; recorded PID: ${process.pid}. ${check(process.pid)}`);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
  await writeFile(lock, JSON.stringify({ pid: await exitedPid(), host: processHost }));
  const stop = new AbortController(), recorded = { text: '' };
  await runWorker(config, stop.signal, { ready: async () => { recorded.text = await readFile(lock, 'utf8'); stop.abort(); } });
  const owner = JSON.parse(recorded.text);
  assert.deepEqual({ ...owner, startedAt: undefined }, { ...ownerRecord, startedAt: undefined }); assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
});
