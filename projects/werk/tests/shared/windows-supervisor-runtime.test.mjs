import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { launchProcess, runProcess, terminateProcess, ProcessRunError } from '../../src/worker/dist/shared/process/launcher.js';

const skip = process.platform !== 'win32' && 'Native Windows Job Object and .NET executable qualification';
const node = process.execPath;

function collect(child, signal) {
  const stdout = [], stderr = [];
  const stop = () => terminateProcess(child);
  signal.addEventListener('abort', stop, { once: true });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', data => stdout.push(data)); child.stderr.on('data', data => stderr.push(data));
    child.once('error', reject);
    child.once('close', code => {
      signal.removeEventListener('abort', stop);
      resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), executable: child.spawnargs[0] });
    });
  });
}

test('native cold and cached supervisors preserve exact arguments, minimal environment, input, output and exit codes', { skip, timeout: 60000 }, async t => {
  const values = ['', 'space value', '"quoted"', 'trailing\\', 'a\\"b', 'line\nbreak'];
  const script = `let input='';process.stdin.on('data',data=>input+=data).on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(1),input,chosen:process.env.CHOSEN,pathext:process.env.PATHEXT??null,secret:process.env.WERK_TEST_SECRET??null,runtime:Object.fromEntries(['PSModulePath','ProgramFiles','PROCESSOR_ARCHITECTURE'].map(key=>[key,process.env[key]??null]))}));process.stderr.write('only target stderr');process.exitCode=7;});`;
  const previous = process.env.WERK_TEST_SECRET; process.env.WERK_TEST_SECRET = 'must not inherit';
  t.after(() => { if (previous === undefined) delete process.env.WERK_TEST_SECRET; else process.env.WERK_TEST_SECRET = previous; });
  const env = { CHOSEN: 'supplied' };
  const cold = launchProcess(node, ['-e', script, ...values], { env, mode: 'contained' });
  const coldResult = collect(cold, t.signal); cold.stdin.end('small input');
  const before = await coldResult;
  assert.equal(basename(before.executable).toLowerCase(), 'powershell.exe', 'synchronous cold launch keeps the established contained fallback');
  assert.equal(before.code, 7, before.stderr);
  const warmed = await runProcess(node, ['-e', script, ...values], { env, mode: 'contained', input: 'small input', maxOutputBytes: 65536, captureStderr: true, allowNonZeroExit: true, signal: t.signal });
  assert.equal(warmed.exitCode, before.code);
  assert.equal(warmed.stdout.toString(), before.stdout);
  assert.equal(warmed.stderr.toString(), 'only target stderr');
  assert.deepEqual(JSON.parse(before.stdout), { args: values, input: 'small input', chosen: 'supplied', pathext: null, secret: null, runtime: { PSModulePath: null, ProgramFiles: null, PROCESSOR_ARCHITECTURE: null } });
  const children = [1, 2].map(() => launchProcess(node, ['-e', 'console.log(process.pid)'], { env, mode: 'contained' }));
  const results = await Promise.all(children.map(child => { const result = collect(child, t.signal); child.stdin.end(); return result; }));
  assert.equal(basename(results[0].executable).toLowerCase(), 'supervisor.exe', 'warm launches execute the compiled supervisor without another PowerShell compiler');
  assert.equal(results[0].executable, results[1].executable, 'the process-private compiled artifact is reused');
  assert.notEqual(results[0].stdout, results[1].stdout, 'each invocation starts a distinct target process');
  for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); }
});

