import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessSupervisor } from '../../src/worker/dist/worker/application/process-supervisor.js';
import { nodeServiceHost } from '../../src/worker/dist/worker/infrastructure/processes/node-host.js';

const input = () => ({ preset: { id: 'dev', name: 'Preview', executable: process.execPath, args: [], enabled: true, ttlMs: 10000, startupTimeoutMs: 1000, restart: { maxAttempts: 0, backoffMs: 100 } }, scope: { featureRequestKey: 'fr-' + 'a'.repeat(64), sessionId: 'session', worktree: '/pinned', worktreeIdentity: { dev: '1', ino: '2', birthtimeMs: 0 } }, expiresAt: new Date(Date.now() + 10000).toISOString(), onEvent() {} });
function fixture(t, { acknowledge = true, closeOnForce = true, autoStart = true } = {}) {
  // The injected launcher owns this fake handle; the injected terminator never signals a PID.
  const child = Object.assign(new ChildProcess(), { pid: 321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const signals = [], frames = []; let canClose = closeOnForce, closed = false;
  child.stdin.on('data', value => { frames.push(String(value)); });
  const keepAlive = setInterval(() => {}, 1000);
  const close = () => { if (closed) return; closed = true; Object.assign(child, { exitCode: null, signalCode: 'SIGKILL' }); child.emit('close', null, 'SIGKILL'); };
  t.after(() => { close(); clearInterval(keepAlive); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const host = nodeServiceHost('/private', {
    startupTimeoutMs: 40, stopGraceMs: 15, cleanupTimeoutMs: 100,
    launch() { if (acknowledge) queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'started' }) + '\n')); return child; },
    terminate(target, signal = 'SIGKILL') { assert.equal(target, child, 'Only the originally captured live handle may be signalled.'); signals.push(signal); if (canClose) queueMicrotask(close); },
  });
  const handle = autoStart ? host.start(input()) : undefined;
  return { host, get handle() { if (!handle) throw Error('The fixture handle has not been started.'); return handle; }, child, signals, frames, close, allowClose() { canClose = true; } };
}

test('service stop sends graceful control before forcing only its captured live child', { timeout: 3000 }, async t => {
  const f = fixture(t); await f.handle.started;
  const stopping = f.handle.stop('operator'); assert.equal(f.signals.length, 0); assert.equal(f.child.stdin.writableEnded, true);
  assert.ok(f.frames.some(frame => frame.includes('"action":"stop"') && frame.includes('"reason":"operator"')));
  await stopping; assert.deepEqual(f.signals, ['SIGKILL']); assert.equal((await f.handle.closed).reason, 'host_lost');
});

test('startup acknowledgement deadline rejects without abandoning the owned handle', { timeout: 3000 }, async t => {
  const f = fixture(t, { acknowledge: false });
  await assert.rejects(f.handle.started, /startup|start|acknowledge/i);
  await f.handle.stop('shutdown'); assert.deepEqual(f.signals, ['SIGKILL']); assert.equal((await f.handle.closed).reason, 'host_lost');
});

test('cleanup uncertainty rejects within its bound, leaves closed pending, and permits a later cleanup retry', { timeout: 3000 }, async t => {
  const f = fixture(t, { closeOnForce: false }); await f.handle.started; let closed = false;
  void f.handle.closed.then(() => { closed = true; });
  await assert.rejects(f.handle.stop('operator'), /cleanup|close|stop|confirm/i);
  assert.equal(closed, false, 'A cleanup deadline must not fabricate an actual close event.'); assert.deepEqual(f.signals, ['SIGKILL']);
  f.allowClose(); await f.handle.stop('shutdown'); assert.equal(closed, true); assert.deepEqual(f.signals, ['SIGKILL', 'SIGKILL']);
});

test('an exited leader with undrained pipes is never signalled as a live process', { timeout: 3000 }, async t => {
  const f = fixture(t, { closeOnForce: false }); await f.handle.started;
  Object.assign(f.child, { exitCode: 0 }); f.child.emit('exit', 0, null);
  await assert.rejects(f.handle.stop('operator'), /cleanup|close|stop|confirm/i); assert.equal(f.signals.length, 0);
  f.close(); await f.handle.closed; await f.handle.stop('shutdown'); assert.equal(f.signals.length, 0);
});

test('an actual close during graceful stop cancels its pending forced termination', { timeout: 3000 }, async t => {
  const f = fixture(t, { closeOnForce: false }); await f.handle.started;
  const stopping = f.handle.stop('operator'); f.close(); await stopping; await delay(30);
  assert.equal(f.signals.length, 0);
});


test('cancelling before observing startup never leaks an unhandled rejection', { timeout: 3000 }, async t => {
  const f = fixture(t, { acknowledge: false });
  await f.handle.stop('feature_ended'); await delay(20);
  await assert.rejects(f.handle.started, /could not start/); assert.equal((await f.handle.closed).reason, 'host_lost');
});

for (const [name, frame] of [['malformed', '{broken\n'], ['oversize', 'x'.repeat(262145)]]) test(`post-start ${name} protocol failure retains a stopping lease when cleanup is unconfirmed`, { timeout: 3000 }, async t => {
  const f = fixture(t, { closeOnForce: false, autoStart: false });
  const owner = await ProcessSupervisor.open({ host: f.host, journal: { async load() { return []; }, async save() {} }, presets: () => [input().preset], async validateScope() {} });
  t.after(async () => { f.close(); await owner.close(); });
  const row = await owner.start({ operationId: 'start', presetId: 'dev', scope: input().scope });
  assert.equal(row.state, 'running');
  f.child.stdout.write(JSON.stringify({ type: 'cleanup_unconfirmed', reason: 'storage_failed' }) + '\n');
  await delay(10); assert.equal(owner.status().services[0].state, 'running', 'Child output cannot forge a trusted adapter cleanup event.');
  f.child.stdout.write(frame);
  for (let attempt = 0; attempt < 100 && owner.status().services[0].state !== 'stopping'; attempt++) await delay(10);
  const current = owner.status().services[0]; assert.equal(current.state, 'stopping'); assert.match(current.error, /cleanup could not be confirmed/);
  assert.equal(owner.status().capacity.active, 1); assert.equal((await owner.controls(row.id)).restart, false);
  f.close(); for (let attempt = 0; attempt < 100 && owner.status().capacity.active; attempt++) await delay(10);
  assert.equal(owner.status().capacity.active, 0);
});
