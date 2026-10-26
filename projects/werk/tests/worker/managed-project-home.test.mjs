import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { workerStatus } from '../helpers/worker-status.mjs';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { ManagedProjects } from '../../src/worker/dist/worker/application/managed-projects.js';
import { managedProjectGit } from '../../src/worker/dist/worker/infrastructure/managed-project-git.js';
import { managedProjectLocations } from '../../src/worker/dist/worker/infrastructure/managed-project-locations.js';
import { managedProjectStorage } from '../../src/worker/dist/worker/infrastructure/managed-project-storage.js';
import { assertManagedProjectIsolation } from '../../src/worker/dist/worker/status/workspace-managed-isolation.js';

prepareNativeProcessFixture();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, { cleanup = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-managed-home-')));
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'Werk Home'), state = join(root, 'custom-private-state'), source = join(root, 'developer-checkout');
  await Promise.all([mkdir(home), mkdir(state), mkdir(source)]);
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, '.gitattributes'), '* text eol=lf\n'); await writeFile(join(source, 'value.txt'), 'developer baseline\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Baseline');
  const command = { action: 'register', id: 'sample', operationId: 'register-home', repository: pathToFileURL(source).toString() };
  const storage = managedProjectStorage(state), locations = managedProjectLocations(state, home), adapter = managedProjectGit(state, locations);
  const ports = { ...storage, ...adapter, async attach() {} };
  return { root, home, state, source, command, storage, locations, adapter, ports, manager: new ManagedProjects(ports) };
}

test('new Home clones expose repository files directly and retain ownership only in private state', async t => {
  const f = await fixture(t), project = await f.manager.command(f.command, t.signal);
  assert.equal(project.status, 'ready'); assert.equal(project.path, join(f.home, 'projects', 'sample'));
  assert.equal(await readFile(join(project.path, 'value.txt'), 'utf8'), 'developer baseline\n');
  assert.equal(git(project.path, 'status', '--porcelain'), ''); assert.equal(git(f.source, 'status', '--porcelain'), '');
  const marker = JSON.parse(await readFile(join(f.state, 'managed-projects', 'sample', 'registration.json'), 'utf8'));
  assert.equal(marker.id, project.id); assert.equal(marker.repository, project.repository);
  assert.equal((await readdir(project.path)).includes('registration.json'), false);
  await assert.rejects(readFile(join(f.state, 'projects', 'sample', 'checkout', 'value.txt')), { code: 'ENOENT' });
  assert.equal((await new ManagedProjects(f.ports).assertIsolated(project.id, t.signal)).path, project.path);
});

test('retained legacy clone identity survives explicit Home selection without moving or cloning again', async t => {
  const f = await fixture(t), legacy = managedProjectGit(f.state), manager = new ManagedProjects({ ...f.storage, ...legacy, async attach() {} });
  const old = await manager.command(f.command, t.signal), before = await readFile(join(f.state, 'managed-projects.json'), 'utf8');
  assert.equal(old.path, join(f.state, 'projects', 'sample', 'checkout'));
  assert.equal((await f.adapter.inspect(old, t.signal)).ready, true);
  assert.equal(await readFile(join(f.state, 'managed-projects.json'), 'utf8'), before, 'Inspection never rewrites retained checkout identities.');
  const recovered = await f.manager.command({ action: 'reconcile', id: old.id, operationId: 'recheck-legacy' }, t.signal);
  assert.equal(recovered.path, old.path); assert.equal(recovered.status, 'ready'); assert.equal(f.locations.placement(recovered).legacy, true);
  await assert.rejects(readFile(join(f.home, 'projects', 'sample', 'value.txt')), { code: 'ENOENT' });
});

test('custom state without explicit Home preserves its legacy destination instead of inferring a parent', async t => {
  const f = await fixture(t), adapter = managedProjectGit(f.state);
  assert.equal(adapter.location('sample'), join(f.state, 'projects', 'sample', 'checkout'));
  assert.throws(() => managedProjectLocations(f.state, 'relative-home'), { code: 'invalid_input' });
});

test('occupied visible destinations are preserved and never silently adopted as managed clones', async t => {
  const f = await fixture(t), projects = join(f.home, 'projects'); await mkdir(projects);
  const checkout = join(projects, 'sample'); git(f.home, 'clone', f.command.repository, checkout);
  await writeFile(join(checkout, 'user-work.txt'), 'Preserve this file.');
  const result = await f.manager.command(f.command, t.signal);
  assert.equal(result.status, 'needs_attention'); assert.equal(result.attached, false); assert.match(result.detail, /destination already exists/);
  assert.equal(await readFile(join(checkout, 'user-work.txt'), 'utf8'), 'Preserve this file.');
  await assert.rejects(readFile(join(f.state, 'managed-projects', 'sample', 'registration.json')), { code: 'ENOENT' });
});