test('cached supervisors retain separate job ownership and exchange frames before EOF', { skip, timeout: 40000 }, async t => {
  await runProcess(node, ['-e', ''], { env: {}, mode: 'contained', maxOutputBytes: 65536, signal: t.signal });
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log(line));`;
  const children = [1, 2].map(() => launchProcess(node, ['-e', script], { env: {}, mode: 'contained' }));
  const outputs = children.map(child => createInterface({ input: child.stdout }));
  const lines = outputs.map(output => output[Symbol.asyncIterator]());
  const endings = children.map(child => new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }));
  const stop = () => children.forEach(child => terminateProcess(child));
  t.signal.addEventListener('abort', stop, { once: true });
  try {
    children.forEach(child => { assert.equal(basename(child.spawnargs[0]).toLowerCase(), 'supervisor.exe'); child.stdin.write('first frame\n'); });
    for (const reader of lines) assert.deepEqual(await reader.next(), { value: 'first frame', done: false });
    terminateProcess(children[0]); await endings[0];
    children[1].stdin.write('independent survivor\n');
    assert.deepEqual(await lines[1].next(), { value: 'independent survivor', done: false }, 'terminating one job cannot stop another invocation using the same compiled artifact');
    children[1].stdin.end(); assert.equal(await endings[1], 0);
  } finally {
    stop(); outputs.forEach(output => output.close()); await Promise.allSettled(endings);
    t.signal.removeEventListener('abort', stop);
  }
});

test('a cold deadline never dispatches its target and later adequate-budget warmup can succeed', { skip, timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-supervisor-deadline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A distinct module instance provides a cold, process-private cache without a production reset hook.
  const launcherUrl = new URL('../../src/worker/dist/shared/process/launcher.js', import.meta.url);
  launcherUrl.search = 'cold-deadline';
  /** @type {typeof import('../../src/shared/process/launcher.ts')} */
  const fresh = await import(launcherUrl.href);
  const marker = join(directory, 'must-not-exist');
  const target = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'dispatched')`];
  await assert.rejects(fresh.runProcess(node, target, { env: {}, cwd: directory, mode: 'contained', maxOutputBytes: 4096, timeoutMs: 1 }), error => {
    assert.ok(error instanceof fresh.ProcessRunError); assert.equal(error.reason, 'timeout'); assert.equal(error.result.stdout.length, 0); assert.equal(error.result.stderr.length, 0); return true;
  });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assert.rejects(fresh.runProcess(node, target, { env: {}, cwd: directory, mode: 'contained', maxOutputBytes: 4096, signal: AbortSignal.abort() }), { reason: 'cancelled' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await fresh.prepareProcessRuntime(directory, t.signal);
  await fresh.runProcess(node, ['-e', ''], { env: {}, cwd: directory, mode: 'contained', maxOutputBytes: 4096, timeoutMs: 30000, signal: t.signal });
  const child = fresh.launchProcess(node, ['-e', ''], { env: {}, cwd: directory, mode: 'contained' });
  const result = collect(child, t.signal); child.stdin.end();
  const completed = await result;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(basename(completed.executable).toLowerCase(), 'supervisor.exe', 'a cancelled initial warmup does not disable optimization for the worker lifetime');
});

test('invalid target arguments retain typed spawn failures', { skip, timeout: 30000 }, async () => {
  await assert.rejects(runProcess(node, ['invalid\0argument'], { env: {}, mode: 'contained', maxOutputBytes: 4096 }), error => error instanceof ProcessRunError && error.reason === 'spawn');
});


test('a runtime owner survives a short cold command deadline and later probes keep their five-second budget', { skip, timeout: 60000 }, async t => {
  const launcherUrl = new URL('../../src/worker/dist/shared/process/launcher.js', import.meta.url);
  launcherUrl.search = 'owned-preparation';
  /** @type {typeof import('../../src/shared/process/launcher.ts')} */
  const fresh = await import(launcherUrl.href);
  const directory = await mkdtemp(join(tmpdir(), 'werk-supervisor-owner-'));
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, t.signal]);
  const marker = join(directory, 'must-not-dispatch');
  const preparation = fresh.prepareProcessRuntime(directory, signal);
  t.after(async () => { controller.abort(); await preparation.catch(() => {}); await rm(directory, {recursive:true,force:true}); });
  assert.equal(fresh.processRuntimePreparing(), true);
  await assert.rejects(fresh.runProcess(node, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], { cwd: directory, env: {}, mode:'contained', signal, timeoutMs:1, maxOutputBytes:4096 }), error => error instanceof fresh.ProcessRunError && error.reason === 'timeout');
  await assert.rejects(readFile(marker), {code:'ENOENT'});
  assert.equal(fresh.processRuntimePreparing(), true, 'the command deadline cannot cancel the separate runtime owner');
  await preparation;
  assert.equal(fresh.processRuntimePreparing(), false);
  const probe = await fresh.runProcess(node, ['-e', 'console.log("ready")'], { cwd:directory, env:{}, mode:'contained', signal, timeoutMs:5000, maxOutputBytes:4096 });
  assert.equal(probe.stdout.toString().trim(), 'ready');
});
