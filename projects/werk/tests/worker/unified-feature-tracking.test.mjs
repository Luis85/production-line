import { workerStatus } from '../helpers/worker-status.mjs';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { SharedFeatureIntake } from '../../src/worker/dist/worker/application/shared-feature-intake.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { defaultSharedIntakeConfig } from '../../src/worker/dist/worker/application/shared-feature-state.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureWorkflowPolicy, featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { publicTaskConversation } from '../../src/worker/dist/worker/application/public-task-transcript.js';

/** @param {import('../../src/worker/application/local-tasks.js').LocalTaskboard} board */
function localRuntime(board) {
  // @ts-expect-error Fault injection deliberately accesses the taskboard's private runtime.
  return board.runtime;
}

async function fixture(t, configuredFolder = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-unified-tracking-'))), state = join(directory, 'state'), project = join(directory, 'project'), features = join(project, 'features');
  await mkdir(state); await mkdir(project); if (configuredFolder) await mkdir(features);
  await writeFile(join(project, 'approved.txt'), 'PRIVATE APPROVED SNAPSHOT\n');
  const config = { stateDir: state, projectDir: project, pollMs: 1000, timeoutMs: 60000, ...(configuredFolder ? { features: { directory: features, provider: 'openai-api', pollMs: 1000 } } : {}) };
  let workspace, journal, server, configured = false;
  async function close() { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; } if (workspace) { await workspace.close(); workspace = undefined; } journal?.close(); journal = undefined; }
  async function open() {
    journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
    workspace = new WorkerWorkspace(config, journal, () => workerStatus({ queuedTasks: [] })); await workspace.init();
    await workspace.updateSettings({ board: { paused: true }, ...(!configured ? { provider: { id: 'openai-api', apiKey: 'fixture-secret-api-key', model: 'fixture-model' } } : {}) });
    configured = true;
  }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await open();
  async function api() {
    server = await statusServer(() => workerStatus({ queuedTasks: [] }), '127.0.0.1', 0, undefined, workspace);
    const token = (await readFile(join(state, 'webview-token'), 'utf8')).trim();
    return async (path, body, authenticated = true) => fetch('http://127.0.0.1:' + server.address().port + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { state, project, features, get workspace() { return workspace; }, open, close, api };
}
/**
 * @param {string} id
 * @param {Partial<import('../../src/worker/webview/store.ts').FeatureRequestCommand>} [extra]
 * @returns {import('../../src/worker/webview/store.ts').FeatureRequestCommand}
 */
const command = (id, extra = {}) => ({ action: 'create', id, title: 'Request ' + id, provider: 'openai-api', message: 'Implement the requested improvement.', ...extra });

test('unified chat creation is idempotent under concurrency and immediately returns its saved Markdown identity', async t => {
  const f = await fixture(t), input = command('chat-one');
  const results = await Promise.all([f.workspace.task(input), f.workspace.task(input), f.workspace.task(command('chat-two'))]);
  assert.deepEqual(results.map(result => result.session.id), ['chat-one', 'chat-one', 'chat-two']);
  assert.equal(results[0].session.featureRequest.path, results[1].session.featureRequest.path);
  assert.equal(results[0].featureTracking.error, null);
  assert.equal(results[0].session.feature.key, results[1].session.feature.key);
  assert.equal(f.workspace.sessions.requests.forSession('chat-one').owner.featureId, results[0].session.feature.key);
  assert.equal(f.workspace.sessions.view().records.filter(row => row.id !== 'default').length, 2);
  assert.equal(f.workspace.sessions.runs.list().total, 2);
  assert.equal(f.workspace.featureTracking.status().records.length, 2);
  const note = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: 'chat-one' });
  assert.equal(note.path, results[0].session.featureRequest.path); assert.match(note.markdown, /Implement the requested improvement/);
  assert.doesNotMatch(note.markdown, /fixture-secret-api-key|PRIVATE APPROVED SNAPSHOT/);
  await assert.rejects(f.workspace.task({ ...input, message: 'Different work' }), error => testErrorCode(error) === 'conflict');
  await assert.rejects(f.workspace.task({ ...input, files: { repository: f.project, paths: ['approved.txt'] } }), error => testErrorCode(error) === 'conflict');
  assert.equal(f.workspace.board.view().tasks.length, 0);
  assert.equal(f.workspace.sessions.runs.list().total, 2);
});

