import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, chmod, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const source = fileURLToPath(new URL('../../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ports() {
  const servers = [];
  try {
    for (let n = 0; n < 3; n++) { const server = createServer(); servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined))); }
    return servers.map(server => testListeningAddress(server).port);
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}

test('extracted native YAML system executes a subprocess fixture into durable review evidence and preserves live identity', { skip: process.platform !== 'linux', timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-live-native-'));
  const root = join(directory, 'release'), repository = join(directory, 'approved-repository');
  const state = join(directory, 'private-state'), file = join(directory, 'system.yaml');
  const executable = join(directory, 'provider-fixture'), providerHome = join(directory, 'provider-home');
  const processes = [];
  await mkdir(root); await mkdir(repository); await mkdir(providerHome);
  function launch(args) {
    const child = spawn(process.execPath, [join(root, 'werk.mjs'), 'system', ...args, '--state-dir', state, '--json'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: providerHome, WERK_ADMIN_TOKEN: 'must-not-reach-provider', AWS_SECRET_ACCESS_KEY: 'must-not-reach-provider' },
    });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1048576) child.kill(); });
    child.stderr.on('data', chunk => { errors += chunk; if (errors.length > 1048576) child.kill(); });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, output, errors })); });
    const item = { child, done, get output() { return output; } }; processes.push(item); return item;
  }
  t.after(async () => {
    const stop = launch(['stop']); const deadline = setTimeout(() => stop.child.kill(), 40000);
    await stop.done; clearTimeout(deadline);
    for (const item of processes) if (item.child.exitCode === null) item.child.kill('SIGTERM');
    await Promise.all(processes.map(item => item.done));
    await rm(directory, { recursive: true, force: true });
  });
  await cp(join(source, 'werk.mjs'), join(root, 'werk.mjs'));
  for (const concern of ['runtime', 'system']) await cp(join(source, 'scripts', concern), join(root, 'scripts', concern), { recursive: true });
  for (const app of ['factory', 'orchestrator', 'worker']) await cp(join(source, 'src', app, 'dist'), join(root, 'src', app, 'dist'), { recursive: true });
  await assert.rejects(lstat(join(root, 'node_modules')), { code: 'ENOENT' });
  await writeFile(join(repository, 'README.md'), '# Operator source\n');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', 'README.md'); git('-c', 'user.name=Werk fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial fixture');
  const baseCommit = git('rev-parse', 'HEAD');
  // This deterministic executable tests real subprocess/environment wiring. It is not an AI model or Codex authentication test.
  await writeFile(executable, `#!${process.execPath}\nconst assert = require('node:assert/strict');\nassert.equal(process.env.CODEX_HOME, ${JSON.stringify(providerHome)});\nassert.equal(process.env.WERK_ADMIN_TOKEN, undefined);\nassert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined);\nassert.ok(process.argv.includes('workspace-write'));\nassert.ok(process.argv.includes('approval_policy="never"'));\nrequire('node:fs').appendFileSync('README.md', 'Fixture change requires human review.\\n');\n`);
  await chmod(executable, 0o700);
  const [factoryPort, linePort, workerPort] = await ports();
  await writeFile(file, JSON.stringify({ schemaVersion: 1, id: 'live-system', environment: 'native', factory: { id: 'factory', name: 'Live Factory', port: factoryPort }, productionLines: [{ id: 'line', name: 'Live line', project: 'fixture', orchestrator: { port: linePort }, workers: { count: 1, statusPort: workerPort, execution: { mode: 'cli', timeoutMs: 10000, codex: { executable, repository, allowedPaths: ['README.md'] } } } }] }));
  async function until(check, label) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await check()) return; await delay(80); }
    throw Error(`Timed out: ${label}`);
  }
  async function started(args) {
    const running = launch(args);
    await until(() => { assert.equal(running.child.exitCode, null, 'System exited before readiness'); return running.output.includes('"event":"ready"'); }, 'native system readiness');
    assert.ok(running.output.includes('"mode":"cli"'));
    return running;
  }
  const first = await started(['up', '--file', file, '--no-open']);
  const credentials = JSON.parse(await readFile(join(state, 'lines/line/credentials.json'), 'utf8'));
  async function request(path, body) {
    const response = await fetch(`http://127.0.0.1:${linePort}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credentials.WERK_ADMIN_TOKEN}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, body ? 201 : 200, `Unexpected HTTP response for ${path}`); return response.json();
  }
  assert.equal((await request('/v1/capabilities')).execution, 'cli');
  const mock = await request('/v1/tasks', { project: 'fixture', title: 'Keep simulated task queued', criteria: ['Must not run in the live worker'], provider: 'codex' });
  const live = await request('/v1/tasks', { project: 'fixture', title: 'Update approved README', criteria: ['Create a patch requiring review'], provider: 'codex', executionMode: 'cli' });
  await until(async () => { const task = await request(`/v1/tasks/${live.id}`); assert.notEqual(task.status, 'blocked', 'Fixture live execution unexpectedly failed'); return task.status === 'review'; }, 'review completion');
  const snapshots = (await request(`/v1/snapshots?task=${live.id}`)).snapshots;
  assert.equal(snapshots.length, 2);
  const after = snapshots.find(item => item.snapshot.phase === 'after').snapshot;
  assert.equal(after.mode, 'cli'); assert.equal(after.execution.outcome, 'change-set');
  assert.equal(after.quality.tests, 'not_run'); assert.equal(after.usage.source, 'unavailable_provider');
  assert.equal(after.review.baseCommit, baseCommit);
  const workerState = join(state, 'lines/line/workers/worker-1');
  const identity = await readFile(join(workerState, 'identity.json'), 'utf8');
  const patch = await readFile(join(workerState, after.review.artifactPath));
  assert.equal(createHash('sha256').update(patch).digest('hex'), after.review.patchSha256);
  assert.equal(patch.length, after.review.patchBytes); assert.match(patch.toString(), /Fixture change requires human review/);
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), '# Operator source\n');
  assert.equal(git('rev-parse', 'HEAD'), baseCommit); assert.equal(git('status', '--porcelain'), '');
  assert.equal((await request(`/v1/tasks/${mock.id}`)).status, 'queued');
  assert.equal((await launch(['stop']).done).code, 0); assert.equal((await first.done).code, 0);
  const second = await started(['start', '--file', file, '--no-open']);
  assert.equal(await readFile(join(workerState, 'identity.json'), 'utf8'), identity);
  assert.equal((await request(`/v1/tasks/${live.id}`)).status, 'review');
  assert.equal((await request(`/v1/tasks/${mock.id}`)).status, 'queued');
  assert.deepEqual(await readFile(join(workerState, after.review.artifactPath)), patch);
  assert.equal((await request(`/v1/snapshots?task=${live.id}`)).snapshots.length, 2);
  assert.equal((await launch(['stop']).done).code, 0); assert.equal((await second.done).code, 0);
  for (const value of Object.values(credentials)) assert.ok(processes.every(item => !item.output.includes(value)), 'Runtime output exposed credentials');
});
