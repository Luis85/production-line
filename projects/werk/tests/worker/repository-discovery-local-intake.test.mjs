import { workerStatus } from '../helpers/worker-status.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { RepositoryDiscovery } from '../../src/worker/dist/worker/infrastructure/repository-discovery.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A checkout with a branch and a remote: the shape that is watched by default. */
async function fixture(t, withRemote = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-local-intake-'))), repository = join(directory, 'project'), state = join(directory, 'state'), bare = join(directory, 'remote.git');
  await mkdir(repository); await mkdir(state, { mode: 0o700 }); await writeFile(join(repository, 'hello.txt'), 'original\n');
  git(repository, 'init', '--initial-branch=main'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Fixture baseline');
  if (withRemote) { git(directory, 'init', '--bare', bare); git(repository, 'remote', 'add', 'origin', bare); git(repository, 'push', '-q', 'origin', 'main'); }
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  return { directory, repository, state, discovery: watchDefault => new RepositoryDiscovery(state, repository, new AbortController().signal, undefined, watchDefault) };
}
async function workspace(t, intake) {
  const f = await fixture(t), journal = new SnapshotJournal(f.state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  await mkdir(join(f.repository, 'features'));
  const config = { stateDir: f.state, projectDir: f.repository, pollMs: 1000, timeoutMs: 60000, features: { directory: join(f.repository, 'features'), provider: 'openai-api', pollMs: 1, ...(intake ? { intake } : {}) } };
  const worker = new WorkerWorkspace(config, journal, () => workerStatus({ queuedTasks: [] })); await worker.init();
  cleanup(t, async () => { await worker.close(); await journal.close(); });
  return { ...f, worker };
}

test('a detected checkout with a remote and branch is watched unless the worker is operator-only', async t => {
  const f = await fixture(t);
  const shared = f.discovery(undefined); await shared.init([]);
  assert.equal(shared.view().watch, true); assert.equal(shared.assignment([]).watch, true);
  const local = f.discovery(false); await local.init([]);
  assert.equal(local.view().watch, false); assert.equal(local.assignment([]).watch, false);
  assert.equal(local.assignment([], true).watch, true, 'An explicit --watch true wins over the local default.');
  assert.equal(shared.assignment([], false).watch, false, 'An explicit --watch false is honoured everywhere.');
});

test('an explicit watch without a remote is refused with the fix instead of saving a broken assignment', async t => {
  const f = await fixture(t, false), local = f.discovery(false); await local.init([]);
  assert.throws(() => local.assignment([], true), /--watch false or add a remote/);
  assert.equal(local.assignment([]).watch, false);
});

test('accepting the detected repository defaults to watch false for features.intake local and explicit watch wins', async t => {
  const f = await workspace(t, 'local'), id = f.worker.repositoryStatus().discovery.id;
  assert.equal(f.worker.repositoryStatus().discovery.watch, false);
  await assert.rejects(f.worker.repositoryCommand({ action: 'accept', discoveryId: id, watch: 'yes' }), /watch must be true or false/);
  await assert.rejects(f.worker.repositoryCommand({ action: 'decline', discoveryId: id, watch: false }), /only applies when accepting/);
  await assert.rejects(f.worker.repositoryCommand({ action: 'sync', watch: false }), /Use discoveryId only/);
  const accepted = await f.worker.repositoryCommand({ action: 'accept', discoveryId: id });
  assert.equal(accepted.items.length, 1); assert.equal(accepted.items[0].watch, false);
});

test('repository accept --watch on an already assigned checkout is refused with where to change watching', async t => {
  const f = await workspace(t, 'local'), id = f.worker.repositoryStatus().discovery.id;
  await f.worker.repositoryCommand({ action: 'accept', discoveryId: id });
  for (const watch of [true, false])
    await assert.rejects(f.worker.repositoryCommand({ action: 'accept', discoveryId: id, watch }), /assigned already.*--watch has no effect.*Settings → Repositories.*settings set \(repositories\.items\[\]\.watch\)/);
  const again = await f.worker.repositoryCommand({ action: 'accept', discoveryId: id });
  assert.equal(again.items.length, 1); assert.equal(again.items[0].watch, false, 'Accepting again without --watch stays allowed and unchanged.');
});

test('an explicit watch true on accept keeps the checkout watched for an operator-only worker', async t => {
  const f = await workspace(t, 'local'), id = f.worker.repositoryStatus().discovery.id;
  const accepted = await f.worker.repositoryCommand({ action: 'accept', discoveryId: id, watch: true });
  assert.equal(accepted.items[0].watch, true);
});

test('the shared default is unchanged: accepting watches a checkout that has a remote and branch', async t => {
  const f = await workspace(t), id = f.worker.repositoryStatus().discovery.id;
  assert.equal(f.worker.repositoryStatus().discovery.watch, true);
  assert.equal((await f.worker.repositoryCommand({ action: 'accept', discoveryId: id })).items[0].watch, true);
});

test('shared status and feature list say shared intake is intentionally off only for features.intake local', async t => {
  const local = await workspace(t, 'local'), shared = await workspace(t);
  const hinted = view => /** @type {{ intake?: string, hint?: string }} */ (view);
  for (const view of [local.worker.sharedIntakeView(), await local.worker.featureList()]) { assert.equal(hinted(view).intake, 'local'); assert.match(String(hinted(view).hint), /intentionally off.*init --intake local.*copying .*local-request\.md outside the feature folder, setting paths, then running feature create --markdown <copy>.*shared setup.*saved repository binding takes precedence/s); }
  assert.equal(hinted(shared.worker.sharedIntakeView()).intake, undefined); assert.equal(hinted(await shared.worker.featureList()).hint, undefined);
});

test('worker configuration accepts features.intake shared or local and rejects anything else', async () => {
  const base = intake => ({ schemaVersion: 1, features: { directory: 'features', provider: 'codex-cli', ...(intake === undefined ? {} : { intake }) } });
  assert.equal((await configuration({}, base())).features.intake, 'shared');
  assert.equal((await configuration({}, base('local'))).features.intake, 'local');
  await assert.rejects(configuration({}, base('both')), /features\.intake must be "shared" or "local"/);
});
