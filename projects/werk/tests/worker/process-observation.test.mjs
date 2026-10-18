import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessObservation } from '../../src/worker/dist/worker/infrastructure/process-observation.js';
import { launchProcess, runProcess, terminateProcess, ProcessRunError } from '../../src/worker/dist/shared/process/launcher.js';
import { withProcessObserver } from '../../src/worker/dist/shared/process/observation.js';
import { runApprovedToolProcess } from '../../src/worker/dist/worker/infrastructure/tool-process.js';
import { providerCommand, runProviderProbe } from '../../src/worker/dist/worker/infrastructure/provider-process.js';

const node = process.execPath, env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
const known = () => ({ scope: /** @type {const} */ ('owned_service_process_group'), platform: process.platform,
  capturedAt: new Date().toISOString(), cpuTotalMicros: 7, rssBytes: 11, processCount: 1, coverage: /** @type {const} */ ('complete_group'), unavailableReason: null });
const identity = { featureRequestKey: 'fr-1', sessionId: 'session-1', taskId: 'task-1', runId: 'run-1' };
async function held(t, registry, context = identity, options = {}) {
  const child = registry.run(context, () => launchProcess(node, ['-e', "process.stdout.write('ready');process.stdin.resume()"], { env, ...options }));
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (options.processGroup === 'inherit') child.kill('SIGKILL'); else terminateProcess(child); await closed; });
  await once(child.stdout, 'data');
  return { child, closed, finish: async () => { child.stdin.end(); await closed; } };
}

test('concurrent worker scopes inherit isolated identities and never expose command details', async t => {
  const a = createProcessObservation({ sampleGroup: async () => known() });
  const b = createProcessObservation({ sampleGroup: async () => known() });
  const [first, second] = await Promise.all([
    held(t, a, identity, { env: { ...env, SECRET: 'private-environment' } }),
    held(t, b, { ...identity, taskId: 'task-2', runId: 'run-2' }),
  ]);
  const sa = await a.status(), sb = await b.status();
  assert.equal(sa.processes.length, 1); assert.equal(sb.processes.length, 1);
  assert.equal(sa.processes[0].taskId, 'task-1'); assert.equal(sb.processes[0].taskId, 'task-2');
  assert.notEqual(sa.processes[0].id, sb.processes[0].id);
  const encoded = JSON.stringify(sa);
  for (const privateText of ['private-environment', 'process.stdout.write', 'spawnargs', '"pid"', '"env"', '"cwd"', '"stdout"']) assert.ok(!encoded.includes(privateText));
  assert.equal(sa.processes[0].state, 'running');
  sa.processes[0].label = 'changed returned snapshot';
  assert.notEqual((await a.status()).processes[0].label, sa.processes[0].label);
  await first.finish(); await second.finish();
  const ended = await a.status();
  assert.equal(ended.processes[0].state, 'exited'); assert.equal(ended.processes[0].exitCode, 0);
  assert.ok(ended.processes[0].endedAt);
  assert.deepEqual(ended.summary, { active: 0, total: 1, activeGroups: 0, measuredGroups: 0, rssBytes: 0, cpuTotalMicros: 0, coverage: 'complete' });
  assert.equal((await createProcessObservation().status()).summary.total, 0, 'restart does not revive stored PIDs');
});

test('async nested contexts restore the parent and capture identity before caller mutation', async () => {
  const outer = createProcessObservation(), inner = createProcessObservation();
  const context = { ...identity };
  const task = outer.run(context, async () => {
    await delay(5);
    await inner.run({ ...identity, runId: 'inner' }, () => runProcess(node, ['-e', ''], { env, maxOutputBytes: 1024 }));
    await runProcess(node, ['-e', ''], { env, maxOutputBytes: 1024 });
  });
  context.runId = 'mutated';
  await task;
  assert.deepEqual((await outer.status()).processes.map(p => p.runId), ['run-1']);
  assert.deepEqual((await inner.status()).processes.map(p => p.runId), ['inner']);
  await runProcess(node, ['-e', ''], { env, maxOutputBytes: 1024 });
  assert.equal((await outer.status()).summary.total, 1, 'launch outside run is not captured');
});

test('provider and tool purposes override inherited label while probes and explicit ignores stay absent', async () => {
  const registry = createProcessObservation();
  await registry.run({ ...identity, kind: 'other', label: 'Parent scope' }, async () => {
    await runApprovedToolProcess(node, ['-e', ''], { cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 5000, maxOutputBytes: 1024 });
    await providerCommand(node, ['-e', ''], process.cwd(), new AbortController().signal);
    await runProviderProbe(node, 'codex', ['--version'], { signal: new AbortController().signal, timeoutMs: 5000, maxOutputBytes: 1024 });
    await runProcess(node, ['-e', ''], { env, maxOutputBytes: 1024, observation: 'ignore' });
  });
  const records = (await registry.status()).processes;
  assert.deepEqual(records.map(p => p.kind), ['tool', 'provider']);
  assert.deepEqual(records.map(p => p.label), ['Approved command', 'Model provider']);
  assert.ok(records.every(p => p.featureRequestKey === identity.featureRequestKey));
});

