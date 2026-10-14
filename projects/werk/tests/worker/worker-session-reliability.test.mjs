import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from '../../src/worker/dist/worker/application/sessions.js';
import { LocalTaskboard } from '../../src/worker/dist/worker/application/local-tasks.js';
const model = () => ({ async reply() { return 'Saved answer'; } });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-session-reliability-'));
  const settings = new WorkerSettings(directory); await settings.init();
  const sessions = new WorkerSessions(directory, settings, model); await sessions.init();
  t.after(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, sessions };
}
test('failed session index deletion retains the transcript and selected task', async t => {
  const { directory, settings, sessions } = await fixture(t);
  await sessions.recordTask('default', 'Keep this request', 'Keep this answer');
  await sessions.action({ action: 'create', title: 'Another task', provider: 'codex-cli' });
  await sessions.action({ action: 'select', id: 'default' });
  const before = sessions.detail('default');
  await rename(join(directory, 'sessions.json'), join(directory, 'sessions-backup.json'));
  await mkdir(join(directory, 'sessions.json'));
  await assert.rejects(sessions.action({ action: 'delete', id: 'default' }));
  assert.equal(sessions.current.id, 'default');
  assert.deepEqual(sessions.detail('default'), before);
  await rm(join(directory, 'sessions.json'), { recursive: true });
  await rename(join(directory, 'sessions-backup.json'), join(directory, 'sessions.json'));
  const recovered = new WorkerSessions(directory, settings, model);
  await recovered.init(); t.after(() => recovered.close());
  assert.deepEqual(recovered.detail('default').chat.messages, before.chat.messages);
});
test('deletion releases cached conversations and failed creation leaves no cached orphan', async t => {
  const { directory, sessions } = await fixture(t);
  for (let n = 0; n < 3; n++) {
    await sessions.action({ action: 'create', title: 'Disposable task', provider: 'codex-cli' });
    const id = sessions.current.id;
    await sessions.action({ action: 'delete', id });
    assert.throws(() => sessions.detail(id), /not found/);
  }
  assert.equal(sessions.instances.size, sessions.view().records.length);
  await rename(join(directory, 'sessions.json'), join(directory, 'sessions-backup.json'));
  await mkdir(join(directory, 'sessions.json'));
  await assert.rejects(sessions.action({ action: 'create', title: 'Failed task', provider: 'codex-cli' }));
  assert.equal(sessions.instances.size, sessions.view().records.length);
});
test('concurrent feature submissions admit one durable task and reject conflicting content', async t => {
  const { directory, settings, sessions } = await fixture(t);
  const repository = join(directory, 'repo'); await mkdir(repository);
  const board = new LocalTaskboard(directory, settings, sessions, model); await board.init(); t.after(() => board.close());
  const input = { title: 'Create file', instruction: 'Create approved file', repository, paths: ['hello.txt'] };
  const submission = { id: 'feature-same', hash: 'a'.repeat(64) };
  await Promise.all([board.create(input, submission), board.create(input, submission)]);
  assert.equal(board.view().tasks.length, 1);
  const results = await Promise.allSettled([
    board.create(input, { id: 'feature-conflict', hash: 'b'.repeat(64) }),
    board.create(input, { id: 'feature-conflict', hash: 'c'.repeat(64) }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /different input/);
  const recovered = new LocalTaskboard(directory, settings, sessions, model); await recovered.init(); t.after(() => recovered.close());
  assert.equal(recovered.view().tasks.length, 2);
  assert.equal(new Set(recovered.view().tasks.map(task => task.id)).size, 2);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test('provider updates reserve admissions during settings persistence and deferred conversation reload', async t => {
  const { sessions } = await fixture(t);
  const { WorkerWorkspace } = await import('../../src/worker/dist/worker/status/workspace.js');
  const saving = deferred(), loading = deferred(), loadStarted = deferred();
  const originalLoad = sessions.load.bind(sessions), previousConversation = sessions.chat;
  sessions.load = async record => { loadStarted.resolve(); await loading.promise; return originalLoad(record); };
  const workspace = { sessions, board: { active: 0 }, settings: { update: async () => { await saving.promise; return { saved: true }; } } };
  const updating = WorkerWorkspace.prototype.updateSettings.call(workspace, { provider: { id: 'codex-cli' } });
  try {
    await assert.rejects(sessions.start('During settings write'), /settings are being saved/);
    await assert.rejects(sessions.ensureTask('blocked-task', 'chat', 'Blocked', 'codex-cli'), /settings are being saved/);
    saving.resolve(); await loadStarted.promise;
    await assert.rejects(sessions.start('During transcript reload'), /settings are being saved/);
    await assert.rejects(sessions.setTaskState('default', 'queued'), /settings are being saved/);
    assert.deepEqual(sessions.detail('default').chat.messages, []);
  } finally { saving.resolve(); loading.resolve(); await updating; }
  assert.equal(previousConversation.closed, true);
  await sessions.start('After provider update');
  await sessions.chat.pending;
  assert.equal(sessions.detail('default').chat.messages.at(-1).text, 'Saved answer');
  assert.equal(sessions.detail('default').chat.messages.at(-1).state, 'complete');
});
test('failed provider save releases admission and leaves the current conversation usable', async t => {
  const { sessions } = await fixture(t), original = sessions.chat;
  await assert.rejects(sessions.updateProviders(async () => { throw Error('Settings write failed'); }), /Settings write failed/);
  assert.equal(sessions.chat, original);
  await sessions.start('After failed save'); await sessions.chat.pending;
  assert.equal(sessions.detail('default').chat.messages.at(-1).state, 'complete');
});
