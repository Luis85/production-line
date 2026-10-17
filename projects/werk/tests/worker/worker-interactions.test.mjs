import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 300; n++) { if (check()) return; await delay(5); } throw Error('Fixture timed out'); }
const question = { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Choose the target.', choices: [{ id: 'opaque_a', label: 'Linux desktop' }, { id: 'opaque_b', label: 'Portable browser' }], reason: 'The target changes packaging.' } };
const measured = { ...unknownUsage(), inputTokens: 12, outputTokens: 4, source: 'provider_reported', reason: null };
function model(execute) { return () => ({ configuration: { id: 'fixture', model: 'model-v1', instruction: 'Frozen instruction' }, capabilities: modelCapabilities, async reply() { throw Error('Typed model expected'); }, execute }); }
async function fixture(t, execute) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-interactions-')));
  const settings = new WorkerSettings(directory); await settings.init();
  let sessions = new WorkerSessions(directory, settings, model(execute)); await sessions.init();
  t.after(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, get sessions() { return sessions; }, async restart(next = execute) { await sessions.close(); sessions = new WorkerSessions(directory, settings, model(next)); await sessions.init(); return sessions; } };
}
function answer(view, value = 'opaque_b') { return { action: 'answer', sessionId: view.sessionId, pendingId: view.pending.id, expectedRevision: view.revision, operationId: 'answer-fixture', answer: value }; }

test('question survives restart without execution; answering replays full question and freezes dispatch before invocation', async t => {
  let calls = 0, f;
  const execute = async (request, signal, onUsage) => {
    calls++;
    const view = f.sessions.interactions.view('default');
    const saved = f.sessions.interactions.turn('default', view.latestTurn.id);
    assert.deepEqual(saved.dispatch, request);
    assert.equal(f.sessions.runs.get(saved.runId).before.state, 'running');
    onUsage(measured);
    if (calls === 1) return question;
    assert.match(JSON.stringify(request.messages), /opaque_b/);
    assert.match(JSON.stringify(request.messages), /Portable browser/);
    assert.match(JSON.stringify(request.messages), /target changes packaging/);
    assert.equal(request.provider.instruction, 'Frozen instruction');
    return { type: 'completed', text: 'Selected portable browser.' };
  };
  f = await fixture(t, execute);
  await f.sessions.start('Prepare delivery'); await until(() => !f.sessions.busy);
  const original = f.sessions.interactions.view('default');
  assert.equal(original.phase, 'waiting_input'); assert.equal(f.sessions.view().records[0].status, 'waiting_input');
  assert.equal(f.sessions.executor.busy, false); assert.equal(f.sessions.runs.list().rows[0].outcome, 'waiting_input');
  await f.restart(); assert.equal(calls, 1); assert.deepEqual(f.sessions.interactions.view('default').pending, original.pending);
  const command = answer(f.sessions.interactions.view('default'));
  await Promise.all([f.sessions.interact(command), f.sessions.interact(command)]);
  await until(() => !f.sessions.busy); assert.equal(calls, 2);
  const finished = f.sessions.interactions.view('default'); assert.equal(finished.phase, 'completed'); assert.equal(finished.pending, null);
  await f.sessions.interact(command); assert.equal(calls, 2);
  await assert.rejects(f.sessions.interact({ ...command, answer: 'different' }), /different input/);
  assert.equal(f.sessions.runs.analyze().consumption.inputTokens, 24);
});

test('known response recovers transcript and numeric outcome without a second model call', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { type: 'completed', text: 'Durable successful response.' }; });
  const finish = f.sessions.runs.finish.bind(f.sessions.runs);
  f.sessions.runs.finish = async () => { throw Error('Fixture terminal projection failure'); };
  await f.sessions.start('Complete once'); await until(() => !f.sessions.busy);
  assert.equal(f.sessions.chat.snapshot().persistenceError, true);
  const turn = f.sessions.interactions.turn('default', f.sessions.interactions.view('default').latestTurn.id);
  assert.equal(turn.result.text, 'Durable successful response.');
  assert.equal(f.sessions.runs.get(turn.runId).after, null);
  f.sessions.runs.finish = finish; await f.restart();
  assert.equal(calls, 1); assert.equal(f.sessions.chat.snapshot().messages.at(-1).text, 'Durable successful response.');
  const recovered = f.sessions.runs.get(turn.runId); assert.equal(recovered.outcome, 'completed'); assert.equal(recovered.after.measurement, 'recovery'); assert.equal(recovered.durationMs, null);
});

