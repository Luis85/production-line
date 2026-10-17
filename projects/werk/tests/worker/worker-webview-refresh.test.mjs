import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFrontend } from '../ui/helpers/frontend-loader.mjs';

async function store(t) {
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; });
  return freshFrontend('src/worker/webview/store.ts');
}
function payloads() {
  return {
    '/status': { state: 'standalone', updatedAt: '2026-10-14T12:00:00.000Z' },
    '/monitoring': { alerts: [] }, '/api/environment': { fixture: 'environment' },
    '/api/history': { rows: [{ id: 'fresh-history' }] },
    '/api/chat/session': { sessions: { selected: 'fresh-session', records: [] }, chat: { messages: [{ text: 'Fresh answer' }], busy: false } },
    '/api/settings': { providers: [] }, '/api/taskboard': { tasks: [] },
    '/api/definitions': { definitions: [{ id: 'fresh-definition' }] },
  };
}
const response = (data, status = 200) => Response.json(data ?? null, { status });
test('failed optional history read preserves history while adopting healthy chat and status, then recovers', async t => {
  const { state, refresh } = await store(t), data = payloads();
  state.unlocked = true; state.history = { rows: [{ id: 'previous-history' }] }; state.lastRead = 'previous-read';
  globalThis.fetch = async path => path === '/api/history' ? response({ error: 'History unavailable' }, 500) : response(data[path]);
  await refresh();
  assert.equal(state.status.updatedAt, data['/status'].updatedAt);
  assert.equal(state.chat.messages[0].text, 'Fresh answer');
  assert.equal(state.sessions.selected, 'fresh-session');
  assert.equal(state.history.rows[0].id, 'previous-history');
  assert.equal(state.error, ''); assert.match(state.partialError, /History.*stale/);
  assert.equal(state.lastRead, 'previous-read'); assert.equal(state.loading, false);
  assert.equal(state.refreshRevision, 1, 'Independent panels observe a completed partial refresh');
  globalThis.fetch = async path => response(data[path]); await refresh();
  assert.equal(state.history.rows[0].id, 'fresh-history');
  assert.equal(state.partialError, ''); assert.notEqual(state.lastRead, 'previous-read');
  assert.equal(state.refreshRevision, 2);
});
test('expired access prevents late successful refresh responses from restoring private data', async t => {
  const { state, refresh } = await store(t), data = payloads(), pending = new Map();
  state.unlocked = true; state.sessions = { selected: 'old-session', records: [] }; state.draft = 'Unsent message';
  state.chat = { messages: [{ text: 'Private old answer' }] }; state.history = { rows: [{ id: 'old-history' }] };
  globalThis.fetch = path => new Promise(resolve => pending.set(path, resolve));
  const read = refresh();
  pending.get('/api/settings')(response({ error: 'Expired access' }, 401));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.unlocked, false); assert.equal(state.chat, null);
  for (const [path, resolve] of pending) if (path !== '/api/settings') resolve(response(data[path]));
  await read;
  assert.equal(state.unlocked, false); assert.equal(state.chat, null); assert.equal(state.sessions, null);
  assert.equal(state.environment, null); assert.equal(state.history, null); assert.equal(state.settings, null);
  assert.equal(state.board, null); assert.deepEqual([...state.definitions], []);
  assert.equal(state.draft, 'Unsent message'); assert.match(state.accessMessage, /expired/);
  assert.equal(state.refreshRevision, 0, 'A discarded access epoch never announces fresh data');
  assert.equal(state.loading, false);
});

