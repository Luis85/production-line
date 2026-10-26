import { legacyProjectFixture } from '../helpers/legacy-project-worker.mjs';
import { observePublishedFeature } from './shared-intake-observation.mjs';
import { taskboardRuntime } from "../worker/runtime-fixtures.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const execute = promisify(execFile), installer = resolve('bin/apps/worker/cli.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');

test('legacy installed worker recovers and publishes one frozen shared feature from two clones and preserves the developer checkout across restart', { timeout: 120000 }, async t => {
  async function git(directory, ...args) {
    return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { signal: t.signal, timeout: 30000, maxBuffer: 2097152 })).stdout.trim();
  }
  async function cli(entry, cwd, ...args) {
    return JSON.parse((await execute(process.execPath, [entry, ...args], { cwd, signal: t.signal, timeout: 45000, maxBuffer: 2097152 })).stdout);
  }
  async function waitFor(check, describe) {
    for (let i = 0; i < 200; i++) { t.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(25); }
    throw Error('Timed out: ' + describe());
  }
  async function configureGit(directory) {
    await git(directory, 'config', 'core.autocrlf', 'false'); await git(directory, 'config', 'core.eol', 'lf');
    await git(directory, 'config', 'user.name', 'Shared feature journey fixture');
    await git(directory, 'config', 'user.email', 'fixture@example.invalid');
  }
  async function checkoutEvidence(directory) {
    return {
      head: await git(directory, 'rev-parse', 'HEAD'), branch: await git(directory, 'symbolic-ref', 'HEAD'),
      index: await readFile(join(directory, '.git/index')), file: await readFile(join(directory, 'approved.txt'), 'utf8'),
      staged: await git(directory, 'show', ':approved.txt'), untracked: await readFile(join(directory, 'developer-only.txt'), 'utf8'),
    };
  }
  let phase = 'initialize repositories and authoring kit', phaseStarted = Date.now();
  function advance(next) {
    t.signal.throwIfAborted();
    t.diagnostic(phase + ' completed in ' + (Date.now() - phaseStarted) + 'ms');
    phase = next; phaseStarted = Date.now();
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk shared journey ')));
  const remote = join(directory, 'origin.git'), author = join(directory, 'author'), checkout = join(directory, 'worker');
  /** @type {import('../../src/worker/dist/worker/status/workspace.js').WorkerWorkspace} */
  let workspace;
  let journal, server, url, token;
  async function stop() {
    const currentServer = server, currentWorkspace = workspace, currentJournal = journal;
    server = undefined; workspace = undefined; journal = undefined;
    // Stop accepting connections, then cancel workspace work before waiting for active HTTP requests.
    const closed = currentServer ? new Promise((resolve, reject) => currentServer.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    const results = await Promise.allSettled([closed, Promise.resolve().then(() => currentWorkspace?.close())]);
    currentJournal?.close();
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  t.after(async () => {
    t.diagnostic('Last phase: ' + phase + ' (' + (Date.now() - phaseStarted) + 'ms)');
    try { await stop(); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  await mkdir(remote); await git(remote, 'init', '--bare', '--initial-branch=main');
  await git(directory, 'clone', remote, author); await configureGit(author);
  await cli(installer, author, 'feature', 'setup', '--provider', 'openai-api');
  await assert.rejects(access(join(author, 'bin/apps/worker')), { code: 'ENOENT' });
  await writeFile(join(author, '.gitattributes'), '* text eol=lf\n');
  await writeFile(join(author, 'approved.txt'), 'committed source\n');
  for (const [stage, rule] of [
    ['ready', { id: 'two-observable-outcomes', fact: 'input.criteriaCount', op: 'gte', value: 2 }],
    ['done', { id: 'exactly-one-approved-file', fact: 'output.changedFileCount', op: 'eq', value: 1 }],
  ]) {
    const path = join(author, `fr-${stage}-check.json`), check = JSON.parse(await readFile(path, 'utf8'));
    check.rules.patch.push(rule); await writeFile(path, JSON.stringify(check, null, 2) + '\n');
  }
  await git(author, 'add', '.'); await git(author, 'commit', '-m', 'Shared workflow and custom checks'); await git(author, 'push', '-u', 'origin', 'main');
  await git(directory, 'clone', remote, checkout); await configureGit(checkout);
  advance('reconstruct historical worker fixture');
  await legacyProjectFixture(checkout, ['--provider', 'openai-api']);
  const application = join(checkout, 'bin/apps/worker'), built = join(application, 'src/worker/dist/worker');
  const { WorkerWorkspace } = await import(pathToFileURL(join(built, 'status/workspace.js')).href);
  const { SnapshotJournal } = await import(pathToFileURL(join(built, 'infrastructure/journal/snapshots.js')).href);
  const { statusServer } = await import(pathToFileURL(join(built, 'status/server.js')).href);
  const { modelFor } = await import(pathToFileURL(join(built, 'infrastructure/providers.js')).href);
  const { prepareProcessRuntime } = await import(pathToFileURL(join(application, 'src/worker/dist/shared/process/launcher.js')).href);
  // This direct workspace fixture uses the installed package's runtime, outside runner startup.
  await prepareProcessRuntime(checkout, t.signal);
  const state = join(checkout, '.werk/worker');
  const status = { workerId: null, project: null, mode: 'mock', state: 'standalone', taskId: null, attempt: null, profile: null, completedSimulations: 0, lastContact: null, lastError: null, updatedAt: new Date().toISOString(), profiles: [], heartbeatErrors: 0, maxParallel: 1, activeTasks: [], queuedTasks: [], configurationHash: 'a'.repeat(64), lastSnapshot: null };
  let modelCalls = 0, requestPath, featureId, sourceCommit;
  const sent = [], transportErrors = [];
  async function fixtureTransport(_url, options) {
    try {
    modelCalls++; sent.push(JSON.parse(options.body));
    const claimed = await git(remote, 'show', `main:${requestPath}`);
    assert.match(claimed, /^    taskId: shared-feature-/m);
    assert.match(claimed, /^    sourceHash: [a-f0-9]{64}$/m);
    assert.match(claimed, new RegExp(sourceCommit));
    assert.match(claimed, new RegExp(workspace.sharedIntakeView().workerId));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Fixture proposal; no independent tests were run.', files: [{ path: 'approved.txt', content: 'proposed shared change\n' }] }) }] }] });
    } catch (error) { transportErrors.push(String(error)); throw error; }
  }
  async function start() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    workspace = new WorkerWorkspace({ stateDir: state, projectDir: checkout, features: { directory: join(checkout, 'features'), provider: 'openai-api', pollMs: 1000 }, pollMs: 1000, timeoutMs: 60000 }, journal, () => status);
    // The actual installed API adapter receives an in-memory HTTP fixture. It cannot make external model requests.
    taskboardRuntime(workspace.board).model = (connection, directory, _transport, options) => modelFor(connection, directory, fixtureTransport, options);
    await workspace.init();
    server = await statusServer(() => status, '127.0.0.1', 0, undefined, workspace);
    url = `http://127.0.0.1:${server.address().port}`;
    token = (await readFile(join(state, 'webview-token'), 'utf8')).trim();
  }
  async function api(path, body) {
    t.signal.throwIfAborted();
    const response = await fetch(url + path, { signal: t.signal, method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  }
  advance('initialize workspace');
  await start();
  advance('assign repository and configure shared intake');
  await api('/api/settings', { board: { paused: true }, provider: { id: 'openai-api', apiKey: 'fixture-only-never-sent', model: 'fixture-model' }, repositories: { pollMs: 300000, items: [{ id: 'shared', path: checkout, remote: 'origin', branch: 'main', watch: true }] } });
  // Explicit synchronization drives the journey; an already scheduled startup poll may still overlap the push.
  const binding = { enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000 };
  await api('/api/shared-intake', { action: 'configure', expectedRevision: 0, config: binding });
  await git(checkout, 'switch', '-c', 'developer-topic');
  await writeFile(join(checkout, 'approved.txt'), 'developer staged change\n'); await git(checkout, 'add', 'approved.txt');
  await writeFile(join(checkout, 'approved.txt'), 'developer unstaged change\n'); await writeFile(join(checkout, 'developer-only.txt'), 'leave this untracked file alone\n');
  const original = await checkoutEvidence(checkout);
  advance('author and validate ready request');
  const authoring = join(author, '.werk/authoring/feature-request.mjs');
  const created = await cli(authoring, author, 'create', '--name', 'shared-change.md', '--title', 'Review a shared change');
  featureId = created.id; requestPath = created.path;
  let draft = await readFile(join(author, requestPath), 'utf8');
  draft = draft.replace('paths: []', 'paths: [approved.txt]')
    .replace('<!-- Explain the problem, who experiences it, and the observable outcome. -->', 'Make the approved text explain the shared change.')
    .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Preserve all developer checkout edits and unrelated files.')
    .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- [ ] The approved file contains the proposed shared change.\n- [ ] No unrelated file changes are proposed.')
    .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Compare the feature branch diff against the approved file and review it before merging.');
  await writeFile(join(author, requestPath), draft);
  const validated = await cli(authoring, author, 'validate', '--file', requestPath); assert.equal(validated.valid, true);
  const ready = await cli(authoring, author, 'ready', '--file', requestPath, '--if-match', validated.revision); assert.equal(ready.status, 'ready');
  const previousCommit = await git(author, 'rev-parse', 'HEAD');
  await git(author, 'add', requestPath); await git(author, 'commit', '-m', 'Author ready shared feature'); await git(author, 'push', 'origin', 'main');
  sourceCommit = await git(author, 'rev-parse', 'HEAD');
  const originalDoneHash = digest(await readFile(join(author, 'fr-done-check.json')));
  await api('/api/settings', { board: { paused: false } });
  advance('claim and admit frozen request');
  let intake = await observePublishedFeature(() => api('/api/shared-intake', { action: 'sync' }), {
    id: featureId, sourceCommit, previousCommit, signal: t.signal, diagnostic: message => t.diagnostic(message),
  });
  const claimed = intake.requests.find(row => row.id === featureId); assert.ok(claimed, JSON.stringify(intake));
  assert.ok(workspace);
  const task = workspace.board.detail(claimed.taskId);
  assert.equal(task.status, 'queued'); assert.equal(task.baseCommit, sourceCommit); assert.equal(task.repositoryId, 'shared');
  assert.equal(task.files[0].content, 'committed source\n'); assert.equal(task.criteria.length, 2);
  assert.ok(task.gatePolicy.done.patch.some(rule => rule.id === 'exactly-one-approved-file' && rule.value === 1));
  assert.ok(task.worktree.startsWith(join(checkout, '.werk/worktrees')));
  assert.deepEqual(await checkoutEvidence(checkout), original);
  advance('revise future policy without changing admitted policy');
  // Revise the current team policy after the durable claim; this attempt must retain its admitted policy.
  await git(author, 'pull', '--ff-only', 'origin', 'main');
  const donePath = join(author, 'fr-done-check.json'), revised = JSON.parse(await readFile(donePath, 'utf8'));
  revised.rules.patch.find(rule => rule.id === 'exactly-one-approved-file').value = 2;
  await writeFile(donePath, JSON.stringify(revised, null, 2) + '\n');
  await git(author, 'add', 'fr-done-check.json'); await git(author, 'commit', '-m', 'Change future completion policy'); await git(author, 'push', 'origin', 'main');
  advance('execute admitted request');
  await workspace.board.tick();
  await waitFor(() => workspace.board.detail(task.id).status === 'review' && !workspace.sessions.executor.busy, () => JSON.stringify({errors: transportErrors, task: workspace.board.detail(task.id)}));
  assert.equal(modelCalls, 1); assert.match(JSON.stringify(sent[0]), /committed source/); assert.doesNotMatch(JSON.stringify(sent[0]), /developer unstaged/);
  assert.match(JSON.stringify(sent[0]), /No unrelated file changes/);
  advance('publish feature branch and review note');
  intake = await api('/api/shared-intake', { action: 'sync' });
  const completed = intake.requests.find(row => row.id === featureId);
  assert.equal(completed.status, 'ready_for_review', JSON.stringify(completed)); assert.equal(completed.publication, 'synced'); assert.equal(completed.done.passed, true);
  advance('verify published evidence and untouched developer checkout');
  const note = await api('/api/shared-intake', { action: 'note', id: featureId });
  assert.match(note.markdown, new RegExp(originalDoneHash)); assert.match(note.markdown, new RegExp(sourceCommit)); assert.match(note.markdown, /human review/i);
  await git(author, 'fetch', 'origin');
  assert.equal(await git(author, 'show', `origin/${completed.featureBranch}:approved.txt`), 'proposed shared change');
  assert.equal(await git(author, 'show', 'origin/main:approved.txt'), 'committed source');
  assert.equal(await git(author, 'diff', '--name-only', sourceCommit, `origin/${completed.featureBranch}`), 'approved.txt');
  assert.equal(await git(author, 'rev-parse', `origin/${completed.featureBranch}^`), sourceCommit);
  assert.equal(await git(author, 'show', `origin/main:${completed.reviewNote}`), note.markdown.trim());
  assert.match(await git(author, 'show', `origin/main:${requestPath}`), /status: ready_for_review/);
  assert.match(note.markdown, /\[\[\.\.\/features\/shared-change\]\]/);
  const refs = await git(remote, 'show-ref');
  assert.deepEqual(await checkoutEvidence(checkout), original);
  advance('stop and restart workspace');
  await stop(); await start();
  assert.deepEqual(await checkoutEvidence(checkout), original, 'Restart initialization must load the shared binding before starting repository watchers.');
  advance('reconcile after restart without duplicate execution or publication');
  await workspace.board.tick(); await api('/api/shared-intake', { action: 'sync' });
  assert.equal(modelCalls, 1); assert.equal(workspace.board.view().tasks.length, 1);
  assert.equal(workspace.board.view().tasks[0].id, task.id); assert.equal(await git(remote, 'show-ref'), refs);
  assert.deepEqual(await checkoutEvidence(checkout), original);
  advance('completed');
});