test('unified file creation replays the exact session and rejects identity or approval changes without another task', async t => {
  const f = await fixture(t), input = command('file-one', { files: { repository: f.project, paths: ['approved.txt'] } });
  await f.workspace.sessions.action({ action: 'create', title: 'Other selected request', provider: 'openai-api' });
  const selected = f.workspace.sessions.current.id;
  const [first, replay] = await Promise.all([f.workspace.task(input), f.workspace.task(input)]);
  assert.equal(first.session.id, 'local-file-one'); assert.equal(replay.session.id, first.session.id);
  assert.equal(f.workspace.sessions.current.id, selected, 'task admission never chooses whichever session was selected most recently');
  assert.equal(first.chat.messages[0].text, input.message);
  assert.equal(f.workspace.board.view().tasks.length, 1); assert.equal(f.workspace.sessions.runs.list().total, 1);
  assert.equal(first.session.submissionHash, f.workspace.board.detail('file-one').submissionHash);
  assert.equal(first.session.feature.key, f.workspace.board.detail('file-one').feature.key);
  assert.equal(f.workspace.sessions.requests.forSession(first.session.id).owner.featureId, first.session.feature.key);
  for (const changed of [{ ...input, message: 'Other work' }, { ...input, files: { ...input.files, paths: ['other.txt'] } }, command('file-one'), command('local-file-one')])
    await assert.rejects(f.workspace.task(changed), error => testErrorCode(error) === 'conflict');
  await assert.rejects(f.workspace.task(command('invalid', { files: { repository: f.project, paths: ['../escape'] } })), error => testErrorCode(error) === 'invalid_input');
  assert.equal(f.workspace.board.view().tasks.length, 1);
  const note = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: first.session.id });
  assert.match(note.markdown, /approved.txt/); assert.doesNotMatch(note.markdown, /PRIVATE APPROVED SNAPSHOT|fixture-secret-api-key/);
  await f.close(); await f.open();
  assert.equal(f.workspace.board.detail('file-one').status, 'queued', 'The original prepared attempt remains queued after restart.');
  const restored = await f.workspace.task(input); assert.equal(restored.session.id, first.session.id); assert.equal(restored.session.featureRequest.path, note.path);
  assert.equal(f.workspace.board.view().tasks.length, 1); assert.equal(f.workspace.sessions.runs.list().total, 1);
});

test('follow-ups update one Markdown record and final flush persists progress before restart', async t => {
  const f = await fixture(t), first = await f.workspace.task(command('follow-up'));
  await f.workspace.task({ action: 'cancel', id: first.session.id });
  const next = await f.workspace.task({ action: 'send', id: first.session.id, message: 'Also explain the final tradeoff.' });
  assert.equal(next.session.featureRequest.path, first.session.featureRequest.path);
  const note = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: first.session.id });
  assert.match(note.markdown, /Also explain the final tradeoff/);
  assert.equal(f.workspace.featureTracking.status().records.length, 1);
  await f.close(); const final = await readFile(note.path, 'utf8'); assert.match(final, /Also explain the final tradeoff/);
  await f.open(); const recovered = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: first.session.id });
  assert.equal(recovered.path, note.path); assert.equal(f.workspace.featureTracking.status().records.length, 1);
});

test('configured intake stores generated records under _tasks without rewriting or re-intaking shared source notes', async t => {
  const f = await fixture(t, true), source = '---\ntemplateId: shared-template\nstatus: ready\ntitle: Owned upstream request\n---\nKeep the shared source unchanged.\n';
  await writeFile(join(f.features, 'shared-source.md'), source);
  const created = await f.workspace.task(command('local-projection'));
  assert.equal(created.featureTracking.directory, join(f.features, '_tasks'));
  await f.workspace.features.tick(true); await f.workspace.features.tick(true); await f.workspace.featureTracking.sync();
  assert.equal(await readFile(join(f.features, 'shared-source.md'), 'utf8'), source);
  assert.equal(f.workspace.features.view().records.length, 0, 'generated lifecycle notes never enter the intake queue');
  assert.equal(f.workspace.sessions.view().records.filter(row => row.id !== 'default').length, 1);
  assert.equal((await readdir(join(f.features, '_tasks'))).filter(name => name.endsWith('.md')).length, 1);
});

