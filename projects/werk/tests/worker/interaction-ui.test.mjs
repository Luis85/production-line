import { normalizeSource } from '../helpers/source-text.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { reactive, ref, computed, watch, nextTick, effectScope } from 'vue';
import { deferred } from '../ui/helpers/frontend-loader.mjs';
const checkpoint = (sessionId = 'task-A', revision = 1) => ({ schemaVersion: 1, sessionId, revision, phase: 'waiting_input', pending: { id: 'question-1', kind: 'question', message: 'Which retry budget?', createdAt: '2026-10-14T16:15:00Z', turnId: 'turn-1' }, latestTurn: { id: 'turn-1', kind: 'message', status: 'waiting_input', finishedAt: null }, turns: [], totalTurns: 1 });
async function fixture(t, request) {
  const source = normalizeSource(await readFile(new URL('../../src/worker/webview/components/InteractionPanel.vue', import.meta.url), 'utf8'));
  const script = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n').replace(/^import .*;\n/gm, '');
  const state = reactive({ unlocked: true, draftEpoch: 0, sessions: { selected: 'task-A' }, lastRead: '', refreshRevision: 0 });
  const changes = [], scope = effectScope(); let operation = 0; t.after(() => scope.stop());
  const ports = { reactive, ref, computed, watch, watchPrivateDrafts: watch, nextTick, workerState: state, state, request, refresh: async () => {}, defineProps: () => ({}), defineEmits: () => (name, value) => changes.push({ name, value }), onMounted() {}, onActivated() {}, onDeactivated() {}, document: { getElementById: () => ({ focus() {} }) }, crypto: { randomUUID: () => 'operation-' + ++operation } };
  const f = scope.run(() => new Function(...Object.keys(ports), ts.transpile(script, { target: ts.ScriptTarget.ES2022 }) + '\nreturn { view, draft, submit, retryCommand, answerDrafts, operations, retry, load, lastTurn, error, readError, earlierDrafts, loading, reading, busy, mutationBlocked };')(...Object.values(ports)));
  f.view.value = checkpoint(); return { ...f, state, changes };
}
test('transport retry reuses the exact answer, checkpoint revision and operation ID', async t => {
  let failed = false, latest = checkpoint(); const calls = [];
  const f = await fixture(t, async (path, method, body) => { if (body.action === 'get') return latest; calls.push(JSON.parse(JSON.stringify(body))); if (!failed) { failed = true; throw Error('Connection reset'); } latest = { ...checkpoint(), revision: 2, phase: 'queued', pending: null }; return latest; });
  f.draft.value = 'Three attempts'; await f.submit(); await nextTick();
  assert.equal(f.draft.value, 'Three attempts'); assert.ok(f.retry.value);
  await f.retryCommand(); await nextTick();
  assert.deepEqual(calls[1], calls[0]); assert.equal(calls[0].answer, 'Three attempts'); assert.equal(calls[0].expectedRevision, 1); assert.equal(f.operations.size, 0);
});
test('revision conflict preserves the answer for explicit review without automatically resubmitting', async t => {
  let posts = 0;
  const f = await fixture(t, async (path, method, body) => { if (body.action === 'get') return checkpoint('task-A', 2); posts++; throw Object.assign(Error('Conflict'), { status: 409 }); });
  f.draft.value = 'Three attempts'; await f.submit(); await nextTick();
  assert.equal(posts, 1); assert.equal(f.draft.value, 'Three attempts'); assert.equal(f.operations.size, 0); assert.match(f.error.value, /checkpoint changed/); assert.equal(f.view.value.revision, 2);
});
test('access expiry retains checkpoint draft in private tab memory; explicit lock clears it', async t => {
  const f = await fixture(t, async () => checkpoint()); f.draft.value = 'Retained answer';
  f.state.unlocked = false; await nextTick(); assert.equal(f.view.value, null); assert.equal(f.answerDrafts.get('task-A:question-1'), 'Retained answer');
  f.state.unlocked = true; await nextTick(); await nextTick(); assert.equal(f.draft.value, 'Retained answer');
  f.state.draftEpoch++; await nextTick(); assert.equal(f.answerDrafts.size, 0); assert.equal(f.operations.size, 0);
});
test('late checkpoint reads cannot replace another selected task or expose prior turn usage', async t => {
  const { promise: pending, resolve: resolveA } = Promise.withResolvers();
  const f = await fixture(t, async (path, method, body) => body.sessionId === 'task-A' ? pending : checkpoint('task-B'));
  const first = f.load(); f.state.sessions.selected = 'task-B'; await nextTick(); await nextTick();
  resolveA(checkpoint('task-A')); await first; assert.equal(f.view.value.sessionId, 'task-B'); assert.equal(f.lastTurn.value, null);
});