test('usage observed before process loss survives as an interrupted invocation without cumulative double counting', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-usage-recovery-')));
  let runs = new WorkerRunJournal(directory); await runs.init();
  t.after(async () => { runs.close(); await rm(directory, { recursive: true, force: true }); });
  const run = await runs.begin({ sessionId: 'fixture', taskId: 'fixture', kind: 'chat', title: 'Fixture', provider: 'fixture', model: 'fixture' });
  await runs.start(run.id); runs.observeUsage(run.id, measured); runs.observeUsage(run.id, { ...measured, inputTokens: 19 }); runs.close();
  runs = new WorkerRunJournal(directory); await runs.init();
  const recovered = runs.get(run.id); assert.equal(recovered.outcome, 'interrupted'); assert.equal(recovered.usage.inputTokens, 19); assert.equal(runs.analyze().consumption.inputTokens, 19); assert.equal(recovered.resourceDelta.cpuUserMicros, null);
});

test('accepted answer interrupted before prepare retains answer and original profile for explicit resume', async t => {
  let calls = 0;
  const f = await fixture(t, async request => { calls++; if (calls === 1) return question; assert.match(JSON.stringify(request.messages), /saved-answer/); assert.match(JSON.stringify(request.messages), /Portable browser/); assert.equal(request.provider.instruction, 'Frozen instruction'); return { type: 'completed', text: 'Recovered answer.' }; });
  await f.sessions.start('Ask first'); await until(() => !f.sessions.busy);
  const view = f.sessions.interactions.view('default');
  const context = { chatMessages: [...f.sessions.chat.snapshot().messages, { id: 'accepted-answer', role: 'user', text: 'saved-answer', state: 'complete', at: new Date().toISOString() }, { id: 'pending-answer', role: 'assistant', text: '', state: 'pending', at: new Date().toISOString() }], assistantId: 'pending-answer' };
  const accepted = f.sessions.interactions.accept({ sessionId: 'default', kind: 'answer', operationId: 'accepted-before-crash', expectedRevision: view.revision, pendingId: view.pending.id, input: 'saved-answer', context });
  assert.equal(accepted.turn.dispatch, null); await f.restart(); assert.equal(calls, 1);
  const stopped = f.sessions.interactions.view('default'); assert.equal(stopped.phase, 'interrupted');
  await f.sessions.interact({ action: 'resume', sessionId: 'default', turnId: stopped.latestTurn.id, expectedRevision: stopped.revision, operationId: 'resume-saved-answer' });
  await until(() => !f.sessions.busy); assert.equal(calls, 2); assert.equal(f.sessions.interactions.view('default').phase, 'completed');
});

test('stale or cancelled questions cannot accept answers; stopping preserves original invocation outcome', async t => {
  const f = await fixture(t, async () => question); await f.sessions.start('Question'); await until(() => !f.sessions.busy);
  const view = f.sessions.interactions.view('default');
  assert.throws(() => f.sessions.interactions.abandon('default', view.revision - 1, 'stop-question', view.pending.id), /changed/);
  f.sessions.interactions.abandon('default', view.revision, 'stop-question', view.pending.id);
  f.sessions.interactions.abandon('default', view.revision, 'stop-question', view.pending.id);
  assert.equal(f.sessions.interactions.view('default').pending, null); assert.equal(f.sessions.detail('default').session.status, 'cancelled');
  await assert.rejects(f.sessions.interact(answer(view)), /changed|no longer/);
  assert.equal(f.sessions.runs.list().rows[0].outcome, 'waiting_input');
});

