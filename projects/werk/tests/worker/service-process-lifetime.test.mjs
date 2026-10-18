import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedServiceWait, createServiceProcessLifetime } from './service-process-lifetime.mjs';

const fakeChild = () => Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });

test('fixture drain terminates its captured child while an independently owned ambient process stays alive', { timeout: 30000 }, async t => {
  const owned = createServiceProcessLifetime(t.signal), external = createServiceProcessLifetime(t.signal);
  t.after(async () => { try { await owned.close(); } finally { await external.close(); } });
  const spawnIdle = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const child = owned.own(spawnIdle()), ambient = external.own(spawnIdle());
  await Promise.all([once(child, 'spawn'), once(ambient, 'spawn')]);
  await owned.close();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(ambient.exitCode, null); assert.equal(ambient.signalCode, null);
  assert.doesNotThrow(() => process.kill(ambient.pid, 0), 'Only the captured fixture child may be terminated.');
});

test('unconfirmed close fails within the cleanup bound and releasing pipes cannot turn it into a receipt', async t => {
  const lifetime = createServiceProcessLifetime(t.signal, 25), child = fakeChild(), signalled = [];
  lifetime.own(child, target => signalled.push(target));
  const failure = await lifetime.close().then(() => undefined, error => error);
  assert.match(failure.message, /Owned fixture cleanup did not settle/);
  assert.deepEqual(signalled, [child]);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
  child.emit('close', null, 'SIGKILL');
  assert.match(failure.message, /did not settle/, 'A later close cannot rewrite the already observed cleanup failure.');
});

test('late ownership after cancellation forces only its still-live child and never signals an exited leader', async () => {
  const controller = new AbortController(); controller.abort();
  const lifetime = createServiceProcessLifetime(controller.signal, 25), live = fakeChild(), exited = fakeChild(), signalled = [];
  Object.assign(exited, { exitCode: 0 });
  lifetime.own(exited, target => signalled.push(target));
  lifetime.own(live, target => { signalled.push(target); Object.assign(target, { signalCode: 'SIGKILL' }); queueMicrotask(() => target.emit('close', null, 'SIGKILL')); });
  exited.emit('close', 0, null);
  await lifetime.close(); assert.deepEqual(signalled, [live]);
});

test('a stalled cleanup reports failure without pinning the runner or hiding the next file', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-service-lifetime-')), lifetime = createServiceProcessLifetime(t.signal);
  t.after(async () => { try { await lifetime.close(); } finally { await boundedServiceWait(rm(directory, { recursive: true, force: true }), 'Regression fixture removal', 2000); } });
  const helper = new URL('./service-process-lifetime.mjs', import.meta.url).href;
  await writeFile(join(directory, 'a.test.mjs'), `import test from 'node:test';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { boundedServiceWait, createServiceProcessLifetime } from ${JSON.stringify(helper)};
test('stalled fixture cleanup', {timeout:5000}, t => {
  const lifetime = createServiceProcessLifetime(t.signal, 30);
  const child = Object.assign(new ChildProcess(), {stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  lifetime.own(child, value => { if(value !== child) throw Error('Wrong fixture child'); });
  t.after(async () => { const errors=[]; try { await boundedServiceWait(new Promise(()=>{}), 'Supervisor fixture cleanup', 30); } catch(error) { errors.push(error); } finally { try { await lifetime.close(); } catch(error) { errors.push(error); } } throw new AggregateError(errors,'Bounded fixture cleanup failed'); });
});
`);
  await writeFile(join(directory, 'b.test.mjs'), "import test from 'node:test'; test('later file remains reportable',()=>{});\n");
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const child = lifetime.own(spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=2', join(directory, 'a.test.mjs'), join(directory, 'b.test.mjs')], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  await lifetime.closed(child);
  assert.equal(child.exitCode, 1, output);
  assert.match(output, /stalled fixture cleanup/); assert.match(output, /Bounded fixture cleanup failed/);
  assert.match(output, /later file remains reportable/); assert.match(output, /tests 2/);
});