function deferred() {
  /** @type {PromiseWithResolvers<Response>} */
  const pending = Promise.withResolvers();
  return pending;
}
test('accepted file task remains acknowledged when selecting another task during submission', async t => {
  const { state, workspaceAction } = await store(t), data = payloads(), admission = deferred();
  state.unlocked = true; state.sessions = { selected: 'previous-session', records: [] };
  const accepted = { tasks: [{ id: 'accepted-file-task' }] };
  globalThis.fetch = async (path, options) => {
    if (path === '/api/taskboard' && options.method === 'POST') return admission.promise;
    return response(data[path] ?? {});
  };
  const submission = workspaceAction('/api/taskboard', { title: 'Accepted file task' });
  await workspaceAction('/api/sessions', { action: 'select', id: 'fresh-session' });
  data['/api/taskboard'] = accepted; admission.resolve(response(accepted));
  assert.deepEqual(await submission, accepted);
  assert.equal(state.sessions.selected, 'fresh-session');
  assert.equal(state.actionError, '');
});
test('saved session action is acknowledged when the follow-up conversation read fails', async t => {
  const { state, workspaceAction } = await store(t), data = payloads();
  state.unlocked = true;
  const accepted = { selected: 'created-session', records: [] };
  globalThis.fetch = async path => path === '/api/sessions' ? response(accepted)
    : path === '/api/chat/session' ? response({ error: 'Read unavailable' }, 500) : response(data[path]);
  assert.deepEqual(await workspaceAction('/api/sessions', { action: 'create' }), accepted);
  assert.equal(state.actionError, '');
  assert.match(state.partialError, /conversation/i);
});
test('accepted chat clears its submitted draft after an unrelated settings mutation', async t => {
  const { state, chatAction, workspaceAction } = await store(t), data = payloads(), admission = deferred();
  state.unlocked = true; state.sessions = data['/api/chat/session'].sessions; state.draft = 'Send exactly once';
  globalThis.fetch = async path => path === '/api/chat' ? admission.promise : response(data[path] ?? {});
  const sending = chatAction('send');
  await workspaceAction('/api/settings', { board: { paused: true } });
  admission.resolve(response({ messages: [{ text: 'Send exactly once' }], busy: true }));
  await sending;
  assert.equal(state.draft, ''); assert.equal(state.actionError, '');
});
test('late admitted mutation cannot return private data or restore drafts after explicit lock', async t => {
  const { state, workspaceAction, lock } = await store(t), admission = deferred();
  state.unlocked = true; state.sessions = { selected: 'private-session', records: [] }; state.draft = 'Clear me';
  globalThis.fetch = async path => path === '/api/taskboard' ? admission.promise : response({});
  const submitting = workspaceAction('/api/taskboard', { instruction: 'Private instruction' });
  await lock();
  admission.resolve(response({ tasks: [{ instruction: 'Private instruction' }] }));
  assert.equal(await submitting, undefined);
  assert.equal(state.unlocked, false); assert.equal(state.board, null); assert.equal(state.draft, '');
  assert.equal(state.draftEpoch, 1);
});

test('an expired request from an older access lifetime cannot relock a newly unlocked browser', async t => {
  const { state, request, unlock } = await store(t), data = payloads(), oldRead = deferred();
  state.unlocked = true;
  globalThis.fetch = async path => path === '/api/old-read' ? oldRead.promise : response(data[path] ?? {});
  const obsolete = request('/api/old-read');
  await unlock('new-access');
  oldRead.resolve(response({ error: 'Old access expired' }, 401));
  await assert.rejects(obsolete, /Old access expired/);
  assert.equal(state.unlocked, true);
  assert.equal(state.sessions.selected, 'fresh-session');
});


test('non-JSON expired access clears private projections and preserves the unsent draft', async t => {
  const { state, request } = await store(t);
  state.unlocked = true;
  state.sessions = { selected: 'private-session', records: [] };
  state.chat = { messages: [{ text: 'Private answer' }] };
  state.settings = { providers: [] };
  state.board = { tasks: [{ id: 'private-task' }] };
  state.history = { rows: [{ id: 'private-history' }] };
  state.draft = 'Keep this unsent message';
  globalThis.fetch = async () => new Response('Access expired', { status: 401 });
  await assert.rejects(request('/api/taskboard'), error => error instanceof Error && 'status' in error && error.status === 401);
  assert.equal(state.unlocked, false);
  for (const key of ['sessions', 'chat', 'settings', 'board', 'history']) assert.equal(state[key], null);
  assert.equal(state.draft, 'Keep this unsent message');
  assert.equal(state.draftEpoch, 0);
  assert.match(state.accessMessage, /Unlock/);
});

test('a non-JSON 401 from an older access lifetime leaves the new private session intact', async t => {
  const { state, request, unlock } = await store(t), data = payloads(), oldRead = deferred();
  state.unlocked = true;
  globalThis.fetch = async path => path === '/api/old-read' ? oldRead.promise : response(data[path] ?? {});
  const obsolete = request('/api/old-read');
  await unlock('new-access');
  oldRead.resolve(new Response('Expired old access', { status: 401 }));
  await assert.rejects(obsolete, error => error instanceof Error && 'status' in error && error.status === 401);
  assert.equal(state.unlocked, true);
  assert.equal(state.sessions.selected, 'fresh-session');
  assert.equal(state.chat.messages[0].text, 'Fresh answer');
});

test('profile acknowledgement survives unrelated mutations and a held prewrite refresh', async t => {
  const { state, executionProfilesAction, workspaceAction, refresh } = await store(t), data = payloads(), admission = deferred(), heldRead = deferred();
  state.unlocked = true; const old = { configurationHash: 'old', profiles: [{ id: 'old' }] }, accepted = { configurationHash: 'new', profiles: [{ id: 'new' }] };
  data['/api/execution-profiles'] = old; state.executionProfiles = old;
  let hold = false;
  globalThis.fetch = async (path, options) => {
    if (path === '/api/execution-profiles' && options.method === 'POST') return admission.promise;
    if (path === '/api/execution-profiles' && hold) return heldRead.promise;
    return response(data[path] ?? {});
  };
  const saving = executionProfilesAction({ expectedConfigurationHash: 'old', profiles: accepted.profiles });
  await workspaceAction('/api/settings', { board: { paused: true } });
  hold = true; const reading = refresh(); admission.resolve(response(accepted));
  assert.deepEqual(await saving, accepted); assert.equal(state.executionProfiles.configurationHash, 'new');
  heldRead.resolve(response(old)); await reading; assert.equal(state.executionProfiles.configurationHash, 'new');
});
test('profile conflicts remain explicit and late profile writes cannot restore data after Lock', async t => {
  const { state, executionProfilesAction, lock } = await store(t); state.unlocked = true;
  globalThis.fetch = async () => response({ error: 'Profiles changed' }, 409);
  await assert.rejects(executionProfilesAction({ expectedConfigurationHash: 'old', profiles: [] }), error => error instanceof Error && 'status' in error && error.status === 409);
  const admission = deferred(); globalThis.fetch = async path => path === '/api/execution-profiles' ? admission.promise : response({});
  const saving = executionProfilesAction({ expectedConfigurationHash: 'old', profiles: [] });
  await lock(); admission.resolve(response({ configurationHash: 'late', profiles: [{ id: 'private' }] }));
  assert.equal(await saving, undefined); assert.equal(state.executionProfiles, null);
});


