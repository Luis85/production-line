import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick } from 'vue';
import { frontend, deferred } from '../helpers/frontend-loader.mjs';
const store = await frontend('src/worker/webview/store.ts');
const { useRepositoryDiscovery } = await frontend('src/worker/webview/repository-discovery.ts');
const candidate = { id: 'a'.repeat(64), path: '/projects/web', currentBranch: 'main', remote: 'origin', watch: true, decision: 'pending' };
const assigned = { id: 'web', path: '/projects/web', remote: 'origin', watch: true, state: 'pending' };
function setup(t, handler = async () => undefined) {
  store.state.unlocked = false;
  Object.assign(store.state, { unlocked: true, loading: false, actionError: '', draftEpoch: store.state.draftEpoch + 1, environment: { repositories: { schemaVersion: 1, pollMs: 30000, items: [], discovery: { ...candidate } } }, settings: { repositories: { pollMs: 30000, items: [] }, providers: [] }, status: { activeTasks: [], queuedTasks: [] }, sessions: { selected: '', records: [], execution: { currentSessionId: null, queued: 0 } }, board: { tasks: [] } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (init.method === 'POST') { requests.push(JSON.parse(init.body)); const response = await handler(path, JSON.parse(init.body)); if (response) return response; }
    const values = { '/status': store.state.status, '/monitoring': {}, '/api/environment': store.state.environment, '/api/history': { rows: [] }, '/api/chat/session': { sessions: store.state.sessions, chat: {} }, '/api/settings': store.state.settings, '/api/taskboard': store.state.board, '/api/definitions': { definitions: [] }, '/api/execution-profiles': null };
    return Response.json(values[path] ?? {});
  });
  const scope = effectScope(); t.after(() => scope.stop());
  const view = scope.run(() => useRepositoryDiscovery());
  const dashboard = scope.run(() => useRepositoryDiscovery(true));
  return { view, dashboard, requests };
}
function result(action) { return { schemaVersion: 1, pollMs: 30000, items: action === 'accept' ? [assigned] : [], discovery: { ...candidate, decision: action === 'accept' ? 'accepted' : 'declined', ...(action === 'accept' ? { repositoryId: 'web' } : {}) } }; }

test('repository consent waits for explicit action, deduplicates clicks and adopts acknowledged assignments', async t => {
  const pending = deferred();
  const { view, requests } = setup(t, () => pending.promise);
  assert.equal(view.visible.value, true); assert.equal(requests.length, 0);
  const saving = view.choose('accept'); assert.equal(view.busy.value, true);
  await view.choose('accept'); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { action: 'accept', discoveryId: candidate.id });
  pending.resolve(Response.json(result('accept'))); await saving;
  assert.equal(view.visible.value, false); assert.match(view.notice.value, /Repository added/);
  assert.deepEqual(store.state.settings.repositories.items, [{ id: 'web', path: '/projects/web', remote: 'origin', watch: true }]);
  assert.equal(store.state.environment.repositories.discovery.decision, 'accepted');
});

test('decline hides the Taskboard prompt and leaves a persistent Dashboard reconsideration action', async t => {
  const { view, dashboard, requests } = setup(t, (_, body) => Response.json(result(body.action)));
  await view.choose('decline');
  assert.equal(view.visible.value, false); assert.equal(dashboard.visible.value, true);
  assert.deepEqual(store.state.settings.repositories.items, []);
  await dashboard.choose('accept');
  assert.equal(dashboard.visible.value, false); assert.equal(requests.length, 2);
  assert.equal(store.state.environment.repositories.discovery.decision, 'accepted');
});

test('failed consent keeps the candidate actionable and does not claim it was saved', async t => {
  const { view } = setup(t, () => Response.json({ error: 'Repository changed. Refresh and try again.' }, { status: 409 }));
  await view.choose('accept'); assert.equal(view.visible.value, true);
  assert.match(view.error.value, /Repository changed/); assert.equal(view.notice.value, ''); assert.equal(view.busy.value, false);
});

test('queued work blocks acceptance but permits declining the optional prompt', async t => {
  const { view, requests } = setup(t, (_, body) => Response.json(result(body.action)));
  store.state.sessions.execution.queued = 1;
  await view.choose('accept'); assert.equal(requests.length, 0);
  await view.choose('decline'); assert.equal(requests.length, 1); assert.equal(view.visible.value, false);
});

test('late consent acknowledgement cannot restore private repository data after access expires', async t => {
  const pending = deferred(); const { view } = setup(t, () => pending.promise);
  const saving = view.choose('accept');
  store.state.unlocked = false; store.state.environment = null; store.state.settings = null; store.state.draftEpoch++;
  await nextTick(); pending.resolve(Response.json(result('accept'))); await saving;
  assert.equal(view.visible.value, false); assert.equal(view.notice.value, ''); assert.equal(view.error.value, ''); assert.equal(view.busy.value, false);
  assert.equal(store.state.environment, null); assert.equal(store.state.settings, null);
});

test('an older background read cannot resurrect pending consent after a successful write', async t => {
  const { view } = setup(t); const old = deferred();
  const previous = JSON.parse(JSON.stringify(store.state.environment));
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/api/repositories') return Response.json(result('accept'));
    if (path === '/api/environment') { await old.promise; return Response.json(previous); }
    const values = { '/status': store.state.status, '/monitoring': {}, '/api/history': { rows: [] }, '/api/chat/session': { sessions: store.state.sessions, chat: {} }, '/api/settings': store.state.settings, '/api/taskboard': store.state.board, '/api/definitions': { definitions: [] }, '/api/execution-profiles': null };
    return Response.json(values[path] ?? {});
  });
  const reading = store.refresh(); await view.choose('accept'); old.resolve(); await reading;
  assert.equal(view.visible.value, false); assert.equal(store.state.environment.repositories.discovery.decision, 'accepted');
  assert.equal(store.state.settings.repositories.items[0].id, 'web');
});
