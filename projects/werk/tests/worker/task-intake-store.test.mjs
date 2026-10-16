import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFrontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const command = () => ({ action: 'create', id: 'stable-operation', title: 'Review lifecycle', message: 'Review the lifecycle.', provider: 'codex-cli', definitionId: 'reviewer', agent: 'root', useInstructionsOnly: true });
async function fixture(t) {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const store = await freshFrontend('src/worker/webview/store.ts');
  const session = { id: 'stable-operation', title: 'Review lifecycle', provider: 'codex-cli', status: 'queued' };
  const detail = { session, chat: { messages: [{ role: 'user', text: 'Review the lifecycle.' }], phase: 'queued', busy: true, available: true }, featureTracking: { directory: '/project/features/_tasks', lastSyncedAt: null, error: null } };
  const calls = [];
  globalThis.fetch = async (path, init) => { calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }); return Response.json(path === '/api/tasks' ? detail : {}); };
  store.state.unlocked = true; store.state.loading = true; // Isolate admission acknowledgement from scheduled polling.
  store.state.sessions = { selected: 'previous', records: [{ id: 'previous', provider: 'codex-cli', title: 'Previous request' }] };
  store.state.draft = 'An unrelated follow-up';
  return { ...store, calls, detail };
}
test('unified request admission uses one exact command and never sends its first message separately', async t => {
  const f = await fixture(t), input = command();
  assert.deepEqual(await f.createFeatureRequest(input), f.detail);
  assert.deepEqual(f.calls, [{ path: '/api/tasks', method: 'POST', body: input }]);
  assert.equal(f.state.workspaceBusy, false); assert.equal(f.state.sessions.selected, 'previous'); assert.equal(f.state.draft, 'An unrelated follow-up');
});
test('file request acknowledgement uses the exact returned local session and accepts delayed Markdown projection', async t => {
  const f = await fixture(t); f.detail.session.id = 'local-stable-operation'; f.detail.featureTracking.error = 'Storage temporarily unavailable';
  const input = { ...command(), files: { repository: 'project', paths: ['README.md'] } };
  const result = await f.createFeatureRequest(input);
  assert.equal(result.session.id, 'local-stable-operation'); assert.match(result.featureTracking.error, /Storage/); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body.files, input.files);
});
test('explicit replay keeps the same operation and does not create or send to a second identity', async t => {
  const f = await fixture(t), input = command();
  await f.createFeatureRequest(input); await f.createFeatureRequest(input);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]); assert.ok(f.calls.every(call => call.path === '/api/tasks'));
});
test('concurrent submission is suppressed and the sent command is immutable', async t => {
  const f = await fixture(t), pending = deferred(), input = command();
  globalThis.fetch = async (path, init) => { f.calls.push({ path, body: JSON.parse(init.body) }); return pending.promise; };
  const submitting = f.createFeatureRequest(input); input.message = 'Changed after submit';
  assert.equal(await f.createFeatureRequest(command()), undefined); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.message, 'Review the lifecycle.');
  pending.resolve(Response.json(f.detail)); await submitting; assert.equal(f.state.workspaceBusy, false);
});
for (const status of [400, 409, 500]) test(`admission failure ${status} retains HTTP status without inventing a selected request`, async t => {
  const f = await fixture(t);
  globalThis.fetch = async () => Response.json({ error: 'Admission could not be confirmed' }, { status });
  await assert.rejects(f.createFeatureRequest(command()), error => error.status === status);
  assert.equal(f.state.sessions.selected, 'previous'); assert.equal(f.state.draft, 'An unrelated follow-up'); assert.equal(f.state.workspaceBusy, false);
});
test('unreadable success cannot be mistaken for an admitted request', async t => {
  const f = await fixture(t); globalThis.fetch = async () => Response.json({});
  await assert.rejects(f.createFeatureRequest(command()), /did not confirm/); assert.equal(f.state.sessions.selected, 'previous');
});
test('explicit lock during admission suppresses late private results and clears drafts', async t => {
  const f = await fixture(t), pending = deferred();
  globalThis.fetch = async path => path === '/api/tasks' ? pending.promise : Response.json({});
  const submitting = f.createFeatureRequest(command()); await f.lock(); pending.resolve(Response.json(f.detail));
  assert.equal(await submitting, undefined); assert.equal(f.state.unlocked, false); assert.equal(f.state.sessions, null); assert.equal(f.state.draft, ''); assert.equal(f.state.draftEpoch, 1);
});
test('access expiry suppresses delayed acknowledgement without clearing the unsent follow-up draft', async t => {
  const f = await fixture(t), pending = deferred();
  globalThis.fetch = async path => path === '/api/tasks' ? pending.promise : Response.json({ error: 'Expired' }, { status: 401 });
  const submitting = f.createFeatureRequest(command()); await assert.rejects(f.request('/api/probe'));
  pending.resolve(Response.json(f.detail)); assert.equal(await submitting, undefined);
  assert.equal(f.state.sessions, null); assert.equal(f.state.draft, 'An unrelated follow-up'); assert.equal(f.state.draftEpoch, 0);
});
test('lock during post-admission refresh also suppresses the returned private detail', async t => {
  const f = await fixture(t), held = []; f.state.loading = false;
  globalThis.fetch = async (path, init) => path === '/api/tasks' ? Response.json(f.detail) : path === '/api/access' ? Response.json({}) : new Promise(resolve => held.push(resolve));
  const submitting = f.createFeatureRequest(command());
  await new Promise(resolve => setImmediate(resolve)); assert.ok(held.length > 0);
  await f.lock(); for (const resolve of held) resolve(Response.json({}));
  assert.equal(await submitting, undefined); assert.equal(f.state.sessions, null); assert.equal(f.state.unlocked, false);
});

test('admission tracking error and record remain visible when all follow-up reads fail', async t => {
  const f = await fixture(t); f.state.loading = false;
  f.detail.featureTracking.error = 'Markdown directory is read-only';
  globalThis.fetch = async path => path === '/api/tasks' ? Response.json(f.detail) : Response.json({ error: 'Read unavailable' }, { status: 503 });
  const result = await f.createFeatureRequest(command());
  assert.equal(result.session.id, 'stable-operation'); assert.equal(f.state.sessions.selected, 'previous');
  assert.equal(f.state.sessions.featureTracking.error, 'Markdown directory is read-only');
  assert.ok(f.state.sessions.records.some(record => record.id === 'stable-operation')); assert.equal(f.state.draft, 'An unrelated follow-up');
});
