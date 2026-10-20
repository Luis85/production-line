import { workspaceContext } from './runtime-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { authoringTemplateFor, authoringBase } from '../../src/worker/dist/worker/infrastructure/feature-authoring-assets.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { workerStatus } from '../helpers/worker-status.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const binding = { enabled: true, repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000 };
const seed = { title: 'Export orders', message: 'Add CSV export for the selected orders.', provider: 'openai-api', paths: ['orders.ts'] };
const complete = markdown => markdown
  .replace('<!-- Describe constraints, relevant behavior, and what is outside this request. -->', 'Preserve the existing order list and its selection behavior.')
  .replace('<!-- Add one or more concrete, verifiable checklist items. -->', '- The CSV contains all selected orders.\n- Dates use UTC ISO 8601 strings.')
  .replace('<!-- Explain how each outcome will be checked and what evidence reviewers need. -->', 'Run the CSV unit tests and inspect the exported headers.');

async function fixture(t, withFolder = false, prompts) {
  const started = performance.now(), completed = [];
  let active = { name: 'create Git fixture', started };
  const stage = name => {
    const now = performance.now();
    completed.push({ name: active.name, elapsedMs: Math.round(now - active.started) });
    if (completed.length > 12) completed.shift();
    active = { name, started: now };
  };
  const interrupted = () => t.diagnostic('Workspace journey interrupted: ' + JSON.stringify({ active: active.name, activeMs: Math.round(performance.now() - active.started), totalMs: Math.round(performance.now() - started), completed }));
  t.signal.addEventListener('abort', interrupted, { once: true });
  // Successful tests also abort their signal after cleanup; report only an interruption during the journey.
  t.after(() => t.signal.removeEventListener('abort', interrupted));
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-fr-workspace-'))), remote = join(directory, 'remote.git'), project = join(directory, 'project'), state = join(directory, 'state');
  git(directory, 'init', '--bare', '--initial-branch=main', remote); git(directory, 'clone', '--', remote, project);
  const workflow = { ...defaultFeatureWorkflow(), ...(prompts ? { readyPrompt: 'team/definition-of-ready.md', donePrompt: 'team/definition-of-done.txt' } : {}) }, ready = defaultFeatureCheck('ready');
  ready.rules.patch.push({ id: 'two-team-criteria', fact: 'input.criteriaCount', op: 'gte', value: 2 });
  const files = { '.werk/feature-workflow.json': JSON.stringify(workflow), [workflow.template]: authoringTemplateFor('openai-api'), [workflow.base]: authoringBase(workflow), [workflow.readyCheck]: JSON.stringify(ready), [workflow.doneCheck]: JSON.stringify(defaultFeatureCheck('done')), 'orders.ts': 'export const orders = [];\n' };
  if (prompts) Object.assign(files, { [workflow.readyPrompt]: prompts.ready, [workflow.donePrompt]: prompts.done });
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(project, path)), { recursive: true }); await writeFile(join(project, path), content); }
  git(project, 'add', '.'); git(project, 'commit', '-m', 'Team workflow'); git(project, 'push', 'origin', 'main');
  const originalHead = git(project, 'rev-parse', 'HEAD');
  const config = { stateDir: state, projectDir: project, ...(withFolder ? { features: { directory: join(project, 'legacy-features'), provider: 'openai-api', pollMs: 1000 } } : {}), repositories: { pollMs: 300000, items: [{ id: 'project', path: project, remote: 'origin', branch: 'main', watch: false }] }, pollMs: 1000, timeoutMs: 60000 };
  let workspace, journal, server, configured = false;
  async function close() { stage('close fixture'); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; } if (workspace) { await workspace.close(); workspace = undefined; } journal?.close(); }
  async function open() {
    stage('initialize workspace');
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    workspace = new WorkerWorkspace(config, journal, workerStatus); await workspace.init();
    await workspace.updateSettings({ board: { paused: true }, ...(!configured ? { provider: { id: 'openai-api', apiKey: 'fixture-private-provider-key', model: 'fixture-never-dispatched' } } : {}) });
    configured = true;
    server = await statusServer(workerStatus, '127.0.0.1', 0, undefined, workspace);
  }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await open();
  async function api(path, body, expected = 200) {
    const label = `${body === undefined ? 'GET' : 'POST'} ${path}${body?.action ? ': ' + body.action : ''}`;
    stage(label);
    const token = (await readFile(join(state, 'webview-token'), 'utf8')).trim();
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, { method: body === undefined ? 'GET' : 'POST', signal: t.signal, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); stage('assertions after ' + label); return result;
  }
  const publish = (draft, operationId, status = 'draft', markdown = draft.markdown) => api('/api/features', { action: 'publish', operationId, name: draft.name, markdown, status, expectedRevision: draft.revision, expectedWorkflowDigest: draft.workflowDigest, expectedBinding: draft.binding });
  return { directory, remote, project, state, originalHead, workflow, api, publish, stage, get workspace() { return workspace; }, async restart() { await close(); await open(); } };
}

