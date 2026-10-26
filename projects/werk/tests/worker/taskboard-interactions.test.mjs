import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { reactive, ref, computed, watch, nextTick, effectScope } from 'vue';

async function fixture(t, name, ports = {}) {
  const modulePath = name.startsWith('components') ? 'components/useTaskboard.ts' : 'components/useTaskConversationHistory.ts';
  const source = await readFile(new URL(`../../src/worker/webview/${modulePath}`, import.meta.url), 'utf8');
  // Evaluate the composable body against explicit behavioral ports. Its production
  // imports are replaced here so races and session expiry remain deterministic.
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const composable = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text.startsWith('use'));
  assert.ok(composable && ts.isFunctionDeclaration(composable) && composable.body);
  const script = ts.createPrinter().printList(ts.ListFormat.MultiLine, ts.factory.createNodeArray(composable.body.statements.filter(statement => !ts.isReturnStatement(statement))), parsed);
  const state = reactive({ unlocked: true, draftEpoch: 0, workspaceBusy: false, actionError: '', settings: null, board: { tasks: [{ id: 'a', title: 'Alpha', provider: 'codex-cli', status: 'review', archived: false }, { id: 'b', title: 'Beta', provider: 'claude-cli', status: 'failed', archived: false }] }, sessions: { records: [] } });
  const route = reactive({ path: '/history', query: {} }), calls = [], navigations = [], focused = [];
  const request = ports.request ?? (async (path, method, body) => ({ ...state.board.tasks.find(task => task.id === body.id), sessionId: `local-${body.id}` }));
  const workspaceAction = async (path, body) => { calls.push({ path, body }); return ports.action ? ports.action(path, body) : {}; };
  const router = { push: async path => navigations.push(path) };
  const document = { getElementById: id => ({ focus: () => focused.push(id), scrollIntoView() {} }) };
  let deactivate, activate;
  const bindings = { options: {}, reactive, ref, computed, watch, nextTick, onActivated: callback => { activate = callback; }, onDeactivated: callback => { deactivate = callback; }, useRoute: () => route, useRouter: () => router, state, workspaceAction, request, document, taskStatus: value => value };
  const exposed = name.startsWith('components') ? 'inspect, closeDetail, readDetail, detail, selectedId, detailLoading, detailError, actionError, action, beginRemoval, removeWorktree, removing, worktreeNotice, openConversation, search, status, archived, visible, canRetry, canManage' : 'chatArchive, taskKind, chatTasks, chatStatus, clearChatFilters';
  const js = ts.transpile(script, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const scope = effectScope(); t.after(() => scope.stop());
  const result = scope.run(() => new Function(...Object.keys(bindings), `${js}\nreturn { ${exposed} };`)(...Object.values(bindings)));
  return { ...result, state, route, calls, navigations, focused, deactivate: () => deactivate?.(), activate: () => activate?.() };
}
const event = { currentTarget: { isConnected: true, focus() {} } };
const deferred = () => Promise.withResolvers();

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
  assert.deepEqual(f.calls[0], { path: '/api/sessions', body: { action: 'select', id: 'local-b' } }); assert.deepEqual(f.navigations, [{ path: '/request', query: { session: 'local-b' } }]);
});