test('visible project directory symlinks cannot redirect managed clones', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.home, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  const project = await f.manager.command(f.command, t.signal);
  assert.equal(project.status, 'needs_attention'); assert.deepEqual(await readdir(outside), []);
});

test('Home isolation ignores repository settings authority and rejects retained external checkout records', async t => {
  const f = await fixture(t), project = await f.manager.command(f.command, t.signal);
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({ config: { homeDir: f.home, stateDir: f.state }, repositoryStop: new AbortController() }));
  await assertManagedProjectIsolation(workspace, project.id, project.path);
  await assert.rejects(assertManagedProjectIsolation(workspace, 'unregistered', f.source), { code: 'conflict' });
  await assert.rejects(assertManagedProjectIsolation(workspace, project.id, f.source), { code: 'conflict' });
  const state = await f.storage.load(); state.projects[0].mode = 'adopt'; state.projects[0].path = f.source; await f.storage.save(state);
  await assert.rejects(assertManagedProjectIsolation(workspace, project.id, f.source), { code: 'conflict' });
  const preserved = await f.manager.command({ action: 'reconcile', id: project.id, operationId: 'legacy-adopt-recheck' }, t.signal);
  assert.equal(preserved.mode, 'adopt'); assert.equal(preserved.status, 'needs_attention'); assert.equal(preserved.path, f.source);
  assert.equal(git(f.source, 'status', '--porcelain'), '');
  await assertManagedProjectIsolation(/** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({ config: { stateDir: 'legacy-state' } })), 'legacy-assignment');
});


test('pending attachment permits internal owned-clone inspection while admission and external checkout authority remain blocked', async t => {
  const f = await fixture(t), ready = await f.manager.command(f.command, t.signal), state = await f.storage.load();
  state.projects[0].status = 'preparing'; state.projects[0].attached = false; await f.storage.save(state);
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({ config: { homeDir: f.home, stateDir: f.state }, repositoryStop: new AbortController() }));
  await assert.rejects(assertManagedProjectIsolation(workspace, ready.id, ready.path), { code: 'conflict' });
  await assertManagedProjectIsolation(workspace, ready.id, ready.path, { allowPendingAttachment: true });
  await assert.rejects(assertManagedProjectIsolation(workspace, 'missing', ready.path, { allowPendingAttachment: true }), { code: 'conflict' });
  state.projects[0].mode = 'adopt'; state.projects[0].path = f.source; await f.storage.save(state);
  await assert.rejects(assertManagedProjectIsolation(workspace, ready.id, f.source, { allowPendingAttachment: true }), { code: 'conflict' });
  state.projects[0].mode = 'clone'; await f.storage.save(state);
  await assert.rejects(assertManagedProjectIsolation(workspace, ready.id, f.source, { allowPendingAttachment: true }), { code: 'conflict' });
  state.projects[0].path = ready.path; await f.storage.save(state);
  await rm(join(f.state, 'managed-projects', ready.id, 'registration.json'));
  await assert.rejects(assertManagedProjectIsolation(workspace, ready.id, ready.path, { allowPendingAttachment: true }));
});

test('actual Home workspace acknowledges a new clone with immediately usable repository status and survives restart', async t => {
  const f = await fixture(t, { cleanup: false });
  const start = async () => {
    const journal = new SnapshotJournal(f.state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    const worker = new WorkerWorkspace({ homeDir: f.home, stateDir: f.state, projectDir: f.home, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus);
    await worker.init(); return { worker, journal };
  };
  let active = await start(); t.after(async () => { await active.worker.close(); active.journal.close(); await rm(f.root, { recursive: true, force: true }); });
  const registered = await active.worker.managedProjectCommand({ ...f.command, pollMs: 27000 });
  assert.equal(registered.projects[0].status, 'ready'); assert.equal(registered.projects[0].attached, true);
  assert.equal(registered.projects[0].path, join(f.home, 'projects', 'sample'));
  const repository = active.worker.repositories.view().find(item => item.id === 'sample'); assert.ok(repository);
  assert.equal(repository.error, null); assert.ok(repository.lastCheckedAt); assert.equal(repository.head, git(f.source, 'rev-parse', 'HEAD'));
  await active.worker.close(); active.journal.close(); active = await start();
  const restored = (await active.worker.managedProjectsView()).projects[0];
  assert.equal(restored.status, 'ready'); assert.equal(restored.path, registered.projects[0].path); assert.equal(restored.pollMs, 27000);
  const restartedRepository = active.worker.repositories.view().find(item => item.id === 'sample'); assert.ok(restartedRepository); assert.equal(restartedRepository.error, null);
  assert.equal(git(f.source, 'status', '--porcelain'), '');
});
