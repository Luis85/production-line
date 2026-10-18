import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions, LocalTaskboard } from './application-fixtures.mjs';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { WorkerConsumption } from '../../src/worker/dist/worker/application/consumption.js';
import { WorkerConsumptionJournal } from '../../src/worker/dist/worker/infrastructure/journal/consumption.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { WorkerInteractionJournal } from '../../src/worker/dist/worker/infrastructure/journal/interactions.js';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { initializeLocalEvidence } from '../../src/worker/dist/worker/infrastructure/journal/startup.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';

/** @type {import('../../src/worker/application/model-contract.js').ModelResult} */
const completed = { type: 'completed', text: JSON.stringify({ summary: 'Updated approved file.', files: [{ path: 'source.txt', content: 'after\n' }] }) };
/** @type {import('../../src/worker/application/model-contract.js').ModelResult} */
const question = { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which behavior should be implemented?' } };
const delay = () => new Promise(resolve => setTimeout(resolve, 5));

/** @param {import('node:test').TestContext} t
 * @param {(request: import('../../src/worker/application/model-contract.js').ModelRequest, count: number) => import('../../src/worker/application/model-contract.js').ModelResult} [result]
 * @param {import('../../src/worker/application/consumption.js').ConsumptionRuntime} [consumption] */
async function fixture(t, result = () => completed, consumption) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-queued-recovery-'))), repository = join(directory, 'repo');
  await mkdir(repository); await writeFile(join(repository, 'source.txt'), 'before\n');
  const settings = new WorkerSettings(directory); await settings.init();
  await settings.update({ provider: { id: 'openai-api', model: 'accepted-model', apiKey: 'fixture-only' }, board: { queueCapacity: 4, paused: true } });
  const calls = [];
  let available = true;
  const factory = connection => available ? ({ configuration: { id: connection.id, model: connection.model, instruction: 'Accepted profile' }, capabilities: modelCapabilities, async reply() { throw Error('Expected structured model'); }, async execute(request) { calls.push(request); return result(request, calls.length); } }) : undefined;
  let sessions, board;
  async function open() { sessions = WorkerSessions(directory, settings, factory, undefined, undefined, consumption); await sessions.init(); board = LocalTaskboard(directory, settings, sessions, factory, undefined, consumption); await board.init(); }
  async function close() { await board?.close(); await sessions?.close(); }
  await open();
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  return {
    disableProvider() { available = false; },
    directory, settings, calls, get sessions() { return sessions; }, get board() { return board; },
    async create(title = 'Implement queued feature') { await board.create({ title, instruction: 'Update the approved file.', repository, paths: ['source.txt'], provider: 'openai-api' }); return structuredClone(board.view().tasks.at(-1)); },
    async restart(mutate = async () => {}) { await close(); await mutate(); await open(); },
    async settle(task, status = 'review') {
      for (let attempt = 0; attempt < 400; attempt++) { await board.tick(); if (board.detail(task.id).status === status && !sessions.executor.busy) return; await delay(); }
      assert.fail(`Expected ${status}, received ${board.detail(task.id).status}`);
    },
  };
}

async function mutateTasks(directory, change) { const path = join(directory, 'taskboard.json'), value = JSON.parse(await readFile(path, 'utf8')); change(value); await writeFile(path, JSON.stringify(value)); }
function mutateRow(directory, file, table, id, change, where = 'id') {
  const db = new DatabaseSync(join(directory, file));
  try { const row = db.prepare(`SELECT payload FROM ${table} WHERE ${where}=?`).get(id); const value = JSON.parse(String(row.payload)); change(value); db.prepare(`UPDATE ${table} SET payload=? WHERE ${where}=?`).run(JSON.stringify(value), id); } finally { db.close(); }
}
function sql(directory, file, statement, ...values) { const db = new DatabaseSync(join(directory, file)); try { db.prepare(statement).run(...values); } finally { db.close(); } }

const identity = task => ({ feature: task.feature, requestId: task.requestId, currentTurnId: task.currentTurnId, runId: task.runId, sessionId: task.sessionId });

