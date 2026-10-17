import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import { createTaskNoteIdentity, renderTaskNote, readTaskNote, taskNoteResponse, markTaskNoteResponse } from '../../src/worker/dist/worker/application/task-notes.js';
import { WorkerInteractionJournal } from '../../src/worker/dist/worker/infrastructure/journal/interactions.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';

/** @param {Partial<import('../../src/worker/application/interactions.js').InteractionView>} [overrides] */
function view(overrides = {}) {
  /** @type {import('../../src/worker/application/interactions.js').InteractionTurnSummary} */
  const turn = { id: 'turn-original', runId: 'run-1', kind: 'message', status: 'waiting_input', createdAt: '2026-10-17T00:00:00.000Z', finishedAt: '2026-10-17T00:00:01.000Z', priorTurnId: null };
  /** @type {import('../../src/worker/application/interactions.js').InteractionView} */
  const value = { schemaVersion: 1, sessionId: 'session-1', revision: 4, phase: 'waiting_input', pending: { id: 'pending-1', kind: 'question', message: 'Choose the target.', createdAt: turn.finishedAt, turnId: turn.id }, latestTurn: turn, turns: [turn], totalTurns: 1, ...overrides };
  return value;
}
function fixture(overrides = {}) {
  const interaction = view(), identity = createTaskNoteIdentity('fr-1', 'worker-1', interaction);
  assert.ok(identity);
  const markdown = renderTaskNote({ identity, title: 'Delivery target', question: interaction.pending.message, choices: [{ id: 'linux', label: 'Linux desktop' }], reason: 'Packaging depends on the target.', ...overrides });
  return { identity, markdown };
}
function metadata(markdown, update) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match);
  const document = parseDocument(match[1]); update(document);
  return '---\n' + document.toString() + '---\n' + markdown.slice(match[0].length);
}
const ready = markdown => metadata(markdown, document => document.set('status', 'ready'));

/** @param {import('../../src/worker/application/interactions.js').InteractionCommand} command */
function admission(command) {
  return { sessionId: command.sessionId, kind: command.action, operationId: command.operationId, expectedRevision: command.expectedRevision, pendingId: command.pendingId, priorTurnId: command.turnId, input: command.answer ?? command.message ?? '' };
}

