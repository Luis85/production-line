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

function memoryStorage() {
  let value;
  return { async read() { return value; }, async write(next) { value = next; } };
}
function fixture() {
  const catalog = memoryStorage(), definitions = new WorkerDefinitions(memoryStorage()), conversations = new Map(), requests = new Map(), modelCalls = [];
  const settings = {
    value: { repositories: { items: [], pollMs: 30000 }, execution: { maxRuntimeMs: 1000 }, board: { paused: false, maxParallel: 1, queueCapacity: 16, orchestratorQueue: 0, order: 'fifo' } },
    provider(id) { assert.ok(['codex-cli', 'openai-api'].includes(id)); return { id, executable: '', apiKey: '', model: 'fixture', instruction: '' }; },
    toolPolicy: defaultToolPolicy,
  };
  const journals = {
    requests: {
      async init() {}, close() {},
      forSession(id) { return [...requests.values()].find(request => request.owner.sessionId === id); },
      forTurn() {}, hasActiveReview() { return false; },
      get(id) { return requests.get(id); },
      ensure(input) { const value = { ...input, id: input.owner.rootTurnId, revision: 1, inputRevision: 1, phase: 'readiness', execution: null }; requests.set(value.id, value); return value; },
      evaluate() { return { passed: false }; }, deleteSession() {},
    },
    interactions: {
      async init() {}, close() {}, retainSessions() {}, resultForRun() {}, deleteSession() {},
      view(sessionId) { return { schemaVersion: 1, sessionId, revision: 0, phase: 'idle', latestTurn: null, pending: null }; },
    },
    runs: { async init() {}, close() {} },
  };
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

test('sessions use injected catalogs, transcripts and model scopes and roll back a rejected catalog commit', async () => {
  const f = fixture(), sessions = f.makeSessions(); await sessions.init();
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

test('approved-file admission rejects invalid scope before file ports and preserves injected snapshots when readiness is held', async () => {
  const f = fixture(), sessions = f.makeSessions(); await sessions.init();
  const storage = { ...memoryStorage(), async writePatch() { throw Error('Held work cannot publish a patch'); } };
  let reads = 0;
  const root = resolve('virtual-repository');
  const board = new LocalTaskboard(f.settings, sessions, {
    model: () => { throw Error('Readiness-held tasks cannot invoke a model'); }, storage,
    files: { async identity() { throw Error('Plain folders have no worktree identity'); }, async snapshot(prepared, paths) { reads++; return { repository: prepared.repository, path: prepared.path, files: paths.map(path => ({ path, content: 'accepted input\n', existed: true })) }; } },
  });
  await board.init();
  const input = { title: 'Scoped request', instruction: 'Retain the accepted input for review.', provider: 'openai-api', repository: root, paths: ['a.txt'] };
  for (const paths of [[], ['../outside'], ['credentials.json'], ['a.txt', 'a.txt']]) {
    await assert.rejects(board.create({ ...input, paths }), error => error.code === 'invalid_input' && httpStatus(error) === 400);
  }
  await assert.rejects(board.create({ ...input, repository: 'relative-folder' }), error => error.code === 'invalid_input');
  assert.equal(reads, 0);
  // A configuration inspection may occur before readiness; it must never execute the returned model.
  board.model = () => ({ async reply() { throw Error('Held work must not execute'); } });
  const result = await board.create(input);
  assert.equal(reads, 1); assert.equal(result.tasks[0].status, 'needs_rework');
  const saved = JSON.parse(await storage.read());
  assert.equal(saved[0].files[0].content, 'accepted input\n');
  assert.equal(saved[0].repository, root); assert.equal(saved[0].patch, null);
  await board.close(); await sessions.close();
});

test('model composition is lazy and preserves readiness checks without tool grants', () => {
  const settings = { toolPolicy() { throw Error('Constructing a model cannot acquire tool authority'); } };
  const calls = [], connection = { id: 'openai-api', executable: '', apiKey: 'private', model: 'fixture' };
  const factory = workspaceModelFactory(resolve('virtual-state'), settings, (saved, directory, transport, options) => { calls.push({ saved, directory, transport, options }); return { configuration: saved }; });
  factory(connection);
  assert.equal(calls[0].options, undefined);
  factory(connection, { sessionId: 'session-a' });
  assert.equal(calls[1].directory, join(resolve('virtual-state'), 'sessions', 'session-a'));
  assert.equal(typeof calls[1].options.tools, 'function');
});

test('session close waits for every conversation before closing all journals after a failure', async () => {
  const f = fixture(), sessions = f.makeSessions(); await sessions.init();
  const events = [], failure = Error('conversation shutdown failed');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  sessions.instances.set('failed', { async close() { events.push('failed'); throw failure; } });
  sessions.instances.set('slow', { async close() { events.push('slow'); await pending; events.push('drained'); } });
  f.journals.requests.close = () => { events.push('requests'); throw Error('journal failed'); };
  f.journals.runs.close = () => { events.push('runs'); };
  f.journals.interactions.close = () => { events.push('interactions'); };
  const closing = sessions.close(); assert.equal(sessions.close(), closing);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['failed', 'slow']);
  release(); await assert.rejects(closing, error => error === failure);
  assert.deepEqual(events, ['failed', 'slow', 'drained', 'requests', 'runs', 'interactions']);
});

test('workspace shutdown preserves staged remote evidence and completes all cleanup after an intake failure', async () => {
  const events = [], failure = Error('intake shutdown failed');
  let releaseTracking;
  const trackingFlush = new Promise(resolve => { releaseTracking = resolve; });
  const workspace = Object.create(WorkerWorkspace.prototype);
  Object.assign(workspace, {
    repositoryStop: new AbortController(), taskRequests: Promise.resolve(),
    featureTracking: { async close() { events.push('tracking'); await trackingFlush; events.push('tracking flushed'); } },
    consumption: { close() { events.push('consumption'); } },
    features: { async stopIntake() { events.push('intake'); throw failure; }, async close() { events.push('feature evidence'); } },
    sharedRuntime: { async close() { events.push('shared'); } }, providerAccounts: { async close() {} }, providerStatuses: { async close() {} },
    repositories: { async close() {} }, board: { async close() {} }, reviews: { async close() {} }, resources: { async close() { events.push('resources'); } },
    sessions: { async close(options) { assert.equal(options.retainEvidence, true); events.push('sessions'); },
      runs: { close() { events.push('runs'); throw Error('run close failed'); } }, interactions: { close() { events.push('interactions'); } }, requests: { close() { events.push('requests'); } } },
  });
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