test('fully prepared queued Feature Request survives repeated restarts and executes once with its frozen intent', async t => {
  const f = await fixture(t), task = await f.create(), before = f.sessions.interactions.turn(task.sessionId, task.currentTurnId);
  await f.restart(); await f.restart();
  assert.equal(f.calls.length, 0); assert.equal(f.board.detail(task.id).status, 'queued');
  assert.deepEqual(identity(f.board.detail(task.id)), identity(task));
  assert.deepEqual(f.sessions.interactions.turn(task.sessionId, task.currentTurnId).dispatch, before.dispatch);
  assert.equal(f.sessions.requests.get(task.requestId).execution.status, 'prepared');
  assert.equal(f.sessions.runs.get(task.runId).before, null);
  await f.board.tick(); await delay(); assert.equal(f.calls.length, 0, 'Queue pause still applies after recovery.');
  await f.settings.update({ board: { paused: false }, provider: { id: 'openai-api', model: 'later-model' } });
  await f.settle(task); assert.deepEqual(f.calls, [before.dispatch]);
  const run = f.sessions.runs.get(task.runId);
  assert.equal(run.outcome, 'review'); assert.equal(run.queueDurationMs, null, 'Cross-process queue timing is unavailable.');
  assert.ok(run.durationMs >= 0); assert.notEqual(run.durationMs, null, 'Execution timing starts in the new process.');
  await f.restart(); await f.board.tick(); assert.equal(f.calls.length, 1);
});

test('prepared Markdown answer retains its original Feature Request and does not repeat an earlier question', async t => {
  const f = await fixture(t, (_request, count) => count === 1 ? question : completed), task = await f.create();
  await f.settings.update({ board: { paused: false } }); await f.settle(task, 'waiting_input');
  await f.settings.update({ board: { paused: true } });
  const view = f.sessions.interactions.view(task.sessionId);
  await f.board.interact({ action: 'answer', sessionId: task.sessionId, pendingId: view.pending.id, expectedRevision: view.revision, operationId: 'team-answer', answer: 'Use the documented behavior.' });
  const prepared = structuredClone(f.board.detail(task.id)), turn = f.sessions.interactions.turn(task.sessionId, prepared.currentTurnId);
  assert.notEqual(prepared.currentTurnId, task.currentTurnId); assert.equal(prepared.requestId, task.requestId);
  await f.restart(); assert.equal(f.calls.length, 1); assert.equal(f.board.detail(task.id).status, 'queued');
  await f.settings.update({ board: { paused: false } }); await f.settle(task);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1], turn.dispatch);
  assert.equal(f.sessions.runs.list({ sessionId: task.sessionId }).total, 2);
});

test('queued second Feature Request continues after the first asks for input without replaying it', async t => {
  const f = await fixture(t, (_request, count) => count === 1 ? question : completed), first = await f.create('First feature'), second = await f.create('Second feature');
  await f.restart(); await f.settings.update({ board: { paused: false } });
  await f.settle(first, 'waiting_input'); await f.settle(second);
  assert.equal(f.calls.length, 2); assert.equal(f.board.detail(first.id).status, 'waiting_input');
  assert.deepEqual(identity(f.board.detail(second.id)), identity(second));
});

