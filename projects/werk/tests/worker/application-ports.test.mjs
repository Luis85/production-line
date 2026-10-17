import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { workerStatus } from '../helpers/worker-status.mjs';
import { sessionInstances } from './runtime-fixtures.mjs';
import { WorkerConversation } from '../../src/worker/dist/worker/application/conversation.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { WorkerRunJournal } from '../../src/worker/dist/worker/infrastructure/journal/local-runs.js';
import { WorkerInteractionJournal } from '../../src/worker/dist/worker/infrastructure/journal/interactions.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { WorkerSessions } from '../../src/worker/dist/worker/application/sessions.js';
import { LocalTaskboard } from '../../src/worker/dist/worker/application/local-tasks.js';
import { WorkerDefinitions } from '../../src/worker/dist/worker/application/definitions.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { httpStatus } from '../../src/worker/dist/shared/http/errors.js';

/** @returns {import('../../src/worker/application/workspace-ports.js').DefinitionStorage} */
function memoryStorage() {
  let value;
  return { async read() { return value; }, async write(next) { value = next; } };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-injected-ports-'));
  const catalog = memoryStorage(), definitions = new WorkerDefinitions(memoryStorage()), conversations = new Map(), modelCalls = [];
  /** @type {import('../../src/worker/application/workspace-ports.js').WorkerSettingsPort} */
  const settings = {
    value: { repositories: { items: [], pollMs: 30000 }, execution: { maxRuntimeMs: 1000, maxToolCalls: 8, commandTimeoutMs: 1000 }, board: { paused: false, maxParallel: 1, queueCapacity: 16, orchestratorQueue: 0, order: 'fifo' } },
    provider(id) { assert.ok(id === 'codex-cli' || id === 'openai-api'); return { id, executable: '', apiKey: '', model: 'fixture', instruction: '' }; },
    toolPolicy: defaultToolPolicy,
  };
  const journals = {
    requests: new WorkerRequestJournal(directory),
    interactions: new WorkerInteractionJournal(directory),
    runs: new WorkerRunJournal(directory),
  };
  const closeJournals = Object.values(journals).map(journal => journal.close.bind(journal));
  t.after(async () => { for (const close of closeJournals) close(); await rm(directory, { recursive: true, force: true }); });
  const storage = { ...catalog, async conversation(id) {
    if (!conversations.has(id)) conversations.set(id, { messages: [] });
    return { async read() { return structuredClone(conversations.get(id)); }, async write(value) { conversations.set(id, structuredClone(value)); } };
  } };
  const model = (connection, scope) => { modelCalls.push({ connection, scope }); return undefined; };
  const makeSessions = () => new WorkerSessions(settings, { ...journals, model, storage, definitions });
  return { settings, storage, conversations, journals, definitions, modelCalls, makeSessions };
}

test('definition policy commits through an injected store and retains prior state on write failure', async () => {
  const storage = memoryStorage(), definitions = new WorkerDefinitions(storage);
  await definitions.init();
  const write = storage.write, failure = Error('catalog write failed');
  storage.write = async () => { throw failure; };
  await assert.rejects(definitions.action({ action: 'import', name: 'Reviewer', yaml: 'agents:\n  root:\n    instruction: Review the supplied change.\n' }), error => error === failure);
  assert.deepEqual(definitions.view().definitions, []);
  storage.write = write;
  const saved = await definitions.action({ action: 'import', name: 'Reviewer', yaml: 'agents:\n  root:\n    instruction: Review the supplied change.\n' });
  const restored = new WorkerDefinitions(storage); await restored.init();
  assert.deepEqual(restored.view(), saved);
});

test('sessions use injected catalogs, transcripts and model scopes and roll back a rejected catalog commit', async t => {
  const f = await fixture(t), sessions = f.makeSessions(); await sessions.init();
  assert.equal(f.modelCalls[0].scope.sessionId, 'default');
  const write = f.storage.write, before = sessions.view(), failure = Error('session catalog write failed');
  f.storage.write = async () => { throw failure; };
  await assert.rejects(sessions.action({ action: 'create', title: 'Not committed', provider: 'openai-api' }), error => error === failure);
  assert.deepEqual(sessions.view(), before);
  f.storage.write = write;
  const created = await sessions.action({ action: 'create', title: 'Independent session', provider: 'openai-api' });
  assert.equal(f.modelCalls.at(-1).scope.sessionId, created.selected);
  await sessions.close();
  const restarted = f.makeSessions(); await restarted.init();
  assert.deepEqual(JSON.parse(JSON.stringify(restarted.view())), JSON.parse(JSON.stringify(created)));
  await restarted.close();
});

test('approved-file admission rejects invalid scope before file ports and preserves injected snapshots when readiness is held', async t => {
  const f = await fixture(t), sessions = f.makeSessions(); await sessions.init();
  const storage = { ...memoryStorage(), async writePatch() { throw Error('Held work cannot publish a patch'); } };
  let reads = 0;
  const root = resolve('virtual-repository');
  const board = new LocalTaskboard(f.settings, sessions, {
    model: () => ({ async reply() { throw Error('Readiness-held tasks cannot invoke a model'); } }), storage,
    files: { async identity() { throw Error('Plain folders have no worktree identity'); }, async snapshot(prepared, paths) { reads++; return { repository: prepared.repository, path: prepared.path, files: paths.map(path => ({ path, content: 'accepted input\n', existed: true })) }; } },
  });
  await board.init();
  const input = { title: 'Scoped request', instruction: 'Retain the accepted input for review.', provider: 'openai-api', repository: root, paths: ['a.txt'] };
  for (const paths of [[], ['../outside'], ['credentials.json'], ['a.txt', 'a.txt']]) {
    await assert.rejects(board.create({ ...input, paths }), error => testErrorCode(error) === 'invalid_input' && httpStatus(error) === 400);
  }
  await assert.rejects(board.create({ ...input, repository: 'relative-folder' }), error => testErrorCode(error) === 'invalid_input');
  assert.equal(reads, 0);
  // The injected gate refuses admission; inspecting model configuration must not execute it.
  const evaluate = f.journals.requests.evaluate.bind(f.journals.requests);
  f.journals.requests.evaluate = (...args) => ({ ...evaluate(...args), passed: false });
  const result = await board.create(input);
  assert.equal(reads, 1); assert.equal(result.tasks[0].status, 'needs_rework');
  const saved = JSON.parse(await storage.read());
  assert.equal(saved[0].files[0].content, 'accepted input\n');
  assert.equal(saved[0].repository, root); assert.equal(saved[0].patch, null);
  await board.close(); await sessions.close();
});

