import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { readTaskNote } from '../../src/worker/dist/worker/application/task-notes.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { WorkerSessions } from './application-fixtures.mjs';

const source = '---\nschemaVersion: 1\ntitle: Markdown request\nstatus: ready\n---\n# Goal\n\nKeep the approved request unchanged.\n';
const answerText = 'Use the portable browser.\n\nKeep **keyboard navigation**.';
/** @typedef {import('../../src/worker/application/feature-requests.js').FeatureRecord} FeatureRecord */
/** @typedef {import('../../src/worker/application/feature-requests.js').FeatureQueuePort} FeatureQueue */
/** @typedef {import('../../src/worker/application/interactions.js').InteractionView} InteractionView */
/** @param {string} sessionId @returns {InteractionView} */
function question(sessionId) {
  const turn = { id: 'turn-one', runId: 'run-one', kind: /** @type {const} */ ('message'), status: /** @type {const} */ ('waiting_input'), createdAt: '2026-10-17T00:00:00.000Z', finishedAt: '2026-10-17T00:00:01.000Z', priorTurnId: null };
  return { schemaVersion: 1, sessionId, revision: 4, phase: 'waiting_input', pending: { id: 'question-one', turnId: turn.id, kind: 'question', message: 'Which target should be used?', createdAt: turn.finishedAt }, latestTurn: turn, turns: [turn], totalTurns: 1 };
}
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'werk-note-roundtrip-'))), state = join(project, '.state'), directory = join(project, 'features');
  await mkdir(state);
  /** @type {Map<string, NonNullable<ReturnType<FeatureQueue['inspect']>>>} */
  const tasks = new Map();
  /** @type {FeatureRecord[]} */
  const admitted = [];
  /** @type {import('../../src/worker/application/interactions.js').InteractionCommand[]} */
  const commands = [];
  /** @type {FeatureQueue} */
  const queue = {
    async submit(record) { if (!tasks.has(record.taskId)) { admitted.push(structuredClone(record)); tasks.set(record.taskId, { status: 'waiting_input', interaction: question(record.sessionId) }); } },
    inspect(record) { return tasks.get(record.taskId); },
    async interact(record, command) {
      if (commands.some(accepted => accepted.operationId === command.operationId)) return;
      const current = tasks.get(record.taskId).interaction;
      if (current.revision !== command.expectedRevision) throw new DomainError('conflict', 'Interaction changed.');
      commands.push(structuredClone(command));
      tasks.set(record.taskId, { status: 'completed', text: 'Completed with your answer.', interaction: { ...current, revision: 5, phase: 'completed', pending: null } });
    },
  };
  let enabled = true;
  let beforeRemove = async () => {};
  let folder = new MarkdownFeatureFolder(directory, state, 'codex-cli', project);
  let service = new FeatureRequests(folder, queue, 0, () => enabled);
  await service.init();
  t.after(async () => { await service.close(); await beforeRemove(); await rm(project, { recursive: true, force: true }); });
  return { project, state, directory, tasks, admitted, commands, queue,
    set beforeRemove(dispose) { beforeRemove = dispose; }, get folder() { return folder; }, get service() { return service; }, set enabled(value) { enabled = value; },
    async scan() { await service.tick(true); await service.tick(true); },
    async admit() { await writeFile(join(directory, 'request.md'), source); await this.scan(); return admitted[0]; },
    async note() { const note = service.view().records[0].taskNote; assert.ok(note); const path = join(directory, note.link); return { ...note, path, markdown: await readFile(path, 'utf8') }; },
    async answer(answer = answerText, status = 'ready') { const note = await this.note(); const markdown = note.markdown.replace(/status: \w+/, 'status: ' + status).replace(/## Answer\n[\s\S]*/, '## Answer\n\n' + answer + '\n'); await writeFile(note.path, markdown); return markdown; },
    async restart() { await service.close(); folder = new MarkdownFeatureFolder(directory, state, 'codex-cli', project); service = new FeatureRequests(folder, queue, 0, () => enabled); await service.init(); },
  };
}

/** @param {() => boolean} check */
async function until(check) { for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Fixture timed out.'); }

test('a Markdown reply resumes the real saved model conversation once across lost acknowledgement and restart', async t => {
  const f = await fixture(t), settings = new WorkerSettings(f.state); await settings.init();
  let calls = 0;
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const model = () => ({ capabilities: modelCapabilities, async reply() { throw Error('Structured model expected.'); }, async execute(request) {
    calls++;
    if (calls === 1) return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which target should be used?' } };
    assert.match(JSON.stringify(request.messages), /portable browser/);
    return { type: 'completed', text: 'Implemented the portable target.' };
  } });
  let sessions = WorkerSessions(f.state, settings, model); await sessions.init();
  f.beforeRemove = async () => { await sessions.close(); };
  f.queue.submit = async record => {
    f.admitted.push(structuredClone(record));
    await sessions.ensureTask(record.sessionId, 'chat', record.input.title, 'codex-cli', record.inputHash);
    await sessions.start(record.input.message, record.sessionId);
  };
  f.queue.inspect = record => { const detail = sessions.detail(record.sessionId); return { status: detail.session.status, interaction: detail.session.interaction, text: detail.chat.messages.findLast(message => message.role === 'assistant' && message.state === 'complete')?.text }; };
  let acknowledgementLost = true;
  f.queue.interact = async (_record, command) => { await sessions.interact(command); if (acknowledgementLost) throw Error('Injected lost acknowledgement'); };
  const record = await f.admit(); await until(() => !sessions.busy); await f.scan();
  const note = await f.note(); assert.equal(readTaskNote(note.markdown, note.identity).status, 'open');
  await f.answer(); await f.scan(); await until(() => !sessions.busy);
  assert.equal(calls, 2); assert.equal(readTaskNote((await f.note()).markdown, note.identity).status, 'ready');
  const saved = JSON.parse(await readFile(join(f.state, 'feature-index.json'), 'utf8'));
  assert.ok(saved.records[0].taskNote.submission.command.operationId);
  await sessions.close(); sessions = WorkerSessions(f.state, settings, model); await sessions.init();
  acknowledgementLost = false; await f.restart(); await f.scan();
  assert.equal(calls, 2); assert.equal(readTaskNote((await f.note()).markdown, note.identity).status, 'processed');
  assert.equal(sessions.interactions.view(record.sessionId).totalTurns, 2);
  assert.equal(parseFeature(await readFile(join(f.directory, 'request.md'), 'utf8')).body, parseFeature(source).body);
  assert.equal(JSON.stringify(f.service.view()).includes(answerText), false);
});

test('draft replies survive every projection and only stable ready documents dispatch', async t => {
  const f = await fixture(t); await f.admit(); const draft = await f.answer(answerText, 'draft');
  await f.scan(); assert.equal((await f.note()).markdown, draft); assert.equal(f.commands.length, 0);
  await f.answer(); await f.service.tick(true); assert.equal(f.commands.length, 0);
  await f.service.tick(true); assert.equal(f.commands.length, 1);
  const processed = await f.note(); assert.equal(readTaskNote(processed.markdown, processed.identity).answer, answerText);
  await f.answer('A later edit must not dispatch again.'); await f.scan();
  assert.equal(f.commands.length, 1); assert.match((await f.note()).markdown, /earlier answer/);
});

test('durable reply reservation blocks dispatch until storage recovers; paused and unavailable queues retain replies', async t => {
  const f = await fixture(t); await f.admit(); await f.answer();
  f.enabled = false; await f.scan(); assert.equal(f.commands.length, 0);
  f.enabled = true;
  const save = f.folder.save.bind(f.folder); let writable = false;
  f.folder.save = async index => { if (!writable) throw Error('Injected full storage'); await save(index); };
  await f.scan(); assert.equal(f.commands.length, 0);
  writable = true;
  const interact = f.queue.interact; let available = false;
  f.queue.interact = async (record, command) => { if (!available) throw new DomainError('unavailable', 'Worker is paused.'); return interact(record, command); };
  await f.scan(); assert.equal(f.commands.length, 0); assert.match((await f.note()).markdown, /status: ready/);
  available = true; await f.scan(); assert.equal(f.commands.length, 1); assert.match((await f.note()).markdown, /status: processed/);
});

test('stale, tampered and malformed replies cannot dispatch and never overwrite operator text', async t => {
  const f = await fixture(t); const record = await f.admit(), note = await f.note();
  const malformed = 'My unfinished editor text'; await writeFile(note.path, malformed); await f.scan();
  assert.equal((await f.note()).markdown, malformed); assert.equal(f.commands.length, 0); assert.ok(f.service.view().errors.length);
  await writeFile(note.path, note.markdown.replace('expectedRevision: 4', 'expectedRevision: 3')); await f.answer(); await f.scan();
  assert.equal(f.commands.length, 0); assert.match(f.service.view().errors[0].message, /identity changed/);
  await writeFile(note.path, note.markdown); await f.answer();
  const current = f.tasks.get(record.taskId).interaction;
  f.tasks.set(record.taskId, { status: 'cancelled', interaction: { ...current, revision: 6, phase: 'cancelled', pending: null } });
  await f.scan(); assert.equal(f.commands.length, 0);
  const stale = readTaskNote((await f.note()).markdown, note.identity);
  assert.equal(stale.status, 'error'); assert.equal(stale.answer, answerText); assert.match(stale.error, /changed/);
});

test('an editor save during acknowledgement is preserved and cannot duplicate the accepted operation', async t => {
  const f = await fixture(t); await f.admit(); await f.answer(); const original = f.folder.taskNotes.write.bind(f.folder.taskNotes);
  let raced = false;
  f.folder.taskNotes.write = async (note, previous, markdown) => {
    if (!raced) { raced = true; const current = await f.note(); await writeFile(current.path, current.markdown + '\nOperator scratch text after admission.\n'); }
    return original(note, previous, markdown);
  };
  await f.scan(); assert.equal(f.commands.length, 1); await f.scan();
  assert.equal(f.commands.length, 1); assert.match((await f.note()).markdown, /Operator scratch text after admission/); assert.match((await f.note()).markdown, /earlier answer/);
});

test('shared-template requests retain local history but block all local reply admission', async t => {
  const f = await fixture(t); await f.admit(); await f.answer();
  const path = join(f.directory, 'request.md'), markdown = (await readFile(path, 'utf8')).replace('schemaVersion: 1', 'schemaVersion: 1\ntemplateId: team-template');
  await writeFile(path, markdown); await f.scan();
  assert.equal(f.commands.length, 0); assert.equal(await readFile(path, 'utf8'), markdown); assert.match(f.service.view().errors[0].message, /Shared Git/);
});

test('failed saved turns yield guarded continuation Tasks while gate holds remain informational', async t => {
  const f = await fixture(t), record = await f.admit(), current = f.tasks.get(record.taskId).interaction;
  f.tasks.set(record.taskId, { status: 'failed', error: 'Provider is unavailable.', interaction: { ...current, revision: 7, phase: 'failed', pending: null, latestTurn: { ...current.latestTurn, status: 'failed' } } });
  await f.scan(); const resume = await f.note(); assert.match(resume.link, /^_tasks\//); assert.equal(resume.identity.action, 'resume');
  await f.answer('The provider is repaired. Continue the saved work.'); await f.scan(); assert.equal(f.commands.length, 1); assert.equal(f.commands[0].action, 'resume');
  f.tasks.set(record.taskId, { status: 'failed', error: 'Readiness needs a new approved request.' }); await f.scan();
  const path = join(f.directory, '_tasks', record.id, 'attention.md'), attention = await readFile(path, 'utf8');
  assert.match(attention, /executable: false/); assert.match(attention, /copy the feature template/);
  assert.equal(f.service.view().records[0].attention, '_tasks/' + record.id + '/attention.md');
  assert.match(await readFile(join(f.directory, 'request.md'), 'utf8'), /attention: _tasks\//);
  assert.equal((await f.note()).link, resume.link);
  await writeFile(path, attention.replace('status: blocked', 'status: ready')); await f.scan(); assert.equal(f.commands.length, 1);
  f.tasks.set(record.taskId, { status: 'completed', text: 'The hold is resolved.' }); await f.scan();
  assert.equal(f.service.view().records[0].attention, undefined);
  assert.doesNotMatch(await readFile(join(f.directory, 'request.md'), 'utf8'), /attention: _tasks\//);
});

test('Task paths reject symlinks and stored identity or command corruption before recovery', async t => {
  const f = await fixture(t); await f.admit(); const note = await f.note();
  if (process.platform !== 'win32') {
    const outside = join(f.project, 'outside.md'); await writeFile(outside, note.markdown); await rm(note.path); await symlink(outside, note.path);
    await f.scan(); assert.equal(f.commands.length, 0); assert.equal(await readFile(outside, 'utf8'), note.markdown); assert.match(f.service.view().errors[0].message, /regular file/);
    await rm(note.path); await writeFile(note.path, note.markdown);
  }
  await f.answer(); await f.scan(); await f.service.close();
  const path = join(f.state, 'feature-index.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.records[0].taskNote.submission.command.sessionId = 'different-session'; await writeFile(path, JSON.stringify(saved));
  const service = new FeatureRequests(new MarkdownFeatureFolder(f.directory, f.state, 'codex-cli', f.project), f.queue, 0);
  await assert.rejects(service.init(), /response reservation/); await service.close();
});

test('local patch results become human review notes with valid latest and immutable patch links', async t => {
  const f = await fixture(t), record = await f.admit();
  record.input.mode = 'patch'; record.input.paths = ['example.ts']; record.status = 'review';
  record.execution = { runId: 'review-run', attempt: 1, before: `_results/${record.id}/review-run.before.json`, after: `_results/${record.id}/review-run.after.json` };
  await f.folder.result(record, 'Implemented the requested behavior.', 'diff --git a/example.ts b/example.ts\n');
  const latest = await readFile(join(f.directory, '_results', record.id + '.md'), 'utf8');
  const immutable = await readFile(join(f.directory, '_results', record.id, 'review-run.md'), 'utf8');
  assert.match(latest, /type: PullRequest/); assert.match(latest, /human review/); assert.match(latest, /not merged or applied/);
  assert.ok(latest.includes('(' + record.id + '.patch)')); assert.match(immutable, /\(review-run\.patch\)/);
  assert.equal(await readFile(join(f.directory, '_results', record.id, 'review-run.patch'), 'utf8'), 'diff --git a/example.ts b/example.ts\n');
  record.gates = { requestId: 'request-one', revision: 8, inputRevision: 1, phase: 'done', policyId: 'policy-one', policyVersion: 1, policyDigest: 'a'.repeat(64), ready: 'pass', done: 'pass', link: '_gates/' + record.id + '/request.md', questions: '_gates/' + record.id + '/questions.md', gaps: '_gates/' + record.id + '/gaps.md' };
  await f.folder.result(record, 'Implemented the requested behavior.', 'diff --git a/example.ts b/example.ts\n');
  assert.equal(await readFile(join(f.directory, '_results', record.id, 'review-run.md'), 'utf8'), immutable);
  assert.match(await readFile(join(f.directory, '_results', record.id + '.md'), 'utf8'), /Completion checks: pass/);
  const legacy = '---\n' + stringify({ schemaVersion: 1, featureId: record.id, source: record.source, status: record.status, taskId: record.taskId, sessionId: record.sessionId, updatedAt: record.updatedAt, execution: record.execution }) + '---\n# Worker result\n\nImplemented the requested behavior.\n';
  await writeFile(join(f.directory, '_results', record.id, 'review-run.md'), legacy);
  await f.folder.result(record, 'Implemented the requested behavior.', 'diff --git a/example.ts b/example.ts\n');
  assert.equal(await readFile(join(f.directory, '_results', record.id, 'review-run.md'), 'utf8'), legacy);
});


test('exact historical question snapshots upgrade without replacing user-edited legacy notes', async t => {
  const f = await fixture(t), record = await f.admit(), note = await f.note(), view = f.tasks.get(record.taskId).interaction;
  const legacy = '---\n' + stringify({ schemaVersion: 1, featureId: record.id, sessionId: record.sessionId, phase: view.phase, revision: view.revision, pendingId: view.pending.id, turnId: view.pending.turnId }) + '---\n# Operator input checkpoint\n\n' + view.pending.message + '\n' +
    '\nThis worker-generated question snapshot may already have been answered or cancelled. Consult the request’s current werk.interaction metadata or the worker interaction controls for its current state. Editing this file does not answer or resume the task. Use the worker interaction controls with this pending ID and current revision. The accepted request body and approved files remain frozen.\n';
  await writeFile(note.path, legacy); await f.scan(); assert.match((await f.note()).markdown, /type: Task/);
  const edited = legacy + '\nAn unsaved operator response belongs here.\n';
  await writeFile(note.path, edited); await f.scan(); assert.equal((await f.note()).markdown, edited); assert.equal(f.commands.length, 0);
});


test('moving a generated Task or PullRequest into the intake root never creates another request', async t => {
  const f = await fixture(t); await f.admit(); const note = await f.note();
  await writeFile(join(f.directory, 'moved-task.md'), note.markdown.replace('status: open', 'status: ready'));
  await writeFile(join(f.directory, 'moved-review.md'), source.replace('schemaVersion: 1', 'schemaVersion: 1\ntype: PullRequest'));
  await f.scan(); assert.equal(f.admitted.length, 1); assert.equal(f.commands.length, 0);
  assert.equal(f.service.view().errors.filter(item => /companions are not new feature requests/.test(item.message)).length, 2);
});
