import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { LocalTaskboard, WorkerSessions } from './application-fixtures.mjs';

const execute = promisify(execFile);
async function git(directory, ...args) {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args])).stdout.trim();
}
async function repository(directory) {
  await mkdir(directory);
  await git(directory, 'init', '--initial-branch=main');
  await git(directory, 'config', 'core.autocrlf', 'false');
  await git(directory, 'config', 'user.name', 'Worker admission test');
  await git(directory, 'config', 'user.email', 'worker@example.invalid');
  await writeFile(join(directory, 'approved.txt'), 'Committed fixture input\n');
  await git(directory, 'add', 'approved.txt');
  await git(directory, 'commit', '-m', 'Fixture baseline');
}
async function until(predicate, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}
function deferred() { return Promise.withResolvers(); }
async function waitForGate(gate, signal) {
  signal.throwIfAborted();
  const interrupted = deferred();
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([gate.promise, interrupted.promise]); }
  finally { signal.removeEventListener('abort', abort); }
}
const completed = { type: 'completed', text: JSON.stringify({ summary: 'Fixture proposal; no checks run.', files: [{ path: 'approved.txt', content: 'Proposed fixture output\n' }] }) };
const input = (extra = {}) => ({ title: 'Prepare a durable request', instruction: 'Change only the approved file.', repository: 'fixture', paths: ['approved.txt'], provider: 'openai-api', background: true, ...extra });
const reservation = (id, extra = {}) => ({ id, hash: 'a'.repeat(64), ...extra });
const command = (id, project, extra = {}) => ({ action: 'create', id, title: 'Request ' + id, provider: 'openai-api', message: 'Implement the requested improvement.', files: { repository: project, paths: ['approved.txt'] }, background: true, ...extra });

async function boardFixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-background-board-'))), project = join(directory, 'project'), state = join(directory, 'state');
  await repository(project); await mkdir(state);
  const settings = new WorkerSettings(state); await settings.init();
  await settings.update({ provider: { id: 'openai-api', apiKey: 'fixture-only', model: 'fixture' }, board: { paused: true }, repositories: { pollMs: 30000, items: [{ id: 'fixture', path: project, remote: 'origin', watch: false }] } });
  const prepared = [], requests = [], releases = [];
  const factory = connection => ({ configuration: { id: connection.id, model: connection.model, instruction: 'Deterministic test model' }, capabilities: modelCapabilities, async execute(request) { requests.push(request); return completed; }, async reply() { throw Error('Typed model required'); } });
  let board, sessions;
  const port = {
    async prepareWorktree(selector, key, signal) {
      const call = { selector, key, signal, index: prepared.length }; prepared.push(call);
      if (options.beforePrepare) await options.beforePrepare(call);
      signal.throwIfAborted();
      const baseCommit = await git(project, 'rev-parse', 'HEAD'), path = join(project, '.werk', 'worktrees', key);
      await git(project, 'worktree', 'add', '--detach', path, baseCommit);
      return { repositoryId: 'fixture', repository: project, path, baseCommit, reused: false };
    },
  };
  async function open() {
    sessions = new WorkerSessions(state, settings, factory); await sessions.init();
    board = new LocalTaskboard(state, settings, sessions, factory, port); await board.init();
  }
  async function close() { await board.close(); await sessions.close(); }
  await open();
  t.after(async () => { for (const release of releases) release(); await close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, project, state, settings, prepared, requests, releases, open, close, get board() { return board; }, get sessions() { return sessions; } };
}

