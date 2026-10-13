import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from '../../src/worker/dist/worker/application/sessions.js';
import { LocalTaskboard } from '../../src/worker/dist/worker/application/local-tasks.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { Store } from '../../src/orchestrator/dist/orchestrator/persistence/store.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await predicate(); if (result) return result; await delay(25); } throw Error('Condition timed out'); }
async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), 'werk-workspace-')); t.after(() => rm(directory, { recursive: true, force: true })); const settings = new WorkerSettings(directory); await settings.init(); const sessions = new WorkerSessions(directory, settings); await sessions.init(); t.after(() => sessions.close()); return { directory, settings, sessions }; }
test('provider credentials are private, write-only and retained across settings edits and restart', async t => {
  const { directory, settings } = await fixture(t);
  await settings.update({ provider: { id: 'openai-api', apiKey: 'private-api-key', model: 'model-example' } });
  await settings.update({ connection: { url: 'https://orchestrator.example', enrollmentToken: 'private-enrollment', enabled: true } });
  await settings.update({ provider: { id: 'openai-api', apiKey: '', model: 'model-updated' } });
  assert.equal(settings.provider('openai-api').apiKey, 'private-api-key');
  assert.doesNotMatch(JSON.stringify(settings.publicView()), /private-api-key|private-enrollment/);
  const next = new WorkerSettings(directory); await next.init(); assert.equal(next.provider('openai-api').apiKey, 'private-api-key');
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'workspace-settings.json'))).mode & 0o777, 0o600);
  await assert.rejects(settings.update({ connection: { url: 'http://user:secret@localhost' } }), /without credentials/);
  await assert.rejects(settings.update({ board: { orchestratorQueue: 65 } }), /0–64/);
  await settings.update({ provider: { id: 'openai-api', clearApiKey: true } }); assert.equal(settings.provider('openai-api').apiKey, '');
});
test('worker sessions keep independent transcripts, names and provider affinity across restart', async t => {
  const { directory, settings, sessions } = await fixture(t);
  await sessions.action({ action: 'create', title: 'Architecture', provider: 'anthropic-api' }); const id = sessions.current.id;
  await sessions.action({ action: 'rename', id, title: 'Architecture decisions' });
  await sessions.action({ action: 'select', id: 'default' }); await sessions.action({ action: 'archive', id });
  const recovered = new WorkerSessions(directory, settings); await recovered.init(); t.after(() => recovered.close());
  assert.equal(recovered.view().records.find(item => item.id === id).archived, true);
  await recovered.action({ action: 'select', id }); assert.equal(recovered.current.provider, 'anthropic-api'); assert.equal(recovered.current.title, 'Architecture decisions'); assert.equal(recovered.current.archived, false);
  assert.throws(() => recovered.assertSelected('default'), /session changed/);
  await assert.rejects(recovered.action({ action: 'create', title: '../bad', provider: 'unknown' }), /provider/);
});
test('API providers send correct protocols, do not retain OpenAI responses and reject incomplete output', async () => {
  const messages = [{ role: 'user', text: 'A question' }];
  for (const id of ['openai-api', 'anthropic-api']) {
    let captured;
    const model = modelFor({ id, model: 'chosen-model', apiKey: 'api-secret', executable: '' }, '/tmp', async (url, options) => { captured = { url, options, body: JSON.parse(options.body) }; return Response.json(id === 'openai-api' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Response' }] }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Response' }] }); });
    assert.equal(await model.reply(messages, new AbortController().signal), 'Response'); assert.equal(captured.body.model, 'chosen-model'); assert.equal(captured.options.redirect, 'error');
    if (id === 'openai-api') { assert.equal(captured.body.store, false); assert.equal(captured.options.headers.authorization, 'Bearer api-secret'); }
    else assert.equal(captured.options.headers['x-api-key'], 'api-secret');
    const incomplete = modelFor({ id, model: 'model', apiKey: 'key', executable: '' }, '/tmp', async () => Response.json({ status: 'incomplete', stop_reason: 'max_tokens' })); await assert.rejects(incomplete.reply(messages, new AbortController().signal), /Incomplete/);
  }
});
test('local tasks queue durably, obey concurrency, produce applicable patches and preserve the original checkout', async t => {
  const { directory, settings, sessions } = await fixture(t), repo = join(directory, 'repo'); await mkdir(repo); await writeFile(join(repo, 'hello.txt'), 'before\n');
  const git = promisify(execFile); await git('git', ['init', repo]);
  // The fixture asserts exact LF patch content, independently of host Git defaults.
  await git('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
  await git('git', ['config', 'core.eol', 'lf'], { cwd: repo });
  await settings.update({ board: { paused: true, maxParallel: 1, queueCapacity: 2 } });
  let active = 0, maximum = 0;
  const model = () => ({ async reply(_, signal) { active++; maximum = Math.max(maximum, active); try { await delay(50); signal.throwIfAborted(); return JSON.stringify({ summary: 'Fixture change; tests not run', files: [{ path: 'hello.txt', content: 'after\n' }] }); } finally { active--; } } });
  const board = new LocalTaskboard(directory, settings, sessions, model); await board.init(); t.after(() => board.close());
  for (let n = 0; n < 2; n++) await board.create({ title: `Task ${n}`, instruction: 'Change hello', repository: repo, paths: ['hello.txt'] });
  await assert.rejects(board.create({ title: 'Overflow', instruction: 'Change', repository: repo, paths: ['hello.txt'] }), /full/);
  await board.tick(); assert.equal(board.view().running, 0);
  await settings.update({ board: { paused: false } });
  await until(async () => { await board.tick(); return board.view().tasks.every(task => task.status === 'review'); }); assert.equal(maximum, 1);
  assert.equal(await readFile(join(repo, 'hello.txt'), 'utf8'), 'before\n');
  const task = board.detail(board.view().tasks[0].id), patch = join(directory, 'change.patch'); await writeFile(patch, task.patch);
  await git('git', ['apply', '--check', patch], { cwd: repo }); await git('git', ['apply', patch], { cwd: repo }); assert.equal(await readFile(join(repo, 'hello.txt'), 'utf8'), 'after\n');
  const restarted = new LocalTaskboard(directory, settings, sessions, model); await restarted.init(); t.after(() => restarted.close()); assert.equal(restarted.detail(task.id).status, 'review');
  await assert.rejects(board.create({ title: 'Unsafe', instruction: 'Read outside', repository: repo, paths: ['../outside'] }), /safe relative/);
});
test('queued task cancellation, priority and interrupted task recovery do not replay execution', async t => {
  const { directory, settings, sessions } = await fixture(t), repo = join(directory, 'repo'); await mkdir(repo);
  const board = new LocalTaskboard(directory, settings, sessions, () => ({ async reply(){ throw Error('should not execute'); } })); await board.init();
  await board.create({ title: 'A queued task', instruction: 'Create hello', repository: repo, paths: ['hello.txt'] }); const id = board.view().tasks[0].id;
  await board.action({ id, action: 'priority', priority: 2 }); assert.equal(board.detail(id).priority, 2);
  await board.action({ id, action: 'cancel' }); assert.equal(board.detail(id).status, 'cancelled');
  await board.action({ id, action: 'retry' }); assert.equal(board.detail(id).status, 'queued');
  const saved = JSON.parse(await readFile(join(directory, 'taskboard.json'), 'utf8')); saved[0].status = 'running'; await writeFile(join(directory, 'taskboard.json'), JSON.stringify(saved));
  const restarted = new LocalTaskboard(directory, settings, sessions); await restarted.init(); assert.equal(restarted.detail(id).status, 'failed'); assert.match(restarted.detail(id).error, /stopped/); await board.close(); await restarted.close();
});
test('orchestrator accepts bounded queued assignments beyond execution slots with project and provider affinity', () => {
  const store = new Store(':memory:'); try {
    const registration = store.register('alpha', [{ id: 'codex', provider: 'codex', mode: 'mock', maxParallel: 1 }], { maxParallel: 1, order: 'fifo', maxAttempts: 3, configHash: 'fixed' });
    const worker = () => store.worker(registration.token);
    for (let i = 0; i < 4; i++) store.submit({ project: 'alpha', title: 'Task ' + i, criteria: ['Done'], wikilinks: [], provider: 'codex', priority: 1 }, 't' + i);
    assert.ok(store.claim(worker(), 'one', 2)); assert.ok(store.claim(worker(), 'two', 2)); assert.ok(store.claim(worker(), 'three', 2)); assert.equal(store.claim(worker(), 'full', 2), null);
    assert.equal(worker().config.maxParallel, 1); assert.equal(worker().config.queueCapacity, 2); assert.equal(worker().config.configHash, 'fixed');
    assert.equal(store.current(worker()).length, 3); assert.equal(store.claim(worker(), 'reduced', 0), null); assert.equal(store.current(worker()).length, 3);
    assert.throws(() => store.claim(worker(), 'bad', 100), /queueCapacity/);
  } finally { store.close(); }
});
test('worker starts standalone and connects later while renewing queued leases without extra execution', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-standalone-')); const stop = new AbortController(); let run;
  t.after(async () => { stop.abort(); await run; await rm(directory, { recursive: true, force: true }); });
  const config = await configuration({ 'poll-ms': '100', 'mock-ms': '1', profiles: 'codex' });
  const assigned = [], finished = new Set(); let executed = 0, active = 0, maxActive = 0, renewedWaiting = 0;
  const client = { async currentAssignments() { return assigned.filter(task => !finished.has(task.id)); }, async claim(_, extra) { assert.equal(extra, 2); if (assigned.length === 3) return null; const i = assigned.length; const task = { id: 'task-' + i, project: 'alpha', title: 'Task ' + i, criteria: ['done'], wikilinks: [], provider: 'codex', priority: 1, executionMode: 'mock', status: 'running', attempt: 1, workerId: 'remote-worker', lease: 'lease-' + i, expiresAt: Date.now() + 1500, createdAt: Date.now(), profile: config.profiles[0].id }; assigned.push(task); return task; }, async heartbeat(task) { if (task.id !== 'task-0') renewedWaiting++; task.expiresAt = Date.now() + 1500; return task; }, async publishSnapshot() {}, async complete(task) { finished.add(task.id); }, async abandon(task) { finished.add(task.id); } };
  const gateway = { async register() { return { id: 'remote-worker', token: 'remote-secret', project: 'alpha' }; }, connect() { return client; } };
  const adapter = { mode: 'mock', async run(task, signal) { executed++; active++; maxActive = Math.max(maxActive, active); try { await delay(650); signal.throwIfAborted(); return { kind: 'simulated', summary: 'fixture' }; } finally { active--; } } };
  let endpoint; const original = console.error; console.error = value => { try { const event = JSON.parse(value); if (event.event === 'status_listening') endpoint = 'http://127.0.0.1:' + event.address.port; } catch {} };
  try { run = runWorker({ ...config, stateDir: directory, enrollmentToken: '', statusHost: '127.0.0.1', statusPort: 0 }, stop.signal, { gateway, adapter }); await until(() => endpoint); }
  finally { console.error = original; }
  await until(async () => (await fetch(endpoint + '/healthz')).status === 200); assert.equal((await (await fetch(endpoint + '/status')).json()).state, 'standalone');
  const token = (await readFile(join(directory, 'webview-token'), 'utf8')).trim();
  const response = await fetch(endpoint + '/api/settings', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ connection: { enabled: true, url: 'http://orchestrator.invalid', enrollmentToken: 'enroll' }, board: { orchestratorQueue: 2 } }) }); assert.equal(response.status, 200);
  await until(async () => (await (await fetch(endpoint + '/status')).json()).queuedTasks.length === 2); await until(() => executed === 1); assert.equal(executed, 1);
  await until(() => finished.size === 3); assert.equal(maxActive, 1); assert.ok(renewedWaiting >= 3);
  stop.abort(); await run;
});

test('Claude subscription adapter disables tools and excludes API keys from the CLI environment', { skip: process.platform === 'win32' }, async t => {
  const { directory } = await fixture(t), executable = join(directory, 'claude-fixture');
  await writeFile(executable, `#!/usr/bin/env node\nlet input='';for await(const chunk of process.stdin)input+=chunk;const args=process.argv.slice(2);if(!args.includes('--safe-mode')||!args.includes('--restricted')||!args.includes('--no-session-persistence')||!args.includes('--strict-mcp-config')||args[args.indexOf('--tools')+1]!==''||process.env.ANTHROPIC_API_KEY||!input.includes('A question'))process.exit(2);console.log(JSON.stringify({type:'result',is_error:false,result:'Claude fixture reply'}));`, { mode: 0o700 });
  const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'must-not-reach-subscription-cli';
  try { const model = modelFor({ id: 'claude-cli', executable, model: '', apiKey: '' }, directory); assert.equal(await model.reply([{ role: 'user', text: 'A question' }], AbortSignal.timeout(5000)), 'Claude fixture reply'); }
  finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; }
});
