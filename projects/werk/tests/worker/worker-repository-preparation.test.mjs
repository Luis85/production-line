import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
  cwd, encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'], timeout:30000
}).trim();
const limits = {timeout:process.platform === 'win32' ? 90000 : 30000};

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-repository-startup-')));
  const remote = join(root, 'remote.git'), producer = join(root, 'producer'), repository = join(root, 'project'), stateDir = join(root, 'state');
  const stop = new AbortController(), ready = Promise.withResolvers(), started = Promise.withResolvers(), release = Promise.withResolvers(), aborted = Promise.withResolvers(), workspaceClosed = Promise.withResolvers();
  let running = Promise.resolve(), endpoint, token, setupSignal, settled = false, finalRepositories;
  const stopTest = () => stop.abort(t.signal.reason);
  t.signal.addEventListener('abort', stopTest, {once:true});
  if (t.signal.aborted) stopTest();
  t.after(async () => {
    stop.abort(); release.resolve();
    try { await running.catch(() => {}); }
    finally { t.signal.removeEventListener('abort', stopTest); await rm(root, {recursive:true, force:true}); }
  });
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  await mkdir(producer); git(producer, 'init', '--initial-branch=main');
  await writeFile(join(producer, 'feature.txt'), 'initial\n'); git(producer, 'add', 'feature.txt'); git(producer, 'commit', '-m', 'Initial feature');
  git(producer, 'remote', 'add', 'origin', remote); git(producer, 'push', '-u', 'origin', 'main');
  git(root, 'clone', '--config', 'core.autocrlf=false', '--', remote, repository);
  const initial = git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(producer, 'feature.txt'), 'team update\n'); git(producer, 'add', 'feature.txt'); git(producer, 'commit', '-m', 'Team update'); git(producer, 'push', 'origin', 'main');
  const expected = git(producer, 'rev-parse', 'HEAD');
  const originalFetch = await readFile(join(repository, '.git', 'FETCH_HEAD'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const config = {...await configuration({'poll-ms':'100','mock-ms':'1',profiles:'codex'}), stateDir, url:'', enrollmentToken:'', statusHost:'127.0.0.1', statusPort:0, projectDir:repository,
    repositories:{pollMs:300000, items:[{id:'project', path:repository, remote:'origin', branch:'main', watch:true}]}};
  const close = WorkerWorkspace.prototype.close;
  t.mock.method(WorkerWorkspace.prototype, 'close', async function (options) {
    try { return await close.call(this, options); }
    finally { finalRepositories = this.repositoryStatus(); workspaceClosed.resolve(); }
  });
  const api = async (path, body) => {
    token ??= (await readFile(join(stateDir, 'webview-token'), 'utf8')).trim();
    const response = await fetch(endpoint + path, {
      method:body === undefined ? 'GET' : 'POST', signal:AbortSignal.any([t.signal, AbortSignal.timeout(5000)]),
      headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})
    });
    return {status:response.status, body:await response.json()};
  };
  function start() {
    running = runWorker(config, stop.signal, {
      prepareProcessRuntime:async (cwd, signal) => {
        setupSignal = signal; started.resolve();
        const cancel = () => aborted.resolve();
        signal.addEventListener('abort', cancel, {once:true}); if (signal.aborted) cancel();
        try { await release.promise; signal.throwIfAborted(); await prepareProcessRuntime(cwd, signal); }
        finally { signal.removeEventListener('abort', cancel); }
      },
      ready:async address => { endpoint = 'http://127.0.0.1:' + address.port; ready.resolve(); }
    });
    void running.then(() => { settled = true; }, () => { settled = true; });
    return running;
  }
  return {root, repository, stateDir, initial, expected, originalFetch, api, start, stop, ready:ready.promise, started:started.promise, aborted:aborted.promise, workspaceClosed:workspaceClosed.promise,
    release:() => release.resolve(), get settled() { return settled; }, get signal() { return setupSignal; }, get finalRepositories() { return finalRepositories; }};
}

