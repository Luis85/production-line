import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { STARTUP_GRACE_MS, start, status, startupTimeout } from '../../scripts/runtime/portable/lifecycle.mjs';
import { ownWorkspace } from '../helpers/workspace-processes.mjs';

const config = pathToFileURL(join(import.meta.dirname, '../../scripts/runtime/config.mjs')).href;
const owner = pathToFileURL(join(import.meta.dirname, '../../src/worker/dist/shared/process/owner.js')).href;
async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  await new Promise(resolve => server.close(() => resolve(undefined)));
  assert.ok(address && typeof address === 'object');
  return address.port;
}
// A `_run` that records its owner like a real worker, then never reports ready and ignores IPC stop and disconnect.
const hungRun = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivate } from ${JSON.stringify(config)};
import { ownerRecord } from ${JSON.stringify(owner)};
const argv = process.argv.slice(2), value = name => argv[argv.indexOf(name) + 1], state = value('--state-dir');
writeFileSync(join(import.meta.dirname, 'child.json'), JSON.stringify({ pid: process.pid, argv }));
await createPrivate(join(state, 'worker.lock'), { ...ownerRecord, startedAt: new Date().toISOString() });
await createPrivate(join(state, 'portable.json'), { schemaVersion: 1, kind: 'worker', runId: 'a'.repeat(64), controlToken: 'b'.repeat(64), ...ownerRecord, controlPort: Number(value('--control-port')), children: [], url: 'http://127.0.0.1:4100' });
process.on('message', () => {}); process.on('disconnect', () => {});
if (argv.includes('--disconnect')) process.disconnect();
setInterval(() => {}, 1000); setTimeout(() => process.exit(1), 90000);
`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-startup-'))), app = join(root, 'app'), state = join(root, 'state');
  await mkdir(app); await writeFile(join(app, 'cli.mjs'), hungRun);
  await ownWorkspace(t, root);
  return { root, app, state, child: async () => JSON.parse(await readFile(join(app, 'child.json'), 'utf8')) };
}
const gone = pid => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

test('a start that misses its deadline stops the child whose _run ignores IPC stop, and leaves no owner behind', { timeout: 120000 }, async t => {
  const f = await fixture(t), logged = t.mock.method(console, 'error', () => {});
  const began = Date.now();
  await assert.rejects(start('worker', f.state, f.app, ['--state-dir', f.state, '--control-port', String(await unusedPort()), '--startup-timeout-ms', '5000'], { 'startup-timeout-ms': '5000' }),
    { message: `Startup deadline (5 s) exceeded; the worker process was stopped. Inspect ${join(f.state, 'portable.log')}. On a busy host retry with --startup-timeout-ms 300000.` });
  const elapsed = Date.now() - began, child = await f.child();
  // Deadline plus grace; the margin covers taskkill and stale recovery on a loaded host.
  assert.ok(elapsed >= 5000 && elapsed < 5000 + STARTUP_GRACE_MS + 20000, `rejected after ${elapsed} ms`);
  gone(child.pid);
  // The deadline is the parent's; the child is launched without it.
  assert.ok(!child.argv.includes('--startup-timeout-ms'), child.argv.join(' '));
  // The killed child's portable.json and lock are recovered: status reports stopped, not unreachable.
  assert.deepEqual(await status('worker', f.state), { state: 'stopped', kind: 'worker', stateDirectory: f.state });
  assert.ok(logged.mock.calls.some(call => JSON.parse(call.arguments[0]).pid === child.pid));
});

test('a child that drops its IPC channel before ready is stopped without waiting for the deadline', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  const began = Date.now();
  await assert.rejects(start('worker', f.state, f.app, ['--state-dir', f.state, '--control-port', String(await unusedPort()), '--disconnect'], { 'startup-timeout-ms': '60000' }),
    { message: `Startup failed; the worker process was stopped. Inspect ${join(f.state, 'portable.log')}.` });
  assert.ok(Date.now() - began < 30000, `rejected after ${Date.now() - began} ms`);
  gone((await f.child()).pid);
  assert.equal((await status('worker', f.state)).state, 'stopped');
});

test('the startup deadline defaults to 120 s; the option wins over WERK_STARTUP_TIMEOUT_MS and both are bounded', () => {
  assert.equal(startupTimeout({}, {}), 120000);
  assert.equal(startupTimeout({}, { WERK_STARTUP_TIMEOUT_MS: '300000' }), 300000);
  assert.equal(startupTimeout({ 'startup-timeout-ms': '5000' }, { WERK_STARTUP_TIMEOUT_MS: 'invalid' }), 5000);
  assert.equal(startupTimeout({ 'startup-timeout-ms': '900000' }, {}), 900000);
  for (const value of ['4999', '900001', '6e4', '60000.5', '-6000', ''])
    assert.throws(() => startupTimeout({ 'startup-timeout-ms': value }, {}), { message: '--startup-timeout-ms: integer 5000–900000', exitCode: 2 });
  assert.throws(() => startupTimeout({}, { WERK_STARTUP_TIMEOUT_MS: '1000' }), { message: 'WERK_STARTUP_TIMEOUT_MS: integer 5000–900000', exitCode: 2 });
});
