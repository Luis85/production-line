import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { reactive, ref, computed, watch, nextTick, effectScope } from 'vue';

async function fixture(t, name, ports = {}) {
  const source = await readFile(new URL(`../../src/worker/webview/${name}`, import.meta.url), 'utf8');
  const scriptSource = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
  // Parse imports so formatted multiline and type-only imports are removed alike.
  // The component script then runs against the explicit behavioral ports below.
  const parsed = ts.createSourceFile('fixture.ts', scriptSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const script = ts.createPrinter().printFile(ts.factory.updateSourceFile(parsed, parsed.statements.filter(statement => !ts.isImportDeclaration(statement))));
  const state = reactive({ unlocked: true, workspaceBusy: false, actionError: '', settings: null, board: { tasks: [{ id: 'a', title: 'Alpha', provider: 'codex-cli', status: 'review', archived: false }, { id: 'b', title: 'Beta', provider: 'claude-cli', status: 'failed', archived: false }] }, sessions: { records: [] } });
  const route = reactive({ path: '/history', query: {} }), calls = [], navigations = [], focused = [];
  const request = ports.request ?? (async (path, method, body) => ({ ...state.board.tasks.find(task => task.id === body.id), sessionId: `local-${body.id}` }));
  const workspaceAction = async (path, body) => { calls.push({ path, body }); return ports.action ? ports.action(path, body) : {}; };
  const router = { push: async path => navigations.push(path) };
  const document = { getElementById: id => ({ focus: () => focused.push(id), scrollIntoView() {} }) };
  let deactivate, activate;
  const bindings = { reactive, ref, computed, watch, nextTick, onActivated: callback => { activate = callback; }, onDeactivated: callback => { deactivate = callback; }, useRoute: () => route, useRouter: () => router, state, workspaceAction, request, document, taskStatus: value => value };
  const exposed = name.startsWith('components') ? 'inspect, closeDetail, readDetail, detail, selectedId, detailLoading, detailError, actionError, action, openConversation, search, status, archived, visible' : 'chatArchive, taskKind, chatTasks, openChat, chatStatus, clearChatFilters';
  const js = ts.transpile(script, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const scope = effectScope(); t.after(() => scope.stop());
  const result = scope.run(() => new Function(...Object.keys(bindings), `${js}\nreturn { ${exposed} };`)(...Object.values(bindings)));
  return { ...result, state, route, calls, navigations, focused, deactivate: () => deactivate?.(), activate: () => activate?.() };
}
const event = { currentTarget: { isConnected: true, focus() {} } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('file evidence keeps the newest selected task when earlier reads arrive late, without refreshing the workspace', async t => {
  const a = deferred(), b = deferred(), reads = [];
  const f = await fixture(t, 'components/Taskboard.vue', { request: (path, method, body) => { reads.push({ path, method, body }); return body.id === 'a' ? a.promise : b.promise; } });
  const first = f.inspect('a', event), second = f.inspect('b', event);
  b.resolve({ id: 'b', title: 'Beta' }); await second;
  a.resolve({ id: 'a', title: 'Alpha' }); await first;
  assert.equal(f.detail.value.id, 'b'); assert.equal(f.selectedId.value, 'b');
  assert.equal(reads.length, 2); assert.ok(reads.every(read => read.path === '/api/taskboard/detail'));
  assert.equal(f.calls.length, 0); assert.equal(f.detailLoading.value, false);
});

test('closing evidence or expiring access prevents delayed reads from reopening private detail', async t => {
  let pending = deferred();
  const f = await fixture(t, 'components/Taskboard.vue', { request: () => pending.promise });
  const first = f.inspect('a', event); await f.closeDetail(); pending.resolve({ id: 'a' }); await first;
  assert.equal(f.detail.value, null); assert.equal(f.selectedId.value, '');
  pending = deferred(); const second = f.inspect('b', event);
  f.state.unlocked = false; f.state.unlocked = true;
  pending.resolve({ id: 'b' }); await second;
  assert.equal(f.detail.value, null); assert.equal(f.selectedId.value, ''); assert.equal(f.detailLoading.value, false);
});

test('evidence failures keep the selected task and offer a successful retry; refresh failures retain loaded evidence', async t => {
  let fail = true;
  const f = await fixture(t, 'components/Taskboard.vue', { request: async () => { if (fail) throw Error('Journal is unavailable'); return { id: 'a', title: 'Alpha' }; } });
  await f.inspect('a', event);
  assert.equal(f.selectedId.value, 'a'); assert.match(f.detailError.value, /Journal/); assert.equal(f.detailLoading.value, false);
  fail = false; await f.readDetail('a'); assert.equal(f.detail.value.title, 'Alpha'); assert.equal(f.detailError.value, '');
  fail = true; await f.readDetail('a'); assert.equal(f.detail.value.title, 'Alpha'); assert.match(f.detailError.value, /Journal/);
});

test('closing a detail during a mutation does not reopen it on acknowledgement', async t => {
  const pending = deferred();
  const f = await fixture(t, 'components/Taskboard.vue', { action: () => pending.promise });
  await f.inspect('a', event); const mutation = f.action({ id: 'a', action: 'archive' });
  await f.closeDetail(); pending.resolve({ tasks: [] }); await mutation;
  assert.equal(f.selectedId.value, ''); assert.equal(f.detail.value, null);
});

test('review and failure entry links reset stale file filters and file evidence opens its own session', async t => {
  const f = await fixture(t, 'components/Taskboard.vue');
  f.search.value = 'unrelated'; f.archived.value = true; f.route.query.fileState = 'review'; await nextTick();
  assert.deepEqual(f.visible.value.map(task => task.id), ['a']); assert.equal(f.search.value, ''); assert.equal(f.archived.value, false);
  f.route.query.fileState = 'failed'; await nextTick(); assert.deepEqual(f.visible.value.map(task => task.id), ['b']);
  await f.inspect('b', event); await f.openConversation();
  assert.deepEqual(f.calls[0], { path: '/api/sessions', body: { action: 'select', id: 'local-b' } }); assert.deepEqual(f.navigations, ['/chat']);
});

test('History recovers archived file and orchestrator sessions and filters by task kind', async t => {
  const f = await fixture(t, 'pages/HistoryPage.vue');
  f.state.sessions.records = ['chat', 'local', 'orchestrator'].map((kind, index) => ({ id: kind, taskId: kind, kind, title: kind, archived: index > 0, status: 'completed', createdAt: '2026-10-14T12:00:00Z' }));
  f.chatArchive.value = 'archived'; assert.deepEqual(f.chatTasks.value.map(task => task.id), ['local', 'orchestrator']);
  f.taskKind.value = 'local'; assert.deepEqual(f.chatTasks.value.map(task => task.id), ['local']);
  await f.openChat('local'); assert.deepEqual(f.calls[0], { path: '/api/sessions', body: { action: 'select', id: 'local' } });
  assert.deepEqual(f.navigations, ['/chat']);
  f.clearChatFilters(); assert.equal(f.chatTasks.value.length, 3);
});


test('failed-conversation links focus results on navigation and activation without competing with file results', async t => {
  const f = await fixture(t, 'pages/HistoryPage.vue');
  f.route.query.taskState = 'failed'; await nextTick(); await nextTick();
  assert.equal(f.chatStatus.value, 'failed'); assert.deepEqual(f.focused, ['chat-history-title']);
  f.focused.length = 0; f.activate(); await nextTick();
  assert.deepEqual(f.focused, ['chat-history-title']);
  f.focused.length = 0; f.route.query.fileState = 'review'; f.activate(); await nextTick();
  assert.deepEqual(f.focused, []);
  delete f.route.query.fileState; f.route.path = '/dashboard'; f.activate(); await nextTick();
  assert.deepEqual(f.focused, []);
  f.route.path = '/history'; f.route.query.taskState = 'all'; await nextTick(); await nextTick();
  assert.deepEqual(f.focused, []);
});