/** @type {[string, (f: Awaited<ReturnType<typeof fixture>>, task: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['create']>>) => void | Promise<void>][]} */
const mutations = [
  ['task start persisted', (f, task) => mutateTasks(f.directory, tasks => { tasks[0].status = 'running'; })],
  ['task admission incomplete', (f, task) => mutateTasks(f.directory, tasks => { tasks[0].admissionFailure = { paths: ['source.txt'] }; })],
  ['task frozen context differs', (f, task) => mutateTasks(f.directory, tasks => { tasks[0].instruction = 'Different input'; })],
  ['duplicate task ownership', (f, task) => mutateTasks(f.directory, tasks => { tasks.push(structuredClone(tasks[0])); })],
  ['catalog running state disagrees', async (f, task) => { const path = join(f.directory, 'sessions.json'), value = JSON.parse(await readFile(path, 'utf8')); value.records.find(record => record.id === task.sessionId).taskState = 'running'; await writeFile(path, JSON.stringify(value)); }],
  ['request generation snapshot missing', (f, task) => sql(f.directory, 'worker-requests.sqlite', 'DELETE FROM request_generations WHERE request_id=?', task.requestId)],
  ['request generation snapshot differs', (f, task) => mutateRow(f.directory, 'worker-requests.sqlite', 'request_generations', task.requestId, value => { value.provider.model = 'different-model'; }, 'request_id')],
  ['request started', (f, task) => mutateRow(f.directory, 'worker-requests.sqlite', 'worker_requests', task.requestId, value => { value.execution.status = 'running'; })],
  ['request execution generation differs', (f, task) => mutateRow(f.directory, 'worker-requests.sqlite', 'worker_requests', task.requestId, value => { value.execution.inputRevision++; })],
  ['request accepted input hash differs', (f, task) => mutateRow(f.directory, 'worker-requests.sqlite', 'worker_requests', task.requestId, value => { value.input.message = 'Changed after acceptance'; })],
  ['request policy hash differs', (f, task) => mutateRow(f.directory, 'worker-requests.sqlite', 'worker_requests', task.requestId, value => { value.policy.version++; })],
  ['request readiness missing', (f, task) => mutateRow(f.directory, 'worker-requests.sqlite', 'worker_requests', task.requestId, value => { value.evaluations = []; })],
  ['request turn binding generation differs', (f, task) => sql(f.directory, 'worker-requests.sqlite', 'UPDATE request_turns SET input_revision=input_revision+1 WHERE turn_id=?', task.currentTurnId)],
  ['request execution row missing', (f, task) => sql(f.directory, 'worker-requests.sqlite', 'DELETE FROM request_executions WHERE turn_id=?', task.currentTurnId)],
  ['interaction started', (f, task) => mutateRow(f.directory, 'worker-interactions.sqlite', 'interaction_turns', task.currentTurnId, value => { value.status = 'running'; })],
  ['interaction dispatch incomplete', (f, task) => mutateRow(f.directory, 'worker-interactions.sqlite', 'interaction_turns', task.currentTurnId, value => { value.dispatch = null; value.dispatchDigest = null; })],
  ['interaction dispatch changed', (f, task) => mutateRow(f.directory, 'worker-interactions.sqlite', 'interaction_turns', task.currentTurnId, value => { value.dispatch.provider.instruction = 'Different profile'; })],
  ['interaction usage observed even if zero', (f, task) => mutateRow(f.directory, 'worker-interactions.sqlite', 'interaction_turns', task.currentTurnId, value => { value.usage = { ...unknownUsage(), inputTokens: 0, source: 'provider_reported' }; })],
  ['interaction indexed status disagrees', (f, task) => sql(f.directory, 'worker-interactions.sqlite', "UPDATE interaction_turns SET status='running' WHERE id=?", task.currentTurnId)],
  ['run started', (f, task) => mutateRow(f.directory, 'worker-runs.sqlite', 'worker_runs', task.runId, value => { value.startedAt = new Date().toISOString(); })],
  ['run belongs to another request', (f, task) => mutateRow(f.directory, 'worker-runs.sqlite', 'worker_runs', task.runId, value => { value.requestId = 'different-request'; })],
  ['run has observed zero usage', (f, task) => mutateRow(f.directory, 'worker-runs.sqlite', 'worker_runs', task.runId, value => { value.usage.inputTokens = 0; })],
  ['run indexed status disagrees', (f, task) => sql(f.directory, 'worker-runs.sqlite', "UPDATE worker_runs SET outcome='running' WHERE id=?", task.runId)],
  ['interaction missing', (f, task) => sql(f.directory, 'worker-interactions.sqlite', 'DELETE FROM interaction_turns WHERE id=?', task.currentTurnId)],
  ['run missing', (f, task) => sql(f.directory, 'worker-runs.sqlite', 'DELETE FROM worker_runs WHERE id=?', task.runId)],
  ['task projection missing', (f, task) => mutateTasks(f.directory, tasks => { tasks.length = 0; })],
  ['session catalog missing local owner', async (f, task) => { const path = join(f.directory, 'sessions.json'), value = JSON.parse(await readFile(path, 'utf8')); value.records = value.records.filter(record => record.id !== task.sessionId); value.selected = 'default'; await writeFile(path, JSON.stringify(value)); }],
];
for (const [name, mutate] of mutations) test(`restart holds uncertain work: ${name}`, async t => {
  const f = await fixture(t), task = await f.create();
  await f.restart(async () => { await mutate(f, task); });
  assert.equal(f.calls.length, 0);
  assert.notEqual(f.board.view().tasks.find(value => value.id === task.id)?.status, 'queued');
  await f.settings.update({ board: { paused: false } }); await f.board.tick(); await delay();
  assert.equal(f.calls.length, 0, 'Uncertain work requires explicit continuation.');
});