async function assertPending(f) {
  const repositories = await f.api('/api/repositories'); assert.equal(repositories.status, 200);
  assert.equal(repositories.body.nativeWork.state, 'preparing');
  assert.match(repositories.body.nativeWork.message, /preparing.*runtime/i);
  assert.equal(repositories.body.items.length, 1);
  const item = repositories.body.items[0];
  assert.equal(item.id, 'project'); assert.equal(item.state, 'pending'); assert.equal(item.error, null); assert.equal(item.lastCheckedAt, null);
  const processes = await f.api('/api/processes'); assert.equal(processes.status, 200);
  assert.deepEqual(processes.body.executions.processes.filter(process => process.kind === 'git'), [], 'Git synchronization must not start before runtime preparation completes');
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), f.initial);
  assert.equal(await readFile(join(f.repository, 'feature.txt'), 'utf8'), 'initial\n');
  const fetchHead = await readFile(join(f.repository, '.git', 'FETCH_HEAD'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert.equal(fetchHead, f.originalFetch, 'readiness cannot fetch behind the pending runtime barrier');
}

async function waitForSync(f, signal) {
  const deadline = performance.now() + (process.platform === 'win32' ? 65000 : 10000);
  while (performance.now() < deadline) {
    const result = await f.api('/api/repositories'); assert.equal(result.status, 200);
    const item = result.body.items[0];
    assert.notEqual(item.state, 'error', item.error ?? 'Repository startup must not manufacture a synchronization failure');
    if (item.state === 'ready' && result.body.nativeWork.state === 'ready') {
      assert.equal(result.body.nativeWork.message, null);
      return item;
    }
    await delay(25, undefined, {signal});
  }
  assert.fail('Initial assigned-repository synchronization did not complete after runtime preparation');
}

test('configured repository startup exposes HTTP before native preparation and performs its first sync only after release', limits, async t => {
  const f = await fixture(t), running = f.start();
  await Promise.all([f.started, f.ready]);
  assert.equal(f.signal.aborted, false); await assertPending(f);
  const sync = await f.api('/api/repositories', {action:'sync', id:'project'});
  assert.equal(sync.status, 503, 'manual native work reports preparation instead of consuming a Git command deadline');
  await assertPending(f);
  const configured = await f.api('/api/settings', {provider:{id:'claude-cli', executable:process.execPath, authenticationMode:'cli-account'}});
  assert.equal(configured.status, 200);
  const fileRequest = await f.api('/api/tasks', {action:'create', id:'startup-file', title:'Deferred native admission', provider:'claude-cli', message:'Update the approved file.', files:{repository:f.repository, paths:['feature.txt']}});
  assert.equal(fileRequest.status, 503, 'Native file admission must remain retryable until preparation completes');
  const board = await f.api('/api/taskboard'); assert.equal(board.status, 200);
  assert.deepEqual(board.body.tasks, []); assert.deepEqual(board.body.preparations, [], 'Rejected startup work must not create a failed preparation receipt');
  const rejected = await f.api('/api/tasks', {action:'get', id:'local-startup-file'}); assert.equal(rejected.status, 404);
  const message = 'Implement the feature after the command runtime is ready.';
  const request = await f.api('/api/tasks', {action:'create', id:'startup-request', title:'Queued during preparation', provider:'claude-cli', message});
  assert.equal(request.status, 200, JSON.stringify(request.body));
  assert.equal(request.body.chat.available, true); assert.equal(request.body.chat.phase, 'queued');
  assert.ok(request.body.session.featureRequest.path);
  assert.match(await readFile(request.body.session.featureRequest.path, 'utf8'), /Implement the feature after the command runtime is ready/);
  const wake = await f.api('/api/settings', {board:{paused:false}}); assert.equal(wake.status, 200);
  const held = await f.api('/api/tasks', {action:'get', id:'startup-request'});
  assert.equal(held.status, 200); assert.equal(held.body.chat.phase, 'queued', 'A user resume cannot bypass preparation');
  const heldProcesses = await f.api('/api/processes'); assert.equal(heldProcesses.status, 200);
  assert.deepEqual(heldProcesses.body.executions.processes, [], 'Queued model work cannot launch a provider before preparation');
  await assertPending(f);
  const cancelled = await f.api('/api/tasks', {action:'cancel', id:'startup-request'}); assert.equal(cancelled.status, 200);
  f.release();
  const item = await waitForSync(f, t.signal);
  assert.equal(item.head, f.expected); assert.equal(item.error, null); assert.equal(item.behind, 0); assert.ok(item.lastPulledAt);
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), f.expected);
  assert.equal(await readFile(join(f.repository, 'feature.txt'), 'utf8'), 'team update\n');
  const processes = await f.api('/api/processes'); assert.equal(processes.status, 200);
  assert.ok(processes.body.executions.processes.some(process => process.kind === 'git'), 'successful real synchronization must produce observed Git work');
  f.stop.abort(); await running;
  await assert.rejects(lstat(join(f.stateDir, 'worker.lock')), {code:'ENOENT'});
});

test('stopping a configured worker while preparation is pending drains ownership without starting Git or inventing repository errors', limits, async t => {
  const f = await fixture(t), running = f.start();
  await Promise.all([f.started, f.ready]); await assertPending(f);
  f.stop.abort(); await f.aborted; await f.workspaceClosed;
  assert.equal(f.signal.aborted, true); assert.equal(f.settled, false);
  assert.equal((await lstat(join(f.stateDir, 'worker.lock'))).isFile(), true);
  const item = f.finalRepositories.items[0];
  assert.equal(item.state, 'pending'); assert.equal(item.error, null); assert.equal(item.lastCheckedAt, null);
  f.release(); await running;
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), f.initial);
  assert.equal(await readFile(join(f.repository, 'feature.txt'), 'utf8'), 'initial\n');
  const status = JSON.parse(await readFile(join(f.stateDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'stopped'); assert.equal(status.lastError, null);
  await assert.rejects(lstat(join(f.stateDir, 'worker.lock')), {code:'ENOENT'});
});
