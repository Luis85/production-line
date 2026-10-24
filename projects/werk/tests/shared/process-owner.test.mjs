import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockOwner, ownerRecord, processHost, processOwnerState } from '../../src/worker/dist/shared/process/owner.js';
import { createLock } from '../../src/worker/dist/shared/process/lock.js';

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return child.pid;
}
const check = pid => `Confirm PID ${pid} is not running (Windows: Get-Process -Id ${pid}; POSIX: ps -p ${pid}).`;

test('an exited process is dead and the current process is alive by its recorded start identity', async () => {
  assert.equal(await processOwnerState(await exitedPid(), ownerRecord.start), 'dead');
  assert.equal(await processOwnerState(await exitedPid(), null), 'dead');
  assert.ok(ownerRecord.start !== null, 'this platform records a start identity');
  // The platform reader returns the identity this process recorded for itself.
  assert.equal(await processOwnerState(process.pid, ownerRecord.start), 'alive');
  assert.equal(await processOwnerState(process.pid, null), 'alive');
});

test('a PID whose start identity differs from the record is reused, never the recorded owner', async () => {
  const start = Date.now() - 60000;
  assert.equal(await processOwnerState(process.pid, start, async () => start + 60000), 'dead');
  assert.equal(await processOwnerState(process.pid, start, async () => start - 10001), 'dead');
  // Clock steps within the tolerance and an unreadable identity never prove death.
  assert.equal(await processOwnerState(process.pid, start, async () => start + 10000), 'alive');
  assert.equal(await processOwnerState(process.pid, start, async () => undefined), 'alive');
  // Linux identities (boot and start ticks) match exactly; another boot or start is another process.
  const linux = 'linux:6b1d1c3e-1111-4c2d-9f00-000000000000:4242';
  assert.equal(await processOwnerState(process.pid, linux, async () => linux), 'alive');
  assert.equal(await processOwnerState(process.pid, linux, async () => 'linux:6b1d1c3e-1111-4c2d-9f00-000000000000:4243'), 'dead');
  assert.equal(await processOwnerState(process.pid, linux, async () => 'linux:7c2e2d4f-2222-4c2d-9f00-000000000000:4242'), 'dead');
  // A real platform read of this process never matches an identity recorded a minute earlier.
  const earlier = typeof ownerRecord.start === 'number' ? ownerRecord.start - 60000 : String(ownerRecord.start).replace(/\d+$/, ticks => String(Number(ticks) + 1));
  assert.equal(await processOwnerState(process.pid, earlier), 'dead');
});

test('an invalid PID proves nothing', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) assert.equal(await processOwnerState(pid, Date.now()), 'unknown');
});

test('a lock is reclaimed from a dead owner only while it still names the checked PID', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-owner-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.lock'), dead = await exitedPid(), locked = 'Locked.';
  await writeFile(path, JSON.stringify({ pid: dead, host: processHost, start: ownerRecord.start }));
  assert.equal((await lockOwner(path)).pid, dead);
  await (await createLock(path, locked)).close();
  assert.equal(await readFile(path, 'utf8'), '');
  // A new owner that replaces the lock between check and removal keeps it.
  await writeFile(path, JSON.stringify({ pid: dead, host: processHost }));
  const replaced = JSON.stringify(ownerRecord);
  await assert.rejects(createLock(path, locked, async () => { await writeFile(path, replaced); return 'dead'; }), { message: `${locked} Lock: ${path}; recorded PID: ${process.pid}. ${check(process.pid)}` });
  assert.equal(await readFile(path, 'utf8'), replaced);
  await assert.rejects(createLock(path, locked), { message: `${locked} Lock: ${path}; recorded PID: ${process.pid}. ${check(process.pid)}` });
  // A lock without this host's identity, or from a container or another machine, is never reclaimed.
  for (const [host, detail] of [[undefined, check(dead)], ['container-1', `PID ${dead} was recorded on container-1, not on this host (${processHost}). If this machine was renamed or the worker runs in Docker (docker compose ps), verify that process has exited before removing the listed files.`]]) {
    const content = JSON.stringify({ pid: dead, host });
    await writeFile(path, content);
    await assert.rejects(createLock(path, locked), { message: `${locked} Lock: ${path}; recorded PID: ${dead}. ${detail}` });
    assert.equal(await readFile(path, 'utf8'), content);
  }
  for (const content of ['', String(dead), '{"pid":"1"}']) {
    await writeFile(path, content);
    await assert.rejects(createLock(path, locked), { message: `${locked} Lock: ${path}; recorded PID: none.` });
    assert.equal(await readFile(path, 'utf8'), content);
  }
});
