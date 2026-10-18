import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { sharedRunnerModelSource } from './shared-runner-model.mjs';

const execute = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Real runner timers, Git publication and CLI/MCP tools; no live model calls or manual dispatch. */
export async function sharedRunnerFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk overnight runner ')));
  const remote = join(directory, 'origin.git'), author = join(directory, 'teammate'), checkout = join(directory, 'worker');
  const state = join(directory, 'state'), callsPath = join(directory, 'model-calls.jsonl');
  const executable = join(directory, 'labelled-claude-fixture.mjs');
  const stop = new AbortController();
  let running, runError, url = '', token = '', lastView;
  async function git(cwd, ...args) {
    return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { signal: t.signal, timeout: 30000, maxBuffer: 2097152 })).stdout.trim();
  }
  async function cli(entry, cwd, ...args) {
    return JSON.parse((await execute(process.execPath, [entry, ...args], { cwd, signal: t.signal, timeout: 30000, maxBuffer: 2097152 })).stdout);
  }
  async function configureGit(cwd) {
    await git(cwd, 'config', 'core.autocrlf', 'false'); await git(cwd, 'config', 'core.eol', 'lf');
    await git(cwd, 'config', 'user.name', 'Unattended runner fixture'); await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  }
  async function events() {
    const text = await readFile(callsPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async function api(path, body) {
    t.signal.throwIfAborted();
    const response = await fetch(url + path, { signal: AbortSignal.any([t.signal, AbortSignal.timeout(15000)]), method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  }
  async function view() { lastView = await api('/api/shared-intake'); return lastView; }
  async function until(check, label, milliseconds = 60000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      t.signal.throwIfAborted(); if (runError) throw runError;
      const result = await check(); if (result) return result;
      await delay(250);
    }
    throw Error(label + ': ' + JSON.stringify({ intake: lastView, events: (await events()).map(({ identity, phase }) => ({ identity, phase })) }));
  }
  async function observePolls(count = 2) {
    let previous = (await view()).lastSyncedAt, observed = 0;
    await until(async () => { const next = (await view()).lastSyncedAt; if (next && next !== previous) { previous = next; observed++; } return observed >= count; }, 'Automatic shared polling must continue', 20000);
  }
  async function checkoutEvidence() {
    return { head: await git(checkout, 'rev-parse', 'HEAD'), branch: await git(checkout, 'symbolic-ref', 'HEAD'), index: await readFile(join(checkout, '.git/index')), staged: await git(checkout, 'show', ':approved.txt'), file: await readFile(join(checkout, 'approved.txt'), 'utf8'), untracked: await readFile(join(checkout, 'developer-only.txt'), 'utf8') };
  }
  async function createRequest(name, identity, ready = true) {
    const authoring = join(author, '.werk/authoring/feature-request.mjs');
    const created = await cli(authoring, author, 'create', '--name', name, '--title', 'Overnight fixture ' + identity);
    const path = join(author, created.path);
    const draft = (await readFile(path, 'utf8'))
      .replace('paths: []', 'paths: [approved.txt]')
      .replace('<!-- Explain the problem, who experiences it, and the observable outcome. -->', 'Implement the approved text change [batch-' + identity + '].')
      .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Preserve unrelated files and developer edits. The batch-00 request needs a team retry decision first.')
      .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- [ ] The approved file contains the requested implementation.\n- [ ] The configured source verification passes.')
      .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Run the required verify-source command against the edited candidate. Review its passing evidence before merge.');
    await writeFile(path, draft);
    if (ready) {
      const checked = await cli(authoring, author, 'validate', '--file', created.path);
      assert.equal(checked.valid, true, JSON.stringify(checked));
      await cli(authoring, author, 'ready', '--file', created.path, '--if-match', checked.revision);
    }
    return { id: created.id, path: created.path, identity };
  }
  async function push(paths, message) {
    await git(author, 'add', ...paths); await git(author, 'commit', '-m', message); await git(author, 'push', 'origin', 'main');
    return git(author, 'rev-parse', 'HEAD');
  }
  t.after(async () => {
    stop.abort();
    try { await running; }
    finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  await mkdir(remote); await git(remote, 'init', '--bare', '--initial-branch=main');
  await git(directory, 'clone', remote, author); await configureGit(author);
  await cli(resolve('bin/apps/worker/cli.mjs'), author, 'feature', 'setup', '--provider', 'claude-cli');
  const workflowPath = join(author, '.werk/feature-workflow.json');
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  workflow.tasksDirectory = 'team/tasks'; workflow.reviewDirectory = 'team/reviews';
  await writeFile(workflowPath, JSON.stringify(workflow, null, 2) + '\n');
  await writeFile(join(author, '.gitattributes'), '* text eol=lf\n');
  await writeFile(join(author, 'approved.txt'), 'committed source\n');
  const draft = await createRequest('90-draft.md', 'draft', false);
  await push(['.'], 'Publish shared setup and an unready draft');
  await git(directory, 'clone', remote, checkout); await configureGit(checkout);
  const local = await createRequest('91-unpushed.md', 'local');
  // A committed author request and a local worker copy still are not shared intake.
  await git(author, 'add', local.path); await git(author, 'commit', '-m', 'Keep this ready request local');
  await writeFile(executable, sharedRunnerModelSource(callsPath, join(directory, 'model-active.lock')), { mode: 0o700 });
  const config = await configuration({ 'poll-ms': '100', profiles: 'claude' });
  const ready = Promise.withResolvers();
  running = runWorker({ ...config, stateDir: state, projectDir: checkout, features: { directory: join(checkout, 'features'), provider: 'claude-cli', pollMs: 250 }, url: '', enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal, { ready: async address => { url = 'http://127.0.0.1:' + address.port; ready.resolve(undefined); } });
  running.catch(error => { runError = error; ready.reject(error); });
  await ready.promise;
  token = (await readFile(join(state, 'webview-token'), 'utf8')).trim();
  await api('/api/settings', { board: { paused: true, queueCapacity: 1 }, provider: { id: 'claude-cli', executable, model: 'labelled-fixture' }, repositories: { pollMs: 300000, items: [{ id: 'shared', path: checkout, remote: 'origin', branch: 'main', watch: true }] } });
  const tools = await api('/api/tool-access');
  const check = "const assert=require('node:assert/strict');const fs=require('node:fs');assert.match(fs.readFileSync('approved.txt','utf8'),/^Implemented batch-(00|10|20)\\n$/);console.log('Verified actual candidate source.');";
  await api('/api/tool-access', { expectedRevision: tools.revision, builtins: { ...tools.builtins, files: true, commands: [{ id: 'verify-source', name: 'Verify candidate source', executable: process.execPath, args: ['-e', check], enabled: true, verification: true }] }, mcp: [] });
  await api('/api/shared-intake', { action: 'configure', expectedRevision: 0, config: { enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 1000 } });
  await writeFile(join(checkout, local.path), await readFile(join(author, local.path)));
  await api('/api/settings', { board: { paused: false } });
  await git(checkout, 'switch', '-c', 'developer-topic');
  await writeFile(join(checkout, 'approved.txt'), 'developer staged change\n'); await git(checkout, 'add', 'approved.txt');
  await writeFile(join(checkout, 'approved.txt'), 'developer unstaged change\n');
  await writeFile(join(checkout, 'developer-only.txt'), 'preserve this untracked file\n');
  const originalCheckout = await checkoutEvidence();
  return { git, api, view, until, observePolls, events, createRequest, push, checkoutEvidence, originalCheckout, remote, author, checkout, draft, local,
    published: path => git(remote, 'show', 'main:' + path),
    async finish() { stop.abort(); await running; },
  };
}
