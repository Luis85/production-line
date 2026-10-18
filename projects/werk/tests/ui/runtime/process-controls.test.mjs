import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as vue from 'vue';
import { frontend, deferred } from '../helpers/frontend-loader.mjs';
const { processDuration, processOwner, processReadState, serviceLifetime, serviceReadiness } = await frontend('src/worker/webview/metrics-processes.ts');

/** @returns {import('../../../src/worker/application/process-supervision').ServiceRecord} */
function service() { return { id: 'service-a', revision: 4, presetId: 'development', name: 'Preview', featureRequestKey: 'fr-' + 'a'.repeat(64), sessionId: 'feature-a', state: 'running', generation: 1, restartCount: 0, restartLimit: 2, createdAt: '2026-10-18T10:00:00Z', startedAt: '2026-10-18T10:00:00Z', endedAt: null, expiresAt: '2026-10-18T11:00:00Z', readiness: 'reported', readyAt: '2026-10-18T10:00:01Z', lastExit: null, error: null, measurement: null }; }
async function fixture(t, request) {
  const source = await readFile(new URL('../../../src/worker/webview/components/useServiceControls.ts', import.meta.url), 'utf8');
  const state = vue.reactive({ unlocked: true }), hooks = { activated: [], deactivated: [], unmounted: [] };
  const ports = { ...vue, onActivated: callback => hooks.activated.push(callback), onDeactivated: callback => hooks.deactivated.push(callback), onUnmounted: callback => hooks.unmounted.push(callback) };
  const exports = /** @type {typeof import('../../../src/worker/webview/components/useServiceControls.ts')} */ ({});
  new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(name => name === 'vue' ? ports : { state, request }, exports);
  const scope = vue.effectScope(); let refreshed = 0;
  const controller = scope.run(() => exports.useServiceControls(async () => { refreshed++; }));
  const trigger = event => hooks[event].forEach(callback => callback());
  t.after(() => { trigger('unmounted'); scope.stop(); });
  return { ...controller, state, trigger, refreshed: () => refreshed };
}

test('service actions require confirmation and retain the originally inspected revision', async t => {
  const calls = [], f = await fixture(t, async (...args) => { calls.push(args); return { service: { id: args[2].id, revision: args[2].expectedRevision } }; });
  const row = service(); f.confirm('stop', row); row.revision++;
  assert.equal(calls.length, 0); assert.equal(f.confirmation.value.service.revision, 4);
  await f.execute();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/api/processes');
  assert.equal(calls[0][2].action, 'stop'); assert.equal(calls[0][2].expectedRevision, 4);
  assert.equal(f.pending.value, null); assert.equal(f.confirmation.value, null); assert.equal(f.refreshed(), 1);
});

test('an uncertain restart keeps one exact operation and blocks conflicting new actions', async t => {
  const calls = [], pending = deferred(); let fail = true;
  const f = await fixture(t, async (path, method, body) => { calls.push(body); if (fail) { await pending.promise; throw Error('Connection lost'); } return { service: { id: body.id, revision: body.expectedRevision } }; });
  f.confirm('restart', service()); const first = f.execute();
  await f.execute(); f.confirm('stop', service()); assert.equal(calls.length, 1);
  pending.resolve(); await first;
  assert.match(f.error.value, /Connection lost/); assert.equal(f.blocked.value, true); assert.equal(f.pending.value.action, 'restart');
  fail = false; await f.retry();
  assert.deepEqual(calls[0], calls[1]); assert.equal(f.pending.value, null); assert.equal(f.blocked.value, false);
});

test('revision conflicts clear the attempt and refresh before another operation', async t => {
  const f = await fixture(t, async () => { throw Object.assign(Error('Service changed'), { status: 409 }); });
  f.confirm('stop', service()); await f.execute();
  assert.equal(f.pending.value, null); assert.equal(f.confirmation.value, null); assert.equal(f.refreshed(), 1); assert.match(f.error.value, /Service changed/);
});