test('authenticated API exposes exact records and safe local conversation while legacy admissions are also tracked', async t => {
  const f = await fixture(t), api = await f.api();
  const unauthenticated = await api('/api/feature-tracking', undefined, false); assert.equal(unauthenticated.status, 401); await unauthenticated.text();
  const input = command('api-files', { files: { repository: f.project, paths: ['approved.txt'] } });
  const response = await api('/api/tasks', input); assert.equal(response.status, 200); const detail = await response.json();
  assert.equal(detail.session.id, 'local-api-files'); assert.equal(detail.chat.messages[0].text, input.message); assert.ok(detail.session.featureRequest.path);
  const selected = await api('/api/sessions', { action: 'select', id: detail.session.id }); assert.equal(selected.status, 200); await selected.json();
  for (const path of ['/api/chat', '/api/chat/session']) { const result = await (await api(path)).json(); assert.equal((result.chat ?? result).messages[0].text, input.message); }
  const record = await (await api('/api/feature-tracking', { action: 'get', sessionId: detail.session.id })).json(); assert.equal(record.path, detail.session.featureRequest.path); assert.match(record.markdown, /Implement the requested improvement/);
  const stale = await api('/api/tasks', { ...input, title: 'Changed title' }); assert.equal(stale.status, 409); await stale.json();
  const legacy = await api('/api/taskboard', { title: 'Legacy file admission', instruction: 'Keep supporting older clients.', provider: 'openai-api', repository: f.project, paths: ['approved.txt'] }); assert.equal(legacy.status, 202); await legacy.json();
  const records = await (await api('/api/feature-tracking')).json(); assert.equal(records.records.filter(row => row.sessionId.startsWith('local-')).length, 2);
});

test('public transcript projection matches generated context without changing retained input or trimmed follow-ups', () => {
  const task = { instruction: 'Make the approved improvement.', paths: ['approved.txt'] }, context = task.instruction + '\nApproved paths: approved.txt';
  /** @type {Parameters<typeof publicTaskConversation>[0]} */
  const snapshot = { available: true, busy: false, phase: 'idle', persistenceError: false, messages: [{ id: 'initial', role: 'user', text: context, state: 'complete', at: '2026-10-17T00:00:00.000Z' }, { id: 'result', role: 'assistant', text: 'Completed change.', state: 'complete', at: '2026-10-17T00:00:00.000Z' }, { id: 'followup', role: 'user', text: 'Explain the change.', state: 'complete', at: '2026-10-17T00:00:00.000Z' }, { id: 'repeat', role: 'user', text: context, state: 'complete', at: '2026-10-17T00:00:00.000Z' }] };
  const projected = publicTaskConversation(snapshot, task);
  assert.equal(projected.messages[0].text, task.instruction); assert.equal(projected.messages[2].text, 'Explain the change.'); assert.equal(projected.messages[3].text, task.instruction);
  assert.equal(snapshot.messages[0].text, context); assert.equal(publicTaskConversation(snapshot), snapshot);
  const trimmed = { ...snapshot, messages: snapshot.messages.slice(2, 3) };
  assert.deepEqual(publicTaskConversation(trimmed, task).messages, trimmed.messages, 'retention must not rewrite a genuine first retained follow-up');
});


test('accepted work reports unavailable Markdown and recovers with the same identity after storage returns', async t => {
  const f = await fixture(t), directory = f.workspace.featureTracking.status().directory, input = command('storage-recovery');
  await rm(directory, { recursive: true }); await writeFile(directory, 'A file temporarily blocks the tracking folder.');
  const accepted = await f.workspace.task(input);
  assert.equal(accepted.session.id, input.id); assert.equal(accepted.session.featureRequest, undefined);
  assert.match(accepted.featureTracking.error, /unavailable|could not be saved/);
  assert.equal(f.workspace.sessions.runs.list().total, 1, 'durable work remains accepted even if projection fails');
  const replay = await f.workspace.task(input); assert.equal(replay.session.id, accepted.session.id); assert.ok(replay.featureTracking.error);
  assert.equal(f.workspace.sessions.runs.list().total, 1);
  await rm(directory); await mkdir(directory); await f.workspace.featureTracking.sync();
  const recovered = await f.workspace.task({ action: 'get', id: input.id });
  assert.equal(recovered.featureTracking.error, null); assert.ok(recovered.session.featureRequest.path);
  assert.equal(f.workspace.sessions.runs.list().total, 1); assert.equal(f.workspace.featureTracking.status().records.length, 1);
  assert.match(await readFile(recovered.session.featureRequest.path, 'utf8'), /Implement the requested improvement/);
});

