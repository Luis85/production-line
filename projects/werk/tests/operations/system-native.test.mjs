import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, lstat, rename, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { bootstrapSystem } from '../../scripts/system/bootstrap.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setupSystem, loadSystem, factoryCredentials } from '../../scripts/system/state.mjs';
import { validateDefinition } from '../../scripts/system/definition.mjs';
import { createPrivate } from '../../scripts/runtime/config.mjs';
import { main, parse } from '../../scripts/system/cli.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const definition = () => ({ schemaVersion: 1, id: 'system-test', environment: 'native', factory: { id: 'root', name: 'Root', port: 37100, subFactories: [{ id: 'group', name: 'Group' }] },
  productionLines: [{ id: 'alpha', name: 'Alpha', project: 'alpha', orchestrator: { port: 37101 }, workers: { count: 1, statusPort: 37102 } },
    { id: 'beta', name: 'Beta', project: 'beta', factoryId: 'group', orchestrator: { port: 37103 }, workers: { count: 1, statusPort: 37104 } }] });
async function directory(t) { const root = await mkdtemp(join(tmpdir(), 'werk-system-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function uniquePorts(count) { const servers = [], ports = []; try { for (let n = 0; n < count; n++) { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); ports.push(server.address().port); } return ports; } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); } }
async function availableDefinition() { const ports = await uniquePorts(5), value = definition(); value.factory.port = ports[0]; value.productionLines.forEach((line, index) => { line.orchestrator.port = ports[1 + index * 2]; line.workers.statusPort = ports[2 + index * 2]; }); return value; }
function launch(root, args) { const child = spawn(process.execPath, [join(root, 'werk.mjs'), 'system', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', errors = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data); const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, output, errors })); }); return { child, done, get output() { return output; } }; }
async function until(check, label, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(60); } throw Error('Timed out: ' + label); }
async function api(port, token, path, body, key) { const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) }); return { status: response.status, value: await response.json() }; }
async function extracted(root) { await cp(join(source, 'werk.mjs'), join(root, 'werk.mjs')); for (const scripts of ['runtime', 'system']) await cp(join(source, 'scripts', scripts), join(root, 'scripts', scripts), { recursive: true }); for (const app of ['orchestrator', 'worker', 'factory']) await cp(join(source, 'src', app, 'dist'), join(root, 'src', app, 'dist'), { recursive: true }); }

test('system setup normalizes hierarchy, resumes partial provisioning and never rotates credentials on retries or drift', async t => {
  const stateDir = join(await directory(t), 'state'), value = definition(); await setupSystem(value, { stateDir });
  const saved = await loadSystem(stateDir), before = await factoryCredentials(stateDir, saved);
  assert.equal(saved.productionLines[1].factoryId, 'group'); assert.equal(Object.keys(before.credentials)[0], 'WERK_LINE_SYSTEM_1_TOKEN');
  assert.equal((await setupSystem(value, { stateDir })).created, false);
  value.factory.name = 'Changed'; await assert.rejects(setupSystem(value, { stateDir }), /differs/);
  assert.deepEqual(await factoryCredentials(stateDir, saved), before);
  const partial = join(await directory(t), 'partial'); await mkdir(partial, { mode: 0o700 });
  await createPrivate(join(partial, 'system.json'), { schemaVersion: 1, definition: saved });
  await mkdir(join(partial, 'factory'), { mode: 0o700 });
  const credentials = { WERK_FACTORY_ADMIN_TOKEN: 'a'.repeat(64) }; await createPrivate(join(partial, 'factory/credentials.json'), credentials);
  await setupSystem(saved, { stateDir: partial });
  assert.deepEqual(JSON.parse(await readFile(join(partial, 'factory/credentials.json'))), credentials);
});

test('system validates before touching state and refuses orphan credentials, concurrent setup and Docker execution', async t => {
  const root = await directory(t), stateDir = join(root, 'state'), value = definition(); value.productionLines[0].orchestrator.port = value.factory.port;
  await assert.rejects(setupSystem(value, { stateDir }), /overlap/); await assert.rejects(lstat(stateDir), { code: 'ENOENT' });
  await mkdir(stateDir, { mode: 0o700 }); await createPrivate(join(stateDir, 'docker-volume.json'), { volume: 'existing' });
  await assert.rejects(setupSystem(definition(), { stateDir }), /without system.json/); await assert.rejects(lstat(join(stateDir, 'factory')), { code: 'ENOENT' });
  await rm(join(stateDir, 'docker-volume.json')); await createPrivate(join(stateDir, 'setup.lock'), { pid: process.pid });
  await assert.rejects(setupSystem(definition(), { stateDir }), /locked/); await rm(join(stateDir, 'setup.lock'));
  const docker = { ...definition(), environment: 'docker' }; await setupSystem(docker, { stateDir });
  const output = []; assert.equal(await main(['start', '--file', join(root, 'docker.json'), '--state-dir', stateDir, '--json'], { stdout: value => output.push(value) }), 1);
  const file = join(root, 'docker.json'); await writeFile(file, JSON.stringify(docker)); output.length = 0;
  assert.equal(await main(['up', '--file', file, '--state-dir', stateDir, '--json'], { stdout: value => output.push(value) }), 2); assert.match(output[0], /Docker/);
  assert.throws(() => parse(['stop']), /state-dir/); assert.throws(() => parse(['up', '--file', file, '--json', '--json']), /repeated/);
});

test('system plan is read-only and stop uses saved identity despite edited YAML', async t => {
  const root = await directory(t), file = join(root, 'system.json'), stateDir = join(root, 'state'); await writeFile(file, JSON.stringify(definition()));
  const output = []; assert.equal(await main(['plan', '--file', file, '--state-dir', stateDir, '--json'], { stdout: value => output.push(JSON.parse(value)) }), 0);
  assert.equal(output[0].plan.totals.factories, 2); await assert.rejects(lstat(stateDir), { code: 'ENOENT' });
  await setupSystem(definition(), { stateDir }); const changed = definition(); changed.factory.port++; await writeFile(file, JSON.stringify({ ...changed, factory: { ...changed.factory, port: 38000 } }));
  assert.equal(await main(['stop', '--file', file, '--state-dir', stateDir, '--json'], { stdout() {} }), 0);
});

test('extracted two-line system registers hierarchy, isolates tasks and credentials, and preserves identities across restart', { timeout: 80000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-system-')), stateDir = join(root, 'state'), file = join(root, 'system.yaml'), value = await availableDefinition(), processes = [];
  await extracted(root); await writeFile(file, JSON.stringify(value));
  await assert.rejects(lstat(join(root, 'node_modules')), { code: 'ENOENT' });
  t.after(async () => { await launch(root, ['stop', '--state-dir', stateDir, '--json']).done; for (const item of processes) if (item.child.exitCode === null) item.child.kill('SIGTERM'); await Promise.all(processes.map(item => item.done)); await rm(root, { recursive: true, force: true }); });
  const first = launch(root, ['up', '--file', file, '--state-dir', stateDir, '--json']); processes.push(first);
  await until(() => first.output.includes('"event":"ready"'), 'system readiness');
  const loaded = validateDefinition(value), credentials = await factoryCredentials(stateDir, loaded);
  const factories = await api(value.factory.port, credentials.adminToken, '/v1/factories'); assert.equal(factories.status, 200); assert.deepEqual(factories.value.factories.map(item => item.id).sort(), ['group', 'root']);
  const registrations = await api(value.factory.port, credentials.adminToken, '/v1/lines'); assert.equal(registrations.value.lines.length, 2); assert.equal(registrations.value.lines.find(line => line.id === 'beta').factoryId, 'group');
  const tasks = [], identities = [];
  for (const [index, line] of value.productionLines.entries()) {
    const token = credentials.credentials[`WERK_LINE_SYSTEM_${index + 1}_TOKEN`];
    assert.equal((await api(line.orchestrator.port, credentials.adminToken, '/v1/overview')).status, 401);
    const result = await api(line.orchestrator.port, token, '/v1/tasks', { project: line.project, title: `${line.id} mock`, criteria: ['Complete isolated mock'] }, `system-test-${line.id}`);
    assert.equal(result.status, 201, JSON.stringify(result.value)); tasks.push(result.value.task ?? result.value);
    identities.push(await readFile(join(stateDir, 'lines', line.id, 'workers/worker-1/identity.json'), 'utf8'));
  }
  for (const [index, line] of value.productionLines.entries()) {
    const token = credentials.credentials[`WERK_LINE_SYSTEM_${index + 1}_TOKEN`], task = tasks[index];
    await until(async () => (await api(line.orchestrator.port, token, `/v1/tasks/${task.id}`)).value.status === 'simulated', `task ${line.id}`);
    assert.equal((await api(line.orchestrator.port, token, `/v1/tasks/${tasks[1 - index].id}`)).status, 404);
    const snapshots = await api(line.orchestrator.port, token, `/v1/snapshots?task=${task.id}`); assert.equal(snapshots.value.snapshots.length, 2);
  }
  const concurrent = await launch(root, ['start', '--file', file, '--state-dir', stateDir, '--json']).done; assert.equal(concurrent.code, 2);
  assert.equal((await launch(root, ['doctor', '--state-dir', stateDir, '--json']).done).code, 0);
  const secretFile = join(stateDir, 'factory/credentials.json'), original = await readFile(secretFile); await writeFile(secretFile, 'invalid-secret-marker');
  assert.equal((await launch(root, ['status', '--state-dir', stateDir, '--json']).done).code, 0);
  assert.equal((await launch(root, ['stop', '--state-dir', stateDir, '--json']).done).code, 0); assert.equal((await first.done).code, 0); await writeFile(secretFile, original);
  const second = launch(root, ['start', '--file', file, '--state-dir', stateDir, '--json']); processes.push(second); await until(() => second.output.includes('"event":"ready"'), 'restart');
  for (const [index, line] of value.productionLines.entries()) assert.equal(await readFile(join(stateDir, 'lines', line.id, 'workers/worker-1/identity.json'), 'utf8'), identities[index]);
  assert.deepEqual(await factoryCredentials(stateDir, loaded), credentials);
  assert.equal((await launch(root, ['stop', '--state-dir', stateDir, '--json']).done).code, 0); assert.equal((await second.done).code, 0);
  const logs = await readFile(join(stateDir, 'logs/runtime.jsonl'), 'utf8');
  assert.ok(logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(record => record.event === 'service_log' && record.role === 'factory' && record.entry.event === 'request_finished' && record.entry.route === '/v1/lines' && record.entry.status === 200), 'Factory HTTP observations reach the bounded system log');
  for (const token of [credentials.adminToken, ...Object.values(credentials.credentials)]) { assert.equal((first.output + second.output + logs).includes(token), false); }
});

test('failure in a later line cleans already-started lines and preserves evidence', { timeout: 45000 }, async t => {
  const root = await directory(t), stateDir = join(root, 'state'), file = join(root, 'system.yaml'), value = await availableDefinition(); await extracted(root); await writeFile(file, JSON.stringify(value)); await setupSystem(value, { stateDir });
  const worker = join(stateDir, 'lines/beta/workers/worker-1'); await mkdir(worker, { recursive: true, mode: 0o700 }); await createPrivate(join(worker, 'identity.json'), { invalid: 'preserve' });
  const failed = await launch(root, ['start', '--file', file, '--state-dir', stateDir, '--json']).done;
  assert.equal(failed.code, 1, failed.output); assert.equal(JSON.parse((await launch(root, ['status', '--state-dir', stateDir, '--json']).done).output).state, 'stopped');
  assert.deepEqual(JSON.parse(await readFile(join(worker, 'identity.json'))), { invalid: 'preserve' });
  for (const line of value.productionLines) {
    await assert.rejects(lstat(join(stateDir, 'lines', line.id, 'runtime.lock')), { code: 'ENOENT' });
    await assert.rejects(fetch(`http://127.0.0.1:${line.orchestrator.port}/healthz`, { signal: AbortSignal.timeout(1000) }));
  }
});


test('authenticated stop during line startup cancels owned services and preserves a restartable setup', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-system-cancel-')), stateDir = join(root, 'state'), file = join(root, 'system.yaml'), value = await availableDefinition();
  await extracted(root); await writeFile(file, JSON.stringify(value));
  const running = launch(root, ['up', '--file', file, '--state-dir', stateDir, '--json']);
  t.after(async () => { if (running.child.exitCode === null) running.child.kill('SIGTERM'); await running.done; await rm(root, { recursive: true, force: true }); });
  await until(async () => { try { await lstat(join(stateDir, 'lines/alpha/runtime.lock')); return true; } catch { return false; } }, 'first line ownership');
  const stopped = await launch(root, ['stop', '--state-dir', stateDir, '--json']).done;
  assert.equal(stopped.code, 0, stopped.output); assert.equal((await running.done).code, 0);
  assert.equal(JSON.parse((await launch(root, ['status', '--state-dir', stateDir, '--json']).done).output).state, 'stopped');
  for (const line of value.productionLines) {
    await assert.rejects(lstat(join(stateDir, 'lines', line.id, 'runtime.lock')), { code: 'ENOENT' });
    await assert.rejects(fetch(`http://127.0.0.1:${line.orchestrator.port}/healthz`, { signal: AbortSignal.timeout(1000) }));
  }
  assert.deepEqual(await loadSystem(stateDir), validateDefinition(value));
});


test('system service state rejects symlinked Factory and line containers', async t => {
  if (process.platform === 'win32') return;
  const root = await directory(t), stateDir = join(root, 'state'), value = validateDefinition(definition()); await setupSystem(value, { stateDir });
  for (const name of ['factory', 'lines']) {
    const original = join(stateDir, name), moved = join(root, name); await rename(original, moved); await symlink(moved, original);
    await assert.rejects(factoryCredentials(stateDir, value), /private real directory/);
    await rm(original); await rename(moved, original);
  }
});


test('bootstrap validates all authenticated line capabilities before any Factory mutation', async t => {
  const value = validateDefinition(definition()), adminToken = 'f'.repeat(64), credentials = { WERK_LINE_SYSTEM_1_TOKEN: 'a'.repeat(64), WERK_LINE_SYSTEM_2_TOKEN: 'b'.repeat(64) };
  const received = []; let mutationRequests = 0;
  const server = httpServer((request, response) => {
    if (request.url !== '/v1/capabilities') { mutationRequests++; response.writeHead(500); response.end('{}'); return; }
    received.push(request.headers.authorization);
    // Alpha is valid; the second service incorrectly announces alpha instead of beta.
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ schemaVersion: 1, project: 'alpha', execution: 'mock', context: 'unbound', intake: ['structured_task', 'requirement_ref'], providers: [], profiles: [], profilesTruncated: false,
      capacity: { kind: 'observed', observedAt: new Date().toISOString(), workers: { total: 0, online: 0, offline: 0, slotsTotal: 0, slotsBusy: 0, slotsAvailable: 0 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(bootstrapSystem(value, { adminToken, credentials }, { factoryUrl: url, internalUrls: [url, url] }), /different project/);
  assert.deepEqual(received, ['Bearer ' + credentials.WERK_LINE_SYSTEM_1_TOKEN, 'Bearer ' + credentials.WERK_LINE_SYSTEM_2_TOKEN]);
  assert.equal(mutationRequests, 0);
});
