import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { readFeatureReview, reviewIdentity, reviewActionHref } = await frontend('src/worker/webview/review-reader.ts');

function fixture() {
  const session = { id: 'local-one', taskId: 'local-one', kind: 'local', requestId: 'request-one', requestRevision: 3 };
  const task = { id: 'one', sessionId: 'local-one', requestId: 'request-one', instruction: 'Accepted goal' };
  const request = { id: 'request-one', revision: 3, owner: { sessionId: 'local-one', taskId: 'one' }, input: { message: 'Accepted goal' } };
  const detail = { session, chat: { messages: [] } };
  const board = { tasks: [task] };
  const shared = { requests: [] }, projectIntakes = new Map();
  const calls = [];
  async function read(path, method = 'GET', body) {
    calls.push({ path, method, body });
    if (path === '/api/tasks') return detail;
    if (path === '/api/taskboard/detail') return task;
    if (path === '/api/taskboard') return board;
    if (path === '/api/requests') return request;
    if (path === '/api/shared-intake') return shared;
    if (path.startsWith('/api/shared-intake?projectId=')) { const id = new URL(path, 'http://worker.test').searchParams.get('projectId'); if (projectIntakes.has(id)) return projectIntakes.get(id); }
    throw Error('Unexpected read ' + path);
  }
  return { session, task, request, detail, board, shared, projectIntakes, read, calls };
}
test('review query preserves exact scalar identity and rejects ambiguous arrays', () => {
  assert.deepEqual(reviewIdentity({ session: 'local-one', fileId: 'one' }), { sessionId: 'local-one', fileId: 'one' });
  assert.deepEqual(reviewIdentity({ session: ['one', 'two'], fileId: null }), { sessionId: '', fileId: '' });
});
test('read-only review does not select, mutate or list unrelated conversations', async () => {
  const f = fixture();
  const result = await readFeatureReview({ sessionId: 'local-one', fileId: '' }, f.read);
  assert.equal(result.session, f.session); assert.equal(result.task, f.task); assert.equal(result.request, f.request);
  assert.deepEqual(f.calls, [
    { path: '/api/tasks', method: 'POST', body: { action: 'get', id: 'local-one' } },
    { path: '/api/taskboard', method: 'GET', body: undefined },
    { path: '/api/taskboard/detail', method: 'POST', body: { id: 'one' } },
    { path: '/api/requests', method: 'POST', body: { action: 'get', requestId: 'request-one' } },
  ]);
});
test('a file bookmark resolves its retained conversation once, without guessing a session ID', async () => {
  const f = fixture(); f.session.id = f.session.taskId = f.task.sessionId = f.request.owner.sessionId = 'retained-custom-session';
  const result = await readFeatureReview({ sessionId: '', fileId: 'one' }, f.read);
  assert.equal(result.session.id, 'retained-custom-session');
  assert.equal(f.calls.filter(call => call.path === '/api/taskboard/detail').length, 1);
});
/** @type {Array<[string, (f: ReturnType<typeof fixture>) => void]>} */
const contradictions = [
  ['file identity', f => { f.task.id = 'other'; }],
  ['session identity', f => { f.session.id = 'other'; }],
  ['task session', f => { f.task.sessionId = 'other'; }],
  ['task identity', f => { f.session.taskId = 'other'; }],
  ['request selection', f => { f.task.requestId = 'other'; }],
  ['request identity', f => { f.request.id = 'other'; }],
  ['request owner session', f => { f.request.owner.sessionId = 'other'; }],
  ['request owner task', f => { f.request.owner.taskId = 'other'; }],
  ['request revision', f => { f.request.revision++; }],
  ['session interaction', f => { Object.assign(f.session, { interaction: { sessionId: 'other' } }); }],
  ['task interaction', f => { Object.assign(f.task, { interaction: { sessionId: 'other' } }); }],
  ['feature key', f => { Object.assign(f.session, { feature: { key: 'accepted' } }); Object.assign(f.task, { feature: { key: 'other' } }); }],
  ['feature source', f => { Object.assign(f.session, { feature: { key: 'accepted', source: 'shared_git' } }); Object.assign(f.task, { feature: { key: 'accepted', source: 'interaction' } }); }],
  ['request feature owner', f => { Object.assign(f.session, { feature: { key: 'accepted' } }); Object.assign(f.request.owner, { featureId: 'other' }); }],
];
for (const [name, mutate] of contradictions) test('mixed evidence is rejected: ' + name, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: 'one' }, f.read));
});
test('local session aliases resolve through the exact unique board owner, never an ID prefix', async () => {
  const f = fixture(); f.session.id = f.session.taskId = f.task.sessionId = f.request.owner.sessionId = 'retained-custom-session';
  assert.equal((await readFeatureReview({ sessionId: f.session.id, fileId: '' }, f.read)).task.id, 'one');
  f.board.tasks.push({ ...f.task, id: 'another' });
  await assert.rejects(readFeatureReview({ sessionId: f.session.id, fileId: '' }, f.read), /unavailable or ambiguous/);
  f.board.tasks.length = 0;
  await assert.rejects(readFeatureReview({ sessionId: f.session.id, fileId: '' }, f.read), /unavailable or ambiguous/);
});
test('missing identity makes no request; unavailable evidence remains an error', async () => {
  const f = fixture();
  await assert.rejects(readFeatureReview({ sessionId: '', fileId: '' }, f.read), /Choose a feature request/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: '' }, async () => { throw Error('Worker offline'); }), /Worker offline/);
});
test('legacy chat without retained gate or local task is readable without invented evidence', async () => {
  const f = fixture(); Object.assign(f.session, { kind: 'chat', requestId: undefined });
  const result = await readFeatureReview({ sessionId: 'local-one', fileId: '' }, f.read);
  assert.equal(result.task, null); assert.equal(result.request, null); assert.equal(result.shared, null);
  assert.equal(f.calls.length, 1);
});
test('shared review joins only the canonical feature key and requires unambiguous ownership', async () => {
  const f = fixture(); Object.assign(f.session, { feature: { key: 'repo:feature-one', source: 'shared_git' } });
  const shared = { feature: { key: 'repo:feature-one', source: 'shared_git' }, taskId: 'one', isLocal: true, publication: 'pending' };
  f.shared.requests.push(shared, { feature: { key: 'other:feature-one' }, taskId: 'one', isLocal: false });
  assert.equal((await readFeatureReview({ sessionId: 'local-one', fileId: '' }, f.read)).shared, shared);
  f.shared.requests.push(shared);
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: '' }, f.read), /ownership is unavailable/);
});
test('shared task contradictions are blocked before exposing decisions', async () => {
  const f = fixture(); Object.assign(f.session, { feature: { key: 'repo:feature-one', source: 'shared_git' } });
  f.shared.requests.push({ feature: { key: 'repo:feature-one', source: 'shared_git' }, taskId: 'different', isLocal: true });
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: '' }, f.read), /task identity changed/);
});
test('next-step links preserve canonical context and lead to the existing continuation workflow', () => {
  assert.equal(reviewActionHref('answer', 'id /&'), '/request?session=id%20%2F%26');
  assert.equal(reviewActionHref('resume', 'one'), '/request?session=one');
  assert.equal(reviewActionHref('inspect_checks', 'one'), '#review-checks');
  assert.equal(reviewActionHref('review_patch', 'one'), '#review-changes');
  assert.equal(reviewActionHref('review_shared', 'one'), '#review-handoff');
  assert.equal(reviewActionHref('inspect_history', 'one'), '/history?view=runs&runSession=one');
});