test('remote assignment admission immediately creates its own Markdown request', async t => {
  const f = await fixture(t);
  await f.workspace.rememberTask({ id: 'remote-one', title: 'Review a distributed assignment', project: 'fixture', provider: 'codex', criteria: [], wikilinks: [], priority: 0, status: 'queued', attempt: 1, workerId: 'fixture-worker', lease: 'PRIVATE-LEASE', expiresAt: null, createdAt: Date.now(), profile: 'fixture-profile' });
  const record = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: 'remote-remote-one' });
  assert.match(record.markdown, /Review a distributed assignment/); assert.doesNotMatch(record.markdown, /PRIVATE-LEASE/);
  assert.equal(f.workspace.featureTracking.status().records.length, 1);
});


test('shared request provenance follows the retained task binding without exposing mutable private state', async () => {
  const configuration = defaultFeatureWorkflow(), readyCheck = defaultFeatureCheck('ready'), doneCheck = defaultFeatureCheck('done');
  const policy = featureWorkflowPolicy(readyCheck, doneCheck), commit = 'a'.repeat(40);
  const template = '---\ntemplateId: fixture\nstatus: draft\nmode: patch\n---\n# Goal\n## Context\n## Acceptance criteria\n## Verification plan\n';
  const file = (path, content) => ({ path, sha256: featureContentHash(content) });
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedFeatureState} */
  const stored = {
    schemaVersion: 1, workerId: 'fixture', revision: 1, config: { ...defaultSharedIntakeConfig(), repositoryId: 'new-repository' },
    records: [{
      id: 'original', name: 'original.md', title: 'Retained provenance', status: 'ready_for_review', owner: 'fixture', isLocal: true,
      sourceCommit: commit, updatedAt: '2026-10-17T00:00:00.000Z', ready: { passed: true, issues: [] }, done: null,
      featureBranch: null, reviewNote: null, publication: 'synced', error: null, taskId: 'shared-one',
      binding: { ...defaultSharedIntakeConfig(), repositoryId: 'original-repository' }, sourcePath: 'features/original.md',
      sourceMarkdown: 'Private retained source content', remoteRevision: 'b'.repeat(64), inputHash: 'c'.repeat(64), claimed: true, submitted: true,
      accepted: { id: 'original', templateId: 'fixture', title: 'Retained provenance', mode: 'patch', provider: 'openai-api', message: 'Retain the original repository.', paths: ['src/file.ts'], priority: 1, criteria: ['Provenance is stable.'], metadata: {}, sections: { goal: 'Retain provenance.', context: 'The binding changed.', verificationPlan: 'Read the retained task.' } },
      workflow: { schemaVersion: 1, commit, configuration, readyCheck, doneCheck, policy, policyDigest: gateDigest(policy), template,
        files: { configuration: file('.werk/feature-workflow.json', JSON.stringify(configuration)), readyCheck: file(configuration.readyCheck, JSON.stringify(readyCheck)), doneCheck: file(configuration.doneCheck, JSON.stringify(doneCheck)), template: file(configuration.template, template), base: file(configuration.base, 'views: []') } },
    }],
  };
  const unexpected = () => { assert.fail('Reading retained provenance must not access the repository or mutate intake'); };
  const intake = new SharedFeatureIntake({ load: async () => stored, save: unexpected, repository: unexpected, loadWorkflow: unexpected, ready: unexpected, source: unexpected, renderSource: unexpected, submit: unexpected, inspect: unexpected, canAdmit: unexpected });
  await intake.init();
  const source = intake.sourceForTask('shared-one'); assert.deepEqual(source, { repositoryId: 'original-repository', path: 'features/original.md' });
  source.path = 'mutated.md'; assert.equal(intake.sourceForTask('shared-one').path, 'features/original.md');
  assert.equal(intake.sourceForTask('missing'), undefined);
});


