import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../../src/orchestrator/dist/orchestrator/server.js';

async function within(operation, milliseconds, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function ready(worker) {
  await within((async () => {
    for (;;) {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw Error('Worker exited before becoming ready');
      if (worker.port) {
        try {
          const response = await fetch(`http://127.0.0.1:${worker.port}/healthz`, { signal: AbortSignal.timeout(300) });
          await response.arrayBuffer();
          if (response.ok) return;
        } catch { /* Wait for enrollment and the first successful poll. */ }
      }
      await delay(25);
    }
  })(), 5000, 'Worker did not become ready');
}

test('SIGTERM bounds an incomplete status request, releases the worker lock and permits restart', { timeout: 20000, skip: process.platform === 'win32' ? 'Requires POSIX SIGTERM delivery' : false }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'werk-worker-shutdown-'));
  const enrollmentToken = 'worker-shutdown-enrollment-token';
  const app = await startServer({ db: ':memory:', host: '127.0.0.1', port: 0, project: 'shutdown', adminToken: 'worker-shutdown-administrator-token', enrollmentToken });
  const children = []; let socket;
  t.after(async () => {
    socket?.destroy();
    for (const worker of children) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    await Promise.all(children.map(worker => worker.closed));
    await app.close(); await rm(stateDir, { recursive: true, force: true });
  });
  function launch() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/worker/dist/worker/cli.js', import.meta.url)), 'run', '--state-dir', stateDir, '--status-port', '0', '--poll-ms', '100'], {
      env: { ...process.env, WERK_URL: `http://127.0.0.1:${app.server.address().port}`, WERK_ENROLLMENT_TOKEN: enrollmentToken }, stdio: ['ignore', 'ignore', 'pipe']
    });
    const worker = { child, port: undefined, closed: once(child, 'close') }; let pending = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try { const event = JSON.parse(line); if (event.event === 'status_listening') worker.port = event.address.port; } catch { /* Ignore unrelated diagnostics. */ }
      }
    });
    children.push(worker); return worker;
  }
  const first = launch(); await ready(first);
  const identity = await readFile(join(stateDir, 'identity.json'), 'utf8');
  socket = connect(first.port, '127.0.0.1'); socket.on('error', () => {});
  await once(socket, 'connect');
  await new Promise(resolve => socket.write('GET /status HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: ', resolve));
  await delay(100); // Let the worker's HTTP parser retain the unfinished request.
  first.child.kill('SIGTERM');
  const [code, signal] = await within(first.closed, 7500, 'Worker shutdown exceeded its status HTTP grace period');
  assert.equal(code, 0); assert.equal(signal, null);
  await assert.rejects(lstat(join(stateDir, 'worker.lock')), { code: 'ENOENT' });
  assert.equal(await readFile(join(stateDir, 'identity.json'), 'utf8'), identity);
  const second = launch(); await ready(second);
  assert.equal(await readFile(join(stateDir, 'identity.json'), 'utf8'), identity);
  second.child.kill('SIGTERM');
  assert.deepEqual(await within(second.closed, 2000, 'Restarted worker did not stop'), [0, null]);
  await assert.rejects(lstat(join(stateDir, 'worker.lock')), { code: 'ENOENT' });
});