test('a changed question keeps the old answer reachable without copying it into the new question', async t => {
  const newer = { ...checkpoint('task-A', 2), pending: { ...checkpoint().pending, id: 'question-2' } };
  const f = await fixture(t, async (path, method, body) => { if (body.action === 'get') return newer; throw Object.assign(Error('Conflict'), { status: 409 }); });
  f.draft.value = 'Answer to the earlier question'; await f.submit(); await nextTick();
  assert.equal(f.draft.value, ''); assert.equal(f.earlierDrafts.value[0].text, 'Answer to the earlier question');
});
test('new turn clears old consumption and successful checkpoint refresh clears a prior read error', async t => {
  let fail = true; const latest = { ...checkpoint(), phase: 'running', pending: null, latestTurn: { id: 'turn-2', status: 'running', finishedAt: null } };
  const f = await fixture(t, async () => { if (fail) throw Error('Temporarily unavailable'); return latest; });
  f.lastTurn.value = { id: 'turn-1', usage: { inputTokens: 100 } }; await f.load(); assert.match(f.readError.value, /Temporarily/);
  fail = false; await f.load(); assert.equal(f.readError.value, ''); assert.equal(f.lastTurn.value, null);
});
test('reopening a saved question reads state without answering or resuming it', async t => {
  const calls = []; const f = await fixture(t, async (path, method, body) => { calls.push(body.action); return checkpoint(); });
  await f.load(); assert.deepEqual(calls, ['get']); assert.equal(f.view.value.pending.id, 'question-1');
});


test('background checkpoint polls keep answer controls enabled and manual refresh shows its pending state', async t => {
  const pending = deferred(); const f = await fixture(t, async () => pending.promise);
  f.draft.value = 'Three attempts'; const read = f.load();
  assert.equal(f.reading.value, true); assert.equal(f.loading.value, false); assert.equal(f.mutationBlocked.value, false);
  await f.load(true); assert.equal(f.loading.value, true); assert.equal(f.mutationBlocked.value, true);
  pending.resolve(checkpoint()); await read;
  assert.equal(f.loading.value, false); assert.equal(f.reading.value, false); assert.equal(f.mutationBlocked.value, false); assert.equal(f.draft.value, 'Three attempts');
});
test('answer submission during a background read shows action progress and fences its late result', async t => {
  const poll = deferred(), saved = deferred(), calls = []; let reads = 0;
  const updated = { ...checkpoint('task-A', 2), phase: 'queued', pending: null };
  const f = await fixture(t, async (path, method, body) => {
    calls.push(body); if (body.action === 'get') return ++reads === 1 ? poll.promise : updated;
    return saved.promise;
  });
  f.draft.value = 'Three attempts'; const read = f.load(); const submit = f.submit();
  assert.equal(f.busy.value, true); assert.equal(f.loading.value, false); assert.equal(f.mutationBlocked.value, true);
  assert.equal(calls.at(-1).action, 'answer'); assert.equal(calls.at(-1).expectedRevision, 1);
  saved.resolve(updated); await submit; poll.resolve(checkpoint()); await read;
  assert.equal(f.view.value.revision, 2); assert.equal(f.view.value.pending, null); assert.equal(f.busy.value, false); assert.equal(f.operations.size, 0);
});
test('failed checkpoint revalidation keeps the answer draft and blocks new commands until recovery', async t => {
  let failed = true, commands = 0;
  const f = await fixture(t, async (path, method, body) => {
    if (body.action !== 'get') { commands++; return checkpoint(); }
    if (failed) throw Error('Offline'); return checkpoint();
  });
  f.draft.value = 'Three attempts'; await f.load(); assert.equal(f.mutationBlocked.value, true);
  await f.submit(); assert.equal(commands, 0); assert.equal(f.draft.value, 'Three attempts');
  failed = false; await f.load(); assert.equal(f.mutationBlocked.value, false); assert.equal(f.readError.value, '');
});
test('refresh revision revalidation is quiet even while the saved checkpoint is actionable', async t => {
  const pending = deferred(); let reads = 0;
  const f = await fixture(t, async () => { reads++; return pending.promise; });
  f.state.refreshRevision++; await nextTick();
  assert.equal(reads, 1); assert.equal(f.reading.value, true); assert.equal(f.loading.value, false); assert.equal(f.mutationBlocked.value, false);
  pending.resolve(checkpoint()); await nextTick(); await nextTick();
  assert.equal(f.loading.value, false);
});