for (const boundary of ['snapshot', 'taskboard']) test('exact file request recovers after interrupted ' + boundary + ' persistence in its original Git worktree', async t => {
  const f = await fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: f.project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main'); git('add', 'approved.txt'); git('commit', '-m', 'Initial recovery fixture');
  await f.workspace.updateSettings({ repositories: { pollMs: 30000, items: [{ id: 'fixture', path: f.project, remote: 'origin', branch: 'main', watch: false }] } });
  const input = command('recover-' + boundary, { files: { repository: 'fixture', paths: ['approved.txt'] } });
  const board = f.workspace.board, runtime = localRuntime(board);
  let faults = 0;
  const fail = async () => { faults++; throw new Error('Fixture transient admission failure'); };
  const injection = boundary === 'snapshot'
    ? t.mock.method(runtime.files, 'snapshot', fail)
    : t.mock.method(runtime.storage, 'write', fail);
  try { await assert.rejects(f.workspace.task(input), /Fixture transient admission failure/); }
  finally { injection.mock.restore(); }
  assert.equal(faults, 1); assert.equal(board.view().tasks.length, 0);
  const retained = (await readdir(join(f.project, '.werk', 'worktrees'))).filter(name => !name.startsWith('.'));
  assert.equal(retained.length, 1);
  if (boundary === 'snapshot') { await f.close(); await f.open(); }
  const accepted = await f.workspace.task(input), replay = await f.workspace.task(input);
  assert.equal(accepted.session.id, 'local-' + input.id); assert.equal(replay.session.id, accepted.session.id);
  assert.equal(f.workspace.board.view().tasks.length, 1); assert.equal(f.workspace.sessions.runs.list().total, 1);
  assert.equal(f.workspace.board.detail(input.id).worktree, join(f.project, '.werk', 'worktrees', retained[0]));
  assert.deepEqual((await readdir(join(f.project, '.werk', 'worktrees'))).filter(name => !name.startsWith('.')), retained);
  assert.equal(f.workspace.sessions.view().records.filter(record => record.id === accepted.session.id).length, 1);
  assert.equal(accepted.session.featureRequest.path, replay.session.featureRequest.path);
  assert.equal(await readFile(join(f.project, 'approved.txt'), 'utf8'), 'PRIVATE APPROVED SNAPSHOT\n');
  assert.ok(f.workspace.sessions.runs.list().rows.every(run => run.startedAt === null), 'recovery never dispatches a second model invocation');
});


