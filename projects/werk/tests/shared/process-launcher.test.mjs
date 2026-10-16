import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { launchProcess, ProcessRunError, runProcess, terminateProcess } from '../../src/worker/dist/shared/process/launcher.js';

const node = process.execPath;
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const rejectsWith = (operation, reason) => assert.rejects(operation, error => error instanceof ProcessRunError && error.reason === reason);

test('runs with exactly the supplied environment and input, capturing stdout by default', async () => {
  const previous = process.env.WERK_LAUNCHER_SECRET; process.env.WERK_LAUNCHER_SECRET = 'private';
  try {
    const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({input:s,secret:process.env.WERK_LAUNCHER_SECRET??null,chosen:process.env.CHOSEN}));process.stderr.write('diagnostic');});`;
    const result = await runProcess(node, ['-e', script], { env: { ...env, CHOSEN: 'yes' }, input: 'hello', maxOutputBytes: 4096 });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout.toString()), { input: 'hello', secret: null, chosen: 'yes' });
    assert.equal(result.stderr.length, 0);
  } finally { if (previous === undefined) delete process.env.WERK_LAUNCHER_SECRET; else process.env.WERK_LAUNCHER_SECRET = previous; }
});

test('nonzero exits reject with captured output unless explicitly allowed', async () => {
  const script = `process.stdout.write('partial');process.stderr.write('why');process.exitCode=7;`;
  await assert.rejects(runProcess(node, ['-e', script], { env, maxOutputBytes: 4096 }), error => {
    assert.ok(error instanceof ProcessRunError); assert.equal(error.reason, 'exit');
    assert.equal(error.result.exitCode, 7); assert.equal(error.result.stdout.toString(), 'partial'); return true;
  });
  const allowed = await runProcess(node, ['-e', script], { env, maxOutputBytes: 4096, captureStderr: true, allowNonZeroExit: true });
  assert.equal(allowed.exitCode, 7); assert.equal(allowed.stderr.toString(), 'why');
});

test('deadlines, cancellation, output limits and missing executables are typed failures', { timeout: 30000 }, async () => {
  const hang = ['-e', 'setInterval(()=>{},1000)'];
  await rejectsWith(runProcess(node, hang, { env, maxOutputBytes: 4096, timeoutMs: 200, graceMs: 0 }), 'timeout');
  const controller = new AbortController(); setTimeout(() => controller.abort(), 200);
  await rejectsWith(runProcess(node, hang, { env, maxOutputBytes: 4096, signal: controller.signal }), 'cancelled');
  await rejectsWith(runProcess(node, hang, { env, maxOutputBytes: 4096, signal: AbortSignal.abort() }), 'cancelled');
  await rejectsWith(runProcess(node, ['-e', `process.stderr.write('x'.repeat(10000));setInterval(()=>{},1000)`], { env, maxOutputBytes: 4096 }), 'output_limit');
  await rejectsWith(runProcess(join(tmpdir(), 'werk-missing-executable'), [], { env, maxOutputBytes: 4096 }), 'spawn');
  assert.throws(() => launchProcess(node, ['a\0b'], { env }), /cannot contain NUL/);
});

test('cancellation stops descendants of a plain launch on POSIX and of a contained launch everywhere', { timeout: 40000 }, async t => {
  const modes = process.platform === 'win32' ? ['contained'] : ['plain', 'contained'];
  for (const mode of modes) {
    const directory = await mkdtemp(join(tmpdir(), 'werk-launcher-tree-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const pidFile = join(directory, 'grandchild.pid');
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const running = runProcess(node, ['-e', script], { env, mode, maxOutputBytes: 4096, signal: controller.signal });
    let grandchild;
    for (let i = 0; i < 200 && !grandchild; i++) { await delay(50); grandchild = Number(await readFile(pidFile, 'utf8').catch(() => '')) || undefined; }
    assert.ok(grandchild, `${mode}: grandchild started`);
    controller.abort();
    await rejectsWith(running, 'cancelled');
    for (let i = 0; i < 100 && alive(grandchild); i++) await delay(50);
    assert.equal(alive(grandchild), false, `${mode}: grandchild stopped`);
  }
});

test('plain launches lead a POSIX process group and terminate cleanly', async () => {
  const child = launchProcess(node, ['-e', 'setInterval(()=>{},1000)'], { env });
  try {
    assert.equal(child.spawnargs[0], node);
    if (process.platform !== 'win32') {
      // A detached POSIX child leads its own group, so signalling -pid reaches it.
      assert.doesNotThrow(() => process.kill(-child.pid, 0));
    }
  } finally {
    terminateProcess(child);
    await new Promise(resolve => child.once('close', resolve));
  }
});