test('failed dispatch persistence prevents model invocation and leaves an explicitly resumable attempt', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return { type: 'completed', text: 'Unused' }; });
  f.sessions.interactions.prepare = () => { throw Error('Fixture full storage'); };
  await f.sessions.start('Do not dispatch'); await until(() => !f.sessions.busy);
  assert.equal(calls, 0); assert.equal(f.sessions.interactions.view('default').phase, 'failed'); assert.equal(f.sessions.chat.snapshot().persistenceError, true);
});

test('deleting or clearing a session removes private checkpoints while retaining numeric evidence', async t => {
  const f = await fixture(t, async () => ({ type: 'completed', text: 'Private result' }));
  await f.sessions.start('Private request'); await until(() => !f.sessions.busy);
  const turnId = f.sessions.interactions.view('default').latestTurn.id;
  await f.sessions.action({ action: 'create', title: 'Other', provider: 'codex-cli' });
  await f.sessions.action({ action: 'delete', id: 'default' });
  assert.throws(() => f.sessions.interactions.turn('default', turnId), /not found/); assert.equal(f.sessions.runs.analyze().total, 1);
  await f.sessions.start('Clear this request'); await until(() => !f.sessions.busy); await f.sessions.chat.clear();
  assert.equal(f.sessions.interactions.view(f.sessions.current.id).totalTurns, 0); await f.restart(); assert.equal(f.sessions.chat.snapshot().messages.length, 0);
});

test('postcommit cleanup failure cannot resurrect a deleted session and startup retries private cleanup', async t => {
  const f = await fixture(t, async () => ({ type: 'completed', text: 'Private result' })); await f.sessions.start('Delete'); await until(() => !f.sessions.busy);
  await f.sessions.action({ action: 'create', title: 'Other', provider: 'codex-cli' });
  const purge = f.sessions.interactions.deleteSession.bind(f.sessions.interactions); f.sessions.interactions.deleteSession = () => { throw Error('Fixture cleanup fault'); };
  await assert.rejects(f.sessions.action({ action: 'delete', id: 'default' }), /cleanup fault/);
  assert.ok(!f.sessions.view().records.some(record => record.id === 'default'));
  f.sessions.interactions.deleteSession = purge; await f.restart(); assert.equal(f.sessions.interactions.view('default').totalTurns, 0);
});

test('normalized events replay in durable order, deduplicate cumulative usage and expose no private content', async t => {
  const f = await fixture(t, async (request, signal, onUsage) => { onUsage({ ...measured, reason: 'PRIVATE-PROVIDER-DETAIL' }); onUsage({ ...measured, reason: 'PRIVATE-PROVIDER-DETAIL' }); return question; });
  await f.sessions.start('PRIVATE-PROMPT-CONTENT'); await until(() => !f.sessions.busy);
  let after = 0, events = [], page;
  do { page = f.sessions.interactions.events('default', after, 2); events.push(...page.events); after = page.nextAfter; } while (page.hasMore);
  assert.deepEqual(events.map(event => event.type), ['accepted', 'prepared', 'started', 'usage_observed', 'input_requested']);
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  assert.ok(events.every((event, index) => !index || event.sequence > events[index - 1].sequence));
  assert.ok(events.every((event, index) => !index || event.revision >= events[index - 1].revision));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-|Choose the target|Portable browser|Frozen instruction/);
  assert.equal(events[3].usage.inputTokens, 12); assert.equal(events[4].pendingId, f.sessions.interactions.view('default').pending.id);
  const original = structuredClone(events); await f.restart(); assert.deepEqual(f.sessions.interactions.events('default').events, original);
  const empty = f.sessions.interactions.events('default', after); assert.equal(empty.nextAfter, after); assert.equal(empty.events.length, 0);
  const waiting = f.sessions.interactions.view('default'); f.sessions.interactions.abandon('default', waiting.revision, 'event-cancel', waiting.pending.id);
  assert.equal(f.sessions.interactions.events('default', after).events[0].type, 'pending_cancelled');
  for (const [cursor, limit] of [[-1, 50], [1.5, 50], [0, 101], [Number.MAX_SAFE_INTEGER + 1, 50]]) assert.throws(() => f.sessions.interactions.events('default', cursor, limit));
  await f.sessions.chat.clear(); assert.equal(f.sessions.interactions.events('default').events.length, 0);
});

