import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions, LocalTaskboard } from './application-fixtures.mjs';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';
import { resultWith, workspaceFixture } from './contract-fixtures.mjs';
import { workspaceContext } from './runtime-fixtures.mjs';

const delay = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(done) {
  for (let n = 0; n < 400; n++) { if (done()) return; await delay(); }
  assert.fail('The deterministic worker operation did not settle.');
}
/** @param {import('node:test').TestContext} t
 * @param {() => Promise<void>} [beforeWorktree] */
async function fixture(t, beforeWorktree) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-selection-'))), repository = join(directory, 'repo');
  await mkdir(repository); await writeFile(join(repository, 'approved.txt'), 'before\n');
  const settings = new WorkerSettings(directory); await settings.init();
  await settings.update({ defaultProvider: 'openai-api', provider: { id: 'openai-api', model: 'initial-model', effort: 'medium', apiKey: 'fixture-only' }, board: { paused: true, queueCapacity: 8 } });
  /** @type {import('../../src/worker/application/model-contract.js').ModelRequest[]} */
  const calls = [];
  /** @type {import('../../src/worker/application/model-selection.js').ModelSelection[]} */
  const executed = [];
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const factory = connection => ({
    configuration: { id: connection.id, authenticationMode: connection.authenticationMode, model: connection.model, effort: connection.effort, instruction: connection.instruction ?? '' }, capabilities: modelCapabilities,
    async reply() { throw Error('Structured execution required.'); },
    async execute(request) {
      calls.push(request); executed.push({ provider: connection.id, authenticationMode: connection.authenticationMode, model: connection.model, effort: connection.effort ?? 'default' });
      return { type: 'completed', text: request.operation === 'patch' ? JSON.stringify({ summary: 'Proposed the accepted edit.', files: [{ path: 'approved.txt', content: 'after\n' }] }) : 'Reviewed the request.' };
    },
  });
  /** @type {import('../../src/worker/application/local-task-contracts.js').LocalTaskWorkspaces | undefined} */
  const workspaces = beforeWorktree ? { async prepareWorktree() { await beforeWorktree(); return { repository, path: repository }; } } : undefined;
  let sessions, board;
  async function open() { sessions = WorkerSessions(directory, settings, factory); await sessions.init(); board = LocalTaskboard(directory, settings, sessions, factory, workspaces); await board.init(); }
  async function close() { await board?.close(); await sessions?.close(); }
  await open(); t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, repository, settings, calls, executed, get sessions() { return sessions; }, get board() { return board; },
    input: { title: 'Implement selected feature', instruction: 'Update the approved text.', repository, paths: ['approved.txt'] },
    async restart(mutate = async () => {}) { await close(); await mutate(); await open(); },
    async settle(id) { await settings.update({ board: { paused: false } }); await board.tick(); await until(() => !sessions.busy && board.detail(id).status === 'review'); },
  };
}
const initial = { provider: 'openai-api', authenticationMode: 'api-key', model: 'initial-model', effort: 'medium' };

test('model defaults freeze before asynchronous worktree preparation and survive queued restart', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, async () => { entered.resolve(undefined); await release.promise; });
  const creating = f.board.create(f.input);
  try {
    await entered.promise;
    await f.settings.update({ defaultProvider: 'claude-cli', provider: { id: 'openai-api', model: 'later-model', effort: 'high' } });
  } finally { release.resolve(undefined); }
  await creating;
  const task = f.board.view().tasks.at(-1), dispatch = f.sessions.interactions.turn(task.sessionId, task.currentTurnId).dispatch;
  assert.deepEqual(task.selection, initial); assert.equal(task.provider, 'openai-api');
  assert.equal(dispatch.provider.model, 'initial-model'); assert.equal(dispatch.provider.effort, 'medium');
  await f.restart(); assert.equal(f.board.detail(task.id).status, 'queued'); assert.equal(f.calls.length, 0);
  await f.settle(task.id);
  assert.deepEqual(f.executed, [initial]); assert.deepEqual(f.calls, [dispatch]);
  await f.restart(); await f.board.tick(); assert.equal(f.calls.length, 1);
});

test('explicit model and default effort override a compatible profile and provider defaults for a file request', async t => {
  const f = await fixture(t);
  const { definitions: [profile] } = resultWith(await f.sessions.definitions.action({ action: 'import', name: 'Developer', yaml: 'agents:\n  root:\n    instruction: Preserve the reviewed scope.\n    model: openai/profile-model\n' }), 'definitions');
  await f.board.create({ ...f.input, definitionId: profile.id, model: 'explicit-model', effort: 'default' });
  const task = f.board.view().tasks.at(-1);
  assert.deepEqual(task.selection, { provider: 'openai-api', authenticationMode: 'api-key', model: 'explicit-model', effort: 'default' });
  assert.equal(task.definition.model, 'profile-model');
  await f.sessions.definitions.action({ action: 'delete', id: profile.id });
  await f.settings.update({ provider: { id: 'openai-api', model: 'replacement', effort: 'high' } });
  await f.restart(); await f.settle(task.id);
  assert.deepEqual(f.executed, [task.selection]);
  assert.match(f.calls[0].provider.instruction, /Preserve the reviewed scope/);
});