test('tool grants acknowledge exact save despite a held older refresh and clear on access expiry', async t => {
  const { state, refresh, toolAccessAction, request } = await store(t), data = payloads(), pending = new Map();
  const old = { schemaVersion: 1, revision: 0, builtins: { files: false, commands: [], webOrigins: [] }, mcp: [], canEdit: true, saveBlockedReason: null };
  const saved = { ...old, revision: 1, builtins: { ...old.builtins, files: true } };
  state.unlocked = true; state.toolAccess = old;
  globalThis.fetch = (path, options) => options.method === 'POST' && path === '/api/tool-access' ? Promise.resolve(response(saved)) : new Promise(resolve => pending.set(path, resolve));
  const reading = refresh();
  assert.deepEqual(await toolAccessAction({ expectedRevision: 0, builtins: saved.builtins, mcp: [] }), saved);
  for (const [path, resolve] of pending) resolve(response(path === '/api/tool-access' ? old : data[path]));
  await reading; assert.equal(state.toolAccess.revision, 1); assert.equal(state.toolAccess.builtins.files, true);
  globalThis.fetch = async () => response({ error: 'Expired' }, 401); await assert.rejects(request('/api/tool-access'));
  assert.equal(state.toolAccess, null); assert.equal(state.unlocked, false);
});
test('tool discovery conflicts remain visible and late discovery cannot repopulate locked state', async t => {
  const { state, toolAccessDiscover, lock } = await store(t); state.unlocked = true;
  globalThis.fetch = async () => response({ error: 'Tool access changed' }, 409);
  await assert.rejects(toolAccessDiscover({ expectedRevision: 0, id: 'docs' }), error => error instanceof Error && 'status' in error && error.status === 409);
  const pending = deferred(); globalThis.fetch = async path => path === '/api/tool-access/discover' ? pending.promise : response({});
  const discovering = toolAccessDiscover({ expectedRevision: 0, id: 'docs' }); await lock(); pending.resolve(response({ revision: 1, mcp: [{ id: 'private' }] }));
  assert.equal(await discovering, undefined); assert.equal(state.toolAccess, null);
});


test('capacity freshness follows task reads independently of optional history and paused updates', async t => {
  const { state, refresh, getCapacityFreshness } = await store(t), data = payloads();
  state.unlocked = true;
  data['/api/chat/session'].sessions.capacity = { schemaVersion: 1 };
  globalThis.fetch = async path => path === '/api/history' ? response({ error: 'History unavailable' }, 500) : response(data[path]);
  await refresh();
  assert.equal(getCapacityFreshness(), 'fresh');
  assert.ok(state.sessionsReadAt);
  state.paused = true; assert.equal(getCapacityFreshness(), 'stale'); state.paused = false;
  const previousRead = state.sessionsReadAt;
  globalThis.fetch = async path => path === '/api/chat/session' ? response({ error: 'Task state unavailable' }, 500) : response(data[path]);
  await refresh();
  assert.equal(state.sessionsReadAt, previousRead);
  assert.equal(getCapacityFreshness(), 'stale');
  globalThis.fetch = async path => response(data[path]); await refresh();
  assert.equal(getCapacityFreshness(), 'fresh');
  state.sessionsReadAt = '2020-01-01T00:00:00.000Z'; assert.equal(getCapacityFreshness(), 'stale');
});


test('scheduled refresh keeps action feedback quiet while explicit refresh has a pending state', async t => {
  const { state, refresh, refreshFromUser } = await store(t), data = payloads(), reads = [];
  state.unlocked = true;
  globalThis.fetch = path => new Promise(resolve => reads.push(() => resolve(response(data[path]))));
  const background = refresh();
  assert.equal(state.loading, true); assert.equal(state.refreshingManually, false);
  await refreshFromUser(); assert.equal(state.refreshingManually, false, 'A running background read is coalesced');
  reads.splice(0).forEach(resolve => resolve()); await background;
  const manual = refreshFromUser(); assert.equal(state.refreshingManually, true);
  reads.splice(0).forEach(resolve => resolve()); await manual;
  assert.equal(state.refreshingManually, false);
});
