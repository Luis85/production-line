import { testErrorStatus } from '../helpers/process-errors.mjs';
import { testErrorMessage, testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as nativeParse } from '../../scripts/runtime/cli.mjs';
import { parse as systemParse } from '../../scripts/system/cli.mjs';
import { captureServiceLogs } from '../../scripts/runtime/service-logs.mjs';
const source = fileURLToPath(new URL('../../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(args, environment = {}) {
  const env = { ...process.env }; for (const key of ['WERK_STATE_DIR', 'WERK_SYSTEM_FILE', 'WERK_LOG_OUTPUT']) delete env[key];
  const child = spawn(process.execPath, [join(source, 'werk.mjs'), ...args], { cwd: source, env: { ...env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, output, errors })); });
  return { child, done, get output() { return output; }, get errors() { return errors; } };
}
async function until(check, label) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(30); } throw Error('Timed out: ' + label); }
function records(owner) { return owner.output.split('\n').filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return {}; } }); }
async function ports(count) { const servers = []; try { for (let n = 0; n < count; n++) { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined))); servers.push(server); } return servers.map(server => testListeningAddress(server).port); } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); } }
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'werk-log-output-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function stopOnFinish(t, owner) { t.after(async () => { if (owner.child.exitCode === null) owner.child.kill('SIGTERM'); await owner.done; }); }
async function request(port, path, token) { const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(3000) }); await response.text(); return response.status; }

test('native and system env defaults have explicit flag precedence and reject invalid log output only at startup', () => {
  const env = { WERK_STATE_DIR: '/env/state', WERK_SYSTEM_FILE: '/env/system.yaml', WERK_LOG_OUTPUT: 'stream' };
  assert.deepEqual(nativeParse(['start'], env).options, { 'state-dir': '/env/state', 'log-output': 'stream' });
  assert.deepEqual(nativeParse(['start', '--state-dir', '/flag/state', '--log-output', 'both'], env).options, { 'state-dir': '/flag/state', 'log-output': 'both' });
  assert.equal(systemParse(['up'], env).options.file, '/env/system.yaml');
  assert.deepEqual(systemParse(['start', '--file', '/flag/system.yaml', '--state-dir', '/flag/state', '--log-output', 'file'], env).options, { file: '/flag/system.yaml', 'state-dir': '/flag/state', 'log-output': 'file' });
  assert.equal(systemParse(['status'], { WERK_STATE_DIR: '/saved' }).options['state-dir'], '/saved');
  assert.equal(nativeParse(['start'], { WERK_LOG_OUTPUT: '' }).options['log-output'], 'file');
  assert.equal(systemParse(['up', '--file', 'system.yaml'], {}).options['log-output'], 'file');
  for (const parse of [nativeParse, systemParse]) {
    const args = parse === systemParse ? ['start', '--file', 'system.yaml'] : ['start'];
    assert.throws(() => parse(args, { WERK_LOG_OUTPUT: 'invalid-secret-marker' }), error => testErrorStatus(error, 'exitCode') === 2 && !testErrorMessage(error).includes('invalid-secret-marker'));
    assert.equal(parse([...args, '--log-output', 'stream'], { WERK_LOG_OUTPUT: 'invalid' }).options['log-output'], 'stream');
    assert.throws(() => parse([...args, '--log-output', 'file', '--log-output', 'both'], {}));
  }
  assert.doesNotThrow(() => nativeParse(['status'], { WERK_LOG_OUTPUT: 'invalid' }));
  assert.throws(() => nativeParse(['status', '--log-output', 'stream'], {}));
});

test('capture bounds UTF-8 bytes, strips secrets, drops malformed records and recovers on the next complete line', async () => {
  const stream = new PassThrough(), values = []; captureServiceLogs(stream, value => values.push(value));
  const safe = { schemaVersion: 1, time: '2026-10-12T12:00:00.000Z', service: 'worker', level: 'warn', event: 'connection_lost' };
  stream.write(JSON.stringify({ ...safe, secret: 'é'.repeat(8500) }) + '\n');
  stream.write('unstructured secret\n'); stream.write(JSON.stringify({ ...safe, event: 'secret-event' }) + '\n');
  const text = JSON.stringify({ ...safe, secret: 'private-marker' }); stream.write(text.slice(0, 11)); stream.write(text.slice(11) + '\n');
  stream.end(); await new Promise(resolve => stream.once('end', resolve)); assert.deepEqual(values, [safe]);
});

