import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeExecution, workerDocument } from '../../scripts/runtime/execution.mjs';
import { loadConfig, setup, validateConfig } from '../../scripts/runtime/config.mjs';
import { loadDefinition, validateDefinition, planDefinition } from '../../scripts/system/definition.mjs';
import { prepare } from '../../scripts/infrastructure/cloud-init.mjs';
const execution = () => ({ mode: 'cli', codex: { executable: '/opt/codex/bin/codex', repository: '/srv/approved-project', allowedPaths: ['README.md', 'docs/example.txt'] } });
const definition = () => ({ schemaVersion: 1, id: 'live-example', environment: 'native', factory: { id: 'factory', name: 'Factory', port: 3100 }, productionLines: [{ id: 'line', name: 'Line', project: 'example', orchestrator: { port: 3001 }, workers: { count: 1, statusPort: 4101, execution: execution() } }] });
const config = () => ({ schemaVersion: 1, project: 'example', runtime: 'native', orchestratorPort: 3001, workerPort: 4101, workers: 1, mode: 'cli', execution: execution() });
async function temporary(t) { const path = await mkdtemp(join(tmpdir(), 'werk-live-config-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('live deployment policy is copied, defaults timeout and restricts worker attempts/concurrency', () => {
  const input = execution(), normalized = normalizeExecution(input);
  assert.equal(normalized.timeoutMs, 300000); assert.equal(input.timeoutMs, undefined);
  normalized.codex.allowedPaths.push('new.txt'); assert.equal(input.codex.allowedPaths.length, 2);
  assert.deepEqual(workerDocument(input), { schemaVersion: 1, execution: normalizeExecution(input), scheduler: { maxParallel: 1, maxAttempts: 1 }, profiles: [{ id: 'codex-live', provider: 'codex', mode: 'cli', maxParallel: 1 }] });
  assert.equal(normalizeExecution(undefined), undefined); assert.equal(workerDocument(undefined), undefined);
});

test('live deployment rejects injected configuration, secret paths, traversal and unbounded policies without reflecting secrets', () => {
  const invalid = [
    value => { value.token = 'do-not-print-secret'; }, value => { value.mode = 'mock'; },
    value => { value.codex.executable = 'codex'; }, value => { value.codex.repository = 'relative/path'; },
    value => { value.codex.executable = '/usr/bin/codex\n--dangerous'; }, value => { value.codex.extra = 'do-not-print-secret'; },
    ...['../outside.txt', '/outside.txt', '.env', 'src/.hidden', 'credentials.json', 'docs/secret.txt', 'keys/private.pem', 'id_rsa', 'a\\b', '-option', 'a//b'].map(path => value => { value.codex.allowedPaths = [path]; }),
    value => { value.codex.allowedPaths = []; }, value => { value.codex.allowedPaths = ['a.txt', 'a.txt']; },
    value => { value.codex.allowedPaths = Array.from({ length: 33 }, (_, n) => `${n}.txt`); },
    ...[999, 3600001, '1000', Infinity].map(timeoutMs => value => { value.timeoutMs = timeoutMs; }),
  ];
  for (const change of invalid) { const value = execution(); change(value); assert.throws(() => normalizeExecution(value), error => error.exitCode === 2 && !error.message.includes('do-not-print-secret')); }
  for (const value of [null, [], {}, true]) assert.throws(() => normalizeExecution(value));
});

test('live runtime mode cannot disagree with policy, use Docker or provision parallel workers', () => {
  assert.equal(validateConfig(config()).mode, 'cli');
  for (const change of [{ mode: 'mock' }, { runtime: 'docker' }, { workers: 2 }, { execution: undefined }]) assert.throws(() => validateConfig({ ...config(), ...change }));
  const mock = { ...config(), mode: 'mock' }; delete mock.execution;
  assert.equal(validateConfig(mock).mode, 'mock'); assert.equal(validateConfig(mock).execution, undefined);
});

test('repeated setup preserves live policy and credentials while drift is refused', async t => {
  const root = await temporary(t), stateDir = join(root, 'state');
  await setup({ stateDir, execution: execution() });
  const bytes = await readFile(join(stateDir, 'credentials.json')), before = await readFile(join(stateDir, 'config.json'));
  assert.equal((await setup({ stateDir, execution: execution() })).created, false);
  assert.equal((await setup({ stateDir })).created, false, 'omitting an optional policy preserves existing setup');
  const changed = execution(); changed.codex.allowedPaths = ['different.txt'];
  await assert.rejects(setup({ stateDir, execution: changed }), /different settings/);
  await assert.rejects(setup({ stateDir, runtime: 'docker' }), /different settings/);
  assert.deepEqual(await readFile(join(stateDir, 'credentials.json')), bytes);
  assert.deepEqual(await readFile(join(stateDir, 'config.json')), before);
  assert.equal((await loadConfig(stateDir)).mode, 'cli');
});

test('YAML live execution requires native one-worker lines and plans mixed fleets honestly', async t => {
  const root = await temporary(t), file = join(root, 'system.yaml'), input = definition();
  assert.equal(validateDefinition(input).productionLines[0].workers.execution.timeoutMs, 300000);
  assert.equal(planDefinition(input).mode, 'cli');
  const twoWorkers = definition(); twoWorkers.productionLines[0].workers.count = 2;
  assert.throws(() => validateDefinition(twoWorkers), /exactly one/);
  assert.throws(() => validateDefinition({ ...definition(), environment: 'docker' }), /native Linux/);
  input.productionLines.push({ id: 'mock-line', name: 'Mock line', project: 'mock', orchestrator: { port: 3002 }, workers: { count: 1, statusPort: 4102 } });
  assert.equal(planDefinition(input).mode, 'mixed');
  await writeFile(file, JSON.stringify(input));
  assert.equal((await loadDefinition(file)).productionLines[0].workers.execution.mode, 'cli');
  await assert.rejects(loadDefinition(file, { environment: 'docker' }), /native Linux/);
  assert.deepEqual(await readdir(root), ['system.yaml'], 'validation/override never provisions state');
});

test('cloud-init refuses live deployment rather than provisioning an unauthenticated provider', async t => {
  const root = await temporary(t), file = join(root, 'system.yaml'); await writeFile(file, JSON.stringify(definition()));
  await assert.rejects(prepare({ file, 'release-version': '0.1.0', 'release-url': 'https://releases.example.test/v0.1.0/werk-0.1.0.tar.gz', 'release-sha256': 'a'.repeat(64), 'node-url': 'https://nodejs.org/dist/v24.4.1/node-v24.4.1-linux-x64.tar.xz', 'node-sha256': 'b'.repeat(64), architecture: 'x86_64' }), /provisions mock workers/);
  assert.deepEqual(await readdir(root), ['system.yaml']);
});
