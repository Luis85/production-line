import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestGateController, initialGateState } from '../../src/worker/webview/request-gate-controller.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const record = (id = 'request-a', revision = 1, sessionId = 'session-a') => ({ schemaVersion: 1, id, revision, inputRevision: 1, inputHash: 'a'.repeat(64), policyDigest: 'b'.repeat(64), owner: { sessionId, rootTurnId: 'turn-' + id }, phase: 'ready', input: { kind: 'chat', title: 'Fixture', message: 'PRIVATE accepted instruction' } });
const list = records => ({ schemaVersion: 1, rows: records.map(item => ({ id: item.id, revision: item.revision, owner: item.owner, phase: item.phase, title: item.input.title })), total: records.length, nextOffset: null });
function fixture(api) {
  const state = initialGateState(), context = { sessionId: 'session-a', unlocked: true }, operations = new Map(), calls = [], changes = []; let count = 0;
  const controller = new RequestGateController({ state, current: () => context, api: async command => { calls.push(structuredClone(command)); return api(command); }, operations, operationId: () => 'operation-' + (++count), changed: value => changes.push(value), refresh: async () => {} });
  return { state, context, operations, calls, changes, controller, get operationCount() { return count; } };
}
test('gate polling reuses unchanged summaries without repeatedly retrieving private accepted context', async () => {
  const request = record(); const f = fixture(command => command.action === 'list' ? list([request]) : request);
  await f.controller.load(true); await f.controller.load(); assert.deepEqual(f.calls.map(call => call.action), ['list', 'get', 'list']); assert.equal(f.state.view.id, request.id);
});
test('late session reads cannot replace a newly selected request', async () => {
  const old = deferred(), newer = record('request-b', 3, 'session-b');
  const f = fixture(command => command.action === 'list' ? command.sessionId === 'session-a' ? old.promise : list([newer]) : newer);
  const earlier = f.controller.load(true); f.context.sessionId = 'session-b'; f.controller.invalidate(); await f.controller.load(true); old.resolve(list([record()])); await earlier;
  assert.equal(f.state.view.id, newer.id); assert.equal(f.state.rows[0].id, newer.id); assert.equal(f.state.loading, false);
});
test('a late detail response cannot overwrite another request within the same session', async () => {
  const old = deferred(), a = record(), b = record('request-b');
  const f = fixture(command => command.action === 'list' ? list([a, b]) : command.requestId === a.id ? old.promise : b);
  const earlier = f.controller.load(true); await new Promise(resolve => setImmediate(resolve)); await f.controller.select(b.id); old.resolve(a); await earlier;
  assert.equal(f.state.view.id, b.id); assert.equal(f.state.selected, b.id);
});
test('uncertain acknowledgement retains one operation and retries exactly rather than creating another admission', async () => {
  const current = record(); let mutations = 0;
  const f = fixture(command => command.action === 'list' ? list([current]) : command.action === 'get' ? current : ++mutations === 1 ? Promise.reject(Error('Connection lost')) : { request: record(current.id, 2), duplicate: true });
  await f.controller.load(true); await f.controller.mutate({ action: 'execute' }); const pending = f.operations.get(current.id); assert.ok(pending); await f.controller.send(pending);
  const commands = f.calls.filter(call => call.action === 'execute'); assert.deepEqual(commands[0], commands[1]); assert.equal(f.operationCount, 1); assert.equal(f.operations.size, 0); assert.match(f.state.notice, /already recorded/);
});
test('explicit validation rejection clears the pending operation without automatic retry', async () => {
  const current = record(); const f = fixture(command => command.action === 'list' ? list([current]) : command.action === 'get' ? current : Promise.reject(Object.assign(Error('Request changed'), { status: 409 })));
  await f.controller.load(true); await f.controller.mutate({ action: 'evaluate', stage: 'ready' }); assert.equal(f.operations.size, 0); assert.equal(f.operationCount, 1); assert.equal(f.calls.filter(call => call.action === 'evaluate').length, 1); assert.equal(f.state.view.revision, 1); assert.equal(f.state.error, 'Request changed');
});
test('late mutation acknowledgement clears its own receipt but leaves the new request view untouched', async () => {
  const response = deferred(), a = record(), b = record('request-b', 4, 'session-b');
  const f = fixture(command => command.action === 'list' ? list([command.sessionId === 'session-a' ? a : b]) : command.action === 'get' ? command.requestId === a.id ? a : b : response.promise);
  await f.controller.load(true); const earlier = f.controller.mutate({ action: 'assign', assignee: 'operator' }); f.context.sessionId = 'session-b'; f.controller.invalidate(); await f.controller.load(true); response.resolve({ request: record(a.id, 2), duplicate: false }); await earlier;
  assert.equal(f.state.view.id, b.id); assert.equal(f.state.view.revision, 4); assert.equal(f.operations.size, 0); assert.equal(f.state.notice, '');
});
test('access expiry and disposed components fence reads and prevent unrequested commands', async () => {
  const response = deferred(); const f = fixture(() => response.promise); const earlier = f.controller.load(); f.context.unlocked = false; f.controller.invalidate(); response.resolve(list([record()])); await earlier; await f.controller.mutate({ action: 'execute' }); assert.equal(f.calls.length, 1); assert.equal(f.state.view, null);
  f.controller.dispose(); f.context.unlocked = true; await f.controller.load(); assert.equal(f.calls.length, 1);
});
test('persisted execute intent with no admission reports its dispatch receipt and needs a fresh guarded operation', async () => {
  const current = record(); const f = fixture(command => command.action === 'list' ? list([current]) : command.action === 'get' ? current : { request: record(current.id, 2), duplicate: false, dispatch: { inputRevision: 1, state: 'not_admitted', note: 'Input retained. Queue is full; execute later using a new guarded operation.' } });
  await f.controller.load(true); await f.controller.mutate({ action: 'execute' }); assert.equal(f.operations.size, 0); assert.match(f.state.notice, /Queue is full/); assert.doesNotMatch(f.state.notice, /started/); await f.controller.mutate({ action: 'execute' }); assert.equal(f.operationCount, 2); assert.equal(f.calls.at(-1).expectedRevision, 2);
});
