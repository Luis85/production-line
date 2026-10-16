import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { LocalTaskboard } from './application-fixtures.mjs';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const question = { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Choose the retry policy.', choices: [{ id: 'opaque_a', label: 'Retry once' }, { id: 'opaque_b', label: 'Never retry' }], reason: 'An automatic retry can duplicate work.' } };
const completed = { type: 'completed', text: JSON.stringify({ summary: 'Changed the approved fixture; tests not run.', files: [{ path: 'checkout.txt', content: 'after\n' }] }) };
const measured = { ...unknownUsage(), inputTokens: 15, outputTokens: 4, source: 'provider_reported', reason: null };

async function fixture(t, execute) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-local-interactions-')));
  const repository = join(directory, 'repository'); await mkdir(repository); await writeFile(join(repository, 'checkout.txt'), 'before\n');
  const settings = new WorkerSettings(directory); await settings.init();
  await settings.update({ provider: { id: 'openai-api', model: 'original-model', apiKey: 'fixture-only' }, board: { queueCapacity: 2, paused: false } });
  let instruction = 'Original provider instruction';
  const factory = connection => ({ configuration: { id: connection.id, model: connection.model, instruction }, capabilities: modelCapabilities, async reply() { throw Error('Typed model expected'); }, execute });
  let sessions, board;
  async function open() { sessions = new WorkerSessions(directory, settings, factory); await sessions.init(); board = new LocalTaskboard(directory, settings, sessions, factory); await board.init(); }
  await open();
  t.after(async () => { await board.close(); await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, repository, settings, get sessions() { return sessions; }, get board() { return board; },
    setInstruction(value) { instruction = value; },
    async create(extra = {}) { await board.create({ title: 'Review checkout retry behavior', instruction: 'Change the approved checkout file.', repository, paths: ['checkout.txt'], provider: 'openai-api', ...extra }); return board.view().tasks.at(-1).id; },
    async restart() { await board.close(); await sessions.close(); await open(); },
    async settle(id, status) {
      await board.tick();
      for (let attempt = 0; attempt < 400; attempt++) { if (board.detail(id).status === status && !sessions.executor.busy) return; await delay(5); }
      throw Error(`Task did not settle as ${status}: ${board.detail(id).status}`);
    }
  };
}
function answer(view, value = 'opaque_b', operationId = 'answer-once') { return { action: 'answer', sessionId: view.sessionId, pendingId: view.pending.id, expectedRevision: view.revision, operationId, answer: value }; }
function resume(view, operationId = 'resume-once') { return { action: 'resume', sessionId: view.sessionId, turnId: view.latestTurn.id, expectedRevision: view.revision, operationId }; }
const inputOf = request => request.messages.map(message => message.text).join('\n');

test('file question survives restart, duplicate answer executes once, and review leaves approved files unchanged', async t => {
  let calls = 0, f;
  f = await fixture(t, async (request, signal, onUsage) => {
    calls++;
    const view = f.sessions.interactions.view(f.board.view().tasks[0].sessionId);
    const turn = f.sessions.interactions.turn(view.sessionId, view.latestTurn.id);
    assert.deepEqual(turn.dispatch, request); assert.equal(f.sessions.runs.get(turn.runId).before.state, 'running');
    onUsage(measured);
    if (calls === 1) return question;
    assert.match(inputOf(request), /opaque_b/); assert.match(inputOf(request), /Never retry/); assert.match(inputOf(request), /duplicate work/);
    return completed;
  });
  const id = await f.create(); await f.settle(id, 'waiting_input');
  const sessionId = f.board.detail(id).sessionId, initial = f.sessions.interactions.view(sessionId);
  assert.equal(f.sessions.executor.busy, false); assert.equal(f.sessions.runs.list({ sessionId }).rows[0].outcome, 'waiting_input');
  await f.restart(); assert.equal(calls, 1); assert.deepEqual(f.sessions.interactions.view(sessionId).pending, initial.pending);
  const command = answer(f.sessions.interactions.view(sessionId));
  await f.board.interact(command); await f.board.interact(command); await f.settle(id, 'review');
  await f.board.interact(command); assert.equal(calls, 2);
  assert.match(f.board.detail(id).patch, /\+after/); assert.equal(await readFile(join(f.repository, 'checkout.txt'), 'utf8'), 'before\n');
  assert.equal(f.sessions.runs.analyze({ sessionId }).consumption.inputTokens, 30);
});

test('continuation retains the original provider profile and approved snapshots after configuration and checkout edits', async t => {
  let calls = 0;
  const f = await fixture(t, async request => {
    if (++calls === 1) { assert.equal(request.policy.maxRuntimeMs, 6 * 60 * 60 * 1000); return question; }
    assert.equal(request.provider.model, 'original-model'); assert.equal(request.provider.instruction, 'Original provider instruction');
    assert.match(inputOf(request), /before\\n/); assert.doesNotMatch(inputOf(request), /outside-edit/);
    assert.deepEqual(request.policy, { tools: 'none', filesystem: 'read_only', continuation: 'worker_context_replay', maxRuntimeMs: 2 * 60 * 60 * 1000, maxToolCalls: 128, commandTimeoutMs: 300000 });
    return completed;
  });
  const id = await f.create(); await f.settle(id, 'waiting_input');
  await f.settings.update({ provider: { id: 'openai-api', model: 'new-model' }, execution: { maxRuntimeMs: 2 * 60 * 60 * 1000 } }); f.setInstruction('Changed provider instruction');
  await writeFile(join(f.repository, 'checkout.txt'), 'outside-edit\n'); await f.restart();
  await f.board.interact(answer(f.sessions.interactions.view(f.board.detail(id).sessionId))); await f.settle(id, 'review');
  assert.equal(await readFile(join(f.repository, 'checkout.txt'), 'utf8'), 'outside-edit\n');
});

test('cancelled file question remains cancelled after restart and explicit retry creates one new invocation', async t => {
  let calls = 0; const f = await fixture(t, async () => ++calls === 1 ? question : completed);
  const id = await f.create(); await f.settle(id, 'waiting_input');
  const sessionId = f.board.detail(id).sessionId;
  await f.board.action({ id, action: 'cancel' }); await f.restart();
  assert.equal(f.board.detail(id).status, 'cancelled'); assert.equal(f.sessions.interactions.view(sessionId).pending, null); assert.equal(calls, 1);
  assert.equal(f.sessions.runs.list({ sessionId }).rows[0].outcome, 'waiting_input');
  await f.board.action({ id, action: 'retry' }); await f.settle(id, 'review'); assert.equal(calls, 2);
});

test('accepted file answer survives a full queue before prepare, restart and explicit resume exactly once', async t => {
  let calls = 0;
  const f = await fixture(t, async request => {
    if (++calls === 1) return question;
    assert.equal(request.messages.filter(message => message.role === 'user' && message.text === 'saved-answer-opaque_b').length, 1);
    assert.match(inputOf(request), /Never retry/); assert.match(inputOf(request), /duplicate work/); return completed;
  });
  const id = await f.create(); await f.settle(id, 'waiting_input');
  await f.settings.update({ board: { paused: true, queueCapacity: 1 } });
  const blocker = await f.create({ title: 'Queue blocker' });
  const sessionId = f.board.detail(id).sessionId;
  await assert.rejects(f.board.interact(answer(f.sessions.interactions.view(sessionId), 'saved-answer-opaque_b')), /queue is full/);
  let view = f.sessions.interactions.view(sessionId);
  assert.equal(f.sessions.interactions.turn(sessionId, view.latestTurn.id).dispatch, null);
  assert.equal(view.phase, 'failed');
  assert.equal(f.board.detail(id).status, 'failed', 'The board must reflect the saved answer failure without a restart.');
  assert.equal(f.board.detail(id).currentTurnId, view.latestTurn.id);
  assert.equal(f.board.detail(id).runId, undefined, 'A pre-prepare failure must not point at the earlier question run.');
  assert.match(f.board.detail(id).error, /saved|Resume/);
  await f.restart(); assert.equal(calls, 1); assert.equal(f.board.detail(id).status, 'failed');
  assert.equal(f.board.detail(blocker).status, 'failed');
  view = f.sessions.interactions.view(sessionId); await f.board.interact(resume(view));
  await f.settings.update({ board: { paused: false } }); await f.settle(id, 'review'); assert.equal(calls, 2);
});

test('validated file result recovers after patch projection failure without another model invocation', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return completed; });
  const id = await f.create(); const writePatch = f.board.writePatch.bind(f.board);
  f.board.writePatch = async () => { throw Error('Fixture patch persistence fault'); };
  await f.board.tick();
  for (let attempt = 0; attempt < 400 && !f.board.view().persistenceError; attempt++) await delay(5);
  assert.equal(f.board.view().persistenceError, true); assert.equal(calls, 1);
  const sessionId = f.board.detail(id).sessionId, turnId = f.sessions.interactions.view(sessionId).latestTurn.id;
  assert.equal(f.sessions.interactions.turn(sessionId, turnId).result.type, 'completed');
  f.board.writePatch = writePatch; await f.restart();
  assert.equal(calls, 1); assert.equal(f.board.detail(id).status, 'review');
  assert.match(await readFile(join(f.directory, 'local-review', id + '.patch'), 'utf8'), /\+after/);
});

