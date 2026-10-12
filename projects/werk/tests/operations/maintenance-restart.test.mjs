import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setup } from '../../scripts/runtime/config.mjs';
import { stopRuntime } from '../../scripts/runtime/control.mjs';
import { backupState, restoreState } from '../../scripts/runtime/maintenance/backup.mjs';
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
async function eventually(probe, failure = () => undefined) {
  const deadline = Date.now() + 20000; let lastProbeError;
  while (Date.now() < deadline) {
    const stopped = failure(); if (stopped) throw Error(stopped);
    try { const value = await probe(); if (value) return value; } catch (error) { lastProbeError = error.name; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Runtime restore fixture timed out; last probe error: ${lastProbeError ?? 'none'}; ${failure(true) ?? 'runtime remained active'}`);
}
function launch(state) {
  const child = spawn(process.execPath, ['werk.mjs', 'start', '--state-dir', state, '--no-open', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderrBytes = 0, stderrCodes = new Set(), exited;
  const events = []; let pending = '';
  child.stdout.on('data', value => {
    output = (output + value).slice(-65536); pending += value;
    for (;;) {
      const newline = pending.indexOf('\n'); if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (['starting', 'ready', 'stopping', 'stopped', 'child_exited'].includes(event.event)) events.push({ event: event.event, role: event.role, exitCode: event.exitCode, signal: event.signal });
        if (event.ok === false) events.push({ errorCode: event.error?.code, message: String(event.error?.message ?? '').replace(/[a-f0-9]{32,}/gi, '[redacted]').slice(0, 400) });
        if (events.length > 20) events.shift();
      } catch { /* Raw diagnostics are never reflected into test output. */ }
    }
    if (pending.length > 65536) pending = '';
  });
  child.stderr.on('data', value => { stderrBytes += value.length; for (const code of ['EADDRINUSE', 'EACCES', 'ENOENT', 'ERR_MODULE_NOT_FOUND']) if (String(value).includes(code)) stderrCodes.add(code); });
  const closed = new Promise(resolve => { child.once('error', error => { exited = { code: null, signal: null, errorCode: error.code ?? 'SPAWN_FAILED' }; resolve(exited); }); child.once('close', (code, signal) => { exited = { code, signal }; resolve(exited); }); });
  const failure = force => exited || force ? `Launcher diagnostics: ${JSON.stringify({ ...exited, stderrBytes, stderrCodes: [...stderrCodes], events })}` : undefined;
  return { child, closed, ready: () => eventually(() => output.includes('"event":"ready"'), failure) };
}
test('replacement-state restore restarts real orchestrator and worker with same task, evidence and identity', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'werk-replacement-')); const original = join(root, 'original'), restored = join(root, 'restored');
  let running, active = original;
  try {
    const orchestratorPort = await port(); let workerPort = await port(); while (workerPort === orchestratorPort) workerPort = await port();
    await setup({ stateDir: original, project: 'restore-rehearsal', port: orchestratorPort, workerPort });
    const credentials = JSON.parse(await readFile(join(original, 'credentials.json')));
    const request = async (path, options = {}) => { const response = await fetch(`http://127.0.0.1:${orchestratorPort}${path}`, { ...options, headers: { Authorization: `Bearer ${credentials.WERK_ADMIN_TOKEN}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(2000) }); assert.equal(response.ok, true); return response.json(); };
    running = launch(original); await running.ready();
    await assert.rejects(backupState(original, join(root, 'live-refused')), /running|owner/);
    const beforeWorkers = (await request('/v1/workers?limit=100')).workers.map(worker => worker.id);
    const task = await request('/v1/tasks', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ project: 'restore-rehearsal', title: 'Preserve this task across restore', criteria: ['Keep the same task, snapshots and worker identity'] }) });
    await eventually(async () => (await request('/v1/tasks/' + task.id)).status === 'simulated');
    await stopRuntime(original); assert.equal((await running.closed).code, 0); running = undefined;
    const backup = join(root, 'backup'); await backupState(original, backup); await restoreState(backup, restored);
    assert.deepEqual(await readFile(join(restored, 'workers/worker-1/identity.json')), await readFile(join(original, 'workers/worker-1/identity.json')));
    active = restored; running = launch(restored); await running.ready();
    assert.deepEqual((await request('/v1/workers?limit=100')).workers.map(worker => worker.id), beforeWorkers);
    assert.equal((await request('/v1/tasks/' + task.id)).status, 'simulated');
    assert.equal((await request('/v1/snapshots?task=' + task.id)).snapshots.length, 2);
    await stopRuntime(restored); assert.equal((await running.closed).code, 0); running = undefined;
  } finally {
    if (running) { await stopRuntime(active).catch(() => running.child.kill('SIGTERM')); await running.closed; }
    await rm(root, { recursive: true, force: true });
  }
});
