import { workspaceModelFactory } from './application-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, rename, symlink, lstat, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cleanup } from './fixture-cleanup.mjs';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle(worker, id, state) { await worker.board.tick(); for (let i = 0; i < 600; i++) { if (worker.board.detail(id).status === state && !worker.sessions.busy) return; await delay(5); } throw Error('File task did not settle: ' + worker.board.detail(id).status); }
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-worktree-'))), state = join(root, 'state'), repository = join(root, 'repository');
  await mkdir(state); await mkdir(repository); cleanup(t, () => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); await writeFile(join(repository, 'approved.txt'), 'accepted committed snapshot\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init(); cleanup(t, () => journal.close());
  let worker, executions = 0;
  const factory = (connection, directory, transport, options) => ({ configuration: { id: connection.id, model: connection.model, instruction: '' }, capabilities: modelCapabilities, get toolManifest() { return options.tools().manifest; }, async reply() { throw Error('Expected typed invocation'); }, async execute(request, signal) {
    executions++; const runtime = options.tools(); try { const result = await runtime.call('werk_files_read', { path: 'approved.txt' }, signal); assert.match(JSON.stringify(result), /accepted committed snapshot/); } finally { await runtime.close(); }
    return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which approved change?' } };
  } });
  const open = async () => { worker = new WorkerWorkspace({ stateDir: state, projectDir: root, pollMs: 1000, timeoutMs: 60000 }, journal, () => ({ activeTasks: [], queuedTasks: [] })); worker.board.model = workspaceModelFactory(state, worker.settings, factory); await worker.init(); };
  await open(); cleanup(t, () => worker.close());
  await worker.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-never-sent', model: 'fixture-model' }, board: { paused: true }, repositories: { items: [{ id: 'project', path: repository, remote: 'origin', watch: false }] } });
  await worker.updateToolAccess({ expectedRevision: 0, builtins: { files: true, commands: [], webOrigins: [] }, mcp: [] });
  await worker.board.create({ title: 'Scoped tool task', instruction: 'Inspect the approved file', repository: 'project', paths: ['approved.txt'], provider: 'openai-api' });
  const task = worker.board.detail(worker.board.view().tasks[0].id); assert.equal(task.status, 'queued'); assert.ok(task.worktreeIdentity);
  return { root, state, repository, task, get worker() { return worker; }, get executions() { return executions; }, async restart() { await worker.close(); await open(); } };
}
async function replaceWorktree(f, kind) {
  const retained = f.task.worktree + '-retained'; await rename(f.task.worktree, retained);
  if (kind === 'directory') {
    await mkdir(f.task.worktree); await copyFile(join(retained, '.git'), join(f.task.worktree, '.git'));
    await writeFile(join(f.task.worktree, 'approved.txt'), 'replacement private content\n');
  } else if (kind === 'symlink') {
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'approved.txt'), 'outside private content\n');
    await symlink(outside, f.task.worktree, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
for (const kind of ['directory', 'symlink', 'missing']) test(`restart and continuation reject a ${kind} replacement without losing accepted snapshots`, async t => {
  const f = await fixture(t); await f.worker.updateSettings({ board: { paused: false } }); await settle(f.worker, f.task.id, 'waiting_input'); assert.equal(f.executions, 1);
  const pinned = structuredClone(f.worker.board.detail(f.task.id).worktreeIdentity); await replaceWorktree(f, kind); await f.restart();
  const task = f.worker.board.detail(f.task.id); assert.deepEqual(task.worktreeIdentity, pinned); assert.equal(task.files[0].content, 'accepted committed snapshot\n');
  const view = f.worker.sessions.interactions.view(task.sessionId);
  await assert.rejects(f.worker.board.interact({ action: 'answer', sessionId: task.sessionId, pendingId: view.pending.id, expectedRevision: view.revision, operationId: 'answer-replaced-worktree', answer: 'Use the approved change' }), /retained task worktree/);
  assert.equal(f.executions, 1, 'No provider starts with replacement filesystem authority');
  assert.equal(f.worker.board.detail(task.id).files[0].content, 'accepted committed snapshot\n');
  assert.equal(await readFile(join(f.repository, 'approved.txt'), 'utf8'), 'accepted committed snapshot\n');
  if (kind === 'missing') assert.equal(await lstat(task.worktree).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; }), false, 'Verification must not recreate a missing retained worktree');
});

test('replacement after queue admission is rejected before model execution', async t => {
  const f = await fixture(t); await replaceWorktree(f, 'directory');
  await f.worker.updateSettings({ board: { paused: false } }); await settle(f.worker, f.task.id, 'failed');
  assert.equal(f.executions, 0); assert.equal(f.worker.board.detail(f.task.id).files[0].content, 'accepted committed snapshot\n');
});