test('managed shared reviews join the retained project when primary intake is empty, including refresh', async () => {
  const f = fixture(), feature = { key: 'company:feature-one', id: 'FR-1', source: 'shared_git', scope: 'company/main', repositoryId: 'company' };
  Object.assign(f.session, { feature }); Object.assign(f.task, { feature }); Object.assign(f.request.owner, { featureId: feature.key });
  const record = { feature, taskId: 'one', isLocal: true, publication: 'synced' };
  f.projectIntakes.set('company', { config: { repositoryId: 'company' }, requests: [record] });
  f.projectIntakes.set('other', { config: { repositoryId: 'other' }, requests: [{ ...record, feature: { ...feature, repositoryId: 'other' } }] });
  for (let refresh = 0; refresh < 2; refresh++) assert.equal((await readFeatureReview({ sessionId: 'local-one', fileId: 'one' }, f.read)).shared, record);
  assert.deepEqual(f.calls.filter(call => call.path.startsWith('/api/shared-intake')).map(call => call.path), ['/api/shared-intake?projectId=company', '/api/shared-intake?projectId=company']);
  assert.equal(f.shared.requests.length, 0, 'an empty primary intake does not affect the assigned project join');
});

test('managed shared review never falls back to another project or accepts a mismatched returned project', async () => {
  const f = fixture(), feature = { key: 'company:feature-one', id: 'FR-1', source: 'shared_git', scope: 'company/main', repositoryId: 'company' };
  Object.assign(f.session, { feature }); Object.assign(f.task, { feature });
  const record = { feature, taskId: 'one', isLocal: true };
  f.shared.requests.push(record);
  f.projectIntakes.set('company', { config: { repositoryId: 'company' }, requests: [] });
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: 'one' }, f.read), /ownership is unavailable/);
  assert.equal(f.calls.some(call => call.path === '/api/shared-intake'), false, 'matching primary records do not authorize fallback');
  f.projectIntakes.set('company', { config: { repositoryId: 'other' }, requests: [record] });
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: 'one' }, f.read), /project identity changed/);
  f.projectIntakes.set('company', { config: { repositoryId: 'company' }, requests: [{ ...record, feature: { ...feature, repositoryId: 'other' } }] });
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: 'one' }, f.read), /ownership changed/);
});

test('project contradictions and malformed retained project IDs are rejected before reading shared ownership', async () => {
  const f = fixture(), feature = { key: 'company:feature-one', source: 'shared_git', repositoryId: 'company' };
  Object.assign(f.session, { feature }); Object.assign(f.task, { feature: { ...feature, repositoryId: 'other' } });
  await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: 'one' }, f.read), /identities do not agree/);
  for (const repositoryId of ['', 'company/other', 'company?projectId=other', ' company', 'a'.repeat(101)]) {
    Object.assign(f.session, { feature: { ...feature, repositoryId } }); Object.assign(f.task, { feature: { ...feature, repositoryId } });
    await assert.rejects(readFeatureReview({ sessionId: 'local-one', fileId: 'one' }, f.read), /project identity is invalid/);
  }
  assert.equal(f.calls.some(call => call.path.startsWith('/api/shared-intake')), false);
});
