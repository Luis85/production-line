import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedFeatureIntake } from '../../src/worker/dist/worker/application/shared-feature-intake.js';
import { readTaskNote, writeTaskNoteAnswer } from '../../src/worker/dist/worker/application/task-notes.js';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { defaultSharedIntakeConfig } from '../../src/worker/dist/worker/application/shared-feature-state.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { trackingSharedRecord } from './tracking-fixtures.mjs';

/** @param {import('node:test').TestContext} t @param {'answer'|'resume'} [action] */
async function fixture(t, action = 'answer') {
  const at = '2026-10-17T00:00:00.000Z';
  const phase = action === 'answer' ? 'waiting_input' : 'failed';
  /** @type {import('../../src/worker/application/interactions.js').InteractionView} */
  const view = { schemaVersion: 1, sessionId: 'local-task-one', revision: 2, phase,
    pending: action === 'answer' ? { id: 'question-one', kind: 'question', message: 'Which timezone?', createdAt: at, turnId: 'turn-one' } : null,
    latestTurn: { id: 'turn-one', runId: null, kind: 'message', status: phase, createdAt: at, finishedAt: at, priorTurnId: null }, turns: [], totalTurns: 1 };
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedExecution} */
  let execution = { status: phase, summary: null, patch: null, request: null, interaction: view };
  const record = trackingSharedRecord({ status: phase });
  record.remoteRevision = sharedHash(record.sourceMarkdown);
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedFeatureState} */
  let saved = { schemaVersion: 1, workerId: 'worker', revision: 0, config: defaultSharedIntakeConfig(), records: [record] };
  const files = new Map([[record.sourcePath, record.sourceMarkdown]]);
  /** @type {Map<string, import('../../src/worker/application/shared-feature-state.js').LifecycleWrite>} */
  const receipts = new Map();
  /** @type {Map<string, import('../../src/worker/application/interactions.js').InteractionCommand>} */
  const admissions = new Map();
  const controls = { failedPush: false, lostPushAck: false, unavailable: false, failedSave: false, answerAtPush: '' };
  const unexpected = async () => { throw Error('Unexpected boundary'); };
  /** @type {{entered:()=>void; wait:Promise<void>}|undefined} */
  let headGate;
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedRepositoryPort} */
  const repository = {
    async head() { if (headGate) { const gate = headGate; headGate = undefined; gate.entered(); await gate.wait; } return 'a'.repeat(40); },
    async readBlob(_commit, path) { return files.get(path) ?? null; }, listRequests: unexpected, publishPatch: unexpected,
    async publishLifecycle(write) {
      if (controls.failedPush) throw Error('Git push unavailable');
      if (controls.answerAtPush && write.artifacts.length && saved.records[0].task.uiResponse) {
        const task = saved.records[0].task;
        files.set(task.path, writeTaskNoteAnswer(files.get(task.path), task.identity, controls.answerAtPush));
        controls.answerAtPush = '';
        throw new DomainError('conflict', 'Shared feature content changed before publication.');
      }
      const previous = receipts.get(write.operationId);
      if (previous) assert.deepEqual(write, previous);
      else {
        for (const item of [write.request, ...write.artifacts]) assert.equal(files.has(item.path) ? sharedHash(files.get(item.path)) : null, item.expectedRevision);
        for (const item of [write.request, ...write.artifacts]) files.set(item.path, item.content);
        receipts.set(write.operationId, structuredClone(write));
      }
      if (controls.lostPushAck) throw Error('Lost Git push acknowledgement');
      return { commit: 'a'.repeat(40), head: 'a'.repeat(40) };
    },
  };
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedIntakePorts} */
  const ports = {
    load: async () => structuredClone(saved), async save(state) { if (controls.failedSave) throw Error('Disk unavailable'); saved = structuredClone(state); },
    repository: () => repository, loadWorkflow: unexpected, ready: () => { throw Error('Unexpected admission'); }, source: () => { throw Error('Unexpected discovery'); },
    renderSource: current => JSON.stringify({ id: current.id, status: current.status, task: current.taskNote, error: current.error }),
    submit: unexpected, inspect: () => structuredClone(execution), canAdmit: () => true,
    async continue(current, command) {
      if (admissions.has(command.operationId)) return;
      if (controls.unavailable) throw new DomainError('unavailable', 'Queue paused');
      const note = readTaskNote(files.get(current.task.path), current.task.identity);
      assert.equal(note.status, 'ready', 'Remote Task publication must precede any continuation.');
      assert.equal(command.action === 'answer' ? command.answer : command.message, note.answer);
      assert.ok(saved.records[0].task.response, 'Response reservation must be durable before continuation.');
      admissions.set(command.operationId, structuredClone(command));
      execution = { ...execution, status: 'completed', interaction: { ...view, phase: 'completed', pending: null, revision: 5,
        latestTurn: { ...view.latestTurn, id: 'turn-two', kind: command.action, status: 'completed', priorTurnId: 'turn-one' }, totalTurns: 2 } };
    },
  };
  let intake = new SharedFeatureIntake(ports); await intake.init(); await intake.sync();
  t.after(async () => intake.close());
  const checkpoint = saved.records[0].task.identity;
  /** @type {import('../../src/worker/application/interactions.js').InteractionCommand} */
  const command = { action, sessionId: view.sessionId, expectedRevision: view.revision, operationId: 'ui-answer-one',
    ...(action === 'answer' ? { pendingId: view.pending.id, answer: 'Use UTC dates.' } : { turnId: view.latestTurn.id, message: 'Continue with UTC dates.' }) };
  return {
    command, controls, files, receipts, admissions, checkpoint,
    get intake() { return intake; }, get record() { return saved.records[0]; },
    async restart() { await intake.close(); intake = new SharedFeatureIntake(ports); await intake.init(); },
    async respond(reply = command) { return intake.respond(record.taskId, reply); },
    note() { const task = saved.records[0].task; return readTaskNote(files.get(task.path), task.identity); },
    markdown(answer, status = 'ready') { const task = saved.records[0].task; files.set(task.path, writeTaskNoteAnswer(files.get(task.path), task.identity, answer).replace('status: ready', 'status: ' + status)); },
    blockHead() {
      const entered = Promise.withResolvers(), wait = Promise.withResolvers();
      headGate = { entered: () => entered.resolve(undefined), wait: wait.promise };
      return { entered: entered.promise, release: () => wait.resolve(undefined) };
    },
  };
}

