import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'werk-process-preparation-'));
  const stop = new AbortController(), started = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers(), ready = Promise.withResolvers();
  const events = [];
  let running = Promise.resolve(), endpoint, settled = false, setupSignal, setupCwd;
  const cancel = () => stop.abort(t.signal.reason);
  t.signal.addEventListener('abort', cancel, {once:true});
  if (t.signal.aborted) cancel();
  t.after(async () => {
    stop.abort(); release.resolve();
    try { await running.catch(() => {}); }
    finally { t.signal.removeEventListener('abort', cancel); await rm(stateDir, {recursive:true, force:true}); }
  });
  const config = {...await configuration({'poll-ms':'100','mock-ms':'1',profiles:'codex'}), stateDir, url:'', enrollmentToken:'', statusHost:'127.0.0.1', statusPort:0};
  const prepareProcessRuntime = async (cwd, signal) => {
    setupCwd = cwd; setupSignal = signal; events.push('prepare'); started.resolve();
    const cancelled = () => { events.push('abort'); aborted.resolve(); };
    signal.addEventListener('abort', cancelled, {once:true});
    if (signal.aborted) cancelled();
    try { await release.promise; events.push('drain'); }
    finally { signal.removeEventListener('abort', cancelled); }
  };
  /** @param {import('../../src/worker/runner.ts').WorkerDependencies} [dependencies] */
  function start(dependencies = {}) {
    running = runWorker(config, stop.signal, {
      prepareProcessRuntime, ...dependencies,
      ready:async address => {
        endpoint = 'http://127.0.0.1:' + address.port; events.push('ready'); ready.resolve();
        await dependencies.ready?.(address);
      }
    });
    void running.then(() => { settled = true; events.push('settled'); }, () => { settled = true; events.push('settled'); });
    return running;
  }
  return {stateDir, stop, start, started:started.promise, aborted:aborted.promise, ready:ready.promise, release:() => release.resolve(), events,
    get settled() { return settled; }, get signal() { return setupSignal; }, get cwd() { return setupCwd; }, get endpoint() { return endpoint; }};
}

async function assertStopped(f, signal) {
  await assert.rejects(lstat(join(f.stateDir, 'worker.lock')), {code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'status.json'), 'utf8')).state, 'stopped');
  if (f.endpoint) await assert.rejects(fetch(f.endpoint + '/healthz', {signal:AbortSignal.any([signal, AbortSignal.timeout(1000)])}));
}

test('background runtime preparation allows HTTP readiness and shutdown owns its cancellation and drain', {timeout:15000}, async t => {
  const f = await fixture(t), running = f.start();
  await Promise.all([f.started, f.ready]);
  assert.equal(f.cwd, process.cwd());
  assert.equal(f.signal.aborted, false);
  assert.equal(f.events.includes('drain'), false, 'readiness does not wait for runtime compilation');
  const response = await fetch(f.endpoint + '/healthz', {signal:AbortSignal.any([t.signal, AbortSignal.timeout(1000)])});
  assert.equal(response.status, 200); await response.arrayBuffer();
  f.stop.abort(); await f.aborted;
  assert.equal(f.signal.aborted, true);
  assert.equal(f.settled, false, 'worker completion must retain unfinished preparation ownership');
  assert.equal((await lstat(join(f.stateDir, 'worker.lock'))).isFile(), true);
  f.release(); await running;
  assert.deepEqual(f.events, ['prepare', 'ready', 'abort', 'drain', 'settled']);
  await assertStopped(f, t.signal);
});

test('startup failure aborts and drains background preparation while preserving the startup error', {timeout:15000}, async t => {
  const f = await fixture(t), primary = Error('ready callback failed');
  const running = f.start({ready:async () => { f.events.push('ready failed'); throw primary; }});
  const failed = assert.rejects(running, error => error === primary);
  await f.started; await f.aborted;
  assert.equal(f.stop.signal.aborted, false, 'startup failure itself must cancel the runtime owner');
  assert.equal(f.signal.aborted, true);
  assert.equal(f.settled, false);
  assert.equal((await lstat(join(f.stateDir, 'worker.lock'))).isFile(), true);
  f.release(); await failed;
  assert.deepEqual(f.events, ['prepare', 'ready', 'ready failed', 'abort', 'drain', 'settled']);
  await assertStopped(f, t.signal);
});

test('runtime preparation failure leaves the worker ready to use the contained fallback', {timeout:15000}, async t => {
  const f = await fixture(t), attempted = Promise.withResolvers();
  const running = f.start({prepareProcessRuntime:async () => { attempted.resolve(); throw Error('Compiler unavailable'); }});
  await Promise.all([attempted.promise, f.ready]);
  assert.equal(f.settled, false);
  const response = await fetch(f.endpoint + '/healthz', {signal:AbortSignal.any([t.signal, AbortSignal.timeout(1000)])});
  assert.equal(response.status, 200); await response.arrayBuffer();
  f.stop.abort(); await running;
  await assertStopped(f, t.signal);
});
