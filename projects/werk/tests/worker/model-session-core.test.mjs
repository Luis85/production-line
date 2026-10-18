import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileModelSessionStore } from '../../src/worker/dist/worker/infrastructure/model-session-store.js';
import { sessionDigest } from '../../src/worker/dist/worker/application/model-session.js';
import { modelContext, conversationProjection } from '../../src/worker/dist/worker/application/model-context.js';
import { modelCapabilities, prepareModelRequest, requireModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { withSessionRecovery } from '../../src/worker/dist/worker/application/model-session-recovery.js';
import { WorkerInteractionJournal } from '../../src/worker/dist/worker/infrastructure/journal/interactions.js';
import { sessionHistoryTool } from '../../src/worker/dist/worker/infrastructure/session-history-tool.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';
/** @type {import('../../src/worker/application/model-session.ts').ModelSessionBinding} */
const binding = { schemaVersion: 1, logicalSessionId: 'fr-session', featureRequestKey: 'fr-' + 'a'.repeat(64), providerId: 'openai-api', generation: 1 };
const signal = () => new AbortController().signal;
/** @returns {import('../../src/worker/application/conversation-contracts.ts').ChatMessage[]} */
const messages = (count = 80) => Array.from({ length: count }, (_, i) => ({ id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', state: 'complete', at: '2026-10-19T00:00:00Z', text: i === 0 ? 'Canonical accepted feature scope' : 'Unchanged decision ' + i }));
/** @returns {import('../../src/worker/application/model-contract.ts').StructuredModel} */
function model() { return { configuration: { id: 'openai-api', model: 'fixture', instruction: '' }, sessionBinding: { ...binding, schemaVersion: 1 }, capabilities: modelCapabilities, toolManifest: { revision: 0, tools: [sessionHistoryTool('/unused', { ...binding, schemaVersion: 1 }).definition] }, async reply() { return 'Done'; }, async execute() { return { type: 'completed', text: 'Done' }; } }; }
async function scratch(t) { const path = await mkdtemp(join(tmpdir(), 'werk-model-session-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
test('durable session revision guards survive restart, preserve old checkpoints and reject another FR', async t => {
  const directory = await scratch(t), first = new FileModelSessionStore(directory);
  const initial = await first.load(binding); assert.equal(initial.revision, 0);
  const running = await first.save(binding, 0, { status: 'running', checkpoint: { nativeId: 'provider-uuid' }, lastDispatchDigest: 'b'.repeat(64) });
  const restarted = new FileModelSessionStore(directory); assert.deepEqual(await restarted.load(binding), running);
  const results = await Promise.allSettled([first.save(binding, 1, { status: 'idle' }), restarted.save(binding, 1, { status: 'unknown' })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await restarted.load(binding)).revision, 2);
  const archive = await readdir(join(directory, 'model-sessions', 'history'));
  assert.equal(archive.length, 1); assert.equal(JSON.parse(await readFile(join(directory, 'model-sessions', 'history', archive[0]), 'utf8')).checkpoint.nativeId, 'provider-uuid');
  await assert.rejects(first.load({ ...binding, featureRequestKey: 'fr-' + 'c'.repeat(64) }), /different feature/);
  const path = join(directory, 'model-sessions', sessionDigest([binding.logicalSessionId, binding.generation]) + '.json');
  await writeFile(path, '{}'); await assert.rejects(first.load(binding));
});
test('long v2 context retains accepted scope, latest question/answer and explicit retrievable archive; v1 remains bounded', () => {
  const original = messages(), compact = modelContext(original, binding);
  assert.ok(compact.messages.length < 24); assert.deepEqual(compact.messages[0], original[0]);
  assert.deepEqual(compact.messages.slice(-2), original.slice(-2)); assert.ok(compact.checkpoint?.archived);
  assert.match(compact.messages[1].text, /werk_session_history/); assert.equal(original.length, 80);
  const prepared = prepareModelRequest(model(), original); assert.equal(prepared.schemaVersion, 2); requireModelRequest(prepared, 'openai-api');
  assert.equal(prepared.session.featureRequestKey, binding.featureRequestKey); assert.ok(Object.isFrozen(prepared.session));
  const projection = conversationProjection(original); assert.deepEqual(projection[0], original[0]); assert.deepEqual(projection.slice(-2), original.slice(-2)); assert.ok(projection.length < 60);
  assert.throws(() => prepareModelRequest({ async reply() { return 'legacy'; } }, original));
  const withoutHistory = { ...model(), toolManifest: undefined }; assert.throws(() => prepareModelRequest(withoutHistory, original));
  assert.throws(() => requireModelRequest({ ...prepared, session: { ...prepared.session, providerId: 'anthropic-api' } }, 'openai-api'));
  assert.throws(() => requireModelRequest({ ...prepared, schemaVersion: 1 }, 'openai-api'));
});
test('bound history reads original archived answers after restart and refuses a different session turn', async t => {
  const directory = await scratch(t), journal = new WorkerInteractionJournal(directory); await journal.init();
  const first = journal.accept({ sessionId: binding.logicalSessionId, operationId: 'one', kind: 'message', input: 'First scope', context: { answer: 'Do not remove the old behavior' } }).turn;
  journal.prepare(binding.logicalSessionId, first.id, prepareModelRequest(model(), messages(2)), 'run-one'); journal.start(binding.logicalSessionId, first.id); journal.complete(binding.logicalSessionId, first.id, { type: 'completed', text: 'Retained original result' }, unknownUsage());
  const foreign = journal.accept({ sessionId: 'other-session', operationId: 'two', kind: 'message', input: 'Private other feature' }).turn;
  journal.close();
  const tool = sessionHistoryTool(directory, binding), listing = JSON.parse((await tool.call({}, signal())).content[0].text);
  assert.equal(listing.turns.length, 1); assert.equal(listing.turns[0].id, first.id);
  const retained = JSON.parse((await tool.call({ turnId: first.id }, signal())).content[0].text);
  assert.match(retained.text, /Do not remove the old behavior/); assert.match(retained.text, /Retained original result/);
  await assert.rejects(tool.call({ turnId: foreign.id }, signal()), /does not belong/);
  await assert.rejects(tool.call({ sessionId: 'other-session' }, signal()), /Invalid history/);
});
test('only accepted explicit resume of a stopped prior turn carries a matching recovery receipt', async t => {
  const directory = await scratch(t), journal = new WorkerInteractionJournal(directory); await journal.init(); t.after(() => journal.close());
  const turn = journal.accept({ sessionId: binding.logicalSessionId, operationId: 'first', kind: 'message', input: 'Work' }).turn;
  const dispatch = prepareModelRequest(model(), messages(2)); journal.prepare(binding.logicalSessionId, turn.id, dispatch, 'run'); journal.start(binding.logicalSessionId, turn.id); journal.fail(binding.logicalSessionId, turn.id, 'failed', 'timeout');
  const view = journal.view(binding.logicalSessionId), resumed = journal.accept({ sessionId: binding.logicalSessionId, operationId: 'resume-op', kind: 'resume', input: '', expectedRevision: view.revision, priorTurnId: turn.id }).turn;
  const request = withSessionRecovery(dispatch, resumed, journal.turn(binding.logicalSessionId, turn.id), 'resume-op');
  assert.equal(request.sessionRecovery.priorDispatchDigest, sessionDigest(dispatch)); assert.equal(request.sessionRecovery.operationId, 'resume-op');
  assert.equal(withSessionRecovery(dispatch, { ...resumed, kind: 'answer' }, journal.turn(binding.logicalSessionId, turn.id)).sessionRecovery, undefined);
});