test('out-of-scope patch output never becomes a durable completed file result', async t => {
  const f = await fixture(t, async () => ({ type: 'completed', text: JSON.stringify({ summary: 'Invalid fixture', files: [{ path: '../outside', content: 'bad' }] }) }));
  const id = await f.create(); await f.settle(id, 'failed');
  const sessionId = f.board.detail(id).sessionId, view = f.sessions.interactions.view(sessionId);
  assert.equal(view.phase, 'failed'); assert.equal(f.sessions.interactions.turn(sessionId, view.latestTurn.id).result, null);
  assert.equal(f.sessions.runs.list({ sessionId }).rows[0].outcome, 'failed'); assert.equal(f.board.detail(id).patch, null);
  await f.restart(); assert.equal(f.board.detail(id).status, 'failed');
});

test('a maximum-length approved instruction remains admissible without appended-path overflow', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return completed; });
  const id = await f.create({ instruction: 'x'.repeat(8000) });
  assert.equal(f.board.detail(id).status, 'queued'); assert.equal(calls, 0);
  const task = f.board.detail(id), turn = f.sessions.interactions.turn(task.sessionId, task.currentTurnId);
  assert.equal(turn.input.length, 8000); assert.match(inputOf(turn.dispatch), /checkout\.txt/);
});