test('recovered queue stays held by consumption until the next UTC window', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-recovery-budget-'));
  let now = new Date('2026-10-18T23:59:00Z');
  const journal = new WorkerConsumptionJournal(directory);
  const consumption = new WorkerConsumption(journal, () => ({ enabled: true, period: 'daily', allowance: 100, workerPercent: 50, perRunReservation: 40 }), () => now);
  await consumption.init();
  t.after(async () => { consumption.close(); await rm(directory, { recursive: true, force: true }); });
  const charged = consumption.begin('openai-api');
  consumption.finish(charged.id, { ...unknownUsage(), inputTokens: 30, outputTokens: 20, source: 'provider_reported' }, true);
  assert.equal(consumption.status().blocked, true);
  const f = await fixture(t, undefined, consumption), task = await f.create();
  await f.restart(); await f.settings.update({ board: { paused: false } });
  await f.board.tick(); await delay();
  assert.equal(f.calls.length, 0); assert.equal(f.board.detail(task.id).status, 'queued');
  now = new Date('2026-10-19T00:00:01Z');
  await f.settle(task); assert.equal(f.calls.length, 1);
  assert.deepEqual(identity(f.board.detail(task.id)), identity(task));
});

test('recovery does not bypass the current provider availability guard', async t => {
  const f = await fixture(t), task = await f.create();
  await f.restart(); f.disableProvider();
  await f.settings.update({ board: { paused: false } }); await f.settle(task, 'failed');
  assert.equal(f.calls.length, 0); assert.equal(f.sessions.runs.get(task.runId).outcome, 'failed');
});

for (const authority of ['request', 'interaction']) test(`a durable ${authority} start event vetoes contradictory queued projections`, async t => {
  const f = await fixture(t), task = await f.create();
  if (authority === 'request') f.sessions.requests.startExecution(task.requestId, task.currentTurnId, task.runId);
  else f.sessions.interactions.start(task.sessionId, task.currentTurnId);
  await f.restart(async () => {
    if (authority === 'request') {
      mutateRow(f.directory, 'worker-requests.sqlite', 'worker_requests', task.requestId, value => { value.execution.status = 'prepared'; value.phase = 'ready'; });
      mutateRow(f.directory, 'worker-requests.sqlite', 'request_executions', task.currentTurnId, value => { value.status = 'prepared'; }, 'turn_id');
      sql(f.directory, 'worker-requests.sqlite', "UPDATE worker_requests SET phase='ready' WHERE id=?", task.requestId);
    } else {
      mutateRow(f.directory, 'worker-interactions.sqlite', 'interaction_turns', task.currentTurnId, value => { value.status = 'queued'; });
      sql(f.directory, 'worker-interactions.sqlite', "UPDATE interaction_turns SET status='queued' WHERE id=?", task.currentTurnId);
      sql(f.directory, 'worker-interactions.sqlite', "UPDATE interaction_sessions SET phase='queued' WHERE id=?", task.sessionId);
    }
  });
  assert.equal(f.board.detail(task.id).status, 'failed');
  await f.settings.update({ board: { paused: false } }); await f.board.tick();
  assert.equal(f.calls.length, 0);
});

for (const boundary of ['request', 'interaction']) test(`interruption during ${boundary} startup reconciliation cannot make uncertain work runnable`, async t => {
  const f = await fixture(t), task = await f.create();
  await f.restart(async () => {
    await mutateTasks(f.directory, tasks => { tasks[0].status = 'running'; });
    const requests = new WorkerRequestJournal(f.directory), interactions = new WorkerInteractionJournal(f.directory), runs = new WorkerRunJournal(f.directory);
    const journal = boundary === 'request' ? requests : interactions, recover = journal.recover.bind(journal);
    journal.recover = retained => { recover(retained); throw Error('Simulated startup interruption'); };
    await assert.rejects(initializeLocalEvidence(f.directory, f.settings, requests, interactions, runs), /Simulated startup interruption/);
  });
  assert.equal(f.board.detail(task.id).status, 'failed');
  assert.equal(f.sessions.runs.get(task.runId).outcome, 'interrupted');
  await f.settings.update({ board: { paused: false } }); await f.board.tick();
  assert.equal(f.calls.length, 0);
});

test('missing canonical Feature Request fails startup closed without inventing a new identity', async t => {
  const f = await fixture(t), task = await f.create();
  await assert.rejects(f.restart(async () => { sql(f.directory, 'worker-requests.sqlite', 'DELETE FROM worker_requests WHERE id=?', task.requestId); }), { code: 'not_found' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessions.runs.get(task.runId).outcome, 'interrupted');
  assert.equal(f.sessions.interactions.turn(task.sessionId, task.currentTurnId).status, 'interrupted');
});