for (const alteration of ['tracked', 'ignored']) test('changed interrupted checkout returns a durable failed request and blocks every follow-up route: ' + alteration, async t => {
  const f = await fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: f.project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await writeFile(join(f.project, '.gitignore'), 'ignored.txt\n');
  git('init', '--initial-branch=main'); git('add', 'approved.txt', '.gitignore'); git('commit', '-m', 'Initial changed worktree fixture');
  await f.workspace.updateSettings({ repositories: { pollMs: 30000, items: [{ id: 'fixture', path: f.project, remote: 'origin', branch: 'main', watch: false }] } });
  const input = command('changed-' + alteration, { files: { repository: 'fixture', paths: ['approved.txt'] } });
  const injection = t.mock.method(localRuntime(f.workspace.board).files, 'snapshot', async () => { throw new Error('Fixture snapshot interruption'); });
  try { await assert.rejects(f.workspace.task(input), /Fixture snapshot interruption/); }
  finally { injection.mock.restore(); }
  const names = await readdir(join(f.project, '.werk', 'worktrees')); assert.equal(names.length, 1);
  const retained = join(f.project, '.werk', 'worktrees', names[0]), changedPath = join(retained, alteration === 'tracked' ? 'approved.txt' : 'ignored.txt');
  await writeFile(changedPath, 'Human work must be preserved.\n');
  const api = await f.api(), response = await api('/api/tasks', input); assert.equal(response.status, 200); const receipt = await response.json();
  assert.equal(receipt.session.id, 'local-' + input.id); assert.equal(receipt.session.status, 'failed'); assert.equal(receipt.chat.messages[0].text, input.message);
  assert.equal(receipt.featureTracking.error, null); assert.ok(receipt.session.featureRequest.path);
  assert.match(receipt.session.continuationBlockedReason, /No file snapshots were accepted/);
  assert.deepEqual(f.workspace.board.detail(input.id).admissionFailure.paths, ['approved.txt']); assert.deepEqual(f.workspace.board.detail(input.id).files, []);
  assert.equal(f.workspace.sessions.runs.list().total, 0);
  const replay = await (await api('/api/tasks', input)).json(); assert.equal(replay.session.id, receipt.session.id); assert.equal(replay.session.status, 'failed');
  await (await api('/api/sessions', { action: 'select', id: receipt.session.id })).json();
  for (const [path, body] of /** @type {const} */ ([
    ['/api/tasks', { action: 'send', id: receipt.session.id, message: 'Continue this request.' }],
    ['/api/chat', { sessionId: receipt.session.id, message: 'Continue from the legacy chat endpoint.' }],
    ['/api/taskboard/action', { action: 'retry', id: input.id }],
    ['/api/interactions', { action: 'resume', sessionId: receipt.session.id, turnId: 'never-accepted', expectedRevision: 0, operationId: 'attempted-bypass' }],
  ])) {
    const blocked = await api(path, body); assert.equal(blocked.status, 409, path); const failure = await blocked.json(); assert.match(failure.error, /No file snapshots were accepted|no accepted file snapshots/i);
  }
  assert.equal(f.workspace.sessions.runs.list().total, 0); assert.equal(f.workspace.sessions.interactions.view(receipt.session.id).turns.length, 0);
  assert.equal(await readFile(changedPath, 'utf8'), 'Human work must be preserved.\n');
  const note = await f.workspace.featureTrackingCommand({ action: 'get', sessionId: receipt.session.id });
  assert.match(note.markdown, /No file snapshots were accepted/); assert.doesNotMatch(note.markdown, /### Approved files|Human work must be preserved/);
  const removed = await api('/api/taskboard/action', { action: 'delete', id: input.id }); assert.equal(removed.status, 200); await removed.json();
  assert.equal(f.workspace.board.view().tasks.length, 0);
  for (const [path, body] of /** @type {const} */ ([
    ['/api/tasks', { action: 'send', id: receipt.session.id, message: 'Continue after board history deletion.' }],
    ['/api/chat', { sessionId: receipt.session.id, message: 'Continue through selected session.' }],
    ['/api/interactions', { action: 'resume', sessionId: receipt.session.id, turnId: 'never-accepted', expectedRevision: 0, operationId: 'deleted-board-bypass' }],
  ])) { const blocked = await api(path, body); assert.equal(blocked.status, 409, path); await blocked.json(); }
  await assert.rejects(f.workspace.sessions.start('Direct session continuation', receipt.session.id), /No file snapshots were accepted/);
  await assert.rejects(f.workspace.sessions.interact({ action: 'resume', sessionId: receipt.session.id, turnId: 'never-accepted', expectedRevision: 0, operationId: 'direct-session-bypass' }), /No file snapshots were accepted/);
  await f.close(); await f.open();
  const restarted = await f.workspace.task({ action: 'get', id: receipt.session.id }); assert.equal(restarted.session.status, 'failed'); assert.equal(restarted.session.featureRequest.path, note.path); assert.match(restarted.session.continuationBlockedReason, /No file snapshots were accepted/);
  await assert.rejects(f.workspace.task({ action: 'send', id: receipt.session.id, message: 'Retry after restart' }), /No file snapshots were accepted/);
  assert.equal(await readFile(changedPath, 'utf8'), 'Human work must be preserved.\n');
});

test('ordinary accepted local requests retain their conversational follow-up capability', async t => {
  const f = await fixture(t), created = await f.workspace.task(command('ordinary-files', { files: { repository: f.project, paths: ['approved.txt'] } }));
  await f.workspace.taskboardAction({ action: 'cancel', id: 'ordinary-files' });
  const followup = await f.workspace.task({ action: 'send', id: created.session.id, message: 'Explain the proposed change.' });
  assert.equal(followup.session.id, created.session.id); assert.ok(followup.chat.messages.some(message => message.role === 'user' && message.text === 'Explain the proposed change.'));
  assert.equal(followup.session.featureRequest.path, created.session.featureRequest.path);
});
