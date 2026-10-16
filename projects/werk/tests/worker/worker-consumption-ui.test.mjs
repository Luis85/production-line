import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { frontend, freshFrontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createConsumptionEditor } = await frontend('src/worker/webview/consumption-editor.ts');
const policy = (overrides = {}) => ({ enabled: false, period: 'daily', allowance: 1_000_000, workerPercent: 50, perRunReservation: 10_000, ...overrides });
function editor(t) {
  const state = reactive({ unlocked: true, epoch: 0, policy: policy() });
  let write = async command => { state.policy = command.consumption; return state.policy; }, refresh = async () => {};
  const e = createConsumptionEditor({ policy: () => state.policy, unlocked: () => state.unlocked, epoch: () => state.epoch, write: command => write(command), refresh: () => refresh() });
  t.after(e.dispose);
  return { ...e, state, onWrite: fn => { write = fn; }, onRefresh: fn => { refresh = fn; } };
}
test('consumption drafts follow pristine updates and keep edits across polling and access expiry', async t => {
  const e = editor(t); assert.equal(e.dirty.value, false);
  e.state.policy = policy({ allowance: 2_000_000 }); await nextTick(); assert.equal(e.draft.allowance, '2000000');
  e.draft.workerPercent = 25; e.state.policy = policy({ allowance: 3_000_000 }); await nextTick();
  assert.equal(e.draft.allowance, '2000000'); assert.equal(e.draft.workerPercent, 25); assert.equal(e.stale.value, true);
  let writes = 0; e.onWrite(async () => { writes++; }); await e.save(); assert.equal(writes, 0);
  e.state.unlocked = false; e.state.policy = null; await nextTick(); assert.equal(e.draft.workerPercent, 25);
  e.state.unlocked = true; e.state.policy = policy({ allowance: 3_000_000 }); await nextTick(); e.reload();
  assert.equal(e.draft.allowance, '3000000'); assert.equal(e.stale.value, false); assert.equal(e.dirty.value, false);
});
test('consumption editor validates usable whole-token allocation before sending and accepts numeric input values', async t => {
  const e = editor(t); e.draft.allowance = 1_000_000; assert.equal(e.dirty.value, false);
  e.draft.enabled = true; e.draft.workerPercent = 50; assert.equal(e.workerAllowance.value, 500_000); assert.equal(e.canSave.value, true);
  e.draft.workerPercent = '50.5'; assert.match(e.validation.value, /1 to 100/);
  e.draft.workerPercent = 50; e.draft.perRunReservation = '500001'; assert.match(e.validation.value, /no larger/); assert.equal(e.workerAllowance.value, 500_000);
  e.draft.perRunReservation = '1'; e.draft.allowance = '9007199254740992'; assert.match(e.validation.value, /whole number/);
  e.draft.allowance = String(Number.MAX_SAFE_INTEGER); e.draft.workerPercent = 99;
  assert.equal(e.workerAllowance.value, Number(BigInt(Number.MAX_SAFE_INTEGER) * 99n / 100n));
  e.draft.allowance = ''; assert.match(e.validation.value, /whole number/);
  e.draft.allowance = '1000000'; e.draft.workerPercent = '0'; assert.match(e.validation.value, /1 to 100/);
});
test('consumption saves snapshot the baseline, serialize submission and preserve subsequent edits', async t => {
  const e = editor(t), pending = deferred(), commands = [];
  e.draft.enabled = true; e.onWrite(command => { commands.push(structuredClone(command)); return pending.promise; });
  const saving = e.save(); await e.save(); assert.equal(commands.length, 1); assert.equal(e.locked.value, true);
  assert.deepEqual(commands[0].expectedConsumption, policy()); assert.equal(commands[0].consumption.enabled, true);
  e.draft.workerPercent = '60'; pending.resolve(policy({ enabled: true })); await saving;
  assert.equal(e.draft.workerPercent, '60'); assert.equal(e.dirty.value, true); assert.match(e.draft.notice, /newer edits/);
});
test('lost consumption acknowledgement retains the exact command and reconciles a successful retry conflict', async t => {
  const e = editor(t), commands = []; e.draft.enabled = true;
  e.onWrite(async command => { commands.push(structuredClone(command)); throw Error('Connection lost'); });
  await e.save(); assert.equal(e.locked.value, true); assert.equal(e.draft.uncertain.consumption.enabled, true);
  e.onWrite(async command => { commands.push(structuredClone(command)); throw Object.assign(Error('Settings changed'), { status: 409 }); });
  e.onRefresh(async () => { e.state.policy = policy({ enabled: true }); });
  await e.retry(); assert.deepEqual(commands[0], commands[1]); assert.equal(e.draft.uncertain, null); assert.match(e.draft.notice, /saved/);
});
test('consumption conflicts retain edits and require reloading the current saved budget', async t => {
  const e = editor(t); e.draft.enabled = true;
  e.onWrite(async () => { throw Object.assign(Error('Consumption settings changed'), { status: 409 }); });
  e.onRefresh(async () => { e.state.policy = policy({ workerPercent: 20 }); });
  await e.save(); assert.equal(e.stale.value, true); assert.equal(e.draft.enabled, true); assert.equal(e.draft.uncertain, null);
  assert.match(e.draft.error, /changed/); e.reload(); assert.equal(e.draft.workerPercent, '20'); assert.equal(e.draft.enabled, false);
});
test('explicit lock clears consumption drafts and ignores late save acknowledgements', async t => {
  const e = editor(t), pending = deferred(); e.draft.enabled = true; e.onWrite(() => pending.promise);
  const saving = e.save(); e.state.epoch++; e.state.unlocked = false; e.state.policy = null; await nextTick();
  pending.resolve(policy({ enabled: true })); await saving;
  assert.equal(e.draft.baseline, null); assert.equal(e.draft.uncertain, null); assert.equal(e.draft.notice, ''); assert.equal(e.draft.busy, false);
});
test('consumption settings acknowledgement survives held older reads; unavailable status stays explicit and lock clears it', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const { state, refresh, consumptionAction, lock } = await freshFrontend('src/worker/webview/store.ts');
  state.unlocked = true; const old = policy(), saved = policy({ enabled: true }), pending = new Map();
  state.settings = { consumption: old }; state.consumption = { measuredTokens: 123 };
  globalThis.fetch = (path, options) => options.method === 'POST' && path === '/api/settings'
    ? Promise.resolve(Response.json({ consumption: saved })) : new Promise(resolve => pending.set(path, resolve));
  const reading = refresh(); const acknowledgement = await consumptionAction({ consumption: saved, expectedConsumption: old });
  assert.deepEqual(acknowledgement, saved); assert.equal(state.settings.consumption.enabled, true);
  for (const [path, resolve] of pending) resolve(Response.json(path === '/api/settings' ? { consumption: old } : {}));
  await reading; assert.equal(state.settings.consumption.enabled, true);
  globalThis.fetch = async path => path === '/api/consumption' ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(path === '/api/chat/session' ? { sessions: { records: [] }, chat: {} } : {});
  await refresh(); assert.match(state.consumptionError, /could not be refreshed/); assert.equal(state.consumption.measuredTokens, 123);
  globalThis.fetch = async () => Response.json({}); await lock(); assert.equal(state.consumption, null); assert.equal(state.consumptionError, '');
});
