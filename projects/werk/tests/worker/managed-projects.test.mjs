import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { ManagedProjects } from '../../src/worker/dist/worker/application/managed-projects.js';
import { managedProjectStorage } from '../../src/worker/dist/worker/infrastructure/managed-project-storage.js';
import { managedProjectGit } from '../../src/worker/dist/worker/infrastructure/managed-project-git.js';

const signal = () => AbortSignal.timeout(30000);
const command = { action: 'register', operationId: 'register-one', id: 'sample', repository: 'https://github.com/example/sample.git' };
/** @param {import('node:test').TestContext} t */
async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-managed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = managedProjectStorage(directory);
  let clones = 0, attaches = 0, ready = false, failAttach = false, failClone = false;
  /** @type {import('../../src/worker/application/managed-projects.ts').ManagedProjectPorts} */
  const ports = { ...storage, location: id => join(directory, 'projects', id, 'checkout'),
    async adopt(path, branch) { assert.equal(branch, 'main'); return { path, repository: command.repository, head: 'a'.repeat(40) }; },
    async clone() {
      const saved = await storage.load(); assert.equal(saved.projects[0].status, 'preparing'); clones++;
      if (failClone) throw Error('private transport credentials must never escape');
      ready = true;
    },
    async inspect() { return { ready, ...(ready ? { head: 'a'.repeat(40) } : {}) }; },
    async attach() { attaches++; if (failAttach) throw Error('settings persistence failed'); },
  };
  return { directory, storage, ports, manager: new ManagedProjects(ports), get clones() { return clones; }, get attaches() { return attaches; },
    ready(value) { ready = value; }, failAttach(value) { failAttach = value; }, failClone(value) { failClone = value; } };
}

test('registration persists intent before clone and command replay does not clone twice', async t => {
  const h = await harness(t);
  const first = await h.manager.command(command, signal());
  assert.equal(first.status, 'ready'); assert.equal(first.attached, true); assert.equal(h.clones, 1);
  const replay = await new ManagedProjects(h.ports).command(command, signal());
  assert.equal(replay.id, first.id); assert.equal(h.clones, 1);
  await assert.rejects(h.manager.command({ ...command, repository: 'https://github.com/other/project.git' }, signal()), /another immutable/);
  await assert.rejects(h.manager.command({ ...command, operationId: 'second-registration' }, signal()), /registered already/);
  assert.equal((await h.storage.load()).projects.length, 1);
});

test('lost settings acknowledgement is reconciled after restart without another clone', async t => {
  const h = await harness(t); h.failAttach(true);
  const first = await h.manager.command(command, signal());
  assert.equal(first.status, 'needs_attention'); assert.equal(first.attached, false);
  h.failAttach(false);
  const restored = await new ManagedProjects(h.ports).command({ action: 'reconcile', id: command.id, operationId: 'reconcile-one' }, signal());
  assert.equal(restored.status, 'ready'); assert.equal(restored.attached, true); assert.equal(h.clones, 1);
});

test('clone failure retains identity, sanitizes diagnostics and requires an explicit retry', async t => {
  const h = await harness(t); h.failClone(true);
  const first = await h.manager.command(command, signal());
  assert.equal(first.status, 'needs_attention'); assert.equal(first.attached, false); assert.doesNotMatch(first.detail, /private transport/);
  await h.manager.command(command, signal()); assert.equal(h.clones, 1);
  await h.manager.command({ action: 'reconcile', id: command.id, operationId: 'reconcile-missing' }, signal()); assert.equal(h.clones, 1);
  h.failClone(false);
  const retry = await h.manager.command({ action: 'retry', id: command.id, operationId: 'retry-clone' }, signal());
  assert.equal(retry.status, 'ready'); assert.equal(h.clones, 2);
  await assert.rejects(h.manager.command({ action: 'retry', id: command.id, operationId: 'retry-ready' }, signal()), /unattached clone/);
});

test('adoption inspects the existing checkout without cloning and rejects reuse with another command', async t => {
  const h = await harness(t); h.ready(true);
  const result = await h.manager.command({ action: 'adopt', id: 'adopted', operationId: 'adopt-first', path: h.directory }, signal());
  assert.equal(result.mode, 'adopt'); assert.equal(result.path, h.directory); assert.equal(h.clones, 0);
  await assert.rejects(h.manager.command({ ...command, id: 'another', operationId: 'adopt-first' }, signal()), /another immutable/);
});