test('file tasks publish normalized cumulative usage events once without private context', async t => {
  const f = await fixture(t, async (request, signal, onUsage) => {
    onUsage({ ...measured, reason: 'PRIVATE-USAGE-DIAGNOSTIC', raw: 'PRIVATE-RAW' });
    onUsage({ ...measured, reason: 'PRIVATE-USAGE-DIAGNOSTIC', raw: 'PRIVATE-RAW' });
    return question;
  });
  const id = await f.create({ instruction: 'PRIVATE-REQUEST-CONTEXT' }); await f.settle(id, 'waiting_input');
  const sessionId = f.board.detail(id).sessionId, events = f.sessions.interactions.events(sessionId).events;
  const usage = events.filter(event => event.type === 'usage_observed');
  assert.equal(usage.length, 1); assert.equal(usage[0].usage.inputTokens, 15);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-|checkout\.txt|Choose the retry policy/);
  assert.equal(events.at(-1).type, 'input_requested');
});

test('validated file result is recorded as a readable transcript message while the raw change set stays evidence', async t => {
  const summary = 'Added toLanguage().\n\nTests belong in ../tests/unit/**/*.spec.ts; tsconfig excludes src/**/*.spec.ts.';
  const content = 'before\nafter\nPRIVATE-FILE-BODY\n';
  const reply = JSON.stringify({ summary, files: [{ path: 'checkout.txt', content }] });
  const f = await fixture(t, async () => ({ type: 'completed', text: reply }));
  const id = await f.create(); await f.settle(id, 'review');
  const sessionId = f.board.detail(id).sessionId, turnId = f.sessions.interactions.view(sessionId).latestTurn.id;
  const message = f.sessions.detail(sessionId).chat.messages.at(-1);
  assert.equal(message.role, 'assistant'); assert.equal(message.state, 'complete');
  assert.match(message.text, /^Added toLanguage\(\)\.\n\nTests belong in `\.\.\/tests\/unit\/\*\*\/\*\.spec\.ts`; tsconfig excludes `src\/\*\*\/\*\.spec\.ts`\./);
  assert.match(message.text, /- `checkout\.txt` · 2 lines added, 0 removed/);
  assert.doesNotMatch(message.text, /PRIVATE-FILE-BODY|"files"|\\n/);
  assert.equal(f.sessions.interactions.turn(sessionId, turnId).result.text, reply);
  assert.equal(f.board.detail(id).summary, summary);
});
