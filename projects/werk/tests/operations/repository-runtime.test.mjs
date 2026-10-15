import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeRepositories, workerDocument } from '../../scripts/runtime/execution.mjs';
import { loadConfig, validateConfig } from '../../scripts/runtime/config.mjs';
import { validateDefinition, planDefinition } from '../../scripts/system/definition.mjs';
import { setupSystem, factoryCredentials } from '../../scripts/system/state.mjs';
import { formatPlan } from '../../scripts/system/plan-view.mjs';

const repositories = () => ({ items: [{ id: 'app', path: resolve('/srv/app'), branch: 'main' }, { id: 'docs', path: resolve('/srv/docs'), watch: false }] });
const execution = () => ({ mode: 'cli', codex: { executable: '/opt/codex', allowedPaths: ['README.md'] } });
const definition = () => ({ schemaVersion: 1, id: 'repositories', environment: 'native', factory: { id: 'factory', name: 'Factory', port: 3100 }, productionLines: [{ id: 'line', name: 'Line', project: 'app', orchestrator: { port: 3001 }, workers: { count: 1, statusPort: 4101, execution: execution(), repositories: repositories() } }] });

test('runtime worker documents preserve multiple assignments without a legacy Codex checkout', async () => {
  const input = repositories(), normalized = normalizeRepositories(input);
  assert.deepEqual(normalized, { pollMs: 30000, items: [{ id: 'app', path: resolve('/srv/app'), remote: 'origin', branch: 'main', watch: true }, { id: 'docs', path: resolve('/srv/docs'), remote: 'origin', watch: false }] });
  const document = workerDocument(execution(), undefined, input);
  assert.deepEqual(document.repositories, normalized);
  assert.equal(document.execution.codex.repository, undefined);
  assert.equal(workerDocument(undefined, undefined, input).execution, undefined, 'assignments do not enable live execution');
  document.repositories.items[0].id = 'changed';
  assert.equal(input.items[0].id, 'app', 'normalization does not mutate operator input');
  const { configuration } = await import('../../src/worker/dist/worker/config.js');
  const configured = await configuration({}, workerDocument(undefined, undefined, input));
  assert.deepEqual(configured.repositories, normalized, 'managed child payload is accepted by the installed worker configuration');
  if (process.platform === 'linux') assert.deepEqual((await configuration({}, workerDocument(execution(), undefined, input))).repositories, normalized);
  assert.throws(() => workerDocument(execution()), /configuration/);
});

test('runtime assignment validation rejects ambiguous or unsafe references without echoing input', () => {
  const invalid = [null, [], { items: null }, { items: [{ id: 'app', path: 'relative' }] }, { items: [{ id: 'app', path: '/srv/app\u0000' }] }, { pollMs: 999 }, { pollMs: 3600001 }, { items: [{ id: 'app', path: resolve('/srv/app'), remote: '--upload-pack' }] }, { items: [{ id: 'app', path: resolve('/srv/app'), branch: 'main..other' }] }, { items: [{ id: 'app', path: resolve('/srv/app'), watch: 'true' }] }, { items: [{ id: 'app', path: resolve('/srv/app'), token: 'never-echo-secret' }] }, { items: [{ id: 'app', path: '/srv/app' }, { id: 'app', path: '/srv/other' }] }, { items: [{ id: 'app', path: '/srv/app' }, { id: 'other', path: '/srv/other/../app' }] }];
  for (const value of invalid) assert.throws(() => normalizeRepositories(value), error => error.exitCode === 2 && !error.message.includes('never-echo-secret'));
  const base = { schemaVersion: 1, project: 'app', runtime: 'native', orchestratorPort: 3001, workerPort: 4101, workers: 1, mode: 'cli', execution: execution() };
  assert.throws(() => validateConfig(base), /repository/);
  assert.deepEqual(validateConfig({ ...base, repositories: repositories() }).repositories, normalizeRepositories(repositories()));
  assert.throws(() => validateConfig({ ...base, runtime: 'docker', repositories: repositories() }), /native/);
  const system = definition(); system.environment = 'docker';
  assert.throws(() => validateDefinition(system), /native/);
});

test('system setup carries assignments into each line and detects assignment drift without replacing state', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'werk-repository-runtime-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const input = definition(), normalized = validateDefinition(input);
  await setupSystem(input, { stateDir });
  const linePath = join(stateDir, 'lines/line/config.json'), before = await readFile(linePath, 'utf8');
  assert.deepEqual((await loadConfig(join(stateDir, 'lines/line'))).repositories, normalized.productionLines[0].workers.repositories);
  assert.equal((await setupSystem(input, { stateDir })).created, false);
  await factoryCredentials(stateDir, normalized);
  const changed = definition(); changed.productionLines[0].workers.repositories.items[0].branch = 'release';
  await assert.rejects(setupSystem(changed, { stateDir }), /differs/);
  assert.equal(await readFile(linePath, 'utf8'), before);
  const tampered = JSON.parse(before); tampered.repositories.items[0].watch = false;
  await writeFile(linePath, JSON.stringify(tampered), { mode: 0o600 });
  await assert.rejects(factoryCredentials(stateDir, normalized), /differs/);
});

test('system plan exposes repository assignment ids and paths while retaining explicit execution mode', () => {
  const plan = planDefinition(definition());
  assert.equal(plan.mode, 'cli');
  assert.deepEqual(plan.productionLines[0].workers.repositories, normalizeRepositories(repositories()));
  const rendered = formatPlan(plan);
  assert.ok(rendered.includes(`app → ${resolve('/srv/app')}, docs → ${resolve('/srv/docs')}`));
  assert.match(rendered, /assigned repositories by task repository or project/);
  assert.doesNotMatch(rendered, /undefined/);
});