test('cancelled escalation can explicitly resume in a new attempt with immutable prior outcome', async t => {
  let calls = 0; const f = await fixture(t, async () => ++calls === 1 ? { ...question, request: { ...question.request, kind: 'escalation' } } : { type: 'completed', text: 'Operator decision accepted.' });
  await f.sessions.start('Escalate'); await until(() => !f.sessions.busy); const pending = f.sessions.interactions.view('default');
  f.sessions.interactions.abandon('default', pending.revision, 'cancel-escalation', pending.pending.id); const stopped = f.sessions.interactions.view('default');
  await f.sessions.interact({ action: 'resume', sessionId: 'default', turnId: stopped.latestTurn.id, expectedRevision: stopped.revision, operationId: 'resume-escalation', message: 'Proceed with portable browser.' });
  await until(() => !f.sessions.busy); assert.equal(calls, 2); assert.deepEqual(f.sessions.runs.list().rows.map(run => run.outcome), ['escalated', 'completed']);
});

test('interaction HTTP endpoints enforce access, bounded event reads, revision fencing and private-content separation', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-interaction-http-')));
  const journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => ({ activeTasks: [] }));
  workspace.sessions.model = model(async () => question); await workspace.init();
  const server = await statusServer(() => ({ activeTasks: [] }), '127.0.0.1', 0, undefined, workspace);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await workspace.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, token = (await readFile(join(directory, 'webview-token'), 'utf8')).trim();
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const post = (body, authorized = true) => fetch(base + '/api/interactions', { method: 'POST', headers: authorized ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'get', sessionId: 'default' }, false)).status, 401);
  assert.equal((await fetch(base + '/api/capabilities')).status, 401);
  const capability = await (await fetch(base + '/api/capabilities', { headers })).json(); assert.equal(capability.events.transport, 'polling'); assert.equal(capability.capabilities.nativeResume, false); assert.equal(capability.toolAccess.implementation.supported, true); assert.equal(capability.toolAccess.implementation.writes, 'approved_paths_in_owned_worktree'); assert.equal(capability.toolAccess.implementation.humanMergeRequired, true);
  await workspace.sessions.start('PRIVATE-HTTP-PROMPT'); await until(() => !workspace.sessions.busy);
  const view = await (await post({ action: 'get', sessionId: 'default' })).json(); assert.equal(view.phase, 'waiting_input');
  const turn = await (await post({ action: 'turn', sessionId: 'default', turnId: view.latestTurn.id })).json(); assert.match(JSON.stringify(turn.dispatch), /PRIVATE-HTTP-PROMPT/);
  const events = await (await post({ action: 'events', sessionId: 'default', limit: 100 })).json(); assert.doesNotMatch(JSON.stringify(events), /PRIVATE-HTTP-PROMPT|Choose the target/);
  assert.doesNotMatch(JSON.stringify(workspace.sessions.runs.list()), /PRIVATE-HTTP-PROMPT|Choose the target/);
  assert.equal((await post({ action: 'events', sessionId: 'default', after: -1 })).status, 400);
  assert.equal((await post({ action: 'get', sessionId: 'default', answer: 'ignored field' })).status, 400);
  assert.equal((await post({ action: 'get', sessionId: 'unknown' })).status, 404);
  const cancel = { action: 'cancel', sessionId: 'default', pendingId: view.pending.id, expectedRevision: view.revision, operationId: 'http-cancel' };
  assert.equal((await post({ ...cancel, expectedRevision: view.revision - 1 })).status, 409);
  assert.equal((await post(cancel)).status, 200); assert.equal((await post(cancel)).status, 200);
  assert.equal((await post(answer(view))).status, 409);
});

