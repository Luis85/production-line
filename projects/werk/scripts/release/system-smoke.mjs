/** Independent release gate: one definition, Factory, two isolated lines, three workers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { extractRelease } from './extract.mjs';
import { apply as applyHomeUpdate, homeUpdateStatus } from '../runtime/home-update/transaction.mjs';
const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--root' || (args.length === 4 && args[2] !== '--update-archives')) throw Error('Usage: node scripts/release/system-smoke.mjs --root EXTRACTED_RELEASE [--update-archives ARCHIVES]');
let root = resolve(args[1]);
const homeLayout = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8')).layout === 'werk-home-v1';
let homeUpdateConfirmed = false;
const updateArchives = args[3] ? resolve(args[3]) : undefined;
const scratch = await mkdtemp(join(tmpdir(), 'werk system smoke '));
if (updateArchives) {
  const original = root; root = join(scratch, 'previous release');
  await cp(original, root, { recursive: true });
  const manifestPath = join(root, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '0.0.0'; // Previous protocol-compatible version fixture.
  await writeFile(manifestPath, JSON.stringify(manifest));
}
const state = join(scratch, 'private system');
const file = join(scratch, 'system definition.yaml');
const hash = value => createHash('sha256').update(value).digest('hex');
const output = [];
let launcher;
async function portRange(count = 1) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const servers = [];
    try {
      for (let index = 0; index < count; index++) {
        const server = createServer(); servers.push(server);
        await new Promise((ok, fail) => { server.once('error', fail); server.listen(index ? servers[0].address().port + index : 0, '127.0.0.1', ok); });
      }
      return servers[0].address().port;
    } catch { /* Retry unavailable contiguous range. */ }
    finally { await Promise.all(servers.map(server => new Promise(ok => server.close(ok)))); }
  }
  throw Error('Could not allocate smoke ports');
}
function cli(command) {
  const forwarded = [...(command[0] === 'up' ? command : ['system', ...command]), '--state-dir', state, '--json'];
  // Substitute only GitHub transport. Startup, selection, extraction, preflight,
  // state backup and the upgraded services execute the actual packaged code.
  const driver = `
    import {readFile} from 'node:fs/promises'; import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
    const [root, archives, encoded] = process.argv.slice(1);
    const {runNative}=await import(pathToFileURL(join(root,'scripts/runtime/update/launcher.mjs')));
    const sums=await readFile(join(archives,'SHA256SUMS'));
    const name=sums.toString().split('\\n').map(x=>x.split('  ')[1]).find(x=>x?.endsWith('.tar.gz'));
    const version=name.slice(5,-7);
    const fetcher=async url=>{
      if(url==='https://github.com/Luis85/production-line/releases/latest/download/SHA256SUMS') return new Response(sums);
      if(url!=='https://github.com/Luis85/production-line/releases/download/v'+version+'/'+name) throw Error('Unexpected update URL');
      return new Response(await readFile(join(archives,name)));
    };
    process.exitCode=await runNative(root,JSON.parse(encoded),{fetcher,environment:{...process.env,WERK_AUTO_UPDATE:'1'}});
  `;
  const entry = updateArchives && !homeLayout && command[0] === 'start'
    ? ['--input-type=module', '-e', driver, root, updateArchives, JSON.stringify(forwarded)]
    : [join(root, 'werk.mjs'), ...forwarded];
  const child = spawn(process.execPath, entry, { cwd: root, env: { ...process.env, WERK_AUTO_UPDATE: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; if (stdout.length > 1048576) child.kill(); });
  child.stderr.on('data', value => { stderr += value; if (stderr.length > 1048576) child.kill(); });
  const completion = new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('close', (code, signal) => { output.push(stdout, stderr); ok({ code, signal, stdout, stderr }); });
  });
  return { child, completion };
}
async function command(args, code = 0) {
  const run = cli(args), timer = setTimeout(() => run.child.kill(), 45000);
  try {
    const result = await run.completion;
    let diagnostic;
    try { diagnostic = JSON.parse(result.stdout).error?.message; } catch { /* Only structured runtime diagnostics are safe to surface. */ }
    assert.equal(result.code, code, `System ${args[0]} unexpected exit: ${diagnostic ?? 'no structured error; inspect locally'}`);
    return JSON.parse(result.stdout);
  } finally { clearTimeout(timer); }
}
async function eventually(probe, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (launcher && launcher.child.exitCode !== null) {
      const result = await launcher.completion;
      throw Error(`System exited before ${label} (exit ${result.code}): ${result.stdout.trim()}`);
    }
    try { const result = await probe(); if (result) return result; } catch { /* Retry bounded local readiness. */ }
    await new Promise(ok => setTimeout(ok, 150));
  }
  throw Error('Timed out waiting for ' + label);
}
async function stop() {
  if (!launcher) return;
  const current = launcher;
  await command(['stop']); // Persisted identity works without the original YAML file.
  const timer = setTimeout(() => current.child.kill(), 30000);
  try { assert.equal((await current.completion).code, 0, 'System graceful shutdown failed'); launcher = undefined; }
  finally { clearTimeout(timer); }
}
try {
  let definition;
  for (;;) {
    definition = { schemaVersion: 1, id: 'release-system', environment: 'native', factory: { id: 'release-factory', name: 'Release Factory', port: await portRange(), subFactories: [{ id: 'delivery-group', name: 'Delivery group' }] }, productionLines: [
      { id: 'alpha', name: 'Alpha', project: 'same-project', orchestrator: { port: await portRange() }, workers: { count: 2, statusPort: await portRange(2) } },
      { id: 'beta', name: 'Beta', factoryId: 'delivery-group', project: 'same-project', orchestrator: { port: await portRange() }, workers: { count: 1, statusPort: await portRange() } },
    ] };
    const ports = [definition.factory.port, ...definition.productionLines.flatMap(line => [line.orchestrator.port, ...Array.from({ length: line.workers.count }, (_, i) => line.workers.statusPort + i)])];
    if (new Set(ports).size === ports.length) break;
  }
  await writeFile(file, JSON.stringify(definition, null, 2)); // JSON is a strict subset of YAML.
  await command(['plan', '--file', file]);
  await assert.rejects(access(state), { code: 'ENOENT' });
  await command(['setup', '--file', file]);
  const credentialFiles = [join(state, 'factory', 'credentials.json'), ...definition.productionLines.map(line => join(state, 'lines', line.id, 'credentials.json'))];
  const credentials = await Promise.all(credentialFiles.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const before = await Promise.all(credentialFiles.map(async path => hash(await readFile(path))));
  const request = async (port, token, path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw Error('Local application HTTP ' + response.status);
    return response.json();
  };
  const lineCall = (index, path, options) => request(definition.productionLines[index].orchestrator.port, credentials[index + 1].WERK_ADMIN_TOKEN, path, options);
  const factoryCall = path => request(definition.factory.port, credentials[0].WERK_FACTORY_ADMIN_TOKEN, path);
  const ready = async () => {
    const registry = await factoryCall('/v1/lines');
    if (registry.lines.length !== 2 || registry.lines.some(line => line.factoryId !== (line.id === 'beta' ? 'delivery-group' : definition.factory.id))) return false;
    for (let index = 0; index < 2; index++) {
      const line = definition.productionLines[index], overview = await lineCall(index, '/v1/overview');
      if (overview.project !== line.project || overview.workers.online !== line.workers.count) return false;
      for (let worker = 0; worker < line.workers.count; worker++) {
        const response = await fetch(`http://127.0.0.1:${line.workers.statusPort + worker}/status`, { signal: AbortSignal.timeout(1500) });
        const status = await response.json();
        if (!response.ok || status.project !== line.project || !['idle', 'executing'].includes(status.state)) return false;
      }
    }
    return true;
  };
  launcher = cli(['up', '--file', file, '--no-open']);
  await eventually(ready, 'whole-system readiness');
  const factories = (await factoryCall('/v1/factories')).factories;
  assert.equal(factories.length, 2);
  assert.equal(factories.find(item => item.id === 'delivery-group').parentId, definition.factory.id);
  assert.equal((await command(['status'])).ok, true);
  assert.equal((await command(['doctor'])).ok, true);
  const workerIds = await Promise.all([0, 1].map(async index => (await lineCall(index, '/v1/workers?limit=100')).workers.map(worker => worker.id).sort()));
  const tasks = [];
  for (let index = 0; index < 2; index++) {
    const task = await lineCall(index, '/v1/tasks', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ project: 'same-project', title: `Isolated line ${index}`, criteria: ['Mock evidence stays in this production line.'] }) });
    tasks.push(task);
    await eventually(async () => (await lineCall(index, '/v1/tasks/' + task.id)).status === 'simulated', 'line task completion');
    assert.equal((await lineCall(index, '/v1/snapshots?task=' + encodeURIComponent(task.id))).snapshots.length, 2);
    const other = 1 - index;
    const absent = await fetch(`http://127.0.0.1:${definition.productionLines[other].orchestrator.port}/v1/tasks/${task.id}`, { headers: { Authorization: 'Bearer ' + credentials[other + 1].WERK_ADMIN_TOKEN }, signal: AbortSignal.timeout(2000) });
    assert.equal(absent.status, 404, 'Task crossed production-line isolation boundary');
  }
  await stop();
  await command(['setup', '--file', file]);
  assert.deepEqual(await Promise.all(credentialFiles.map(async path => hash(await readFile(path)))), before);
  const changed = structuredClone(definition); changed.productionLines[0].name = 'Changed topology';
  await writeFile(file, JSON.stringify(changed));
  await command(['setup', '--file', file], 2);
  assert.deepEqual(await Promise.all(credentialFiles.map(async path => hash(await readFile(path)))), before);
  await writeFile(file, JSON.stringify(definition));
  if (updateArchives && homeLayout) {
    const candidate = await extractRelease(updateArchives, join(scratch, 'Home update candidate'));
    const receipt = await applyHomeUpdate(root, candidate.root, { stateDirectory: state }); assert.equal(receipt.status, 'confirmed'); homeUpdateConfirmed = true;
  }
  launcher = cli(['start', '--file', file, '--no-open']);
  await eventually(ready, 'whole-system restart');
  for (let index = 0; index < 2; index++) {
    assert.equal((await lineCall(index, '/v1/tasks/' + tasks[index].id)).status, 'simulated');
    assert.deepEqual((await lineCall(index, '/v1/workers?limit=100')).workers.map(worker => worker.id).sort(), workerIds[index]);
  }
  await stop();
  if (updateArchives && homeLayout) {
    assert.equal((await homeUpdateStatus(root)).status, 'confirmed'); assert.equal(homeUpdateConfirmed, true);
    assert.deepEqual(await Promise.all(credentialFiles.map(async path => hash(await readFile(path)))), before);
  } else if (updateArchives) {
    const selected = JSON.parse(await readFile(state + '.updates/selection.json', 'utf8'));
    assert.notEqual(selected.active, '0.0.0');
    assert.equal(selected.previous, '0.0.0');
    assert.ok(selected.backup);
    assert.ok(output.some(value => value.includes('\"event\":\"updated\"')));
    assert.deepEqual(await Promise.all(credentialFiles.map(async path => hash(await readFile(path)))), before);
  }
  for (const record of credentials) for (const secret of Object.values(record)) assert.ok(output.every(value => !value.includes(secret)), 'Runtime output exposed a credential');
  console.log(JSON.stringify({ ok: true, runtime: 'native-system', extractedRelease: root, factoryServices: 1, logicalFactories: 2, lines: 2, workers: 3, isolatedSimulatedTasks: 2, restartPreserved: true, automaticUpgradeVerified: Boolean(updateArchives) && !homeLayout, selectiveHomeUpgradeVerified: homeUpdateConfirmed, planReadOnly: true, driftRejected: true }));
} finally {
  if (launcher) { await stop().catch(() => launcher?.child.kill()); await launcher?.completion; }
  await rm(scratch, { recursive: true, force: true });
}
