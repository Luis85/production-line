import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ownWorkspace, processesUnder, processIsRunning as alive, removeWorkspace, terminateProcessesUnder } from '../helpers/workspace-processes.mjs';

// Fixture cleanup for tests that start detached portable workers: only processes whose
// command line names the owned temporary workspace are terminated.
const watchdog = fileURLToPath(new URL('../helpers/workspace-watchdog.mjs', import.meta.url));
async function eventually(check, message, timeout = 30000) {
  for (const end = Date.now() + timeout; Date.now() < end; await delay(200)) if (await check()) return;
  assert.fail(message);
}
async function workspace(label) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `werk ${label} `)));
  await writeFile(join(directory, 'idle.cjs'), 'setInterval(() => {}, 1000);\n');
  return directory;
}
// Like portable start: a detached process whose launching parent is not the test.
function detachedFrom(directory) {
  const child = spawn(process.execPath, [join(directory, 'idle.cjs')], { cwd: directory, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref(); return child.pid;
}

test('cleanup terminates detached processes started from the workspace and then removes it', { timeout: 120000 }, async t => {
  const directory = await workspace('process cleanup'), other = await workspace('process unrelated');
  t.after(async () => { await terminateProcessesUnder(directory); await terminateProcessesUnder(other); await removeWorkspace(directory); await removeWorkspace(other); });
  const pid = detachedFrom(directory), unrelated = detachedFrom(other);
  await eventually(async () => (await processesUnder(directory)).includes(pid), 'the detached process is found by its command line');
  assert.deepEqual(await terminateProcessesUnder(directory), [pid]);
  assert.equal(alive(pid), false);
  assert.equal(alive(unrelated), true, 'processes from another directory are never signalled');
  await removeWorkspace(directory);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('owned workspaces stop through the supplied command before removal', { timeout: 120000 }, async t => {
  const directory = await workspace('process owned'), calls = [];
  await t.test('fixture', async child => {
    await ownWorkspace(child, directory, async () => { calls.push('stop'); throw Error('stop failures do not skip termination'); });
    detachedFrom(directory);
  });
  assert.deepEqual(calls, ['stop']);
  await assert.rejects(access(directory), { code: 'ENOENT' });
  assert.deepEqual(await processesUnder(directory), []);
});

test('the guard cleans up when the test process dies before its after hooks run', { timeout: 120000 }, async t => {
  const directory = await workspace('process guard');
  t.after(async () => { await terminateProcessesUnder(directory); await removeWorkspace(directory); });
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const launched = spawn(process.execPath, [watchdog, 'launch', String(owner.pid), directory], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let guard = ''; launched.stdout.on('data', part => guard += part);
  await new Promise(resolve => launched.once('close', resolve));
  assert.ok(Number(guard) > 0, 'the launcher reports its detached guard');
  const worker = detachedFrom(directory);
  await delay(1500);
  assert.equal(alive(worker), true, 'the guard waits while its owner is alive');
  owner.kill('SIGKILL');
  await eventually(async () => !alive(worker) && !alive(Number(guard)), 'the guard terminated the workspace processes and exited');
  await eventually(async () => access(directory).then(() => false, () => true), 'the guard removed the workspace');
});

test('owned workspaces fail explicitly and clean up when the detached guard cannot start', { timeout: 120000 }, async t => {
  const directory = await workspace('process launch failure');
  t.after(async () => { await terminateProcessesUnder(directory); await removeWorkspace(directory); });
  const worker = detachedFrom(directory);
  await t.test('failed launch fixture', async child => {
    const prior = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = '--invalid-werk-fixture-option';
      await assert.rejects(ownWorkspace(child, directory), /Could not start workspace cleanup guard/);
    } finally {
      if (prior === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prior;
    }
  });
  assert.equal(alive(worker), false, 'the registered teardown owns processes even after launcher failure');
  assert.deepEqual(await processesUnder(directory), []);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
