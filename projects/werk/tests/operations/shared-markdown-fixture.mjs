import assert from 'node:assert/strict';
import { observePublishedFeature } from './shared-intake-observation.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { workerStatus } from '../helpers/worker-status.mjs';
import { taskboardRuntime } from '../worker/runtime-fixtures.mjs';

const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function markdownParts(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  assert.ok(match, 'Expected an Obsidian Markdown note with YAML frontmatter.');
  /** @type {Record<string, unknown>} */
  const data = parse(match[1]);
  assert.ok(data && typeof data === 'object' && !Array.isArray(data));
  return { data, body: match[2] };
}

export function readyAnswer(markdown, answer, fields = {}) {
  const { data, body } = markdownParts(markdown);
  assert.match(body, /^## Answer\r?$/m);
  return '---\n' + stringify({ ...data, status: 'ready', ...fields }) + '---\n'
    + body.replace(/(^## Answer\r?\n)[\s\S]*$/m, '$1\n' + answer + '\n');
}

/** Real Git publication and production worker/model adapters; the HTTP transport never leaves this process.
 * @param {import('node:test').TestContext} t
 */
export async function sharedMarkdownFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk markdown team ')));
  const remote = join(directory, 'origin.git'), author = join(directory, 'teammate');
  const checkout = join(directory, 'worker'), state = join(directory, 'state');
  /** @type {WorkerWorkspace | undefined} */
  let workspace;
  /** @type {SnapshotJournal | undefined} */
  let journal;
  /** @type {string[]} */
  const sent = [];
  let featureId = '', requestPath = '', sourceCommit = '';
  let phaseName = 'initialize repositories and authoring kit', phaseStarted = Date.now();
  let syncCount = 0, restartCount = 0;
  function phase(next) {
    t.signal.throwIfAborted();
    t.diagnostic(phaseName + ' completed in ' + (Date.now() - phaseStarted) + 'ms');
    phaseName = next; phaseStarted = Date.now();
  }
  const aborted = () => t.diagnostic('Aborted during ' + phaseName + ' after ' + (Date.now() - phaseStarted) + 'ms');
  t.signal.addEventListener('abort', aborted, { once: true });
  async function git(cwd, ...args) {
    return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      signal: t.signal, timeout: 30000, maxBuffer: 2097152,
    })).stdout.trim();
  }
  async function cli(entry, cwd, ...args) {
    return JSON.parse((await execute(process.execPath, [entry, ...args], {
      cwd, signal: t.signal, timeout: 45000, maxBuffer: 2097152,
    })).stdout);
  }
  async function configureGit(cwd) {
    await git(cwd, 'config', 'core.autocrlf', 'false');
    await git(cwd, 'config', 'core.eol', 'lf');
    await git(cwd, 'config', 'user.name', 'Markdown team fixture');
    await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  }
  function current() { assert.ok(workspace); return workspace; }
  async function stop() {
    const previous = workspace, previousJournal = journal;
    workspace = undefined; journal = undefined;
    try { await previous?.close(); } finally { previousJournal?.close(); }
  }
  t.after(async () => {
    t.diagnostic('Final phase: ' + phaseName + ' (' + (Date.now() - phaseStarted) + 'ms); syncs: ' + syncCount + ', restarts: ' + restartCount);
    t.signal.removeEventListener('abort', aborted);
    try { await stop(); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  /** @type {typeof fetch} */
  const fixtureTransport = async (_url, options) => {
    assert.equal(typeof options?.body, 'string');
    const body = String(options.body);
    sent.push(body);
    const claimed = await git(remote, 'show', `main:${requestPath}`);
    assert.match(claimed, /taskId: shared-feature-/);
    assert.match(claimed, new RegExp(sourceCommit));
    const text = sent.length === 1 ? {
      werkInteraction: {
        schemaVersion: 1, kind: 'question', message: 'Which retry policy should the implementation use?',
        choices: [{ id: 'retry_once', label: 'Retry once' }, { id: 'never_retry', label: 'Never retry' }],
        reason: 'Repeating the operation can duplicate work.',
      },
    } : {
      summary: 'Deterministic fixture proposal; independent application verification remains human review.',
      files: [{ path: 'approved.txt', content: 'Retry once, then report the failure.\n' }],
    };
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(text) }] }] });
  };
  async function start() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64));
    await journal.init();
    workspace = new WorkerWorkspace({ stateDir: state, projectDir: checkout,
      features: { directory: join(checkout, 'features'), provider: 'openai-api', pollMs: 1000 },
      pollMs: 1000, timeoutMs: 60000,
    }, journal, workerStatus);
    taskboardRuntime(workspace.board).model = (connection, path, _transport, options) => modelFor(connection, path, fixtureTransport, options);
    await workspace.init();
  }
  async function sync() {
    const started = Date.now(), count = ++syncCount;
    try {
      await current().sharedIntakeCommand({ action: 'sync' });
      return current().sharedIntakeView();
    } finally { t.diagnostic('Shared sync ' + count + ' took ' + (Date.now() - started) + 'ms during ' + phaseName); }
  }
  function feature() {
    const row = current().sharedIntakeView().requests.find(row => row.id === featureId);
    assert.ok(row, JSON.stringify(current().sharedIntakeView()));
    return row;
  }
  function task() {
    const id = feature().taskId; assert.ok(id);
    return current().board.detail(id);
  }
  async function waitFor(check, describe) {
    for (let attempt = 0; attempt < 400; attempt++) {
      t.signal.throwIfAborted();
      if (await check()) return;
      await delay(25);
    }
    throw Error('Timed out: ' + describe());
  }
  async function settle(status) {
    await waitFor(() => task().status === status && !current().sessions.executor.busy,
      () => JSON.stringify({ task: task(), calls: sent.length, intake: current().sharedIntakeView() }));
  }
  async function publish(path, markdown, message) {
    await git(author, 'pull', '--ff-only', 'origin', 'main');
    await writeFile(join(author, path), markdown);
    await git(author, 'add', path);
    await git(author, 'commit', '-m', message);
    await git(author, 'push', 'origin', 'main');
  }
  async function published(path) { return git(remote, 'show', `main:${path}`); }
  async function checkoutEvidence() {
    return {
      head: await git(checkout, 'rev-parse', 'HEAD'), branch: await git(checkout, 'symbolic-ref', 'HEAD'),
      index: await readFile(join(checkout, '.git/index')),
      staged: await git(checkout, 'show', ':approved.txt'),
      file: await readFile(join(checkout, 'approved.txt'), 'utf8'),
      untracked: await readFile(join(checkout, 'developer-only.txt'), 'utf8'),
    };
  }
  await mkdir(remote); await git(remote, 'init', '--bare', '--initial-branch=main');
  await git(directory, 'clone', remote, author); await configureGit(author);
  await cli(resolve('bin/apps/worker/cli.mjs'), author, 'feature', 'setup', '--provider', 'openai-api');
  const workflowPath = join(author, '.werk/feature-workflow.json');
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  workflow.tasksDirectory = 'team/tasks'; workflow.reviewDirectory = 'team/reviews';
  await writeFile(workflowPath, JSON.stringify(workflow, null, 2) + '\n');
  await writeFile(join(author, '.gitattributes'), '* text eol=lf\n');
  await writeFile(join(author, 'approved.txt'), 'committed source\n');
  await git(author, 'add', '.'); await git(author, 'commit', '-m', 'Configure shared Markdown workflow');
  await git(author, 'push', '-u', 'origin', 'main');
  await git(directory, 'clone', remote, checkout); await configureGit(checkout);
  // This direct workspace fixture bypasses runner startup; prepare before its Git/sync operation budgets.
  await prepareProcessRuntime(checkout, t.signal);
  phase('initialize workspace and shared binding');
  await start();
  await current().updateSettings({ board: { paused: true },
    provider: { id: 'openai-api', apiKey: 'fixture-only-never-sent', model: 'fixture-model' },
    repositories: { pollMs: 300000, items: [{ id: 'shared', path: checkout, remote: 'origin', branch: 'main', watch: true }] },
  });
  await current().sharedIntakeCommand({ action: 'configure', expectedRevision: 0, config: {
    enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000,
  } });
  await git(checkout, 'switch', '-c', 'developer-topic');
  await writeFile(join(checkout, 'approved.txt'), 'developer staged change\n'); await git(checkout, 'add', 'approved.txt');
  await writeFile(join(checkout, 'approved.txt'), 'developer unstaged change\n');
  await writeFile(join(checkout, 'developer-only.txt'), 'preserve this untracked file\n');
  const originalCheckout = await checkoutEvidence();
  phase('author and publish a ready request');
  const authoring = join(author, '.werk/authoring/feature-request.mjs');
  const created = await cli(authoring, author, 'create', '--name', 'retry-policy.md', '--title', 'Clarify the retry policy');
  featureId = created.id; requestPath = created.path;
  const draft = (await readFile(join(author, requestPath), 'utf8'))
    .replace('paths: []', 'paths: [approved.txt]')
    .replace('<!-- Explain the problem, who experiences it, and the observable outcome. -->', 'Document a retry policy chosen by the team.')
    .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Ask the team which retry policy to use before changing the approved file.')
    .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- [ ] Only the approved file changes.\n- [ ] The retry policy matches the team answer.')
    .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Inspect the proposed diff and review the recorded question and answer.');
  await writeFile(join(author, requestPath), draft);
  const validated = await cli(authoring, author, 'validate', '--file', requestPath);
  assert.equal(validated.valid, true, JSON.stringify(validated));
  await cli(authoring, author, 'ready', '--file', requestPath, '--if-match', validated.revision);
  const previousCommit = await git(author, 'rev-parse', 'HEAD');
  await git(author, 'add', requestPath); await git(author, 'commit', '-m', 'Queue a ready feature'); await git(author, 'push', 'origin', 'main');
  sourceCommit = await git(author, 'rev-parse', 'HEAD');
  await current().updateSettings({ board: { paused: false } });
  phase('claim the request and publish the model question');
  await observePublishedFeature(sync, { id: featureId, sourceCommit, previousCommit, signal: t.signal, diagnostic: message => t.diagnostic(message) });
  assert.equal(task().status, 'queued'); assert.equal(task().baseCommit, sourceCommit);
  await current().board.tick(); await settle('waiting_input'); await sync();
  assert.equal(sent.length, 1);
  return {
    current, sync, feature, task, settle, publish, published, checkoutEvidence, originalCheckout, phase,
    git, remote, author, checkout, sent, requestPath, sourceCommit,
    async restart() {
      const started = Date.now(), count = ++restartCount;
      try { await stop(); await start(); }
      finally { t.diagnostic('Workspace restart ' + count + ' took ' + (Date.now() - started) + 'ms during ' + phaseName); }
    },
  };
}
