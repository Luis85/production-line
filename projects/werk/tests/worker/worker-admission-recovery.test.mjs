import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { LocalTaskboard } from './application-fixtures.mjs';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';

const instruction = 'Implement this explicit approved request and preserve the recorded scope and existing unrelated behavior.';
const question = { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Choose the target.', choices: [{ id: 'opaque_a', label: 'Linux desktop' }, { id: 'opaque_b', label: 'Portable browser' }], reason: 'The target changes packaging.' } };
async function fixture(t, execute) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-admission-recovery-'));
  const repository = join(directory, 'repository'); await mkdir(repository);
  const settings = new WorkerSettings(directory); await settings.init();
  await settings.update({ provider: { id: 'codex-cli', executable: process.execPath, model: 'fixture' } });
  const calls = [];
  const model = connection => !connection.executable ? undefined : ({
    configuration: { id: connection.id, model: connection.model, instruction: 'Fixture only; no external calls.' },
    capabilities: modelCapabilities,
    async reply() { throw Error('Typed model required'); },
    async execute(request) {
      calls.push(request);
      return execute ? execute(request) : { type: 'completed', text: request.operation === 'patch' ? JSON.stringify({ summary: 'Fixture patch', files: [{ path: 'new.txt', content: 'created\n' }] }) : 'Fixture completed.' };
    },
  });
  let sessions, board;
  async function open() {
    sessions = new WorkerSessions(directory, settings, model, undefined, () => board?.active ?? 0);
    await sessions.init();
    board = new LocalTaskboard(directory, settings, sessions, model); await board.init();
  }
  await open();
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  for (const kind of ['chat', 'patch']) policy.ready[kind].push({ id: 'explicit-message', fact: 'input.messageLength', op: 'gte', value: 80 });
  sessions.requests.setPolicy({ policy, expectedRevision: sessions.requests.policy().revision, operationId: 'fixture-policy' });
  t.after(async () => { await board.close(); await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  const f = {
    directory, repository, settings, calls,
    get sessions() { return sessions; }, get board() { return board; },
    get workspace() { return { acceptingTasks: true, settings, sessions, board, reviews: { tick() {}, cancel() {} } }; },
    command(id, action, extra = {}, operationId = crypto.randomUUID()) {
      return { requestId: id, expectedRevision: sessions.requests.get(id).revision, operationId, action, ...extra };
    },
    async execute(id, body = this.command(id, 'execute')) {
      return WorkerWorkspace.prototype.requestCommand.call(this.workspace, body);
    },
    async held(kind) {
      if (kind === 'chat') await sessions.start('Short');
      else await board.create({ title: 'Approved patch', instruction: 'Short', repository, paths: ['new.txt'], provider: 'codex-cli' });
      const request = kind === 'chat' ? sessions.requests.forSession('default') : sessions.requests.get(board.view().tasks[0].requestId);
      const proposed = sessions.requests.command(this.command(request.id, 'propose', { input: { ...request.input, message: instruction } })).request;
      return sessions.requests.command(this.command(request.id, 'accept_candidate', { candidateId: proposed.candidates.at(-1).id })).request;
    },
    async provider(enabled) {
      await settings.update({ provider: { id: 'codex-cli', executable: enabled ? process.execPath : '' } });
      await sessions.reloadProviders();
    },
    async restart() { await board.close(); await sessions.close(); await open(); },
    async settle() {
      for (let n = 0; n < 300; n++) {
        await board.tick();
        if (!board.active && !sessions.busy) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw Error('Fixture did not settle.');
    },
    async block() {
      await settings.update({ board: { queueCapacity: 1, paused: true } });
      await sessions.ensureTask('queue-blocker', 'chat', 'Queue blocker', 'codex-cli');
      await sessions.start(instruction, 'queue-blocker');
    },
    async unblock() { await sessions.cancelTask('queue-blocker'); await settings.update({ board: { paused: false } }); },
  };
  return f;
}

for (const kind of ['chat', 'patch']) {
  test(`fresh guarded ${kind} execute recovers failed owner admission after provider repair and restart`, async t => {
    const f = await fixture(t), request = await f.held(kind);
    await f.provider(false);
    const original = f.command(request.id, 'execute', {}, 'failed-command');
    await assert.rejects(f.execute(request.id, original), /command was saved/);
    assert.equal(f.sessions.requests.get(request.id).execution, null);
    assert.equal(f.calls.length, 0);
    await f.provider(true); await f.restart();
    const replay = await f.execute(request.id, original);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.dispatch.state, 'not_admitted');
    const recovered = await f.execute(request.id);
    assert.equal(recovered.dispatch.state, 'admitted');
    await f.settle();
    assert.equal(f.calls.length, 1);
    assert.equal(f.sessions.requests.get(request.id).phase, 'done');
    await f.execute(request.id, original);
    assert.equal(f.calls.length, 1);
  });

  test(`guarded ${kind} execute respects shared queue capacity and can be retried when it clears`, async t => {
    const f = await fixture(t), request = await f.held(kind);
    await f.block();
    const body = f.command(request.id, 'execute', {}, 'full-queue');
    await assert.rejects(f.execute(request.id, body), /queue is full/);
    assert.equal(f.sessions.requests.get(request.id).execution, null);
    assert.equal(f.calls.length, 0);
    await f.unblock();
    const recovered = await f.execute(request.id);
    assert.equal(recovered.dispatch.state, 'admitted');
    await f.settle(); assert.equal(f.calls.length, 1);
  });
}

test('a chat answer blocked by queue capacity remains saved and resumes once without losing its question', async t => {
  let count = 0;
  const f = await fixture(t, async request => {
    if (++count === 1) return question;
    assert.match(JSON.stringify(request.messages), /opaque_b/);
    assert.match(JSON.stringify(request.messages), /The target changes packaging/);
    return { type: 'completed', text: 'Selected portable browser.' };
  });
  await f.sessions.start(instruction); await f.settle();
  await f.block();
  const view = f.sessions.interactions.view('default');
  const answer = { action: 'answer', sessionId: 'default', pendingId: view.pending.id, expectedRevision: view.revision, operationId: 'saved-answer', answer: 'opaque_b' };
  await assert.rejects(f.sessions.interact(answer), /queue is full/);
  const saved = f.sessions.interactions.view('default');
  assert.equal(saved.phase, 'failed');
  assert.equal(f.sessions.interactions.turn('default', saved.latestTurn.id).input, 'opaque_b');
  await f.sessions.interact(answer); assert.equal(count, 1);
  await f.unblock();
  await f.sessions.interact({ action: 'resume', sessionId: 'default', turnId: saved.latestTurn.id, expectedRevision: saved.revision, operationId: 'resume-saved-answer' });
  await f.settle(); assert.equal(count, 2);
});

test('shutdown rejects new chat admission before asynchronous resource drains finish', async () => {
  let calls = 0;
  const workspace = { acceptingTasks: false, settings: { value: { board: { queueCapacity: 16 } } }, board: { active: 0 }, sessions: { chatActive: 0, start() { calls++; } } };
  await assert.rejects(WorkerWorkspace.prototype.startChat.call(workspace, instruction), /stopping/);
  assert.equal(calls, 0);
});

for (const action of ['execute', 'answer']) {
  test(`patch ${action} reserves its queue slot while durable run admission is pending`, async t => {
    let count = 0;
    const f = await fixture(t, async request => {
      if (action === 'answer' && ++count === 1) return question;
      return { type: 'completed', text: request.operation === 'patch' ? JSON.stringify({ summary: 'Fixture patch', files: [{ path: 'new.txt', content: 'created\n' }] }) : 'Fixture completed.' };
    });
    const request = await f.held('patch');
    if (action === 'answer') { await f.execute(request.id); await f.settle(); }
    await f.settings.update({ board: { queueCapacity: 1 } });
    let entered, release;
    const pending = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const begin = f.sessions.runs.begin.bind(f.sessions.runs);
    f.sessions.runs.begin = async (...args) => { entered(); await gate; return begin(...args); };
    const interaction = f.sessions.interactions.view(request.owner.sessionId);
    const admission = action === 'execute' ? f.execute(request.id) : f.board.interact({ action: 'answer', sessionId: request.owner.sessionId, pendingId: interaction.pending.id, expectedRevision: interaction.revision, operationId: 'pending-patch-answer', answer: 'opaque_b' });
    try {
      await pending;
      await assert.rejects(WorkerWorkspace.prototype.startChat.call(f.workspace, instruction), /queue is full/);
    } finally {
      release();
      await admission;
      await f.settle();
    }
  });
}

for (const action of ['execute', 'answer']) {
  test(`shutdown drains pending patch ${action} admission before closing its evidence`, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return question; });
    const request = await f.held('patch');
    if (action === 'answer') { await f.execute(request.id); await f.settle(); }
    let entered, release;
    const pending = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const begin = f.sessions.runs.begin.bind(f.sessions.runs);
    f.sessions.runs.begin = async (...args) => { entered(); await gate; return begin(...args); };
    const interaction = f.sessions.interactions.view(request.owner.sessionId);
    const admission = action === 'execute' ? f.execute(request.id) : f.board.interact({ action: 'answer', sessionId: request.owner.sessionId, pendingId: interaction.pending.id, expectedRevision: interaction.revision, operationId: 'closing-patch-answer', answer: 'opaque_b' });
    await pending;
    let closed = false;
    const closing = f.board.close().then(() => { closed = true; });
    try {
      await new Promise(setImmediate);
      assert.equal(closed, false, 'Board must retain evidence access until accepted input admission settles.');
    } finally {
      release(); await admission; await closing;
    }
    assert.equal(calls, action === 'answer' ? 1 : 0);
    await f.restart();
    assert.equal(f.board.view().tasks[0].status, 'failed');
    assert.equal(calls, action === 'answer' ? 1 : 0, 'Restart must not replay uncertain execution.');
  });
}
