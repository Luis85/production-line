import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFrontend } from '../ui/helpers/frontend-loader.mjs';


const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return data; } });
const options = { provider: 'codex-cli', title: 'Review lifecycle', definitionId: 'reviewer', agent: 'root', useInstructionsOnly: true };
const instructions = 'Write acceptance criteria for the worker lifecycle.';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; });
  const store = await freshFrontend('src/worker/webview/store.ts');
  const previous = { selected: 'previous-task', records: [{ id: 'previous-task', title: 'Previous task', provider: 'codex-cli', status: 'completed' }] };
  const created = { selected: 'created-task', records: [...previous.records, { id: 'created-task', title: options.title, provider: options.provider, status: 'draft' }] };
  let sessions = previous, chat = { messages: [], available: true, busy: false, phase: 'idle' };
  const writes = [];
  const defaults = {
    '/status': { state: 'standalone', updatedAt: '2026-10-15T12:00:00.000Z' },
    '/monitoring': { alerts: [] }, '/api/environment': {}, '/api/history': { rows: [] },
    '/api/settings': { providers: [{ id: 'codex-cli', configured: true }] },
    '/api/taskboard': { tasks: [] }, '/api/definitions': { definitions: [] },
  };
  async function respond(path, init) {
    if (init.method === 'POST' && path !== '/api/access') writes.push({ path, body: JSON.parse(init.body) });
    if (path === '/api/sessions' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      sessions = body.action === 'select' ? { ...created, selected: body.id } : created;
      return response(sessions);
    }
    if (path === '/api/chat' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      chat = { messages: [{ role: 'user', text: body.message }], available: true, busy: true, phase: 'queued' };
      return response(chat);
    }
    if (path === '/api/chat/session') return response({ sessions, chat });
    return response(defaults[path] ?? {});
  }
  globalThis.fetch = respond;
  store.state.unlocked = true; store.state.sessions = previous;
  store.state.settings = defaults['/api/settings']; store.state.chat = chat;
  return { ...store, writes, created, respond, select: value => { sessions = value; } };
}
function assertLocked(state) {
  assert.equal(state.unlocked, false);
  for (const key of ['sessions', 'chat', 'settings', 'board', 'history', 'environment']) assert.equal(state[key], null, key);
  assert.deepEqual([...state.definitions], []);
  assert.equal(state.workspaceBusy, false);
}

test('new task creates one configured session then sends its first message to that returned ID', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.createTaskAndSend(options, instructions), { sessionId: 'created-task', queued: true });
  assert.deepEqual(f.writes, [
    { path: '/api/sessions', body: { action: 'create', ...options } },
    { path: '/api/chat', body: { sessionId: 'created-task', message: instructions } },
  ]);
  assert.equal(f.state.sessions.selected, 'created-task'); assert.equal(f.state.draft, '');
  assert.equal(f.state.chat.messages[0].text, instructions); assert.equal(f.state.workspaceBusy, false);
});

for (const status of [409, 500]) test(`first-message failure (${status}) retains the created draft for an explicit same-task retry`, async t => {
  const f = await fixture(t);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/chat') { f.writes.push({ path, body: JSON.parse(init.body) }); return response({ error: status === 409 ? 'Selection changed' : 'Admission unavailable' }, status); }
    return f.respond(path, init);
  };
  assert.deepEqual(await f.createTaskAndSend(options, instructions), { sessionId: 'created-task', queued: false });
  assert.equal(f.state.sessions.selected, 'created-task'); assert.equal(f.state.draft, instructions);
  assert.equal(f.state.chat.messages.length, 0); assert.equal(f.state.workspaceBusy, false);
  assert.match(f.state.actionError, /Task created.*not confirmed/);
  assert.equal(f.writes.filter(write => write.path === '/api/sessions').length, 1);
  globalThis.fetch = f.respond;
  await f.chatAction('send');
  assert.equal(f.writes.filter(write => write.path === '/api/sessions').length, 1);
  assert.deepEqual(f.writes.at(-1), { path: '/api/chat', body: { sessionId: 'created-task', message: instructions } });
  assert.equal(f.state.draft, '');
});