test('sampling provides group totals with explicit partial and unknown coverage', { skip: process.platform === 'win32' && 'POSIX group attribution' }, async t => {
  let firstPid;
  const registry = createProcessObservation({ sampleGroup: async pid => {
    firstPid ??= pid;
    if (pid !== firstPid) throw Error('private operating-system details');
    return known();
  } });
  const first = await held(t, registry), second = await held(t, registry);
  const status = await registry.status();
  assert.deepEqual(status.summary, { active: 2, total: 2, activeGroups: 2, measuredGroups: 1, rssBytes: 11, cpuTotalMicros: 7, coverage: 'partial' });
  assert.equal(status.processes[0].measurement.scope, 'owned_execution_process_group');
  assert.equal(status.processes[1].measurement.rssBytes, null);
  assert.ok(!JSON.stringify(status).includes('private operating-system details'));
  await first.finish();
  assert.equal((await registry.status()).summary.coverage, 'unavailable');
  assert.equal((await registry.status()).summary.rssBytes, null);
  await second.finish();
});

test('unavailable numeric evidence never becomes zero and inherited groups are not double-counted', async t => {
  const registry = createProcessObservation({ sampleGroup: async () => ({ ...known(), rssBytes: NaN }) });
  const first = await held(t, registry);
  const snapshot = await registry.status();
  assert.equal(snapshot.summary.rssBytes, null); assert.equal(snapshot.summary.coverage, 'unavailable');
  await first.finish();
  const inherited = createProcessObservation({ sampleGroup: async () => { throw Error('must not sample an inherited group'); } });
  const child = await held(t, inherited, identity, { processGroup: 'inherit' });
  const state = await inherited.status();
  assert.equal(state.summary.measuredGroups, 0); assert.equal(state.summary.rssBytes, null);
  await child.finish();
});

test('late samples after process exit cannot attach to a reused process identity', { skip: process.platform === 'win32' && 'POSIX group attribution' }, async t => {
  /** @type {(value: ReturnType<typeof known>) => void} */
  let finishSample = () => { throw Error('sampler was not called'); };
  let calls = 0;
  const registry = createProcessObservation({ sampleGroup: () => { calls++; return new Promise(resolve => { finishSample = resolve; }); } });
  const child = await held(t, registry);
  const snapshot = registry.status();
  await child.finish();
  finishSample(known());
  const state = await snapshot;
  assert.equal(calls, 1); assert.equal(state.processes[0].measurement, null); assert.equal(state.summary.active, 0);
});

test('cancellation remains a failure even when the child handles SIGTERM with exit zero', { skip: process.platform === 'win32' && 'POSIX SIGTERM handler', timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-observed-cancel-'));
  const ready = join(directory, 'ready'), controller = new AbortController(), registry = createProcessObservation();
  t.after(async () => { controller.abort(); await rm(directory, { recursive: true, force: true }); });
  const operation = registry.run(identity, () => runProcess(node, ['-e', `process.on('SIGTERM',()=>process.exit(0));require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { env, maxOutputBytes: 1024, signal: controller.signal, timeoutMs: 10000 }));
  const rejected = assert.rejects(operation, error => error instanceof ProcessRunError && error.reason === 'cancelled');
  for (let i = 0; i < 200 && !await readFile(ready).catch(() => null); i++) await delay(20);
  assert.equal(await readFile(ready, 'utf8'), 'ready'); controller.abort(); await rejected;
  const record = (await registry.status()).processes[0];
  assert.equal(record.state, 'failed'); assert.equal(record.exitCode, 0);
});

test('spawn failures are bounded historical entries; active work survives retention pruning', async t => {
  const registry = createProcessObservation(), live = await held(t, registry);
  for (let index = 0; index < 104; index++) await assert.rejects(registry.run(identity, () => runProcess(join(tmpdir(), 'werk-observation-missing-executable'), [], { env, maxOutputBytes: 1024 })), error => error instanceof ProcessRunError && error.reason === 'spawn');
  const snapshot = await registry.status();
  assert.equal(snapshot.processes.length, 101); assert.equal(snapshot.summary.active, 1);
  assert.equal(snapshot.processes.filter(p => p.state === 'failed').length, 100);
  assert.equal(snapshot.processes[0].state, 'running');
  await live.finish(); assert.equal((await registry.status()).processes.length, 100);
});

test('observer failure and pre-aborted execution do not change finite launch semantics', async () => {
  const result = await withProcessObserver(() => { throw Error('failed telemetry'); }, () => runProcess(node, ['-e', "process.stdout.write('ok')"], { env, maxOutputBytes: 1024 }));
  assert.equal(result.stdout.toString(), 'ok');
  const registry = createProcessObservation();
  await assert.rejects(registry.run(identity, () => runProcess(node, ['-e', ''], { env, maxOutputBytes: 1024, signal: AbortSignal.abort() })), error => error instanceof ProcessRunError && error.reason === 'cancelled');
  assert.equal((await registry.status()).summary.total, 0);
});


test('owned child exit cancels its in-flight measurement before output close', { skip: process.platform === 'win32' && 'POSIX group attribution', timeout: 5000 }, async t => {
  /** @type {PromiseWithResolvers<AbortSignal>} */
  const started = Promise.withResolvers();
  const registry = createProcessObservation({ sampleGroup: async (_pid, signal) => {
    started.resolve(signal);
    await delay(10000, undefined, { signal });
    return known();
  } });
  const child = await held(t, registry);
  const sampleSignal = await started.promise;
  const snapshot = registry.status(), exited = once(child.child, 'exit');
  child.child.stdin.end();
  await exited;
  assert.equal(sampleSignal.aborted, true, 'measurement ownership ends at leader exit');
  await child.closed;
  await snapshot;
  const state = await registry.status();
  assert.equal(state.processes[0].measurement, null);
  assert.equal(state.summary.active, 0);
});