test('shared binding closes every legacy new-work route without requiring a legacy feature folder', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.workspace.sharedIntakeCommand({ action: 'configure', expectedRevision: 0, config: { ...binding, enabled: false } });
  for (const [path, body] of [
    ['/api/tasks', { action: 'create', id: 'bypass', title: seed.title, provider: seed.provider, message: seed.message }],
    ['/api/taskboard', { title: seed.title, provider: seed.provider, instruction: seed.message, repository: 'project', paths: seed.paths }],
    ['/api/sessions', { action: 'create', title: seed.title, provider: seed.provider }],
    ['/api/chat', { sessionId: 'default', message: seed.message }],
  ]) { const error = await f.api(path, body, 409); assert.match(error.error, /Shared Git intake/); }
  assert.equal(f.workspace.board.view().tasks.length, 0); assert.equal(f.workspace.sessions.runs.list().total, 0);
  assert.equal(f.workspace.sessions.view().records.length, 1);
  const draft = await f.api('/api/features', { action: 'prepare', operationId: 'browser-draft', seed });
  assert.equal(draft.status, 'draft'); assert.equal(draft.readiness.valid, false);
  const saved = await f.publish(draft, 'save-draft');
  assert.equal(saved.featureId, draft.featureId); assert.match(git(f.remote, 'show', 'main:' + saved.path), /status: draft/);
  assert.equal(f.workspace.board.view().tasks.length, 0); assert.equal(f.workspace.sessions.runs.list().total, 0);
  assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.originalHead);
});