test('a webview answer publishes the existing Task and the Markdown consumer continues the same Feature Request once', async t => {
  const f = await fixture(t), originalPath = f.record.task.path;
  const result = await f.respond();
  assert.equal(result.phase, 'completed'); assert.equal(f.admissions.size, 1);
  assert.equal(f.intake.view().requests[0].taskResponse.status, 'processed');
  assert.equal(f.record.task.path, originalPath); assert.equal(f.record.id, 'feature-one');
  assert.equal(f.note().status, 'processed'); assert.equal(f.note().answer, 'Use UTC dates.');
  assert.equal(f.record.task.uiResponse.command.operationId, 'ui-answer-one');
  assert.match([...f.admissions.keys()][0], /^task-response-/);
  await f.respond(); await f.intake.sync(); assert.equal(f.admissions.size, 1);
  await assert.rejects(f.respond({ ...f.command, answer: 'Use local dates.' }), /different response/);
});

test('concurrent webview replays and polling serialize on one shared lifecycle', async t => {
  const f = await fixture(t), gate = f.blockHead();
  const first = f.respond(); await gate.entered;
  const second = f.respond(), polling = f.intake.sync();
  assert.equal(f.intake.busy, true); assert.equal(f.admissions.size, 0);
  gate.release(); await Promise.all([first, second, polling]);
  assert.equal(f.admissions.size, 1); assert.equal(f.note().status, 'processed');
});

for (const loss of ['failedPush', 'lostPushAck']) test(`${loss} never dispatches before remote confirmation and restart reuses the saved publication`, async t => {
  const f = await fixture(t); f.controls[loss] = true;
  await assert.rejects(f.respond(), /Git push/);
  assert.equal(f.admissions.size, 0); assert.ok(f.record.pending);
  assert.equal(f.intake.view().requests[0].taskResponse.status, 'publication_pending');
  assert.equal(f.record.pending.artifacts[0].path, f.record.task.path);
  assert.equal(readTaskNote(f.record.task.markdown, f.checkpoint).status, 'ready');
  const pendingId = f.record.pending.operationId;
  await f.restart(); f.controls[loss] = false; await f.intake.sync();
  assert.ok(f.receipts.has(pendingId)); assert.equal(f.admissions.size, 1);
  assert.equal(f.note().status, 'processed'); await f.respond(); assert.equal(f.admissions.size, 1);
});

