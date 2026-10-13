import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--root') throw Error('Usage: node scripts/release/smoke.mjs --root EXTRACTED_RELEASE');
const root = resolve(args[1]);
const temporary = await mkdtemp(join(tmpdir(), 'werk release smoke '));
const state = join(temporary, 'private state');
let launcher;
const digest = value => createHash('sha256').update(value).digest('hex');
async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return port;
}
function cli(command) {
  const child = spawn(process.execPath, [join(root, 'werk.mjs'), ...command, '--state-dir', state, '--json'], {
    cwd: root, env: { ...process.env, WERK_AUTO_UPDATE: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill(); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
  const completion = new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => ok({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}
async function command(args) {
  const running = cli(args);
  const timeout = setTimeout(() => running.child.kill(), 25000);
  try {
    const result = await running.completion;
    if (result.code !== 0) throw Error(`Runtime ${args[0]} failed (exit ${result.code ?? result.signal}); inspect that command in the extracted release.`);
    return result;
  } finally { clearTimeout(timeout); }
}
async function eventually(probe, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launcher?.child.exitCode !== null && launcher?.child.exitCode !== undefined) throw Error('Runtime exited before readiness');
    try { const value = await probe(); if (value) return value; } catch { /* Retry transient local startup/processing failures. */ }
    await new Promise(ok => setTimeout(ok, 150));
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function stop() {
  if (!launcher) return;
  const current = launcher;
  await command(['stop']);
  const deadline = setTimeout(() => current.child.kill(), 25000);
  try {
    const result = await current.completion;
    if (result.code !== 0) throw Error('Runtime failed during graceful stop');
    launcher = undefined;
  } finally { clearTimeout(deadline); }
}
try {
  const port = await freePort();
  let workerPort = await freePort();
  while (workerPort === port) workerPort = await freePort();
  await command(['setup', '--project', 'release-smoke', '--port', String(port), '--worker-port', String(workerPort), '--workers', '1']);
  const credentialsPath = join(state, 'credentials.json');
  const credentialsBytes = await readFile(credentialsPath);
  const credentials = JSON.parse(credentialsBytes);
  const configurationBefore = digest(await readFile(join(state, 'config.json')));
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: {
      Authorization: `Bearer ${credentials.WERK_ADMIN_TOKEN}`, 'Content-Type': 'application/json', ...options.headers,
    }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw Error(`Local API ${response.status}`);
    return response.json();
  };
  const ready = async () => {
    const overview = await request('/v1/overview');
    const response = await fetch(`http://127.0.0.1:${workerPort}/healthz`, { signal: AbortSignal.timeout(2000) });
    const worker = response.ok ? await response.json() : null;
    return overview.project === 'release-smoke' && overview.workers.online >= 1 && worker?.project === 'release-smoke' && typeof worker.workerId === 'string';
  };
  launcher = cli(['start', '--no-open']);
  await eventually(ready, 'orchestrator and worker readiness');
  await command(['doctor']);
  await command(['status']);
  const workers = (await request('/v1/workers?limit=100')).workers.map(worker => worker.id).sort();
  const task = await request('/v1/tasks', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ project: 'release-smoke', title: 'Verify the extracted release', criteria: ['The mock attempt records before and after evidence.'] }) });
  await eventually(async () => (await request('/v1/tasks/' + task.id)).status === 'simulated', 'simulated task result');
  const snapshots = (await request('/v1/snapshots?task=' + encodeURIComponent(task.id))).snapshots;
  if (snapshots.length !== 2 || snapshots.map(item => item.snapshot.phase).sort().join(',') !== 'after,before') {
    throw Error('Extracted release did not persist exactly one before/after snapshot pair');
  }
  await stop();
  await command(['setup']);
  if (digest(await readFile(credentialsPath)) !== digest(credentialsBytes)
    || digest(await readFile(join(state, 'config.json'))) !== configurationBefore) throw Error('Repeated setup changed existing configuration or credentials');
  launcher = cli(['start', '--no-open']);
  await eventually(ready, 'restart readiness');
  if ((await request('/v1/tasks/' + task.id)).status !== 'simulated') throw Error('Restart lost the completed mock task');
  const restoredWorkers = (await request('/v1/workers?limit=100')).workers.map(worker => worker.id).sort();
  if (JSON.stringify(restoredWorkers) !== JSON.stringify(workers)) throw Error('Restart changed persistent worker identity');
  if ((await request('/v1/snapshots?task=' + encodeURIComponent(task.id))).snapshots.length !== 2) throw Error('Restart duplicated mock evidence');
  await stop();
  process.stdout.write(JSON.stringify({ ok: true, runtime: 'native', extractedRelease: root, task: 'simulated', snapshots: 2, restartPreserved: true }) + '\n');
} finally {
  if (launcher) {
    await stop().catch(() => { launcher?.child.kill(); });
    await launcher?.completion;
  }
  await rm(temporary, { recursive: true, force: true });
}
