import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { launchProcess, ProcessRunError, runProcess, terminateProcess } from '../../src/worker/dist/shared/process/launcher.js';

prepareNativeProcessFixture();

const node = process.execPath;
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const alive = async pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      // A killed orphan may await init's reap; a zombie cannot continue work.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    }
    return true;
  } catch { return false; }
};
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

test('contained processes exchange small frames before stdin closes', { timeout: 20000 }, async t => {
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>process.stdout.write(JSON.stringify({reply:line})+'\\n'));`;
  const child = launchProcess(node, ['-e', script], { env, mode: 'contained' });
  const output = createInterface({ input: child.stdout }), lines = output[Symbol.asyncIterator]();
  const closed = new Promise((resolve, reject) => { child.once('close', code => resolve(code)); child.once('error', reject); });
  // Timeout must stop the supervisor too, so a failed handshake cannot leak a child.
  const stop = () => terminateProcess(child);
  t.signal.addEventListener('abort', stop, { once: true });
  try {
    for (const frame of ['first small request', 'second small request']) {
      child.stdin.write(frame + '\n');
      const response = await lines.next();
      assert.equal(response.done, false, 'the child responds while its input pipe stays open');
      assert.deepEqual(JSON.parse(response.value), { reply: frame });
      assert.equal(child.stdin.writableEnded, false);
    }
    child.stdin.end();
    assert.equal(await closed, 0, 'EOF still permits a normal drained exit');
  } finally {
    output.close(); terminateProcess(child); await closed.catch(() => {});
    t.signal.removeEventListener('abort', stop);
  }
});

test('contained processes report only their own stderr, without supervisor progress records', { timeout: 30000 }, async () => {
  // A minimal environment has no module analysis cache, so Windows PowerShell prepares modules on every launch.
  const minimal = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  for (let run = 0; run < 2; run++) {
    const result = await runProcess(node, ['-e', `console.error('x')`], { env: minimal, mode: 'contained', maxOutputBytes: 65536, captureStderr: true });
    assert.equal(result.stderr.toString(), 'x\n');
    assert.equal(result.stdout.toString(), '');
  }
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
  /** @type {import('../../src/shared/process/launcher.ts').LaunchMode[]} */
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
    for (let i = 0; i < 100 && await alive(grandchild); i++) await delay(50);
    assert.equal(await alive(grandchild), false, `${mode}: grandchild stopped`);
  }
});

for (const inheritPipes of [false, true]) {
  test(`successful POSIX leaders stop descendants with ${inheritPipes ? 'inherited' : 'ignored'} output before completing`, { skip: process.platform === 'win32' && 'POSIX process groups', timeout: 15000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'werk-launcher-exit-'));
    const controller = new AbortController(), pidFile = join(directory, 'grandchild.pid');
    t.after(async () => { controller.abort(); await rm(directory, { recursive: true, force: true }); });
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${JSON.stringify(inheritPipes ? ['ignore', 'inherit', 'inherit'] : 'ignore')}});c.unref();require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.stdout.write('parent completed\\n');`;
    const result = await runProcess(node, ['-e', script], { env, signal: controller.signal, maxOutputBytes: 4096, timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.toString(), 'parent completed\n');
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    assert.ok(grandchild, 'parent started its descendant');
    for (let i = 0; i < 100 && await alive(grandchild); i++) await delay(50);
    assert.equal(await alive(grandchild), false, 'descendant stopped after successful parent exit');
  });
}

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