test('a Markdown answer wins a race with a different webview reply without being overwritten or dispatched twice', async t => {
  const f = await fixture(t); f.markdown('Use the customer timezone.');
  await assert.rejects(f.respond(), /different published answer/);
  assert.equal(f.admissions.size, 1); assert.equal(f.note().answer, 'Use the customer timezone.');
  assert.equal(f.note().status, 'processed'); assert.equal(f.record.task.uiResponse, undefined);
});

test('a teammate draft answer and a stale checkpoint are preserved without execution', async t => {
  const f = await fixture(t); f.markdown('Let me confirm the timezone.', 'draft');
  await assert.rejects(f.respond(), /teammate changed/);
  assert.equal(f.admissions.size, 0); assert.equal(f.note().answer, 'Let me confirm the timezone.');
  await assert.rejects(f.respond({ ...f.command, expectedRevision: 1 }), /checkpoint changed/);
  assert.equal(f.admissions.size, 0);
});

test('paused execution retains a published webview answer for the existing Markdown consumer', async t => {
  const f = await fixture(t); f.controls.unavailable = true;
  const result = await f.respond(); assert.equal(result.phase, 'waiting_input');
  assert.equal(f.note().status, 'ready'); assert.equal(f.admissions.size, 0);
  const response = f.intake.view().requests[0].taskResponse;
  assert.deepEqual(response, { sessionId: f.command.sessionId, expectedRevision: f.command.expectedRevision, pendingId: f.command.pendingId, turnId: 'turn-one', status: 'ready', error: 'Queue paused' });
  assert.doesNotMatch(JSON.stringify(response), /Use UTC dates/);
  await f.restart(); f.controls.unavailable = false; await f.intake.sync();
  assert.equal(f.admissions.size, 1); assert.equal(f.note().status, 'processed');
});

test('shared resume uses the same Task publication and keeps the original Feature Request identity', async t => {
  const f = await fixture(t, 'resume');
  await f.respond(); assert.equal(f.note().status, 'processed');
  assert.equal([...f.admissions.values()][0].action, 'resume');
  assert.equal(f.record.id, 'feature-one'); assert.equal(f.admissions.size, 1);
});

test('editing a webview answer preserves Task identity, surrounding sections and CRLF', async t => {
  const f = await fixture(t), task = f.record.task;
  const original = (f.files.get(task.path) + '\n## Team context\n\nPreserve this context.\n').replace(/\n/g, '\r\n');
  const edited = writeTaskNoteAnswer(original, task.identity, 'Use **UTC** dates.');
  assert.equal(readTaskNote(edited, task.identity).answer, 'Use **UTC** dates.');
  assert.match(edited, /## Team context\r\n\r\nPreserve this context\.\r\n/);
  assert.match(edited, /Which timezone\?/); assert.doesNotMatch(edited, /(?<!\r)\n/);
  assert.throws(() => writeTaskNoteAnswer(original, task.identity, 'UTC\n## A second section\nHidden answer'), /Answer section/);
  assert.throws(() => writeTaskNoteAnswer(original, task.identity, '<!-- no response -->'), /nonempty answer/);
});


test('a teammate answer pushed during UI publication releases only the rejected write and resumes through Markdown', async t => {
  const f = await fixture(t); f.controls.answerAtPush = 'Use the customer timezone.';
  await assert.rejects(f.respond(), /teammate changed the Task/);
  assert.equal(f.admissions.size, 0); assert.equal(f.record.pending, undefined);
  assert.equal(f.record.task.uiResponse, undefined); assert.equal(f.note().answer, 'Use the customer timezone.');
  assert.equal(f.note().status, 'ready');
  await f.restart(); await f.intake.sync();
  assert.equal(f.admissions.size, 1); assert.equal(f.note().status, 'processed');
  assert.equal([...f.admissions.values()][0].answer, 'Use the customer timezone.');
});

test('a later teammate edit cannot discard a UI publication whose push acknowledgement remains unknown', async t => {
  const f = await fixture(t); f.controls.lostPushAck = true;
  await assert.rejects(f.respond(), /Lost Git push acknowledgement/);
  const operation = f.record.pending.operationId;
  f.markdown('Use the customer timezone.');
  await f.restart(); f.controls.lostPushAck = false; f.controls.failedPush = true; await f.intake.sync();
  assert.equal(f.record.pending.operationId, operation); assert.equal(f.admissions.size, 0);
  f.controls.failedPush = false; await f.intake.sync();
  assert.ok(f.receipts.has(operation)); assert.equal(f.admissions.size, 1);
  assert.equal([...f.admissions.values()][0].answer, 'Use the customer timezone.');
});