test('native human stream sends both service types to stdout, omits local logs and keeps maintenance JSON singular', { timeout: 30000 }, async t => {
  const root = await fixture(t), stateDir = join(root, 'state'), [port, workerPort] = await ports(2);
  const env = { WERK_STATE_DIR: stateDir, WERK_LOG_OUTPUT: 'stream' };
  const setup = await launch(['setup', '--port', String(port), '--worker-port', String(workerPort), '--json'], env).done;
  assert.equal(setup.code, 0, setup.output + setup.errors); assert.equal(JSON.parse(setup.output).created, true);
  const credentials = JSON.parse(await readFile(join(stateDir, 'credentials.json'), 'utf8'));
  const owner = launch(['start', '--no-open'], env); await stopOnFinish(t, owner);
  await until(() => owner.output.includes('Werk is ready:'), 'native readiness');
  const marker = 'private-request-marker'; await request(port, '/v1/tasks/' + marker + '?token=' + marker, credentials.WERK_ADMIN_TOKEN); await request(workerPort, '/status?token=' + marker);
  await until(() => ['orchestrator', 'worker'].every(service => records(owner).some(value => value.entry?.service === service && value.entry?.event === 'request_finished')), 'both native service logs');
  const status = await launch(['status', '--json'], env).done; assert.equal(status.code, 0); assert.equal(JSON.parse(status.output).state, 'running');
  const stopped = await launch(['stop', '--json'], env).done; assert.equal(stopped.code, 0); assert.equal(JSON.parse(stopped.output).state, 'stopped');
  const result = await owner.done; assert.equal(result.code, 0, result.errors);
  await assert.rejects(lstat(join(stateDir, 'logs')), { code: 'ENOENT' });
  const identity = JSON.parse(await readFile(join(stateDir, 'workers/worker-1/identity.json'), 'utf8'));
  for (const secret of [...Object.values(credentials), identity.token, marker]) assert.equal((owner.output + owner.errors + status.output + stopped.output).includes(secret), false);
});

for (const mode of ['stream', 'both']) test(`system ${mode} propagates Factory, nested line and worker events with safe attribution`, { timeout: 35000 }, async t => {
  const root = await fixture(t), stateDir = join(root, 'state'), file = join(root, 'system.yaml'), [factoryPort, port, workerPort] = await ports(3);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, id: 'log-test', environment: 'native', factory: { id: 'root', name: 'Root', port: factoryPort }, productionLines: [{ id: 'alpha', name: 'Alpha', project: 'alpha', orchestrator: { port }, workers: { count: 1, statusPort: workerPort } }] }));
  const env = { WERK_STATE_DIR: stateDir, WERK_SYSTEM_FILE: file, WERK_LOG_OUTPUT: mode };
  const setup = await launch(['system', 'setup', '--json'], env).done; assert.equal(setup.code, 0, setup.output + setup.errors); assert.equal(JSON.parse(setup.output).created, true);
  const owner = launch(['system', 'start', '--json'], env); await stopOnFinish(t, owner);
  await until(() => records(owner).some(record => record.event === 'ready'), 'system readiness');
  const credentials = JSON.parse(await readFile(join(stateDir, 'lines/alpha/credentials.json'), 'utf8'));
  const factoryCredentials = JSON.parse(await readFile(join(stateDir, 'factory/credentials.json'), 'utf8'));
  const marker = 'private-request-marker'; await request(port, '/v1/tasks/' + marker + '?token=' + marker, credentials.WERK_ADMIN_TOKEN); await request(workerPort, '/status?token=' + marker);
  await until(() => ['factory', 'orchestrator', 'worker'].every(service => records(owner).some(value => value.entry?.service === service && value.entry?.event === 'request_finished')), 'all nested service logs');
  const entries = records(owner).filter(value => value.event === 'service_log');
  assert.ok(entries.some(value => value.role === 'line' && value.id === 'alpha' && value.childRole === 'worker' && value.index === 1 && value.entry.service === 'worker'));
  assert.ok(entries.some(value => value.role === 'line' && value.id === 'alpha' && value.childRole === 'orchestrator' && value.index === 0 && value.entry.service === 'orchestrator'));
  const status = await launch(['system', 'status', '--json'], env).done; assert.equal(status.code, 0); assert.equal(JSON.parse(status.output).state, 'running');
  const stopped = await launch(['system', 'stop', '--json'], env).done; assert.equal(stopped.code, 0); assert.equal(JSON.parse(stopped.output).state, 'stopped');
  const result = await owner.done; assert.equal(result.code, 0, result.output + result.errors);
  let logText = '';
  for (const path of [stateDir, join(stateDir, 'lines/alpha')]) {
    if (mode === 'stream') await assert.rejects(lstat(join(path, 'logs')), { code: 'ENOENT' });
    else { const content = await readFile(join(path, 'logs/runtime.jsonl'), 'utf8'); logText += content; assert.ok(content.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(value => value.entry?.service === 'worker')); }
  }
  const identity = JSON.parse(await readFile(join(stateDir, 'lines/alpha/workers/worker-1/identity.json'), 'utf8'));
  const secrets = [...Object.values(credentials), ...Object.values(factoryCredentials).flatMap(value => typeof value === 'string' ? [value] : Object.values(value)), identity.token, marker];
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length >= 16)) assert.equal((owner.output + owner.errors + status.output + stopped.output + logText).includes(secret), false);
  assert.ok(owner.output.trim().split('\n').every(line => JSON.parse(line).ok === true), 'foreground --json remains JSONL');
});
