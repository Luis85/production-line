import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockOwner, processHost, processOwnerState } from '../../src/worker/dist/shared/process/owner.js';
import { createLock } from '../../src/worker/dist/shared/process/lock.js';

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return child.pid;
}
const check = pid => `Confirm PID ${pid} is not running (Windows: Get-Process -Id ${pid}; POSIX: ps -p ${pid}).`;

test('an exited process is dead and the current process is alive', async () => {
  assert.equal(await processOwnerState(await exitedPid(), Date.now()), 'dead');
  assert.equal(await processOwnerState(process.pid, new Date()), 'alive');
});

test('a PID started after the record was written is a reused PID, never the recorded owner', async () => {
  const since = Date.now() - 60000;
  assert.equal(await processOwnerState(process.pid, since, async () => Date.now()), 'dead');
  // Coarse platform clocks never prove reuse within their tolerance, and an unreadable start never proves death.
  assert.equal(await processOwnerState(process.pid, since, async () => since + 1000), 'alive');
  assert.equal(await processOwnerState(process.pid, since, async () => undefined), 'alive');
  // The platform reader sees this process start well after a record written ten seconds before it.
  assert.equal(await processOwnerState(process.pid, Date.now() - process.uptime() * 1000 - 10000), 'dead');
});

test('an invalid PID proves nothing', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) assert.equal(await processOwnerState(pid, Date.now()), 'unknown');
});

test('a lock is reclaimed from a dead owner only while it still names the checked PID', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-owner-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.lock'), dead = await exitedPid(), locked = 'Locked.';
  await writeFile(path, JSON.stringify({ pid: dead, host: processHost, startedAt: new Date().toISOString() }));
  assert.equal((await lockOwner(path)).pid, dead);
  await (await createLock(path, locked)).close();
  assert.equal(await readFile(path, 'utf8'), '');
  // A new owner that replaces the lock between check and removal keeps it.
  await writeFile(path, JSON.stringify({ pid: dead, host: processHost }));
  const replaced = JSON.stringify({ pid: process.pid, host: processHost });
  await assert.rejects(createLock(path, locked, async () => { await writeFile(path, replaced); return 'dead'; }), { message: `${locked} Lock: ${path}; recorded PID: ${process.pid}. ${check(process.pid)}` });
  assert.equal(await readFile(path, 'utf8'), replaced);
  await assert.rejects(createLock(path, locked), { message: `${locked} Lock: ${path}; recorded PID: ${process.pid}. ${check(process.pid)}` });
  // A lock without this host's identity, or from a container or another machine, is never reclaimed.
  for (const [host, detail] of [[undefined, check(dead)], ['container-1', `PID ${dead} was recorded on container-1, not this host: confirm it is not running there (for a container: docker compose ps).`]]) {
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