test('old or delayed pending cancellation cannot cancel a newer patch question', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-patch-cancel-generation-'))), repository = join(directory, 'repo'); await mkdir(repository);
  const journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => ({ activeTasks: [] }));
  workspace.sessions.model = model(async () => question); workspace.board.model = model(async () => question); await workspace.init();
  t.after(async () => { await workspace.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  await workspace.board.create({ title: 'Patch question', instruction: 'Create file', repository, paths: ['a.txt'] }); const task = workspace.board.view().tasks[0];
  const waitQuestion = async () => { await until(() => workspace.board.detail(task.id).status === 'waiting_input' && !workspace.sessions.executor.busy); return workspace.sessions.interactions.view(task.sessionId); };
  await workspace.board.tick(); const first = await waitQuestion();
  const oldCancel = { action: 'cancel', sessionId: task.sessionId, pendingId: first.pending.id, expectedRevision: first.revision, operationId: 'cancel-first-question' };
  await workspace.interaction(oldCancel);
  let current = workspace.sessions.interactions.view(task.sessionId);
  await workspace.interaction({ action: 'resume', sessionId: task.sessionId, turnId: current.latestTurn.id, expectedRevision: current.revision, operationId: 'resume-first-question' });
  await workspace.board.tick(); const second = await waitQuestion();
  await workspace.interaction(oldCancel);
  assert.equal(workspace.sessions.interactions.view(task.sessionId).pending.id, second.pending.id); assert.equal(workspace.board.detail(task.id).status, 'waiting_input');
  const action = workspace.board.action.bind(workspace.board); let release, entered;
  const gated = new Promise(resolve => { entered = resolve; });
  workspace.board.action = async (...args) => { if (args[1] !== undefined) { entered(); await new Promise(resolve => { release = resolve; }); } return action(...args); };
  const delayedCancel = workspace.interaction({ action: 'cancel', sessionId: task.sessionId, pendingId: second.pending.id, expectedRevision: second.revision, operationId: 'cancel-second-question' });
  await gated; current = workspace.sessions.interactions.view(task.sessionId);
  await workspace.interaction({ action: 'resume', sessionId: task.sessionId, turnId: current.latestTurn.id, expectedRevision: current.revision, operationId: 'resume-before-projection' });
  let providerEntered, completeProvider, providerSignal;
  const providerStarted = new Promise(resolve => { providerEntered = resolve; });
  workspace.board.model = model(async (request, signal) => {
    providerSignal = signal; providerEntered();
    await new Promise(resolve => { completeProvider = resolve; });
    return question;
  });
  await workspace.board.tick(); await providerStarted;
  release(); await delayedCancel; workspace.board.action = action;
  try { assert.equal(providerSignal.aborted, false, 'A delayed old projection must not abort the new provider invocation.'); }
  finally { completeProvider(); }
  const third = await waitQuestion();
  assert.notEqual(third.pending.id, second.pending.id); assert.equal(workspace.board.detail(task.id).status, 'waiting_input');
});