test('History filters retained file and orchestrator sessions without selecting or restoring them', async t => {
  const f = await fixture(t, 'pages/HistoryPage.vue');
  f.state.sessions.records = ['chat', 'local', 'orchestrator'].map((kind, index) => ({ id: kind, taskId: kind, kind, title: kind, archived: index > 0, status: 'completed', createdAt: '2026-10-14T12:00:00Z' }));
  f.chatArchive.value = 'archived'; assert.deepEqual(f.chatTasks.value.map(task => task.id), ['local', 'orchestrator']);
  f.taskKind.value = 'local'; assert.deepEqual(f.chatTasks.value.map(task => task.id), ['local']);
  assert.equal(f.state.sessions.records[1].archived, true);
  f.activate(); await nextTick();
  assert.deepEqual(f.calls, [], 'Read-only filtering and activation cannot select or restore an archived request');
  assert.deepEqual(f.navigations, []);
  f.clearChatFilters(); assert.equal(f.chatTasks.value.length, 3);
  assert.equal(f.state.sessions.records[1].archived, true); assert.deepEqual(f.calls, []);
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


test('failed admission evidence stays inspectable but never retries its unaccepted file snapshot', async t => {
  const f = await fixture(t, 'components/Taskboard.vue');
  const task = f.state.board.tasks[1];
  Object.assign(task, { admissionFailure: { paths: ['src/main.ts'] }, error: 'Inspect the preserved worktree, then create a new request.', worktree: '/worktrees/retained', files: [] });
  await f.inspect('b', event);
  assert.equal(f.detail.value.worktree, '/worktrees/retained');
  await f.action({ id: 'b', action: 'retry' });
  assert.equal(f.calls.length, 0);
  // The detail receipt also guards a retry if a later summary no longer contains it.
  f.state.board.tasks = f.state.board.tasks.filter(item => item.id !== 'b');
  await f.action({ id: 'b', action: 'retry' });
  assert.equal(f.calls.length, 0);
  await f.openConversation();
  assert.equal(f.calls[0].body.id, 'local-b');
  assert.deepEqual(f.navigations, [{ path: '/request', query: { session: 'local-b' } }]);
});


test('each delete confirmation restores required cleanup and a refusal keeps the task open', async t => {
  const f = await fixture(t, 'components/Taskboard.vue', { action: async () => { f.state.actionError = 'Worktree contains uncommitted changes. Keep its worktree to delete only the task.'; return undefined; } });
  await f.inspect('a', event); f.beginRemoval(); assert.equal(f.removeWorktree.value, true);
  f.removeWorktree.value = false; f.removing.value = false; f.beginRemoval(); assert.equal(f.removeWorktree.value, true);
  await f.action({ id: 'a', action: 'delete', removeWorktree: true });
  assert.equal(f.removing.value, true); assert.equal(f.detail.value.id, 'a'); assert.match(f.actionError.value, /uncommitted changes/);
  f.removeWorktree.value = false; await f.inspect('b', event); f.beginRemoval(); assert.equal(f.removeWorktree.value, true);
});
test('lock and reopen cannot apply a late delete result to a new confirmation of the same task', async t => {
  const pending = deferred(), f = await fixture(t, 'components/Taskboard.vue', { action: () => pending.promise });
  await f.inspect('a', event); f.beginRemoval(); const deleting = f.action({ id: 'a', action: 'delete', removeWorktree: false });
  f.state.unlocked = false; f.state.draftEpoch++; assert.equal(f.removing.value, false); assert.equal(f.worktreeNotice.value, '');
  f.state.unlocked = true; await f.inspect('a', event); f.beginRemoval();
  pending.resolve({ worktree: { outcome: 'kept', reason: 'old private result' } }); await deleting;
  assert.equal(f.detail.value.id, 'a'); assert.equal(f.removing.value, true); assert.equal(f.worktreeNotice.value, '');
});


test('matching background refresh keeps controls stable and updates same-status evidence', async t => {
  let pending, reads = 0;
  const f = await fixture(t, 'components/Taskboard.vue', { request: async () => {
    reads++;
    return pending ? pending.promise : { id: 'a', title: 'Alpha', status: 'review', summary: 'Earlier result' };
  } });
  await f.inspect('a', event); f.activate(); await nextTick();
  pending = deferred(); f.state.refreshRevision = 1; await nextTick();
  assert.equal(f.detailLoading.value, false);
  assert.equal(f.detail.value.summary, 'Earlier result');
  f.state.refreshRevision = 2; await nextTick(); assert.equal(reads, 2);
  pending.resolve({ id: 'a', title: 'Alpha', status: 'review', summary: 'Current check result' });
  await nextTick(); await nextTick();
  assert.equal(f.detail.value.summary, 'Current check result');
});

test('history management respects shared checkpoint and pending-input boundaries', async t => {
  const f = await fixture(t, 'components/Taskboard.vue');
  await f.inspect('b', event);
  f.detail.value.feature = { source: 'shared_git' };
  assert.equal(f.canRetry.value, false);
  await f.action({ id: 'b', action: 'retry' }); assert.equal(f.calls.length, 0);
  f.detail.value.status = 'waiting_input';
  assert.equal(f.canManage.value, false);
  await f.action({ id: 'b', action: 'archive' });
  await f.action({ id: 'b', action: 'delete' }); assert.equal(f.calls.length, 0);
  f.detail.value.status = 'review'; assert.equal(f.canManage.value, true);
});