// Windows qualification reached the final replay after 114 s: ready publication alone took 25 s and draft publication 18 s.
// Keep the complete restart journey together, with modest Windows headroom and interruption diagnostics for an actual stall.
test('chat publication and Markdown intake share one feature identity, definitions, policy, execution and progress projection', { timeout: process.platform === 'win32' ? 180000 : 120000 }, async t => {
  const prompts = { ready: 'Confirm the CSV consumers and their timezone expectations before implementation.', done: 'Report CSV regression evidence and document any unresolved compatibility limitations.' };
  const f = await fixture(t, false, prompts); f.stage('configure shared intake'); await f.workspace.sharedIntakeCommand({ action: 'configure', expectedRevision: 0, config: binding });
  const draft = await f.api('/api/features', { action: 'prepare', operationId: 'browser-one', seed });
  const saved = await f.publish(draft, 'draft-one');
  const reopened = await f.api('/api/features', { action: 'prepare', operationId: 'reopen', name: saved.name });
  assert.equal(reopened.featureId, draft.featureId); assert.equal(reopened.revision, saved.revision);
  const markdown = complete(reopened.markdown);
  const command = { action: 'publish', operationId: 'ready-one', name: reopened.name, markdown, status: 'ready', expectedRevision: reopened.revision, expectedWorkflowDigest: reopened.workflowDigest, expectedBinding: reopened.binding };
  const published = await f.api('/api/features', command);
  assert.equal(published.readiness.valid, true); assert.equal(f.workspace.board.view().tasks.length, 0, 'A paused queue does not admit the ready note.');
  f.stage('unpause queue and admit shared request');
  await f.workspace.updateSettings({ board: { paused: false } }); await f.workspace.sharedIntakeCommand({ action: 'sync' });
  const shared = f.workspace.sharedIntakeView().requests.find(record => record.id === draft.featureId); assert.ok(shared?.taskId);
  const task = f.workspace.board.executionDetail(shared.taskId), detail = await f.api('/api/tasks', { action: 'get', id: task.sessionId });
  const feature = detail.session.feature;
  assert.equal(feature.id, draft.featureId); assert.equal(feature.source, 'shared_git'); assert.equal(feature.sourcePath, draft.path);
  assert.equal(shared.feature.key, feature.key); assert.equal(task.feature.key, feature.key);
  const request = f.workspace.sessions.requests.get(task.requestId); assert.equal(request.owner.featureId, feature.key);
  assert.ok(request.policy.ready.patch.some(rule => rule.id === 'two-team-criteria'));
  const definitions = { schemaVersion: 1, commit: shared.sourceCommit,
    ready: { path: f.workflow.readyPrompt, sha256: featureContentHash(prompts.ready), content: prompts.ready },
    done: { path: f.workflow.donePrompt, sha256: featureContentHash(prompts.done), content: prompts.done },
  };
  assert.deepEqual(task.definitionPrompts, definitions, 'Shared intake passes the source-pinned snapshot through the workspace coordinator.');
  const dispatch = f.workspace.sessions.interactions.turn(task.sessionId, task.currentTurnId).dispatch;
  assert.ok(dispatch, 'The actual model request is durably prepared by the composed worker.');
  const lines = dispatch.messages[0].text.split('\n');
  for (const [label, expected] of [['Ready', definitions.ready], ['Done', definitions.done]]) {
    const headings = lines.flatMap((line, index) => line.startsWith('Definition of ' + label + ' —') ? [index] : []);
    assert.equal(headings.length, 1, 'Each definition appears once in the prepared dispatch.');
    assert.deepEqual(JSON.parse(lines[headings[0] + 1]), expected);
  }
  await writeFile(join(f.project, f.workflow.readyPrompt), 'A local edit is not accepted team guidance.');
  await writeFile(join(f.project, f.workflow.donePrompt), 'A local edit cannot change this request completion guidance.');
  f.stage('read canonical feature progress');
  const tracking = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: task.sessionId });
  assert.equal(parseFeature(tracking.markdown).data.type, 'FeatureRequestProgress');
  assert.match(tracking.markdown, new RegExp(feature.key)); assert.doesNotMatch(tracking.markdown, /fixture-private-provider-key|export const orders/);
  await f.api('/api/features', command); f.stage('synchronize replayed publication'); await f.workspace.sharedIntakeCommand({ action: 'sync' });
  assert.equal(f.workspace.board.view().tasks.length, 1); assert.equal(f.workspace.sessions.runs.list().total, 1);
  assert.ok(f.workspace.sessions.runs.list().rows.every(run => run.startedAt === null), 'This integration checks admission without invoking a commercial provider.');
  for (const [path, body] of [
    ['/api/tasks', { action: 'send', id: task.sessionId, message: 'Change accepted scope.' }],
    ['/api/taskboard/action', { action: 'retry', id: task.id }],
    ['/api/requests', { action: 'propose', requestId: request.id, expectedRevision: request.revision, operationId: 'replace-scope', input: { ...request.input, message: 'Replace scope.' } }],
    ['/api/requests', { action: 'execute', requestId: request.id, expectedRevision: request.revision, operationId: 'bypass-retry' }],
  ]) { const failure = await f.api(path, body, 409); assert.match(failure.error, /Feature Request|checkpoint|Task/); }
  assert.equal(git(f.project, 'rev-parse', 'HEAD'), f.originalHead);
  await f.restart();
  assert.equal(f.workspace.board.detail(task.id).status, 'queued', 'A prepared shared request survives restart without requiring a new attempt.');
  assert.deepEqual(f.workspace.board.executionDetail(task.id).definitionPrompts, definitions);
  assert.deepEqual(f.workspace.sessions.interactions.turn(task.sessionId, task.currentTurnId).dispatch, dispatch, 'Restart preserves the same prepared model request despite later local prompt edits.');
  const restored = await f.api('/api/tasks', { action: 'get', id: task.sessionId });
  assert.equal(restored.session.feature.key, feature.key); await f.api('/api/features', command);
  assert.equal(f.workspace.board.view().tasks.length, 1); assert.equal(f.workspace.sessions.runs.list().total, 1);
});

