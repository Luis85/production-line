import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessSupervisor } from '../../src/worker/dist/worker/application/process-supervisor.js';
import { serviceJournal } from '../../src/worker/dist/worker/infrastructure/processes/journal.js';
import { boundedServiceWait, createServiceProcessLifetime } from './service-process-lifetime.mjs';
import { nodeServiceHost } from '../../src/worker/dist/worker/infrastructure/processes/node-host.js';
import { sampleOwnedProcessGroup } from '../../src/worker/dist/worker/infrastructure/processes/sampler.js';

const fixture = fileURLToPath(new URL('./service-process-fixture.mjs', import.meta.url));
const alive = async pid => { try { process.kill(pid, 0); if (process.platform === 'linux') { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'; } return true; } catch { return false; } };
async function until(read, predicate, message) { for (let i = 0; i < (process.platform === 'win32' ? 750 : 250); i++) { const value = await read(); if (predicate(value)) return value; await delay(20); } assert.fail(message); }
async function setup(t, mode = 'server', ttlMs = 30000) {
  // Production pins canonical worktrees; macOS temporary paths can pass through /var aliases.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-service-'))); const info = await lstat(directory);
  const scope = { featureRequestKey: 'fr-' + 'a'.repeat(64), sessionId: 'session-service', worktree: directory, worktreeIdentity: { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs } };
  const preset = { id: 'dev', name: 'Development fixture', enabled: true, executable: process.execPath, args: [fixture, mode, 'literal;argument', 'space value'], ttlMs, startupTimeoutMs: Math.min(ttlMs, 10000), readyText: '"ready":true', restart: { maxAttempts: 0, backoffMs: 100 } };
  const lifetime = createServiceProcessLifetime(t.signal), cleanupPaths = [directory];
  let owner;
  t.after(async () => {
    const errors = [];
    try { if (owner) await boundedServiceWait(owner.close(), 'Service supervisor cleanup', 6000); }
    catch (error) { errors.push(error); }
    finally {
      try { await lifetime.close(); } catch (error) { errors.push(error); }
      try { await boundedServiceWait(Promise.all(cleanupPaths.map(path => rm(path, { recursive: true, force: true }))), 'Service fixture removal', 2000); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Service fixture cleanup failed.');
  });
  const privateDirectory = join(directory, 'processes');
  owner = await ProcessSupervisor.open({ journal: serviceJournal(privateDirectory), host: nodeServiceHost(privateDirectory, { launch: lifetime.launch }), presets: () => [preset], async validateScope(value) { const current = await lstat(value.worktree); assert.equal(String(current.ino), value.worktreeIdentity.ino); } });
  return { owner, preset, scope, directory, lifetime, cleanupPaths, start: () => owner.start({ operationId: 'start-service', presetId: preset.id, scope }) };
}
const output = (owner, id) => owner.logs(id, { limit: 128 }).entries.map(entry => entry.text).join('');
const readiness = text => { for (const line of text.split('\n')) { try { const value = JSON.parse(line); if (value.ready) return value; } catch {} } return undefined; };

test('real approved service remains usable after start, isolates credentials, and stop drains descendants', { timeout: 30000 }, async t => {
  const previous = process.env.WERK_TEST_SERVICE_SECRET; process.env.WERK_TEST_SERVICE_SECRET = 'must-not-reach-service';
  const f = await setup(t); let row;
  try { row = await f.start(); } finally { if (previous === undefined) delete process.env.WERK_TEST_SERVICE_SECRET; else process.env.WERK_TEST_SERVICE_SECRET = previous; }
  assert.equal(row.state, 'running');
  const info = await until(() => readiness(output(f.owner, row.id)), Boolean, 'The real service never reported readiness.');
  assert.equal(info.secret, null); assert.deepEqual(info.args, ['literal;argument', 'space value']);
  assert.equal(await (await fetch(`http://127.0.0.1:${info.port}`, { signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]) })).text(), 'service response');
  assert.equal(f.owner.status().services[0].readiness, 'reported'); assert.ok(await alive(info.descendant));
  const measurement = await sampleOwnedProcessGroup(info.host);
  if (process.platform === 'linux') { assert.equal(measurement.coverage, 'complete_group'); assert.ok(measurement.rssBytes > 0); assert.ok(measurement.cpuTotalMicros >= 0); assert.ok(measurement.processCount >= 3); }
  else { assert.equal(measurement.coverage, 'unavailable'); assert.equal(measurement.rssBytes, null); }
  const current = f.owner.status().services[0]; const ended = await f.owner.stop({ id: row.id, operationId: 'stop-service', expectedRevision: current.revision });
  assert.equal(ended.state, 'stopped'); await until(async () => !(await alive(info.pid)) && !(await alive(info.descendant)), Boolean, 'Stop acknowledged before owned descendants ended.');
  const stoppedEndpoint = AbortSignal.any([t.signal, AbortSignal.timeout(5000)]);
  await assert.rejects(fetch(`http://127.0.0.1:${info.port}`, { signal: stoppedEndpoint }), error => error instanceof TypeError && !stoppedEndpoint.aborted, 'A deadline is not evidence that the stopped service refuses connections.');
  const journal = await readFile(join(f.directory, 'processes/services.json'), 'utf8'); assert.ok(!journal.includes('must-not-reach-service')); assert.ok(!journal.includes('"pid":') || journal.includes('\\"pid\\":'));
});

test('worker crash closes the private lease and kills service descendants without touching ambient processes', { timeout: 30000 }, async t => {
  const f = await setup(t); const input = { preset: f.preset, scope: f.scope, expiresAt: new Date(Date.now() + f.preset.ttlMs).toISOString() };
  const ambient = f.lifetime.own(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }));
  const driver = f.lifetime.own(spawn(process.execPath, [fixture, 'driver', JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  let text = ''; driver.stdout.setEncoding('utf8').on('data', value => { text += value; }); driver.stderr.resume();
  const info = await until(() => readiness(text), Boolean, 'The worker fixture never started its real service.');
  driver.kill('SIGKILL'); await f.lifetime.closed(driver);
  await until(async () => !(await alive(info.pid)) && !(await alive(info.descendant)), Boolean, 'A crashed worker left its owned service descendants running.');
  assert.equal(await alive(ambient.pid), true, 'The supervisor must not control unrelated processes.');
});

test('payload leader exit still cleans an ignoring descendant and reports normal completion', { timeout: 30000 }, async t => {
  const f = await setup(t, 'leader-exit'); const row = await f.start();
  const info = await until(() => readiness(output(f.owner, row.id)), Boolean, 'The fixture did not report its descendant.');
  await until(() => f.owner.status().services[0].state, state => state === 'stopped', 'The payload exit did not settle after containment cleanup.');
  assert.equal(f.owner.status().services[0].lastExit.code, 0);
  await until(async () => !(await alive(info.descendant)), Boolean, 'Payload completion left a descendant alive.');
});

test('host-enforced TTL ends a service even without a supervisor stop request', { timeout: 30000 }, async t => {
  const f = await setup(t, 'server', process.platform === 'win32' ? 10000 : 1500); let text = '';
  const handle = nodeServiceHost(f.directory, { launch: f.lifetime.launch }).start({ preset: f.preset, scope: f.scope, expiresAt: new Date(Date.now() + f.preset.ttlMs).toISOString(), onEvent(event) { if (event.type === 'output') text += event.text; } });
  await f.lifetime.wait(handle.started, 'Service host startup');
  const info = await until(() => readiness(text), Boolean, 'The fixture did not start within its lease.');
  const exit = await f.lifetime.wait(handle.closed, 'Service host close');
  assert.equal(exit.reason, 'ttl'); await until(async () => !(await alive(info.descendant)), Boolean, 'Expired service descendant remains alive.');
});


test('host refuses a replaced pinned directory before spawning its approved payload', { timeout: 30000 }, async t => {
  const f = await setup(t); const retained = f.directory + '-retained';
  await rename(f.directory, retained); f.cleanupPaths.push(retained); await mkdir(f.directory);
  const events = [];
  const handle = nodeServiceHost(f.directory, { launch: f.lifetime.launch }).start({ preset: f.preset, scope: f.scope, expiresAt: new Date(Date.now() + f.preset.ttlMs).toISOString(), onEvent(event) { events.push(event); } });
  await assert.rejects(handle.started, /could not start/); await f.lifetime.wait(handle.closed, 'Service host close');
  assert.equal(events.length, 0, 'No payload output or measurements can be published from a replacement directory.');
});

test('EOF during host setup cannot spawn a payload after its lifetime lease ended', { timeout: 30000 }, async t => {
  const f = await setup(t);
  const entry = fileURLToPath(new URL('../../src/worker/dist/worker/infrastructure/processes/service-host.js', import.meta.url));
  const host = f.lifetime.launch(process.execPath, [entry], { cwd: f.directory, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, mode: 'contained', observation: 'ignore' });
  let text = ''; host.stdout.setEncoding('utf8').on('data', value => { text += value; }); host.stderr.resume();
  host.stdin.end(JSON.stringify({ preset: f.preset, scope: f.scope, expiresAt: new Date(Date.now() + f.preset.ttlMs).toISOString() }) + '\n');
  await f.lifetime.closed(host); assert.equal(text.includes('"type":"started"'), false); assert.equal(text.includes('"ready":true'), false);
});

test('adapter forces its live stubborn host and descendants after graceful stop is ignored', { timeout: 30000 }, async t => {
  const f = await setup(t); let info;
  const handle = nodeServiceHost(f.directory, {
    launch(executable, _args, options) { return f.lifetime.launch(executable, [fixture, 'stalled-host'], options); },
    stopGraceMs: 100, cleanupTimeoutMs: 5000,
  }).start({ preset: f.preset, scope: f.scope, expiresAt: new Date(Date.now() + f.preset.ttlMs).toISOString(), onEvent(event) { if (event.type === 'output') info = JSON.parse(event.text); } });
  await f.lifetime.wait(handle.started, 'Service host startup'); const owned = await until(() => info, Boolean, 'The stubborn fixture did not report its owned descendants.');
  assert.equal(await alive(owned.pid), true); assert.equal(await alive(owned.descendant), true);
  await handle.stop('operator'); const exit = await f.lifetime.wait(handle.closed, 'Service host close');
  assert.equal(exit.reason, 'host_lost', 'Forced cleanup without a host receipt must not invent successful completion.');
  await until(async () => !(await alive(owned.pid)) && !(await alive(owned.descendant)), Boolean, 'Forced cleanup left an owned service descendant alive.');
});
