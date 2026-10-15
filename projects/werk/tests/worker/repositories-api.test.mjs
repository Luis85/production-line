import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-repository-api-'))), state = join(root, 'state'); await mkdir(state);
  const repos = [];
  for (const id of ['frontend', 'backend']) {
    const path = join(root, id), remote = join(root, id + '.git'); await mkdir(path);
    git(path, 'init', '-b', 'main'); git(path, 'config', 'core.autocrlf', 'false'); await writeFile(join(path, 'a.txt'), id + '\n'); git(path, 'add', '.'); git(path, 'commit', '-m', 'initial');
    git(root, 'init', '--bare', remote); git(path, 'remote', 'add', 'origin', remote); git(path, 'push', '-u', 'origin', 'main');
    repos.push({ id, path, remote: 'origin', watch: false, branch: 'main' });
  }
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = { activeTasks: [], queuedTasks: [] };
  const workspace = new WorkerWorkspace({ stateDir: state, pollMs: 1000, timeoutMs: 60000 }, journal, () => current); await workspace.init();
  const server = await statusServer(() => current, '127.0.0.1', 0, undefined, workspace);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await workspace.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, token = (await readFile(join(state, 'webview-token'), 'utf8')).trim(), headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  return { root, state, workspace, journal, current, repos, base, headers, post: (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }) };
}
test('repository assignments are authenticated, persisted, watched, and available after restart', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/repositories')).status, 401);
  assert.equal((await fetch(f.base + '/api/repositories', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"action":"sync"}' })).status, 401);
  const saved = await f.post('/api/settings', { repositories: { pollMs: 1000, items: f.repos } }); assert.equal(saved.status, 200);
  const status = await (await fetch(f.base + '/api/repositories', { headers: f.headers })).json();
  assert.equal(status.pollMs, 1000); assert.deepEqual(status.items.map(item => [item.id, item.state]), [['frontend', 'ready'], ['backend', 'ready']]);
  assert.equal((await f.post('/api/repositories', { action: 'sync', id: 'outside' })).status, 400);
  assert.equal((await f.post('/api/repositories', { action: 'sync', path: '/tmp' })).status, 400);
  assert.equal((await f.post('/api/repositories', { action: 'sync', id: 'frontend' })).status, 200);
  assert.equal((await (await fetch(f.base + '/status')).json()).repositories, undefined);
  await f.workspace.close();
  const reopened = new WorkerWorkspace({ stateDir: f.state, pollMs: 1000, timeoutMs: 60000 }, f.journal, () => f.current); await reopened.init();
  try { assert.deepEqual(reopened.repositoryStatus().items.map(item => [item.id, item.state]), [['frontend', 'ready'], ['backend', 'ready']]); }
  finally { await reopened.close(); }
});
test('assigned file tasks snapshot their worktrees and prevent reassignment while queued', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/settings', { repositories: { items: f.repos }, board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-key-never-sent', model: 'fixture-model' } })).status, 200);
  await writeFile(join(f.repos[1].path, 'a.txt'), 'operator dirty edit\n');
  const task = { title: 'Backend task', instruction: 'Change text', repository: 'backend', paths: ['a.txt'], provider: 'openai-api' };
  assert.equal((await f.post('/api/taskboard', task)).status, 202);
  const entry = f.workspace.board.view().tasks[0], detail = f.workspace.board.detail(entry.id);
  assert.equal(f.workspace.settings.value.board.paused, true);
  assert.equal(detail.status, 'queued', 'The paused fixture must retain an admitted task without relying on a host CLI installation.');
  assert.equal(detail.repositoryId, 'backend'); assert.equal(detail.repository, f.repos[1].path); assert.ok(detail.worktree.startsWith(join(detail.repository, '.werk', 'worktrees')));
  assert.equal(detail.files[0].content, 'backend\n'); assert.equal(await readFile(join(detail.repository, 'a.txt'), 'utf8'), 'operator dirty edit\n');
  assert.equal((await f.post('/api/settings', { repositories: { items: [] } })).status, 409);
  assert.equal((await f.post('/api/taskboard', { ...task, repository: f.root })).status, 400);
  assert.equal(f.workspace.repositoryStatus().items.length, 2);
});
