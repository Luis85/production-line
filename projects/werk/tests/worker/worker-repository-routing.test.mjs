import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';

// Routing scenarios begin after native setup; cold startup ownership is covered separately.
prepareNativeProcessFixture();

/** @param {WorkerWorkspace} workspace */
function context(workspace) {
  // @ts-expect-error Inspect the real status seam to observe accepted work waiting behind the executor.
  return workspace.context;
}

async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('Repository advertisement timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function updateRepositoriesWhenIdle(workspace, items) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { return await workspace.updateSettings({ repositories: { items } }); }
    catch (error) { if (error.code !== 'conflict' || Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('claims refresh saved assignments, withdraw removed repositories, and reuse identity on restart', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-repository-routing-'));
  // Offline/missing checkouts still advertise their configured assignment; preparation reports availability.
  const items = ['web', 'api'].map(id => ({ id, path: join(root, id), watch: false }));
  const config = await configuration({ 'poll-ms': '100' }, { repositories: { items } });
  /** @type {WorkerWorkspace | undefined} */
  let workspace;
  let run, stop = new AbortController(), registrations = 0;
  const claims = [];
  const originalInit = WorkerWorkspace.prototype.init;
  WorkerWorkspace.prototype.init = async function (options) { await originalInit.call(this, options); workspace = this; };
  t.after(async () => { stop.abort(); await run; WorkerWorkspace.prototype.init = originalInit; await rm(root, { recursive: true, force: true }); });
  const client = {
    async currentAssignments() { return []; },
    async claim(requestId, queueCapacity, repositoryIds, legacyRepository) { claims.push({ repositoryIds, legacyRepository }); return null; },
    async publishSnapshot() {},
    async heartbeat() { throw Error('No task should be assigned'); },
    async complete() { throw Error('No task should be assigned'); },
    async abandon() { throw Error('No task should be assigned'); },
  };
  const gateway = {
    async register(profiles, policy) {
      registrations++;
      assert.deepEqual(policy.repositoryIds, ['web', 'api']);
      assert.equal(policy.legacyRepository, false);
      assert.equal(policy.configHash, config.policy.configHash);
      return { id: 'worker-one', token: 'fixture-token', project: 'alpha' };
    },
    connect() { return client; },
  };
  const launch = () => runWorker({ ...config, stateDir: join(root, 'state'), url: 'http://orchestrator.invalid', enrollmentToken: 'fixture', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal, { gateway });
  run = launch();
  await until(() => claims.length && workspace?.nativeWorkReady);
  assert.deepEqual(claims.at(-1), { repositoryIds: ['web', 'api'], legacyRepository: false });
  await updateRepositoriesWhenIdle(workspace, [items[1]]);
  await until(() => claims.at(-1).repositoryIds.join(',') === 'api');
  await updateRepositoriesWhenIdle(workspace, []);
  await until(() => claims.at(-1).repositoryIds.length === 0);
  stop.abort(); await run;
  const identity = await readFile(join(root, 'state', 'identity.json'), 'utf8');
  claims.length = 0; stop = new AbortController(); run = launch();
  await until(() => claims.length && workspace?.nativeWorkReady);
  assert.deepEqual(claims.at(-1), { repositoryIds: [], legacyRepository: false });
  assert.equal(registrations, 1, 'repository changes do not force re-enrollment');
  assert.equal(await readFile(join(root, 'state', 'identity.json'), 'utf8'), identity);
});

test('legacy CLI fallback is advertised separately from explicit repository assignments', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-legacy-routing-')), stop = new AbortController();
  const config = await configuration({ 'poll-ms': '100' });
  // The injected adapter never executes; still advertise a valid live profile on every test platform.
  config.profiles = [{ id: 'codex-live', provider: 'codex', mode: 'cli', maxParallel: 1 }];
  config.policy = { ...config.policy, maxAttempts: 1, configHash: 'b'.repeat(64) };
  let run, claim;
  t.after(async () => { stop.abort(); await run; await rm(root, { recursive: true, force: true }); });
  const gateway = {
    async register(profiles, policy) {
      assert.deepEqual(policy.repositoryIds, []);
      assert.equal(policy.legacyRepository, true);
      return { id: 'worker-one', token: 'fixture-token', project: 'alpha' };
    },
    connect() { return {
      async currentAssignments() { return []; },
      async claim(requestId, queueCapacity, repositoryIds, legacyRepository) { claim = { repositoryIds, legacyRepository }; return null; },
      async publishSnapshot() {},
    async heartbeat() { throw Error('No task should be assigned'); },
    async complete() { throw Error('No task should be assigned'); },
    async abandon() { throw Error('No task should be assigned'); },
    }; },
  };
  run = runWorker({ ...config, codex: { executable: process.execPath, repository: root, allowedPaths: ['file.txt'] }, stateDir: join(root, 'state'), url: 'http://orchestrator.invalid', enrollmentToken: 'fixture', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal, { gateway, adapter: { mode: 'cli', async run() { throw Error('No task should be assigned'); } } });
  await until(() => claim);
  assert.deepEqual(claim, { repositoryIds: [], legacyRepository: true });
});


for (const pendingOperation of ['currentAssignments', 'claim']) {
  test(`repository mappings cannot change during pending ${pendingOperation} and assignment acceptance`, { timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'werk-repository-admission-')), stop = new AbortController();
    const initial = { id: 'selected', path: join(root, 'original'), watch: false };
    const replacement = { ...initial, path: join(root, 'replacement') };
    const config = await configuration({ profiles: 'codex', 'poll-ms': '100' }, { repositories: { items: [initial] } });
    /** @type {WorkerWorkspace | undefined} */
    let workspace;
    /** @type {(() => void) | undefined} */
    let releaseExecutor;
    let run, entered = false, assigned = false, completed = false, selected;
    const {promise:pending,resolve:release}=Promise.withResolvers();
    const originalInit = WorkerWorkspace.prototype.init;
    WorkerWorkspace.prototype.init = async function (options) { await originalInit.call(this, options); workspace = this; };
    t.after(async () => { release(); releaseExecutor?.(); stop.abort(); await run; WorkerWorkspace.prototype.init = originalInit; await rm(root, { recursive: true, force: true }); });
    /** @type {import('../../src/shared/domain.ts').Task} */
    const task = { id: 'pending-assignment', project: 'alpha', repository: initial.id, title: 'Keep the selected repository', criteria: ['Keep the admitted mapping'], wikilinks: [], provider: 'codex', priority: 1, status: 'running', attempt: 1, workerId: 'worker-one', lease: 'pending-lease', expiresAt: Date.now() + 60000, createdAt: Date.now(), profile: config.profiles[0].id };
    const assign = async () => { entered = true; await pending; assigned = true; task.expiresAt = Date.now() + 60000; return task; };
    const client = {
      async currentAssignments() {
        if (!assigned && pendingOperation === 'currentAssignments') return [await assign()];
        return assigned && !completed ? [task] : [];
      },
      async claim() { return assigned ? null : assign(); },
      async heartbeat() { return task; }, async publishSnapshot() {},
      async complete() { completed = true; }, async abandon() { completed = true; },
    };
    const gateway = { async register() { return { id: 'worker-one', token: 'fixture-token', project: 'alpha' }; }, connect() { return client; } };
/** @type {import('../../src/shared/domain.ts').Adapter} */
    const adapter = { mode: 'mock', async run(task) {
      selected = workspace.repositories.resolve(task.repository).path;
      return { kind: 'simulated', summary: 'Repository selection observed without changing files.' };
    } };
    run = runWorker({ ...config, stateDir: join(root, 'state'), url: 'http://orchestrator.invalid', enrollmentToken: 'fixture', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal, { gateway, adapter });
    await until(() => entered && workspace?.nativeWorkReady);
    assert.ok(workspace);
    await assert.rejects(workspace.updateSettings({ repositories: { items: [replacement] } }), error => testErrorCode(error) === 'conflict');
    assert.equal(workspace.settings.value.repositories.items[0].path, initial.path);
    releaseExecutor = await workspace.executor.acquire('fixture-held-execution', stop.signal);
    release();
    await until(() => context(workspace).get().queuedTasks?.some(item => item.id === task.id));
    assert.equal(selected, undefined, 'assignment is accepted but execution remains queued');
    await assert.rejects(workspace.updateSettings({ repositories: { items: [replacement] } }), error => testErrorCode(error) === 'conflict');
    releaseExecutor(); releaseExecutor = undefined;
    await until(() => workspace.sessions.view().records.find(record => record.id === 'remote-' + task.id)?.status === 'completed' && !workspace.executor.busy);
    assert.equal(selected, initial.path);
    await updateRepositoriesWhenIdle(workspace, [replacement]);
    assert.equal(workspace.repositories.resolve(initial.id).path, replacement.path);
  });
}