test('chat selection persists through provider reload, restart and subsequent messages', async t => {
  const f = await fixture(t);
  await f.sessions.action({ action: 'create', title: 'Discuss the feature', model: 'chat-model', effort: 'low' });
  const id = f.sessions.current.id, selection = { provider: 'openai-api', authenticationMode: 'api-key', model: 'chat-model', effort: 'low' };
  await f.settings.update({ board: { paused: false } });
  await f.sessions.start('Review the feature', id); await until(() => !f.sessions.busy);
  await f.sessions.updateProviders(() => f.settings.update({ provider: { id: 'openai-api', model: 'changed-default', effort: 'high' } }));
  await f.restart(); await f.sessions.start('Explain the next step', id); await until(() => !f.sessions.busy);
  assert.deepEqual(f.sessions.detail(id).session.selection, selection);
  assert.deepEqual(f.executed, [selection, selection]);
  assert.ok(f.calls.every(call => call.provider.model === 'chat-model' && call.provider.effort === 'low'));
});

test('legacy chat catalog recovers its accepted model from the journal instead of new defaults', async t => {
  const f = await fixture(t);
  await f.sessions.action({ action: 'create', title: 'Retain historical choice', provider: 'openai-api', model: 'historical-model', effort: 'default' });
  const id = f.sessions.current.id;
  await f.settings.update({ board: { paused: false } }); await f.sessions.start('Review the original request', id); await until(() => !f.sessions.busy);
  await f.settings.update({ provider: { id: 'openai-api', model: 'new-default', effort: 'high' } });
  await f.restart(async () => {
    const path = join(f.directory, 'sessions.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    delete saved.records.find(record => record.id === id).selection;
    await writeFile(path, JSON.stringify(saved));
  });
  await f.sessions.start('Continue the original discussion', id); await until(() => !f.sessions.busy);
  assert.deepEqual(f.sessions.detail(id).session.selection, { provider: 'openai-api', authenticationMode: 'api-key', model: 'historical-model', effort: 'default' });
  assert.equal(f.executed[1].model, 'historical-model'); assert.equal(f.executed[1].effort, 'default');
});

for (const mutation of ['delete', 'change']) test(`restart rejects ${mutation} of a file request's frozen selection before dispatch`, async t => {
  const f = await fixture(t); await f.board.create(f.input);
  await assert.rejects(f.restart(async () => {
    const path = join(f.directory, 'taskboard.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    if (mutation === 'delete') delete saved[0].selection; else saved[0].selection.effort = 'high';
    await writeFile(path, JSON.stringify(saved));
  }), /selection differs/);
  assert.equal(f.calls.length, 0);
});

test('unsupported effort is rejected before queue or worktree admission', async t => {
  let preparations = 0;
  const f = await fixture(t, async () => { preparations++; });
  await assert.rejects(f.board.create({ ...f.input, provider: 'cursor-cli', effort: 'high' }), /supported effort/);
  await assert.rejects(f.sessions.action({ action: 'create', title: 'Invalid effort', provider: 'cursor-cli', effort: 'high' }), /supported effort/);
  assert.equal(preparations, 0); assert.equal(f.board.view().tasks.length, 0); assert.equal(f.calls.length, 0);
});

test('identical webview intake replays its accepted defaults while explicit selection changes conflict', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-selection-intake-'))), workspace = await workspaceFixture(t, directory);
  await workspace.init(); t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  await workspace.updateSettings({ defaultProvider: 'openai-api', provider: { id: 'openai-api', model: 'accepted', effort: 'low', apiKey: 'fixture-only' }, board: { paused: true } });
  const command = { action: 'create', id: 'stable-model-intake', title: 'Plan a feature', message: 'Describe the accepted next step.' };
  const first = resultWith(await workspace.task(command), 'chat');
  // Simulate a changed durable configuration while the accepted queue remains paused.
  await workspaceContext(workspace).settings.update({ defaultProvider: 'claude-cli', provider: { id: 'openai-api', model: 'later', effort: 'high' } });
  const repeated = resultWith(await workspace.task(command), 'chat');
  assert.deepEqual(repeated.session.selection, first.session.selection);
  assert.equal(repeated.chat.messages.length, first.chat.messages.length);
  await assert.rejects(workspace.task({ ...command, effort: 'high' }), /different input/);
  await assert.rejects(workspace.task({ ...command, model: 'other' }), /different input/);
  await workspace.task({ action: 'cancel', id: command.id });
});
