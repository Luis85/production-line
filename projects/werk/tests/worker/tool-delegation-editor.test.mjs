import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createToolAccessEditor } = await frontend('src/worker/webview/tool-access-editor.ts');
const defaults = { enabled: false, maxChildren: 4, maxConcurrent: 2 };
/** @returns {import('../../src/worker/application/tool-policy.js').ToolAccessView} */
const view = (revision = 0) => ({ schemaVersion: 1, revision, builtins: { files: false, commands: [], cliTools: [], webOrigins: [] }, mcp: [], canEdit: true, saveBlockedReason: null, workerNode: '/example/bin/node' });
function editor(t) {
  const state = reactive({ unlocked: true, epoch: 0, view: view() }), writes = [];
  let write = async command => ({ ...view(state.view.revision + 1), delegation: command.delegation });
  const e = createToolAccessEditor({ view: () => state.view, unlocked: () => state.unlocked, epoch: () => state.epoch, write: async command => { writes.push(JSON.parse(JSON.stringify(command))); const result = await write(command); if (result && state.unlocked) state.view = result; return result; }, discover: async () => state.view, refresh: async () => {} });
  t.after(e.dispose);
  return { ...e, state, writes, onWrite: fn => { write = fn; } };
}

test('legacy grants display delegation off without an edit and save explicit bounded grants', async t => {
  const e = editor(t);
  assert.deepEqual(e.draft.delegation, defaults);
  assert.equal(e.dirty.value, false); assert.equal(e.canSave.value, false);
  e.draft.delegation.maxChildren = '4'; e.draft.delegation.maxConcurrent = '2';
  assert.equal(e.dirty.value, false, 'numeric inputs with the same value remain clean');
  Object.assign(e.draft.delegation, { enabled: true, maxChildren: '2', maxConcurrent: '1' });
  await e.save();
  assert.deepEqual(e.writes[0].delegation, { enabled: true, maxChildren: 2, maxConcurrent: 1 });
  assert.equal(e.dirty.value, false); assert.match(e.draft.notice, /saved/);
  e.draft.delegation.enabled = false; await e.save();
  assert.deepEqual(e.writes[1].delegation, { enabled: false, maxChildren: 2, maxConcurrent: 1 });
  assert.equal(e.dirty.value, false, 'revocation is acknowledged through the same saved baseline');
});

test('delegation rejects blank, fractional and out-of-range limits even when disabled', async t => {
  const e = editor(t);
  for (const [key, invalids, pattern] of /** @type {const} */ ([
    ['maxChildren', [0, -1, 5, 1.5, '', 'invalid', Infinity], /whole number from 1–4/],
    ['maxConcurrent', [0, -1, 3, 1.5, '', 'invalid', Infinity], /whole number from 1–2/],
  ])) {
    for (const value of invalids) {
      Object.assign(e.draft.delegation, defaults, { [key]: value });
      assert.match(e.validation.value, pattern); assert.equal(e.canSave.value, false);
      await e.save(); assert.equal(e.draft.delegation[key], value, 'keep invalid input for correction');
    }
  }
  Object.assign(e.draft.delegation, { enabled: true, maxChildren: 1, maxConcurrent: 2 });
  assert.match(e.validation.value, /cannot exceed/); await e.save(); assert.equal(e.writes.length, 0);
  e.draft.delegation.maxConcurrent = 1; assert.equal(e.canSave.value, true); await e.save();
  assert.deepEqual(e.writes[0].delegation, { enabled: true, maxChildren: 1, maxConcurrent: 1 });
});

test('delegation drafts survive polling and require paused, drained and unlocked authority', async t => {
  const e = editor(t); e.draft.delegation.enabled = true;
  e.state.view = { ...view(), canEdit: false, saveBlockedReason: 'Pause and drain first.' }; await nextTick();
  assert.equal(e.draft.delegation.enabled, true); assert.equal(e.draft.busy, false); assert.equal(e.locked.value, false);
  await e.save(); assert.equal(e.writes.length, 0);
  e.state.view.canEdit = true; e.state.unlocked = false; await e.save(); assert.equal(e.writes.length, 0);
  e.state.unlocked = true; await nextTick(); await e.save();
  assert.equal(e.writes.length, 1); assert.equal(e.state.view.delegation.enabled, true);
});

test('concurrent delegation updates keep unsaved edits until explicit reload and Lock resets defaults', async t => {
  const e = editor(t); e.draft.delegation.maxChildren = 3;
  e.state.view = { ...view(1), delegation: { enabled: true, maxChildren: 1, maxConcurrent: 1 } }; await nextTick();
  assert.equal(e.draft.delegation.maxChildren, 3); assert.equal(e.stale.value, true);
  await e.save(); assert.equal(e.writes.length, 0);
  e.reload(); assert.deepEqual(e.draft.delegation, { enabled: true, maxChildren: 1, maxConcurrent: 1 });
  assert.equal(e.dirty.value, false);
  e.draft.delegation.maxChildren = 2;
  assert.equal(e.state.view.delegation.maxChildren, 1, 'editing a draft never mutates saved authority');
  e.state.epoch++; assert.deepEqual(e.draft.delegation, defaults);
});

test('lost delegation acknowledgement locks editing and retries the exact bounded grant', async t => {
  const e = editor(t), pending = deferred();
  Object.assign(e.draft.delegation, { enabled: true, maxChildren: 3, maxConcurrent: 2 });
  e.onWrite(() => pending.promise); const saving = e.save(); await e.save();
  assert.equal(e.writes.length, 1); assert.equal(e.locked.value, true);
  pending.reject(Error('Acknowledgement lost')); await saving;
  assert.equal(e.locked.value, true); assert.deepEqual(e.draft.uncertain.delegation, { enabled: true, maxChildren: 3, maxConcurrent: 2 });
  e.onWrite(async command => ({ ...view(1), delegation: command.delegation })); await e.retry();
  assert.deepEqual(e.writes[1], e.writes[0]); assert.equal(e.draft.uncertain, null); assert.equal(e.dirty.value, false);
});

test('Lock suppresses a late delegation acknowledgement from the previous workspace epoch', async t => {
  const e = editor(t), pending = deferred(); e.draft.delegation.enabled = true;
  e.onWrite(() => pending.promise); const saving = e.save();
  e.state.epoch++; e.state.unlocked = false;
  pending.resolve({ ...view(1), delegation: { enabled: true, maxChildren: 4, maxConcurrent: 2 } }); await saving;
  assert.deepEqual(e.draft.delegation, defaults); assert.equal(e.draft.notice, ''); assert.equal(e.draft.uncertain, null);
});
