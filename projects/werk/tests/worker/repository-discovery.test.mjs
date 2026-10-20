import { workspaceContext } from './runtime-fixtures.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';
import { prepareTaskWorkspace } from '../../src/worker/dist/worker/status/workspace-repositories.js';
import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepositoryDiscovery } from '../../src/worker/dist/worker/infrastructure/repository-discovery.js';
import { RepositoryManager } from '../../src/worker/dist/worker/infrastructure/repositories.js';
import { worktreeName } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = async path => !!await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
async function fixture(t, initializeGit = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-discovery-'))), repository = join(directory, 'project'), state = join(directory, 'state');
  await mkdir(repository); await mkdir(state, { mode: 0o700 });
  await writeFile(join(repository, 'hello.txt'), 'original\n');
  if (initializeGit) {
    git(repository, 'init', '--initial-branch=main'); git(repository, 'config', 'core.autocrlf', 'false');
    git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Fixture baseline');
  }
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const discovery = (path = repository, legacy) => new RepositoryDiscovery(state, path, new AbortController().signal, legacy);
  return { directory, repository, state, discovery };
}
async function workspace(t, options = {}) {
  const f = await fixture(t, !options.withoutGit), journal = new SnapshotJournal(f.state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = workerStatus({ queuedTasks: [] });
  if (options.features) await mkdir(join(f.repository, 'features'));
  /** @type {ConstructorParameters<typeof WorkerWorkspace>[0]} */
  const config = { stateDir: f.state, projectDir: f.repository, pollMs: 1000, timeoutMs: 60000, ...(options.features ? { features: { directory: join(f.repository, 'features'), provider: 'openai-api', pollMs: 1 } } : {}) };
  const worker = new WorkerWorkspace(config, journal, () => current); await worker.init();
  cleanup(t, async () => { await worker.close(); await journal.close(); });
  // @ts-expect-error Exercise extracted repository orchestration with the actual initialized workspace context.
  const context = worker.context;
  return { ...f, worker, journal, config, current, context };
}

test('installation discovery is read-only, ignores ambient Git redirection and never exposes remote credentials', async t => {
  const f = await fixture(t), before = await readFile(join(f.repository, '.git/config'), 'utf8');
  git(f.repository, 'remote', 'add', 'origin', 'https://private-user:private-password@example.invalid/project.git');
  git(f.repository, 'remote', 'add', 'upstream', 'https://private-token@example.invalid/upstream.git');
  git(f.repository, 'config', 'branch.main.remote', 'upstream');
  const previous = process.env.GIT_DIR; process.env.GIT_DIR = join(f.directory, 'unrelated.git');
  let d; try { d = f.discovery(); await d.init([]); } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  const value = d.view(); assert.equal(value.path, f.repository); assert.equal(value.remote, 'upstream'); assert.equal(value.watch, true); assert.equal(value.decision, 'pending');
  assert.doesNotMatch(JSON.stringify(value), /private-user|private-password|private-token|https:|commonDirectory/);
  assert.equal(await exists(join(f.repository, '.git/FETCH_HEAD')), false); assert.equal(await exists(join(f.repository, '.werk')), false);
  assert.equal(await exists(join(f.state, 'repository-discovery.json')), false);
  await assert.rejects(d.assertAllowed(f.repository), /Approve the detected/);
  assert.ok((await readFile(join(f.repository, '.git/config'), 'utf8')).startsWith(before));
});

test('discovery requires the exact root, supports Git-file worktrees and leaves detached checkouts unwatched', async t => {
  const f = await fixture(t), child = join(f.repository, 'nested'), bare = join(f.directory, 'bare.git'), linked = join(f.directory, 'linked');
  await mkdir(child); git(f.directory, 'init', '--bare', bare); git(f.repository, 'worktree', 'add', '--detach', linked, 'HEAD');
  for (const path of [child, bare, f.directory, join(f.directory, 'missing')]) { const d = f.discovery(path); await d.init([]); assert.equal(d.view(), null); }
  await writeFile(join(child, '.git'), 'invalid Git metadata'); const invalid = f.discovery(child); await invalid.init([]); assert.equal(invalid.view(), null); await assert.rejects(invalid.assertAllowed(child), /could not be checked safely/);
  const d = f.discovery(linked); await d.init([]); assert.equal(d.view().path, linked); assert.equal(d.view().currentBranch, null); assert.equal(d.view().watch, false); assert.equal(d.assignment([]).watch, false);
  git(f.repository, 'remote', 'add', 'origin', bare); const remote = f.discovery(linked); await remote.init([]); assert.equal(remote.view().remote, 'origin'); assert.equal(remote.view().watch, false);
});

test('decisions survive restart and commits, but replacement invalidates consent before watcher or task use', async t => {
  const f = await fixture(t), d = f.discovery(); await d.init([]); const original = d.view();
  await d.record('declined'); const declined = f.discovery(); await declined.init([]); assert.equal(declined.view().decision, 'declined');
  await declined.verify(original.id); const assignment = declined.assignment([]); await declined.record('accepted', assignment.id); await declined.assignmentsChanged([assignment]);
  await writeFile(join(f.repository, 'hello.txt'), 'later\n'); git(f.repository, 'add', '.'); git(f.repository, 'commit', '-m', 'Later commit');
  await declined.assertAllowed(f.repository); assert.equal(declined.view().id, original.id);
  const saved = join(f.directory, 'previous.git'); await rename(join(f.repository, '.git'), saved); git(f.repository, 'init', '--initial-branch=main'); git(f.repository, 'add', '.'); git(f.repository, 'commit', '-m', 'Replacement');
  await assert.rejects(declined.assertAllowed(f.repository), /Approve the detected/); assert.equal(declined.view().decision, 'pending');
  const recovered = f.discovery(); await recovered.init([assignment]); assert.equal(recovered.view().decision, 'pending');
  const manager = new RepositoryManager({ pollMs: 1000, items: [assignment] }, { beforeRepositoryUse: item => recovered.assertAllowed(item.path) }); cleanup(t, () => manager.close());
  await manager.init(); assert.equal(manager.view()[0].state, 'error'); assert.equal(await exists(join(f.repository, '.git/FETCH_HEAD')), false);
  await assert.rejects(manager.prepareWorktree(assignment.id, 'blocked', new AbortController().signal), /Approve the detected/);
  await assert.rejects(recovered.verify(original.id), /repository changed/);
  await recovered.verify(recovered.view().id); await recovered.record('declined', assignment.id); await recovered.assignmentsChanged([assignment]); assert.equal(recovered.view().decision, 'declined');
});

test('already configured roots and legacy Codex checkouts are approved without duplicate assignments', async t => {
  const f = await fixture(t), assignment = { id: 'existing', path: f.repository, remote: 'origin', watch: false };
  const configured = f.discovery(); await configured.init([assignment]); assert.equal(configured.view().decision, 'accepted'); assert.equal(configured.view().repositoryId, 'existing');
  await configured.assignmentsChanged([]); assert.equal(configured.view().decision, 'accepted');
  const legacy = f.discovery(f.repository, f.repository); await legacy.init([]); assert.equal(legacy.view().decision, 'accepted');
  const collision = configured.assignment([]); assert.notEqual(configured.assignment([collision]).id, collision.id);
});

test('a durable decline takes precedence over legacy Codex repository configuration after restart', async t => {
  const f = await fixture(t), initial = f.discovery(f.repository, f.repository); await initial.init([]);
  assert.equal(initial.view().decision, 'accepted');
  await initial.record('declined');
  const restarted = f.discovery(f.repository, f.repository); await restarted.init([]);
  assert.equal(restarted.view().decision, 'declined');
  assert.equal(JSON.parse(await readFile(join(f.state, 'repository-discovery.json'), 'utf8')).decision, 'declined');
  await assert.rejects(restarted.assertAllowed(f.repository), /Approve the detected/);
  assert.equal(await exists(join(f.repository, '.git/FETCH_HEAD')), false);
  assert.equal(await exists(join(f.repository, '.werk/worktrees')), false);
});

test('acceptance persists one assignment, enables worktrees and remembers decline without blocking unrelated tasks', async t => {
  const f = await workspace(t), id = f.worker.repositoryStatus().discovery.id;
  f.current.activeTasks.push({ id: 'unrelated', attempt: 1, profile: null });
  await f.worker.repositoryCommand({ action: 'decline', discoveryId: id }); assert.equal(f.worker.repositoryStatus().discovery.decision, 'declined');
  await assert.rejects(f.worker.repositoryCommand({ action: 'accept', discoveryId: id }), /Finish or cancel/);
  f.current.activeTasks.length = 0;
  await assert.rejects(prepareTaskWorkspace(f.context, f.repository, 'task-before', new AbortController().signal), /Approve the detected/);
  const accepted = await f.worker.repositoryCommand({ action: 'accept', discoveryId: id }); assert.equal(accepted.items.length, 1); assert.equal(accepted.items[0].watch, false); assert.equal(accepted.discovery.decision, 'accepted');
  await f.worker.repositoryCommand({ action: 'accept', discoveryId: id }); assert.equal(f.worker.repositoryStatus().items.length, 1);
  const task = await prepareTaskWorkspace(f.context, accepted.items[0].id, 'task-after', new AbortController().signal);
  assert.ok(task.path.startsWith(join(f.repository, '.werk/worktrees')));
  const name = worktreeName(accepted.items[0].id, 'task-after'), branch = 'werk/workspaces/' + name;
  assert.equal(git(task.path, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  const ownership = JSON.parse(await readFile(join(f.repository, '.git', 'werk-worktrees', name + '.json'), 'utf8'));
  assert.equal(ownership.branch, branch); assert.equal(ownership.branchOwned, true); assert.equal(ownership.taskKey, 'task-after');
  assert.equal(git(task.path, 'rev-parse', 'HEAD'), git(f.repository, 'rev-parse', 'HEAD'));
  assert.equal(git(f.repository, 'branch', '--show-current'), 'main');
  assert.equal(await readFile(join(f.repository, 'hello.txt'), 'utf8'), 'original\n');
  const saved = JSON.parse(await readFile(join(f.state, 'workspace-settings.json'), 'utf8')); assert.equal(saved.repositories.items[0].id, accepted.items[0].id);
});

test('failed settings persistence leaves consent pending and concurrent updates cannot replace acceptance assignments', async t => {
  const f = await workspace(t), id = f.worker.repositoryStatus().discovery.id, save = f.worker.settings.update.bind(f.worker.settings);
  f.worker.settings.update = async () => { throw Error('Fixture disk failure'); };
  await assert.rejects(f.worker.repositoryCommand({ action: 'accept', discoveryId: id }), /disk failure/);
  assert.equal(f.worker.repositoryStatus().discovery.decision, 'pending'); assert.equal(f.worker.settings.value.repositories.items.length, 0); assert.equal(await exists(join(f.state, 'repository-discovery.json')), false);
  f.worker.settings.update = save;
  const verify = f.worker.repositoryDiscovery.verify.bind(f.worker.repositoryDiscovery);
  const {promise:started,resolve:entered}=Promise.withResolvers();
  const {promise:blocked,resolve:finish}=Promise.withResolvers();
  f.worker.repositoryDiscovery.verify = async value => { entered(); await blocked; return verify(value); };
  const accepting = f.worker.repositoryCommand({ action: 'accept', discoveryId: id }); await started;
  await assert.rejects(f.worker.updateSettings({ repositories: { items: [] } }), /Finish or cancel/);
  await assert.rejects(f.worker.repositoryCommand({ action: 'accept', discoveryId: id }), /Finish or cancel/);
  finish(); await accepting; assert.equal(f.worker.settings.value.repositories.items.length, 1);
});

test('a repository created after startup still requires approval before legacy task preparation', async t => {
  const f = await workspace(t); await rename(join(f.repository, '.git'), join(f.directory, 'original.git'));
  await f.worker.repositoryDiscovery.assertAllowed(f.repository); assert.equal(f.worker.repositoryStatus().discovery, null);
  git(f.repository, 'init', '--initial-branch=main'); git(f.repository, 'add', '.'); git(f.repository, 'commit', '-m', 'New repository');
  await assert.rejects(prepareTaskWorkspace(f.context, f.repository, 'new-repository', new AbortController().signal), /Approve the detected/);
  assert.equal(f.worker.repositoryStatus().discovery.decision, 'pending'); assert.equal(await exists(join(f.repository, '.werk/worktrees')), false);
});

test('explicit assignment authorizes an installation repository initialized after worker startup', async t => {
  const f = await workspace(t, { withoutGit: true }), remote = join(f.directory, 'remote.git');
  assert.equal(f.worker.repositoryStatus().discovery, null);
  git(f.repository, 'init', '--initial-branch=main'); git(f.repository, 'config', 'core.autocrlf', 'false');
  git(f.repository, 'add', 'hello.txt'); git(f.repository, 'commit', '-m', 'Late repository');
  git(f.directory, 'clone', '--bare', '--no-hardlinks', '--', f.repository, remote); git(f.repository, 'remote', 'add', 'origin', remote);
  assert.equal(await exists(join(f.repository, '.git/FETCH_HEAD')), false);
  assert.equal(await exists(join(f.repository, '.werk/worktrees')), false);
  const assignment = { id: 'project', path: f.repository, remote: 'origin', branch: 'main', watch: true };
  await f.worker.updateSettings({ repositories: { pollMs: 30000, items: [assignment] } });
  const status = f.worker.repositoryStatus();
  assert.equal(status.discovery.decision, 'accepted'); assert.equal(status.discovery.repositoryId, 'project'); assert.equal(status.items[0].state, 'ready');
  assert.equal(await exists(join(f.repository, '.git/FETCH_HEAD')), true);
  const task = await prepareTaskWorkspace(f.context, 'project', 'late-assignment', new AbortController().signal);
  assert.ok('repositoryId' in task); assert.equal(task.repositoryId, 'project'); assert.ok(task.path.startsWith(join(f.repository, '.werk/worktrees')));
  const restarted = f.discovery(); await restarted.init([assignment]); assert.equal(restarted.view().decision, 'accepted'); await restarted.assertAllowed(f.repository);
});

test('assignment refresh preserves fresh-consent and decline requirements for a replacement repository', async t => {
  const f = await workspace(t), original = f.worker.repositoryStatus().discovery;
  await f.worker.repositoryCommand({ action: 'accept', discoveryId: original.id });
  const assignment = structuredClone(f.worker.settings.value.repositories.items[0]);
  await rename(join(f.repository, '.git'), join(f.directory, 'previous.git'));
  git(f.repository, 'init', '--initial-branch=main'); git(f.repository, 'config', 'core.autocrlf', 'false');
  git(f.repository, 'add', 'hello.txt'); git(f.repository, 'commit', '-m', 'Replacement repository');
  await f.worker.updateSettings({ repositories: { pollMs: 15000, items: [assignment] } });
  const changed = f.worker.repositoryStatus().discovery;
  assert.notEqual(changed.id, original.id); assert.equal(changed.decision, 'pending');
  await assert.rejects(prepareTaskWorkspace(f.context, assignment.id, 'unapproved-replacement', new AbortController().signal), /Approve the detected/);
  await f.worker.repositoryCommand({ action: 'decline', discoveryId: changed.id });
  await f.worker.updateSettings({ repositories: { pollMs: 20000, items: [assignment] } });
  assert.equal(f.worker.repositoryStatus().discovery.decision, 'declined');
  const restarted = f.discovery(); await restarted.init([assignment]); assert.equal(restarted.view().decision, 'declined');
  await assert.rejects(restarted.assertAllowed(f.repository), /Approve the detected/);
  assert.equal(await exists(join(f.repository, '.git/FETCH_HEAD')), false); assert.equal(await exists(join(f.repository, '.werk/worktrees')), false);
});

test('a repository replacement during acceptance cannot inherit the previously selected identity', async t => {
  const f = await workspace(t), id = f.worker.repositoryStatus().discovery.id;
  const assignmentsChanged = f.worker.repositoryDiscovery.assignmentsChanged.bind(f.worker.repositoryDiscovery);
  f.worker.repositoryDiscovery.assignmentsChanged = async assignments => {
    await rename(join(f.repository, '.git'), join(f.directory, 'previous.git'));
    git(f.repository, 'init', '--initial-branch=main'); git(f.repository, 'config', 'core.autocrlf', 'false');
    git(f.repository, 'add', 'hello.txt'); git(f.repository, 'commit', '-m', 'Replacement during acceptance');
    return assignmentsChanged(assignments);
  };
  await assert.rejects(f.worker.repositoryCommand({ action: 'accept', discoveryId: id }), /repository changed/);
  assert.notEqual(f.worker.repositoryStatus().discovery.id, id); assert.equal(f.worker.repositoryStatus().discovery.decision, 'pending');
  assert.equal(f.worker.settings.value.repositories.items.length, 0);
  assert.equal(await exists(join(f.state, 'repository-discovery.json')), false);
  assert.equal(await exists(join(f.repository, '.git/FETCH_HEAD')), false); assert.equal(await exists(join(f.repository, '.werk/worktrees')), false);
});

test('ready patch features remain waiting for consent then enter the queue after acceptance', async t => {
  const f = await workspace(t, { features: true }); await f.worker.updateSettings({ board: { paused: true }, provider: { id: 'openai-api', model: 'fixture-model', apiKey: 'fixture-key' } });
  await writeFile(join(f.repository, 'features/change.md'), '---\nschemaVersion: 1\ntitle: Await repository permission\nstatus: ready\nmode: patch\npaths: [hello.txt]\n---\nChange the approved file.\n');
  await workspaceContext(f.worker).features.tick(true); await workspaceContext(f.worker).features.tick(true);
  let record = workspaceContext(f.worker).features.view().records[0]; assert.equal(record.submitted, false); assert.equal(record.status, 'waiting'); assert.match(record.error, /Approve the detected/); assert.equal(await exists(join(f.repository, '.werk/worktrees')), false);
  await f.worker.repositoryCommand({ action: 'accept', discoveryId: f.worker.repositoryStatus().discovery.id });
  await workspaceContext(f.worker).features.tick(true); record = workspaceContext(f.worker).features.view().records[0]; assert.equal(record.submitted, true); assert.equal(f.worker.board.view().tasks.length, 1); assert.equal(await exists(join(f.repository, '.werk/worktrees')), true);
});
