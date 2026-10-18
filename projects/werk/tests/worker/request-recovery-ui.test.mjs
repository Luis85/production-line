import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { reactive, ref, computed, watch, nextTick, effectScope } from 'vue';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { buildWorkerCapacityView } = await frontend('src/worker/webview/worker-capacity.ts');

async function fixture(t) {
  const source = await readFile(new URL('../../src/worker/webview/components/TaskInteraction.vue', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('interaction.ts', source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1], ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const script = ts.createPrinter().printFile(ts.factory.updateSourceFile(parsed, parsed.statements.filter(statement => !ts.isImportDeclaration(statement))));
  const reason = 'No file snapshots were accepted. Inspect the preserved worktree, then create a new request.';
  const state = reactive({ unlocked: true, workspaceBusy: false, draft: 'Retain my follow-up draft', actionError: '', settings: { providers: [] }, sessions: { selected: 'local-failed', execution: { currentSessionId: null }, records: [{ id: 'local-failed', title: 'Failed request', status: 'failed', provider: 'codex-cli', continuationBlockedReason: reason }, { id: 'normal', title: 'Normal request', status: 'completed', provider: 'codex-cli' }] }, board: { tasks: [{ id: 'failed', sessionId: 'local-failed', admissionFailure: { paths: ['src/a.ts'] }, error: reason, worktree: '/worktrees/preserved' }] }, chat: { available: true, busy: false, messages: [], phase: 'idle' } });
  const calls = [], focused = [], navigations = [];
  const ports = { reactive, ref, computed, watch, nextTick, state, useRouter: () => ({ push: async path => { navigations.push(path); } }), buildWorkerCapacityView, getCapacityFreshness: () => 'fresh', onActivated() {}, onDeactivated() {}, onBeforeUnmount() {}, defineEmits: () => () => {}, defineExpose() {}, chatAction: async action => calls.push(action), request: async () => ({}), workspaceAction: async (path, body) => { calls.push({ path, body }); return {}; }, document: { getElementById: id => ({ focus: () => focused.push(id), scrollIntoView() {} }) } };
  const javascript = ts.transpile(script, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const scope = effectScope(); t.after(() => scope.stop());
  const result = scope.run(() => new Function(...Object.keys(ports), javascript + '\nreturn { failedAdmission, available, act, mode, created, savedRequest, active, intakeBusy, openNewTask, focusConversation, focusControls };')(...Object.values(ports)));
  return { ...result, state, calls, focused, navigations, reason };
}

test('failed admission blocks ordinary follow-up while retaining its transcript selection and New request', async t => {
  const f = await fixture(t);
  assert.equal(f.failedAdmission.value.worktree, '/worktrees/preserved');
  assert.equal(f.available.value, false);
  await f.act('send'); assert.deepEqual(f.calls, []);
  await f.focusConversation(); assert.equal(f.mode.value, 'followup');
  await f.openNewTask(); assert.equal(f.mode.value, 'new');
  assert.equal(f.state.sessions.selected, 'local-failed');
  assert.equal(f.state.draft, 'Retain my follow-up draft');
});

test('removing file history cannot expose continuation for a permanently blocked request', async t => {
  const f = await fixture(t);
  f.state.board.tasks = [];
  assert.equal(f.failedAdmission.value.error, f.reason);
  assert.equal(f.failedAdmission.value.worktree, undefined);
  assert.equal(f.available.value, false);
  await f.act('send'); assert.deepEqual(f.calls, []);
  f.state.sessions.selected = 'normal'; await nextTick();
  assert.equal(f.failedAdmission.value, undefined); assert.equal(f.available.value, true);
  await f.act('send'); assert.deepEqual(f.calls, ['send']);
});

test('older sessions remain blocked from board admission evidence before the session marker is refreshed', async t => {
  const f = await fixture(t);
  delete f.state.sessions.records[0].continuationBlockedReason;
  assert.equal(f.failedAdmission.value.error, f.reason); assert.equal(f.available.value, false);
  await f.act('send'); assert.deepEqual(f.calls, []);
});


test('background completion keeps a newer task or tab selected and offers the saved request', async t => {
  const f = await fixture(t);
  f.state.sessions.selected = 'normal'; await nextTick();
  await f.created('local-prepared', 'local-failed');
  assert.equal(f.state.sessions.selected, 'normal'); assert.equal(f.mode.value, 'followup'); assert.equal(f.savedRequest.value, 'local-prepared'); assert.deepEqual(f.calls, []);
  f.mode.value = 'new'; f.state.workspaceBusy = true; await f.created('local-second', 'normal');
  assert.equal(f.savedRequest.value, 'local-second'); assert.deepEqual(f.calls, [], 'An in-flight selection must also win over preparation completion.');
  f.state.unlocked = false; assert.equal(f.savedRequest.value, '');
});
test('finished request opens automatically only while its original composer still has attention', async t => {
  const f = await fixture(t); await f.created('local-prepared', 'local-failed');
  assert.deepEqual(f.calls, [{ path: '/api/sessions', body: { action: 'select', id: 'local-prepared' } }]);
  assert.equal(f.mode.value, 'followup'); assert.equal(f.savedRequest.value, '');
});


test('recovery review opens the canonical request without selecting or continuing it', async t => {
  const f = await fixture(t);
  await f.focusControls();
  assert.deepEqual(f.navigations, ['/review?session=local-failed']);
  assert.equal(f.state.sessions.selected, 'local-failed');
  assert.deepEqual(f.calls, []);
  assert.equal(f.available.value, false, 'Inspection does not authorize continuation');
});