test('Task notes are Obsidian-readable, open by default and require explicit ready with a meaningful answer', () => {
  const { identity, markdown } = fixture();
  assert.match(markdown, /type: Task/); assert.match(markdown, /status: open/);
  assert.match(markdown, /## Choices\n\n- Linux desktop \(`linux`\)/);
  assert.match(markdown, /> Packaging depends on the target/);
  assert.equal(taskNoteResponse(markdown, identity), null);
  assert.throws(() => taskNoteResponse(ready(markdown), identity), /nonempty answer/);
  for (const status of ['draft', 'open', 'processed', 'error']) {
    const written = fixture({ status, answer: 'Linux' });
    assert.equal(taskNoteResponse(written.markdown, written.identity), null);
  }
  const written = fixture({ status: 'ready', answer: 'Linux desktop\n\nUse the existing native installer.\nKeep Docker available.' });
  const response = taskNoteResponse(written.markdown, written.identity); assert.ok(response);
  assert.equal(response.command.answer, 'Linux desktop\n\nUse the existing native installer.\nKeep Docker available.');
  assert.deepEqual(Object.keys(response.command).sort(), ['action', 'answer', 'expectedRevision', 'operationId', 'pendingId', 'sessionId']);
  assert.equal(response.command.action, 'answer'); assert.equal(response.command.expectedRevision, 4);
  assert.equal(response.command.pendingId, 'pending-1'); assert.match(response.command.operationId, /^task-response-[a-f0-9]{64}$/);
  assert.deepEqual(taskNoteResponse(written.markdown.replaceAll('\n', '\r\n'), written.identity), response);
  assert.notEqual(taskNoteResponse(fixture({ status: 'ready', answer: 'Browser' }).markdown, identity).command.operationId, response.command.operationId);
});

test('Task identity cannot be replaced, normalized or expanded into permission commands', () => {
  const { identity, markdown } = fixture({ status: 'ready', answer: 'Approved target' });
  for (const [key, value] of Object.entries({ id: 'other-note', featureId: 'other-feature', owner: 'other-worker', sessionId: 'other-session', pendingId: 'other-question', turnId: 'other-turn', expectedRevision: 5 }))
    assert.throws(() => taskNoteResponse(metadata(markdown, doc => doc.set(key, value)), identity), /identity changed/, key);
  for (const [key, value] of Object.entries({ action: 'grant', expectedRevision: -1, sessionId: ' session-1 ', pendingId: null, grants: ['terminal'], policy: { approve: true } }))
    assert.throws(() => taskNoteResponse(metadata(markdown, doc => doc.set(key, value)), identity), undefined, key);
  assert.throws(() => taskNoteResponse(metadata(markdown, doc => doc.delete('owner')), identity), /owner/);
  assert.equal(createTaskNoteIdentity('fr-1', 'worker-2', view()).id === identity.id, false);
  assert.equal(createTaskNoteIdentity('fr-1', 'worker-1', view({ sessionId: 'another-repository-session' })).id === identity.id, false);
});

test('Markdown parsing isolates the real Answer from fences, quotations, comments and later sections', () => {
  const answer = 'Use Linux.\n\n```markdown\n## Answer\nLiteral example only.\n```\n\n> ## Answer\n> Quoted material.\n\n### Additional detail\nKeep this with the answer.';
  const { identity, markdown } = fixture({ status: 'ready', question: 'Question\n\n## Answer\nA heading supplied by the model.', answer });
  const response = taskNoteResponse(markdown + '\n## Operator notes\nUnrelated private annotation.\n', identity); assert.ok(response);
  assert.equal(response.command.answer, answer);
  assert.throws(() => readTaskNote(markdown + '\n## Answer\nAnother answer.\n', identity), /exactly one/);
  assert.throws(() => readTaskNote(markdown.replace('\n## Answer\n', '\n## Response\n'), identity), /editable ## Answer/);
  for (const empty of ['   ', '<!-- intentionally blank -->', '<!-- first -->\n\n<!-- second -->', '<!-- unfinished comment', '> <!-- quoted blank -->', '- <!-- list blank -->']) {
    const note = fixture({ status: 'ready', answer: empty });
    assert.throws(() => taskNoteResponse(note.markdown, identity), /nonempty answer/);
  }
  const literal = fixture({ status: 'ready', answer: '```html\n<!-- literal answer -->\n```' });
  assert.equal(taskNoteResponse(literal.markdown, identity).command.answer, '```html\n<!-- literal answer -->\n```');
});

test('Malformed YAML, duplicate keys, aliases, oversized input and ambiguous answers fail closed', () => {
  const { identity, markdown } = fixture({ status: 'ready', answer: 'Linux' });
  for (const broken of [
    markdown.replace('type: Task', 'type: [unterminated'),
    markdown.replace('type: Task', 'type: Task\ntype: Task'),
    markdown.replace('title: Delivery target', 'title: &title Delivery target\nerror: *title'),
    markdown.replace('title: Delivery target', 'title: !!str Delivery target'),
    markdown.replace('title: Delivery target', 'title: ' + 'x'.repeat(241)),
    markdown.replace('status: ready', 'status: automatic'),
    markdown.replace('type: Task', 'type: Task\n__proto__: denied'),
    markdown.replace('type: Task', 'type: Task\nresponseDigest: not-a-digest'),
    markdown + 'x'.repeat(65536),
    markdown.replace('Linux\n', 'x'.repeat(8001) + '\n'),
  ]) assert.throws(() => readTaskNote(broken, identity));
  assert.throws(() => renderTaskNote({ identity, title: 'Large question', question: 'x'.repeat(8001) }), /question/);
  assert.throws(() => renderTaskNote({ identity, title: 'Large answer', question: 'Choose', answer: 'x'.repeat(8001) }), /answer/);
});

test('Acknowledgements preserve all operator Markdown and bind the processed response digest', () => {
  const { identity, markdown } = fixture({ status: 'ready', answer: 'Linux\n\nKeep the original installer.' });
  const source = (markdown + '\n## Team notes\nKeep this annotation and [[Related feature]].\n').replaceAll('\n', '\r\n');
  const response = taskNoteResponse(source, identity); assert.ok(response);
  const body = value => value.slice(value.indexOf('\r\n---\r\n') + 7);
  const failed = markTaskNoteResponse(source, identity, { status: 'error', error: 'Worker is paused.', responseDigest: response.responseDigest });
  assert.equal(body(failed), body(source)); assert.equal(readTaskNote(failed, identity).status, 'error');
  assert.equal(taskNoteResponse(failed, identity), null);
  const processed = markTaskNoteResponse(failed, identity, { status: 'processed', responseDigest: response.responseDigest });
  assert.equal(body(processed), body(source)); assert.equal(readTaskNote(processed, identity).error, undefined);
  assert.equal(readTaskNote(processed, identity).responseDigest, response.responseDigest);
  assert.equal(taskNoteResponse(processed, identity), null);
  assert.throws(() => markTaskNoteResponse(source, identity, { status: 'processed' }), /does not match/);
  assert.throws(() => markTaskNoteResponse(source, identity, { status: 'processed', responseDigest: '0'.repeat(64) }), /does not match/);
});

test('Only failed and interrupted latest turns can generate explicit resumable Tasks', () => {
  for (const phase of /** @type {const} */ (['failed', 'interrupted'])) {
    const stopped = view({ phase, pending: null, latestTurn: { ...view().latestTurn, status: phase } });
    const identity = createTaskNoteIdentity('fr-1', 'worker-1', stopped); assert.ok(identity);
    assert.equal(identity.action, 'resume'); assert.equal(identity.pendingId, null);
    const markdown = renderTaskNote({ identity, title: 'Resume delivery', question: 'Confirm the stopped attempt should continue.', answer: 'The connection is restored. Continue.', status: 'ready' });
    const response = taskNoteResponse(markdown, identity); assert.ok(response);
    assert.deepEqual(Object.keys(response.command).sort(), ['action', 'expectedRevision', 'message', 'operationId', 'sessionId', 'turnId']);
    assert.equal(response.command.turnId, stopped.latestTurn.id);
  }
  for (const phase of /** @type {const} */ (['cancelled', 'completed', 'queued', 'running', 'idle', 'waiting_input', 'escalated']))
    assert.equal(createTaskNoteIdentity('fr-1', 'worker-1', view({ phase, pending: null })), null);
  assert.equal(createTaskNoteIdentity('fr-1', 'worker-1', view({ phase: 'failed', pending: null, latestTurn: { ...view().latestTurn, status: 'completed' } })), null);
  assert.throws(() => createTaskNoteIdentity('fr-1', 'worker-1', view({ latestTurn: { ...view().latestTurn, id: 'wrong-turn' } })), /latest interaction/);
});

async function journalFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-task-note-'));
  let journal = new WorkerInteractionJournal(directory); await journal.init();
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  return { get journal() { return journal; }, async restart() { journal.close(); journal = new WorkerInteractionJournal(directory); await journal.init(); } };
}

test('Real interaction admission rejects stale answers and deduplicates acknowledged Task replies after restart', async t => {
  const f = await journalFixture(t), sessionId = 'session-1';
  const first = f.journal.accept({ sessionId, kind: 'message', operationId: 'initial', input: 'Implement native delivery.' });
  const request = prepareModelRequest({ async reply() { return 'unused'; } }, [{ id: 'message-1', role: 'user', text: first.turn.input, at: '2026-10-17T00:00:00.000Z', state: 'complete' }]);
  f.journal.prepare(sessionId, first.turn.id, request, 'run-1'); f.journal.start(sessionId, first.turn.id);
  f.journal.complete(sessionId, first.turn.id, { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Choose a target.' } }, unknownUsage());
  const identity = createTaskNoteIdentity('fr-1', 'worker-1', f.journal.view(sessionId)); assert.ok(identity);
  const note = answer => renderTaskNote({ identity, title: 'Target', question: 'Choose a target.', answer, status: 'ready' });
  const response = taskNoteResponse(note('Linux'), identity); assert.ok(response);
  const accepted = f.journal.accept(admission(response.command)); assert.equal(accepted.duplicate, false);
  await f.restart();
  assert.equal(f.journal.view(sessionId).phase, 'interrupted');
  const duplicate = f.journal.accept(admission(response.command));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.turn.id, accepted.turn.id); assert.equal(f.journal.view(sessionId).totalTurns, 2);
  const changed = taskNoteResponse(note('Browser'), identity); assert.ok(changed);
  assert.throws(() => f.journal.accept(admission(changed.command)), /interaction changed/);
});

test('Real resume admission retains stopped-turn and revision guards', async t => {
  const f = await journalFixture(t), sessionId = 'session-1';
  const first = f.journal.accept({ sessionId, kind: 'message', operationId: 'initial', input: 'Implement delivery.' });
  f.journal.fail(sessionId, first.turn.id, 'failed', 'unavailable');
  const identity = createTaskNoteIdentity('fr-1', 'worker-1', f.journal.view(sessionId)); assert.ok(identity);
  const note = renderTaskNote({ identity, title: 'Resume', question: 'Retry after the connection is restored.', answer: 'Continue with existing scope.', status: 'ready' });
  const response = taskNoteResponse(note, identity); assert.ok(response);
  const accepted = f.journal.accept(admission(response.command)); assert.equal(accepted.turn.priorTurnId, first.turn.id);
  f.journal.fail(sessionId, accepted.turn.id, 'interrupted', 'worker_restarted');
  const edited = taskNoteResponse(note.replace('Continue with existing scope.', 'Retry again.'), identity); assert.ok(edited);
  assert.throws(() => f.journal.accept(admission(edited.command)), /interaction changed/);
  assert.equal(f.journal.view(sessionId).totalTurns, 2);
});