async function workspaceFixture(t, withGit = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-background-workspace-'))), state = join(directory, 'state'), project = join(directory, 'project');
  await mkdir(state);
  if (withGit) await repository(project); else { await mkdir(project); await writeFile(join(project, 'approved.txt'), 'Private fixture snapshot\n'); }
  let workspace, journal;
  const releases = [];
  async function open() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    workspace = new WorkerWorkspace({ stateDir: state, projectDir: project, pollMs: 1000, timeoutMs: 60000 }, journal, () => ({ activeTasks: [], queuedTasks: [] }));
    await workspace.init();
    await workspace.updateSettings({ board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-only', model: 'fixture' }, ...(withGit ? { repositories: { pollMs: 30000, items: [{ id: 'fixture', path: project, remote: 'origin', branch: 'main', watch: false }] } } : {}) });
  }
  async function close() { if (workspace) { await workspace.close(); workspace = undefined; } journal?.close(); journal = undefined; }
  await open();
  t.after(async () => { for (const release of releases) release(); await close(); await rm(directory, { recursive: true, force: true }); });
  return { state, project, releases, open, close, get workspace() { return workspace; } };
}

test('unified background admission returns its request identity before snapshots and later exposes one Markdown-backed conversation', { timeout: 120000 }, async t => {
  const f = await workspaceFixture(t), gate = deferred(), entered = deferred(), original = f.workspace.board.files;
  f.releases.push(() => gate.resolve());
  f.workspace.board.files = { ...original, async snapshot(...args) { entered.resolve(); await gate.promise; return original.snapshot(...args); } };
  const request = command('unified-background', f.project);
  const [accepted, replay] = await Promise.all([f.workspace.task(request), f.workspace.task(request)]);
  assert.equal(accepted.preparation.id, request.id); assert.equal(replay.preparation.id, request.id);
  assert.equal(accepted.preparation.state, 'preparing'); assert.equal(accepted.session, undefined);
  await entered.promise;
  assert.equal(f.workspace.board.view().preparations.length, 1); assert.equal(f.workspace.board.view().tasks.length, 0);
  assert.equal(f.workspace.sessions.view().records.filter(row => row.id !== 'default').length, 0);
  assert.equal(f.workspace.sessions.runs.list().total, 0);
  assert.equal(f.workspace.featureTracking.status().records.length, 0);
  for (const changed of [{ ...request, message: 'Different input' }, { ...request, files: undefined, background: undefined }, { ...request, id: 'local-' + request.id, files: undefined, background: undefined }])
    await assert.rejects(f.workspace.task(changed), error => error.code === 'conflict');
  gate.resolve();
  await until(() => f.workspace.board.view().tasks.some(row => row.id === request.id) && f.workspace.board.view().preparations.length === 0, 'The unified request never completed admission.');
  const detail = await f.workspace.task({ action: 'get', id: 'local-' + request.id }), duplicate = await f.workspace.task(request);
  assert.equal(detail.session.id, 'local-' + request.id); assert.equal(duplicate.session.id, detail.session.id);
  assert.equal(detail.chat.messages[0].text, request.message); assert.equal(detail.featureTracking.error, null);
  assert.equal(detail.session.featureRequest.path, duplicate.session.featureRequest.path);
  assert.match(await readFile(detail.session.featureRequest.path, 'utf8'), /Implement the requested improvement/);
  assert.equal(f.workspace.sessions.runs.list().total, 1); assert.equal(f.workspace.board.view().tasks.length, 1);
  assert.ok(f.workspace.sessions.runs.list().rows.every(run => run.startedAt === null), 'Paused admission must not dispatch the provider.');
  const synchronous = await f.workspace.task(command('synchronous-request', f.project, { background: false }));
  assert.equal(synchronous.session.id, 'local-synchronous-request'); assert.equal(synchronous.preparation, undefined);
});

test('durable background reservations deduplicate input and context, retain failures and retry only on an explicit create', { timeout: 120000 }, async t => {
  const gate = deferred(), entered = deferred();
  const f = await boardFixture(t, { async beforePrepare(call) { if (call.index === 0) { entered.resolve(); await waitForGate(gate, call.signal); throw new DomainError('conflict', 'Fixture checkout is temporarily unavailable.'); } } });
  f.releases.push(() => gate.resolve());
  const submission = reservation('durable-background', { criteria: ['Keep the approved behavior.'] });
  const [first, replay] = await Promise.all([f.board.create(input(), submission), f.board.create(input(), submission)]);
  assert.equal(first.preparationId, submission.id); assert.equal(replay.preparationId, submission.id);
  await entered.promise;
  for (const changed of [{ ...submission, hash: 'b'.repeat(64) }, { ...submission, criteria: ['Changed acceptance criterion.'] }])
    await assert.rejects(f.board.create(input(), changed), error => error.code === 'conflict');
  assert.equal(f.prepared.length, 1); assert.equal(f.board.active, 1);
  gate.resolve();
  await until(() => f.board.preparation(submission.id)?.state === 'failed', 'The failed checkout was not reported.');
  assert.match(f.board.preparation(submission.id).error, /temporarily unavailable/);
  assert.equal(f.board.active, 0); assert.equal(f.board.view().tasks.length, 0);
  for (let attempt = 0; attempt < 3; attempt++) { f.board.view(); await f.board.tick(); }
  assert.equal(f.prepared.length, 1, 'Reading status and ticking cannot retry a failed admission.');
  const retried = await f.board.create(input(), submission); assert.equal(retried.preparationId, submission.id);
  await until(() => f.board.view().tasks.some(row => row.id === submission.id) && !f.board.preparation(submission.id), 'The explicit retry was not admitted.');
  const task = f.board.detail(submission.id);
  assert.equal(f.prepared.length, 2); assert.equal(f.prepared[0].key, f.prepared[1].key);
  assert.equal(task.worktreeKey, f.prepared[1].key); assert.match(task.worktreeKey, new RegExp('^' + submission.id + '-' + submission.hash + '-'));
  await Promise.all([f.board.create(input(), submission), f.board.create(input(), submission)]);
  assert.equal(f.prepared.length, 2); assert.equal(f.board.view().tasks.length, 1); assert.equal(f.sessions.runs.list().total, 1);
  await f.settings.update({ board: { paused: false } });
  await until(async () => { await f.board.tick(); return f.board.detail(submission.id).status === 'review' && !f.sessions.executor.busy; }, 'The fixture model did not complete the accepted task.');
  assert.equal(f.requests.length, 1, 'Concurrent acceptance and retries must produce exactly one model invocation.');
});

test('waiting, worktree and admission phases reserve one slot even after the taskboard write precedes session state', { timeout: 120000 }, async t => {
  const worktreeGate = deferred(), worktreeEntered = deferred(), snapshotGate = deferred(), snapshotEntered = deferred(), stateGate = deferred(), stateEntered = deferred();
  const f = await boardFixture(t, { async beforePrepare(call) { if (call.index === 0) { worktreeEntered.resolve(); await waitForGate(worktreeGate, call.signal); } } });
  f.releases.push(() => worktreeGate.resolve(), () => snapshotGate.resolve(), () => stateGate.resolve());
  await f.settings.update({ board: { queueCapacity: 3 } });
  const first = reservation('capacity-first'), second = reservation('capacity-second'), third = reservation('capacity-third');
  const files = f.board.files; f.board.files = { ...files, async snapshot(...args) { if (args[0].path.includes(first.id)) { snapshotEntered.resolve(); await snapshotGate.promise; } return files.snapshot(...args); } };
  const setTaskState = f.sessions.setTaskState.bind(f.sessions);
  f.sessions.setTaskState = async (id, state) => { if (id === 'local-' + first.id && state === 'queued') { stateEntered.resolve(); await stateGate.promise; } return setTaskState(id, state); };
  await f.board.create(input(), first); await worktreeEntered.promise;
  await f.board.create(input(), second);
  assert.equal(f.board.preparation(first.id).phase, 'worktree'); assert.equal(f.board.preparation(second.id).phase, 'waiting'); assert.equal(f.board.active, 2);
  worktreeGate.resolve(); await snapshotEntered.promise;
  assert.equal(f.board.preparation(first.id).phase, 'admission'); assert.equal(f.board.active, 2); assert.equal(f.board.view().tasks.length, 0);
  snapshotGate.resolve(); await stateEntered.promise;
  assert.equal(f.board.view().tasks.length, 1); assert.equal(f.board.active, 2, 'The persisted queued task and its in-flight admission are the same reservation.');
  await f.board.create(input(), third); assert.equal(f.board.active, 3);
  await assert.rejects(f.board.create(input(), reservation('capacity-fourth')), /queue is full/);
  await f.settings.update({ board: { paused: false } }); await f.board.tick();
  assert.equal(f.requests.length, 0, 'A task whose admission has not finished must not execute.');
  await f.settings.update({ board: { paused: true } });
  stateGate.resolve();
  await until(() => f.board.view().tasks.length === 3 && f.board.view().preparations.length === 0, 'The remaining reservations did not finish admission.');
  assert.equal(f.board.active, 3); assert.equal(f.prepared.length, 3); assert.equal(f.requests.length, 0);
});

test('cancelling a waiting or active preparation frees its reservation without admitting or executing it', { timeout: 120000 }, async t => {
  const gate = deferred(), entered = deferred();
  const f = await boardFixture(t, { async beforePrepare(call) { entered.resolve(); await waitForGate(gate, call.signal); } });
  f.releases.push(() => gate.resolve()); await f.settings.update({ board: { queueCapacity: 2 } });
  const first = reservation('cancel-active'), waiting = reservation('cancel-waiting');
  await f.board.create(input(), first); await entered.promise; await f.board.create(input(), waiting);
  await f.board.action({ id: waiting.id, action: 'cancel' });
  assert.equal(f.board.preparation(waiting.id).state, 'failed'); assert.match(f.board.preparation(waiting.id).error, /cancelled/i); assert.equal(f.board.active, 1);
  await f.board.action({ id: first.id, action: 'cancel' });
  await until(() => f.board.preparation(first.id)?.state === 'failed' && f.board.active === 0, 'The active preparation did not finish cancellation.');
  assert.match(f.board.preparation(first.id).error, /cancelled/i);
  await f.board.close();
  assert.equal(f.prepared.length, 1, 'A cancelled waiting entry must never invoke the preparation port.');
  assert.equal(f.prepared[0].signal.aborted, true); assert.equal(f.board.view().tasks.length, 0); assert.equal(f.requests.length, 0);
});

test('shutdown aborts preparation and drains its cleanup; restart does not replay an unadmitted request', { timeout: 120000 }, async t => {
  const entered = deferred(), aborted = deferred(), cleanup = deferred(); let hold = true;
  const f = await boardFixture(t, { async beforePrepare(call) {
    if (!hold) return;
    entered.resolve();
    await new Promise(resolve => { if (call.signal.aborted) resolve(); else call.signal.addEventListener('abort', resolve, { once: true }); });
    aborted.resolve(); await cleanup.promise; call.signal.throwIfAborted();
  } });
  f.releases.push(() => cleanup.resolve()); const submission = reservation('restart-background');
  await f.board.create(input(), submission); await entered.promise;
  let closed = false; const closing = f.close().then(() => { closed = true; }); await aborted.promise; await delay(0);
  assert.equal(closed, false, 'Shutdown must wait for the preparation port to release its resources.');
  cleanup.resolve(); await closing; hold = false; await f.open();
  assert.equal(f.board.view().preparations.length, 0); assert.equal(f.board.view().tasks.length, 0); assert.equal(f.prepared.length, 1);
  await f.board.tick(); assert.equal(f.prepared.length, 1, 'Restart cannot silently retry a request that was never admitted.');
  await f.board.create(input(), submission);
  await until(() => f.board.view().tasks.some(row => row.id === submission.id) && !f.board.preparation(submission.id), 'The explicit request after restart did not finish.');
  assert.equal(f.prepared.length, 2); assert.equal(f.prepared[0].key, f.prepared[1].key); assert.equal(f.sessions.runs.list().total, 1); assert.equal(f.requests.length, 0);
});

test('an explicit background retry reuses a pristine worktree after interrupted snapshots and restart', { timeout: 120000 }, async t => {
  const f = await workspaceFixture(t, true), request = command('recover-background', 'fixture'), files = f.workspace.board.files;
  f.workspace.board.files = { ...files, async snapshot() { throw new DomainError('unavailable', 'Fixture snapshot was interrupted.'); } };
  const accepted = await f.workspace.task(request); assert.equal(accepted.preparation.id, request.id);
  await until(() => f.workspace.board.preparation(request.id)?.state === 'failed', 'The interrupted snapshot did not leave a visible failure.');
  assert.equal(f.workspace.board.view().tasks.length, 0); assert.equal(f.workspace.sessions.runs.list().total, 0);
  const retained = (await readdir(join(f.project, '.werk', 'worktrees'))).filter(name => !name.startsWith('.')); assert.equal(retained.length, 1);
  await f.close(); await f.open();
  assert.equal(f.workspace.board.view().preparations.length, 0); assert.equal(f.workspace.board.view().tasks.length, 0);
  const retry = await f.workspace.task(request); assert.equal(retry.preparation.id, request.id);
  await until(() => f.workspace.board.view().tasks.some(row => row.id === request.id) && !f.workspace.board.preparation(request.id), 'The pristine retained worktree was not recovered.');
  const result = await f.workspace.task({ action: 'get', id: 'local-' + request.id }), replay = await f.workspace.task(request);
  assert.equal(result.session.id, replay.session.id); assert.equal(result.session.featureRequest.path, replay.session.featureRequest.path);
  assert.equal(f.workspace.board.detail(request.id).worktree, join(f.project, '.werk', 'worktrees', retained[0]));
  assert.deepEqual((await readdir(join(f.project, '.werk', 'worktrees'))).filter(name => !name.startsWith('.')), retained);
  assert.equal(f.workspace.sessions.runs.list().total, 1); assert.equal(f.workspace.board.view().tasks.length, 1);
  assert.ok(f.workspace.sessions.runs.list().rows.every(run => run.startedAt === null));
  assert.equal(await readFile(join(f.project, 'approved.txt'), 'utf8'), 'Committed fixture input\n');
});

test('a waiting background request keeps its accepted definition after that definition is updated and its reference moves', { timeout: 120000 }, async t => {
  const f = await workspaceFixture(t), gate = deferred(), entered = deferred(), files = f.workspace.board.files;
  f.releases.push(() => gate.resolve());
  let firstSnapshot = true;
  f.workspace.board.files = { ...files, async snapshot(...args) { if (firstSnapshot) { firstSnapshot = false; entered.resolve(); await gate.promise; } return files.snapshot(...args); } };
  const yaml = instruction => 'agents:\n  root:\n    model: openai/fixture-model\n    instruction: ' + instruction + '\n';
  const { definitions: [original] } = await f.workspace.definitions.action({ action: 'import', name: 'Accepted reviewer', ref: 'team-reviewer', yaml: yaml('Keep the originally accepted instructions.') });
  await f.workspace.task(command('definition-blocker', f.project)); await entered.promise;
  const request = command('definition-waiting', f.project, { definitionRef: 'team-reviewer' });
  const accepted = await f.workspace.task(request); assert.equal(accepted.preparation.id, request.id);
  assert.equal(f.workspace.board.preparation(request.id).phase, 'waiting');
  await f.workspace.definitions.action({ action: 'update', ref: 'team-reviewer', revision: original.revision, yaml: yaml('Changed instructions must apply only to future requests.') });
  const { definitions } = await f.workspace.definitions.action({ action: 'import', name: 'Replacement reviewer', yaml: yaml('A different reviewer is selected for future work.') });
  await f.workspace.definitions.action({ action: 'ref', id: definitions.find(item => item.id !== original.id).id, ref: 'team-reviewer' });
  const pendingReplay = await f.workspace.task(request); assert.equal(pendingReplay.preparation.id, request.id);
  gate.resolve();
  await until(() => f.workspace.board.view().tasks.length === 2 && f.workspace.board.view().preparations.length === 0, 'The request with a frozen definition did not finish admission.');
  const result = await f.workspace.task({ action: 'get', id: 'local-' + request.id });
  assert.equal(result.session.definition.definitionId, original.id); assert.equal(result.session.definition.digest, original.digest);
  assert.equal(result.session.definition.instruction, 'Keep the originally accepted instructions.');
  assert.deepEqual(f.workspace.board.detail(request.id).definition, result.session.definition);
  const replay = await f.workspace.task(request); assert.equal(replay.session.id, result.session.id);
  assert.equal(f.workspace.sessions.runs.list().total, 2, 'Definition changes and request replay cannot duplicate accepted turns.');
  assert.ok(f.workspace.sessions.runs.list().rows.every(run => run.startedAt === null));
});

test('a full queue rejects retry without erasing the failed preparation or its accepted identity', { timeout: 120000 }, async t => {
  const gate = deferred(), entered = deferred();
  const f = await boardFixture(t, { async beforePrepare(call) {
    if (call.index === 0) throw new DomainError('conflict', 'Fixture checkout needs an explicit retry.');
    entered.resolve(); await waitForGate(gate, call.signal);
  } });
  f.releases.push(() => gate.resolve()); await f.settings.update({ board: { queueCapacity: 1 } });
  const failed = reservation('retry-when-full'), blocker = reservation('retry-capacity-blocker');
  await f.board.create(input(), failed);
  await until(() => f.board.preparation(failed.id)?.state === 'failed', 'The initial preparation did not fail.');
  const retained = f.board.preparation(failed.id);
  await f.board.create(input(), blocker); await entered.promise;
  await assert.rejects(f.board.create(input(), failed), /queue is full/);
  assert.deepEqual(f.board.preparation(failed.id), retained, 'A rejected retry must keep the visible reason and retry identity.');
  await assert.rejects(f.board.create(input(), { ...failed, hash: 'b'.repeat(64) }), error => error.code === 'conflict' && /different input/.test(error.message));
  assert.equal(f.prepared.length, 2); assert.equal(f.board.active, 1); assert.equal(f.board.view().tasks.length, 0);
  await f.board.action({ id: blocker.id, action: 'cancel' });
  await until(() => f.board.active === 0, 'The capacity blocker did not release its reservation.');
  assert.deepEqual(f.board.preparation(failed.id), retained); assert.equal(f.requests.length, 0);
});

test('a file request cannot claim the raw identity of another preparing or admitted file request as its session', { timeout: 120000 }, async t => {
  const f = await workspaceFixture(t), gate = deferred(), entered = deferred(), files = f.workspace.board.files;
  f.releases.push(() => gate.resolve());
  f.workspace.board.files = { ...files, async snapshot(...args) { entered.resolve(); await gate.promise; return files.snapshot(...args); } };
  const original = command('local-alias-request', f.project), overlapping = command('alias-request', f.project);
  const accepted = await f.workspace.task(original); await entered.promise;
  await assert.rejects(f.workspace.task(overlapping), error => error.code === 'conflict');
  const pendingReplay = await f.workspace.task(original); assert.equal(pendingReplay.preparation.id, accepted.preparation.id);
  assert.equal(f.workspace.board.view().preparations.length, 1); assert.equal(f.workspace.board.active, 1);
  gate.resolve();
  await until(() => f.workspace.board.view().tasks.length === 1 && f.workspace.board.view().preparations.length === 0, 'The original aliased request did not finish admission.');
  await assert.rejects(f.workspace.task(overlapping), error => error.code === 'conflict');
  const replay = await f.workspace.task(original); assert.equal(replay.session.id, 'local-' + original.id);
  assert.equal(f.workspace.board.view().tasks.length, 1); assert.equal(f.workspace.sessions.runs.list().total, 1);
  assert.equal(f.workspace.featureTracking.status().records.length, 1);
});