test('existing local feature requests remain continuable when a project later adopts shared intake', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const created = await f.api('/api/tasks', { action: 'create', id: 'existing-local', title: seed.title, provider: seed.provider, message: seed.message });
  await f.api('/api/tasks', { action: 'cancel', id: created.session.id });
  await f.workspace.sharedIntakeCommand({ action: 'configure', expectedRevision: 0, config: { ...binding, enabled: false } });
  const replay = await f.api('/api/tasks', { action: 'create', id: 'existing-local', title: seed.title, provider: seed.provider, message: seed.message });
  assert.equal(replay.session.feature.key, created.session.feature.key);
  const continued = await f.api('/api/tasks', { action: 'send', id: created.session.id, message: 'Explain the next step for this existing request.' });
  assert.equal(continued.session.feature.key, created.session.feature.key);
  assert.equal(continued.session.featureRequest.path, created.session.featureRequest.path);
  assert.equal(f.workspace.featureTracking.status().records.length, 1);
});


test('a rejected folder identity collision preserves the original request and survives restart', { timeout: 120000 }, async t => {
  const f = await fixture(t, true);
  const created = await f.api('/api/tasks', { action: 'create', id: 'feature-collision', title: seed.title, provider: seed.provider, message: seed.message });
  await f.api('/api/tasks', { action: 'cancel', id: created.session.id });
  const runs = f.workspace.sessions.runs.list().total;
  await writeFile(join(f.project, 'legacy-features', 'collision.md'), '---\nschemaVersion: 1\nid: collision\ntitle: Export orders\nstatus: ready\nmode: chat\nprovider: openai-api\n---\n' + seed.message + '\n');
  await workspaceContext(f.workspace).features.tick(true); await workspaceContext(f.workspace).features.tick(true);
  const record = workspaceContext(f.workspace).features.view().records.find(item => item.id === 'collision');
  assert.ok(record); assert.equal(record.submitted, false); assert.match(record.error, /another Feature Request/);
  await f.workspace.featureTracking.sync();
  const tracking = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: created.session.id });
  assert.equal(parseFeature(tracking.markdown).data.featureRequestKey, created.session.feature.key);
  assert.equal(parseFeature(tracking.markdown).data.type, 'FeatureRequestProgress');
  assert.equal(created.session.feature.source, 'folder');
  const canonical = parseFeature(await readFile(join(f.project, 'legacy-features', 'interaction-feature-collision.md'), 'utf8'));
  assert.equal(canonical.data.schema, 'worker.request/v1'); assert.equal(canonical.data.id, 'feature-collision');
  await f.restart();
  assert.equal(f.workspace.sessions.detail(created.session.id).session.feature.key, created.session.feature.key);
  assert.equal(workspaceContext(f.workspace).features.view().records.find(item => item.id === 'collision').submitted, false);
  assert.equal(f.workspace.sessions.runs.list().total, runs);
});