test('model composition is lazy and preserves readiness checks without tool grants', async t => {
  const settings = { ...(await fixture(t)).settings, toolPolicy() { throw Error('Constructing a model cannot acquire tool authority'); } };
  const calls = [];
  /** @type {import('../../src/worker/application/provider-contract.js').ProviderConnection} */
  const connection = { id: 'openai-api', executable: '', apiKey: 'private', model: 'fixture' };
  const factory = workspaceModelFactory(resolve('virtual-state'), settings, (saved, directory, transport, options) => { calls.push({ saved, directory, transport, options }); return { configuration: { ...saved, instruction: saved.instruction ?? '' }, capabilities: modelCapabilities, async execute() { throw Error('Model composition must not execute a provider.'); }, async reply() { throw Error('Model composition must not execute a provider.'); } }; });
  factory(connection);
  assert.equal(calls[0].options, undefined);
  factory(connection, { sessionId: 'session-a' });
  assert.equal(calls[1].directory, join(resolve('virtual-state'), 'sessions', 'session-a'));
  assert.equal(typeof calls[1].options.tools, 'function');
});

test('session close waits for every conversation before closing all journals after a failure', async t => {
  const f = await fixture(t), sessions = f.makeSessions(); await sessions.init();
  const events = [], failure = Error('conversation shutdown failed');
  /** @type {PromiseWithResolvers<void>} */
  const { promise: pending, resolve: release } = Promise.withResolvers();
  const failed = new WorkerConversation({ async read() { return { messages: [] }; }, async write() {} });
  const slow = new WorkerConversation({ async read() { return { messages: [] }; }, async write() {} });
  failed.close = async () => { events.push('failed'); throw failure; };
  slow.close = async () => { events.push('slow'); await pending; events.push('drained'); };
  sessionInstances(sessions).set('failed', failed);
  sessionInstances(sessions).set('slow', slow);
  const close = Object.fromEntries(Object.entries(f.journals).map(([key, journal]) => [key, journal.close.bind(journal)]));
  f.journals.requests.close = () => { close.requests(); events.push('requests'); throw Error('journal failed'); };
  f.journals.runs.close = () => { close.runs(); events.push('runs'); };
  f.journals.interactions.close = () => { close.interactions(); events.push('interactions'); };
  const closing = sessions.close(); assert.equal(sessions.close(), closing);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['failed', 'slow']);
  release(); await assert.rejects(closing, error => error === failure);
  assert.deepEqual(events, ['failed', 'slow', 'drained', 'requests', 'runs', 'interactions']);
});

test('workspace shutdown preserves staged remote evidence and completes all cleanup after an intake failure', async t => {
  const events = [], failure = Error('intake shutdown failed');
  /** @type {PromiseWithResolvers<void>} */
  const { promise: trackingFlush, resolve: releaseTracking } = Promise.withResolvers();
  const directory = await mkdtemp(join(tmpdir(), 'werk-shutdown-ports-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64));
  const workspace = new WorkerWorkspace({ stateDir: join(directory, 'state'), pollMs: 1000, timeoutMs: 1000,
    features: { directory: join(directory, 'features'), provider: 'openai-api', pollMs: 1000 } }, journal, workerStatus);
  workspace.featureTracking.close = async () => { events.push('tracking'); await trackingFlush; events.push('tracking flushed'); return workspace.featureTracking.status(); };
  workspace.consumption.close = () => { events.push('consumption'); };
  workspace.features.stopIntake = async () => { events.push('intake'); throw failure; };
  workspace.features.close = async () => { events.push('feature evidence'); };
  workspace.sharedRuntime.close = async () => { events.push('shared'); };
  workspace.resources.close = async () => { events.push('resources'); };
  workspace.sessions.close = async options => { assert.equal(options.retainEvidence, true); events.push('sessions'); };
  workspace.sessions.runs.close = () => { events.push('runs'); throw Error('run close failed'); };
  workspace.sessions.interactions.close = () => { events.push('interactions'); };
  workspace.sessions.requests.close = () => { events.push('requests'); };
  const draining = workspace.close({ deferEvidence: true }); assert.equal(workspace.close({ deferEvidence: true }), draining);
  await assert.rejects(draining, error => error === failure);
  assert.deepEqual(events, ['intake', 'shared', 'sessions']);
  const evidence = workspace.closeEvidence(); assert.equal(workspace.closeEvidence(), evidence);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['intake', 'shared', 'sessions', 'feature evidence', 'resources', 'tracking'], 'Final Markdown flush must retain access to every journal until it settles.');
  releaseTracking();
  await assert.rejects(evidence, /run close failed/);
  assert.deepEqual(events, ['intake', 'shared', 'sessions', 'feature evidence', 'resources', 'tracking', 'tracking flushed', 'runs', 'interactions', 'requests', 'consumption']);
});