test('operator input rejects unsafe transport, paths, IDs, private intake and recovery mutations', async t => {
  const { manager } = await harness(t);
  for (const repository of ['ext::sh -c touch', 'https://user:secret@example.com/project', 'ssh://root@example.com/project', 'https://example.com/repo?secret=x', '-u', 'file://remote-host/project'])
    await assert.rejects(manager.command({ ...command, repository }, signal()));
  for (const id of ['../escape', 'CON', 'nul', 'a'.repeat(41)]) await assert.rejects(manager.command({ ...command, id }, signal()));
  await assert.rejects(manager.command({ ...command, branch: '--help' }, signal()));
  await assert.rejects(manager.command({ ...command, featuresDirectory: '.werk/requests' }, signal()));
  await assert.rejects(manager.command({ action: 'adopt', operationId: 'a', id: 'p', path: 'relative' }, signal()));
  await assert.rejects(manager.command({ action: 'reconcile', operationId: 'a', id: 'p', repository: command.repository }, signal()));
});

test('real Git clone, restart reconciliation and worktree paths stay beneath worker-owned project', async t => {
  const h = await harness(t), source = join(h.directory, 'source'), state = join(h.directory, 'state');
  await mkdir(source); await mkdir(state);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  await writeFile(join(source, '.gitattributes'), '* text eol=lf\n');
  await writeFile(join(source, 'hello.txt'), 'baseline\n'); git('add', '.'); git('commit', '-m', 'baseline');
  const repository = pathToFileURL(source).toString(), adapter = managedProjectGit(state), storage = managedProjectStorage(state);
  const manager = new ManagedProjects({ ...storage, ...adapter, async attach(project) { assert.equal(project.head, git('rev-parse', 'HEAD')); } });
  const registered = await manager.command({ ...command, repository }, signal());
  assert.equal(registered.status, 'ready'); assert.equal(registered.path, join(state, 'projects', 'sample', 'checkout'));
  assert.equal(await readFile(join(registered.path, 'hello.txt'), 'utf8'), 'baseline\n');
  const before = await readdir(join(state, 'projects', 'sample'));
  await manager.command({ action: 'reconcile', id: 'sample', operationId: 'real-reconcile' }, signal());
  assert.deepEqual(await readdir(join(state, 'projects', 'sample')), before);
  git('branch', 'different');
  const adopted = await assert.rejects(adapter.adopt(source, 'different', signal()), /already be on/);
  assert.equal(adopted, undefined);
});

test('managed clone refuses a preexisting symlink instead of following it', async t => {
  const h = await harness(t), projects = join(h.directory, 'projects'), elsewhere = join(h.directory, 'elsewhere');
  await mkdir(projects); await mkdir(elsewhere);
  await symlink(elsewhere, join(projects, 'sample'), process.platform === 'win32' ? 'junction' : 'dir');
  const adapter = managedProjectGit(h.directory), manager = new ManagedProjects({ ...h.storage, ...adapter, async attach() {} });
  const result = await manager.command(command, signal());
  assert.equal(result.status, 'needs_attention'); assert.equal(result.attached, false);
  assert.deepEqual(await readdir(elsewhere), []);
});

test('corrupt registration state blocks setup instead of inventing a fresh project identity', async t => {
  const h = await harness(t); await writeFile(join(h.directory, 'managed-projects.json'), '{"schemaVersion":1,"projects":[{}]}');
  await assert.rejects(h.manager.command(command, signal()), /state is invalid/);
  assert.equal(h.clones, 0);
});

test('known setup conflicts keep their actionable explanation and reconcile without another clone', async t => {
  const h = await harness(t), attach = h.ports.attach;
  h.ports.attach = async () => { throw new DomainError('conflict', 'This repository already has local intake. Adopt it with intake: local.'); };
  const failed = await h.manager.command(command, signal());
  assert.equal(failed.status, 'needs_attention');
  assert.equal(failed.detail, 'This repository already has local intake. Adopt it with intake: local.');
  assert.equal((await h.storage.load()).projects[0].detail, failed.detail);
  h.ports.attach = attach;
  const recovered = await h.manager.command({ action: 'reconcile', operationId: 'fixed-setup', id: command.id }, signal());
  assert.equal(recovered.status, 'ready'); assert.equal(h.clones, 1);
});