test('late service acknowledgements cannot repopulate state after lock and unlock', async t => {
  const pending = deferred(), f = await fixture(t, () => pending.promise);
  f.confirm('restart', service()); const running = f.execute();
  f.state.unlocked = false; f.state.unlocked = true; pending.resolve({}); await running;
  assert.equal(f.pending.value, null); assert.equal(f.notice.value, ''); assert.equal(f.confirmation.value, null); assert.equal(f.refreshed(), 0);
});

test('navigation preserves an unconfirmed receipt but fences its late UI update', async t => {
  const pending = deferred(); let fail = true; const calls = [];
  const f = await fixture(t, async (path, method, body) => { calls.push(body); if (fail) { await pending.promise; throw Error('No response'); } return { service: { id: body.id, revision: body.expectedRevision } }; });
  f.confirm('restart', service()); const running = f.execute(); f.trigger('deactivated');
  pending.resolve(); await running; assert.equal(f.error.value, '');
  await f.retry(); assert.equal(calls.length, 1);
  f.trigger('activated'); fail = false; await f.retry();
  assert.deepEqual(calls[0], calls[1]); assert.equal(f.pending.value, null);
});

test('process freshness rejects unknown, future, old and failed reads while preserving measured zero time', () => {
  const at = Date.parse('2026-10-18T10:00:00Z'), iso = new Date(at).toISOString();
  assert.equal(processReadState(iso, at + 15000, false, '').stale, false);
  for (const input of [[iso, at + 15001, false, ''], [iso, at, true, ''], [iso, at, false, 'offline'], ['invalid', at, false, ''], [iso, at - 6000, false, '']]) assert.equal(processReadState(...input).stale, true);
  assert.equal(processDuration(0), '0s'); assert.equal(processDuration(null), 'Unavailable'); assert.equal(processDuration(-1), 'Unavailable');
  assert.equal(serviceLifetime(service(), at), '1h 0m remaining');
  assert.match(serviceLifetime(service(), at + 3600000), /awaiting worker update/);
  assert.equal(serviceReadiness(service()), 'Readiness output received');
});

for (const response of [{}, { service: { id: 'another-service', revision: 5 } }, { service: { id: 'service-a', revision: 3 } }]) {
test('inconsistent service acknowledgement preserves the exact pending operation: ' + JSON.stringify(response), async t => {
  let result = response; const calls = [];
  const f = await fixture(t, async (path, method, body) => { calls.push(body); return result; });
  f.confirm('restart', service()); await f.execute();
  assert.ok(f.pending.value); assert.match(f.error.value, /inconsistent service acknowledgement/); assert.equal(f.refreshed(), 0);
  result = { service: { id: 'service-a', revision: 5 } }; await f.retry();
  assert.deepEqual(calls[0], calls[1]); assert.equal(f.pending.value, null); assert.equal(f.refreshed(), 1);
});
}

test('delegated process navigation resolves one canonical request and refuses contradictory ownership', () => {
  const process = { sessionId: 'delegated-child', taskId: 'file-a', featureRequestKey: 'fr-a' };
  const sessions = [{ id: 'parent', taskId: 'file-a', title: 'Parent request', feature: { key: 'fr-a' } }];
  assert.deepEqual(processOwner(process, sessions, []), { id: 'parent', title: 'Parent request' });
  const tasks = [{ id: 'file-a', sessionId: 'parent', title: 'File request', feature: { key: 'fr-a' } }];
  assert.deepEqual(processOwner(process, sessions, tasks), { id: 'parent', title: 'File request' });
  assert.equal(processOwner(process, [], []), null);
  assert.equal(processOwner(process, [...sessions, { ...sessions[0], id: 'another' }], []), null);
  assert.equal(processOwner({ ...process, sessionId: 'parent', featureRequestKey: 'fr-other' }, sessions, tasks), null);
  assert.equal(processOwner(process, sessions, [{ ...tasks[0], feature: { key: 'fr-other' } }]), null);
});