test('a local patch review keeps its artifact when a later chat question is answered and the worker restarts', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-local-chat-ownership-'))), repository = join(directory, 'repo'); await mkdir(repository);
  const journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  let patchCalls = 0, chatCalls = 0;
  const create = () => {
    const workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => ({ activeTasks: [] }));
    workspace.board.model = model(async request => { patchCalls++; assert.equal(request.operation, 'patch'); return patchCalls === 1 ? question : { type: 'completed', text: JSON.stringify({ summary: 'Prepared file', files: [{ path: 'a.txt', content: 'Approved patch\n' }] }) }; });
    workspace.sessions.model = model(async request => { chatCalls++; assert.equal(request.operation, 'chat'); return chatCalls === 1 ? question : { type: 'completed', text: 'Follow-up explanation.' }; });
    return workspace;
  };
  let workspace = create(); await workspace.init();
  t.after(async () => { await workspace.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  await workspace.board.create({ title: 'Patch then discuss', instruction: 'Create file', repository, paths: ['a.txt'] }); const task = workspace.board.view().tasks[0];
  await workspace.board.tick(); await until(() => workspace.board.detail(task.id).status === 'waiting_input' && !workspace.executor.busy);
  const patchAnswer = { ...answer(workspace.sessions.interactions.view(task.sessionId)), operationId: 'answer-original-patch' };
  await workspace.interaction(patchAnswer); await workspace.board.tick();
  await until(() => workspace.board.detail(task.id).status === 'review' && !workspace.executor.busy);
  const original = structuredClone(workspace.board.detail(task.id));
  await workspace.sessions.start('Explain the patch choices.', task.sessionId); await until(() => !workspace.sessions.busy);
  const pending = workspace.sessions.interactions.view(task.sessionId); assert.equal(pending.phase, 'waiting_input');
  const command = answer(pending);
  await workspace.interaction(command); await until(() => !workspace.sessions.busy);
  assert.equal(chatCalls, 2); assert.equal(patchCalls, 2); assert.equal(workspace.sessions.interactions.view(task.sessionId).phase, 'completed');
  await workspace.interaction(command); await workspace.interaction(patchAnswer); assert.equal(chatCalls, 2); assert.equal(patchCalls, 2);
  assert.equal(workspace.board.detail(task.id).patch, original.patch); assert.equal(workspace.board.detail(task.id).currentTurnId, original.currentTurnId);
  await workspace.close(); workspace = create(); await workspace.init();
  assert.equal(patchCalls, 2); assert.equal(chatCalls, 2);
  assert.equal(workspace.board.detail(task.id).status, 'review'); assert.equal(workspace.board.detail(task.id).patch, original.patch);
  assert.equal(workspace.board.detail(task.id).currentTurnId, original.currentTurnId);
  assert.equal(workspace.sessions.detail(task.sessionId).chat.messages.at(-1).text, 'Follow-up explanation.');
  await workspace.interaction(command); await workspace.interaction(patchAnswer); assert.equal(chatCalls, 2); assert.equal(patchCalls, 2);
});


test('failed answer admission projects a resumable failed session without overriding an active task owner', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ++calls === 1 ? question : { type: 'completed', text: 'Accepted answer recovered.' });
  await f.sessions.start('Choose deployment'); await until(() => !f.sessions.busy);
  const pending = f.sessions.interactions.view('default'), originalTranscript = f.sessions.chat.snapshot().messages;
  const provider = f.sessions.chat.model; f.sessions.chat.model = undefined;
  await assert.rejects(f.sessions.interact(answer(pending)), /No model configured/);
  assert.equal(calls, 1);
  assert.deepEqual(f.sessions.chat.snapshot().messages, originalTranscript, 'Admission failed before transcript projection.');
  const stopped = f.sessions.detail('default');
  assert.equal(stopped.session.interaction.phase, 'failed'); assert.equal(stopped.session.status, 'failed'); assert.equal(stopped.session.busy, false);
  f.sessions.chat.model = provider;
  await f.sessions.interact({ action: 'resume', sessionId: 'default', turnId: stopped.session.interaction.latestTurn.id, expectedRevision: stopped.session.interaction.revision, operationId: 'resume-admission-failure' });
  await until(() => !f.sessions.busy); assert.equal(calls, 2); assert.equal(f.sessions.detail('default').session.status, 'completed');
  await f.sessions.ensureTask('remote-owner', 'orchestrator', 'Remote lease', 'codex-cli');
  const stale = f.sessions.interactions.accept({ sessionId: 'remote-owner', operationId: 'old-followup', kind: 'message', input: 'Earlier follow-up' });
  f.sessions.interactions.fail('remote-owner', stale.turn.id, 'failed', 'admission_unavailable');
  assert.equal(f.sessions.detail('remote-owner').session.status, 'queued');
  await f.sessions.setTaskState('remote-owner', 'running'); assert.equal(f.sessions.detail('remote-owner').session.status, 'running');
});
