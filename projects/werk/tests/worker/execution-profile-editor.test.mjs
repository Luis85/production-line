import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createExecutionProfileEditor } = await frontend('src/worker/webview/execution-profile-editor.ts');
const profile = (id = 'codex-review', provider = 'codex') => ({ id, provider, mode: 'mock', maxParallel: 1 });
const view = (hash = 'initial', profiles = [profile()]) => ({ schemaVersion: 1, profiles, configurationHash: hash, mode: 'mock', allowedProviders: ['claude', 'codex'], maxProfiles: 8, pending: null, state: 'ready', canEdit: true, saveBlockedReason: null });
function editor(t) {
  const state = reactive({ unlocked: true, epoch: 0, view: view() });
  let write = async command => { state.view = view('saved', command.profiles); return state.view; }, refresh = async () => {};
  const e = createExecutionProfileEditor({ view: () => state.view, unlocked: () => state.unlocked, epoch: () => state.epoch, write: command => write(command), refresh: () => refresh() });
  t.after(e.dispose);
  return { ...e, state, onWrite: fn => { write = fn; }, onRefresh: fn => { refresh = fn; } };
}
test('profile drafts survive background refresh and reject stale configuration until explicitly reloaded', async t => {
  const e = editor(t); assert.equal(e.dirty.value, false);
  e.state.view = view('external', [profile('external')]); await nextTick(); assert.equal(e.draft.profiles[0].id, 'external');
  e.draft.profiles[0].id = 'unsaved'; e.state.view = view('changed', [profile('changed')]); await nextTick();
  assert.equal(e.draft.profiles[0].id, 'unsaved'); assert.equal(e.stale.value, true);
  let writes = 0; e.onWrite(async () => { writes++; }); await e.save(); assert.equal(writes, 0);
  e.reload(); assert.equal(e.draft.profiles[0].id, 'changed'); assert.equal(e.stale.value, false);
});
test('profile saves snapshot edits, serialize requests and preserve uncertain requests for exact retry', async t => {
  const e = editor(t), first = deferred(), commands = []; e.draft.profiles[0].id = 'renamed';
  e.onWrite(async command => { commands.push(structuredClone(command)); return first.promise; });
  const saving = e.save(); await e.save(); assert.equal(commands.length, 1); assert.equal(e.locked.value, true);
  first.reject(Error('Connection lost')); await saving;
  assert.equal(e.draft.uncertain.profiles[0].id, 'renamed'); assert.equal(e.locked.value, true);
  e.onWrite(async command => { commands.push(JSON.parse(JSON.stringify(command))); e.state.view = view('saved', command.profiles); return e.state.view; });
  await e.retry(); assert.deepEqual(commands[0], commands[1]); assert.equal(e.draft.uncertain, null); assert.match(e.draft.notice, /saved/);
});
test('profile status recovers a lost acknowledgement and displays retained pending profiles', async t => {
  const e = editor(t); e.draft.profiles[0].id = 'requested'; e.onWrite(async () => { throw Error('Timed out'); }); await e.save();
  e.state.view = { ...view(), state: 'pending', canEdit: false, pending: { configurationHash: 'next', profiles: [profile('requested')] } }; await nextTick();
  assert.equal(e.draft.uncertain, null); assert.equal(e.draft.profiles[0].id, 'requested'); assert.equal(e.locked.value, true);
  assert.match(e.draft.notice, /orchestrator/);
  e.state.view = view('next', [profile('requested')]); await nextTick(); assert.equal(e.locked.value, false); assert.equal(e.dirty.value, false);
});
test('profile controls enforce names, providers, fixed capacity and backend save blockers', async t => {
  const e = editor(t); e.draft.profiles[0].id = 'bad name'; assert.match(e.validation.value, /letters/);
  e.draft.profiles = [profile('same'), profile('same', 'claude')]; assert.match(e.validation.value, /different ID/);
  e.draft.profiles = [profile('valid')]; e.state.view.canEdit = false; let writes = 0; e.onWrite(async () => { writes++; }); await e.save(); assert.equal(writes, 0);
  e.state.view.canEdit = true; e.state.view.mode = 'cli'; e.state.view.maxProfiles = 1; e.state.view.allowedProviders = ['codex'];
  e.add(); assert.equal(e.draft.profiles.length, 1); e.remove(0); assert.equal(e.draft.profiles.length, 1);
  e.draft.profiles[0].provider = 'claude'; assert.match(e.validation.value, /supported/);
  e.draft.profiles[0].provider = 'codex'; e.onWrite(async command => { assert.equal(command.profiles[0].maxParallel, 1); assert.equal(command.profiles[0].mode, 'cli'); e.state.view = { ...e.state.view, profiles: command.profiles }; return e.state.view; }); await e.save();
});
test('profile conflict retains edits, refreshes state and permits safe reload', async t => {
  const e = editor(t); e.draft.profiles[0].id = 'draft';
  e.onWrite(async () => { throw Object.assign(Error('Profiles changed. Refresh.'), { status: 409 }); });
  e.onRefresh(async () => { e.state.view = view('changed', [profile('new')]); });
  await e.save(); assert.equal(e.draft.uncertain, null); assert.equal(e.stale.value, true); assert.equal(e.draft.profiles[0].id, 'draft'); assert.match(e.draft.error, /changed/);
  e.reload(); assert.equal(e.draft.profiles[0].id, 'new');
});
test('access expiry preserves unsent profile edits while explicit Lock clears drafts and late acknowledgements', async t => {
  const e = editor(t); e.draft.profiles[0].id = 'private-draft'; e.state.unlocked = false; e.state.view = null; await nextTick();
  assert.equal(e.draft.profiles[0].id, 'private-draft'); e.state.unlocked = true; e.state.view = view(); await nextTick();
  assert.equal(e.draft.profiles[0].id, 'private-draft');
  const pending = deferred(); e.onWrite(() => pending.promise); const saving = e.save();
  e.state.epoch++; e.state.unlocked = false; e.state.view = null; await nextTick(); pending.resolve(view('late', [profile('private-draft')])); await saving;
  assert.deepEqual(e.draft.profiles, []); assert.equal(e.draft.notice, ''); assert.equal(e.draft.uncertain, null);
});