test('a selection conflict retains instructions with the created task without replacing another task draft', async t => {
  const f = await fixture(t);
  f.state.draft = 'Previous unsent follow-up';
  globalThis.fetch = async (path, init) => {
    if (path === '/api/chat') {
      f.writes.push({ path, body: JSON.parse(init.body) });
      f.select({ ...f.created, selected: 'previous-task' });
      return response({ error: 'Selection changed' }, 409);
    }
    return f.respond(path, init);
  };
  assert.deepEqual(await f.createTaskAndSend(options, instructions), { sessionId: 'created-task', queued: false });
  assert.equal(f.state.sessions.selected, 'previous-task'); assert.equal(f.state.draft, 'Previous unsent follow-up');
  assert.deepEqual(f.writes.at(-1), { path: '/api/chat', body: { sessionId: 'created-task', message: instructions } });
  globalThis.fetch = f.respond;
  await f.workspaceAction('/api/sessions', { action: 'select', id: 'created-task' });
  assert.equal(f.state.draft, instructions);
  assert.equal(f.writes.filter(write => write.path === '/api/chat').length, 1);
});

test('concurrent creation is suppressed while the first task is being admitted', async t => {
  const f = await fixture(t), admission = deferred();
  globalThis.fetch = async (path, init) => path === '/api/sessions' ? admission.promise : f.respond(path, init);
  const first = f.createTaskAndSend(options, instructions);
  assert.equal(f.state.workspaceBusy, true);
  assert.deepEqual(await f.createTaskAndSend({ title: 'Duplicate' }, 'Do not dispatch'), { queued: false });
  f.select(f.created); admission.resolve(response(f.created));
  assert.deepEqual(await first, { sessionId: 'created-task', queued: true });
  assert.deepEqual(f.writes, [{ path: '/api/chat', body: { sessionId: 'created-task', message: instructions } }]);
  assert.equal(f.state.workspaceBusy, false);
});

test('unconfirmed creation never dispatches a message or invents a selected session', async t => {
  const f = await fixture(t); let creates = 0;
  globalThis.fetch = async (path, init) => path === '/api/sessions'
    ? (creates++, response({ error: 'Storage unavailable' }, 500)) : f.respond(path, init);
  const outcome = await f.createTaskAndSend(options, instructions);
  assert.equal(outcome.queued, false); assert.equal(outcome.sessionId, undefined); assert.equal(creates, 1);
  assert.equal(f.writes.length, 0); assert.equal(f.state.sessions.selected, 'previous-task');
  assert.match(f.state.actionError, /Task creation was not confirmed.*Refresh/);
});

for (const phase of ['create', 'send']) test(`explicit lock during ${phase} prevents late acknowledgement restoring private task data`, async t => {
  const f = await fixture(t), admission = deferred();
  const heldPath = phase === 'create' ? '/api/sessions' : '/api/chat';
  globalThis.fetch = async (path, init) => path === heldPath ? admission.promise : f.respond(path, init);
  const submission = f.createTaskAndSend(options, instructions); await tick();
  await f.lock();
  admission.resolve(response(phase === 'create' ? f.created : { messages: [{ text: instructions }], busy: true }));
  assert.deepEqual(await submission, { queued: false });
  assertLocked(f.state); assert.equal(f.state.draft, ''); assert.equal(f.state.draftEpoch, 1);
  if (phase === 'create') assert.equal(f.writes.length, 0);
});

test('access expiry during send keeps the unsent tab draft without exposing late private results', async t => {
  const f = await fixture(t), admission = deferred();
  globalThis.fetch = async (path, init) => path === '/api/chat' ? admission.promise
    : path === '/api/expiry-probe' ? new Response('Session expired', { status: 401 }) : f.respond(path, init);
  const submission = f.createTaskAndSend(options, instructions); await tick();
  await assert.rejects(f.request('/api/expiry-probe'), error => error.status === 401);
  admission.resolve(response({ messages: [{ text: 'Private accepted result' }], busy: true }));
  assert.deepEqual(await submission, { queued: false });
  assertLocked(f.state); assert.equal(f.state.draft, instructions); assert.equal(f.state.draftEpoch, 0);
  assert.match(f.state.accessMessage, /expired/);
});
