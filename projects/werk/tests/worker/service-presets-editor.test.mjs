import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createToolAccessEditor } = await frontend('src/worker/webview/tool-access-editor.ts');
const { servicePolicyDraft, servicePolicyFromDraft, serviceDraftError } = await frontend('src/worker/webview/service-presets-draft.ts');
/** @returns {import('../../src/worker/application/service-access-policy').ServicePolicy} */
const policy = () => ({ enabled: true, maxActive: 4, presets: [{ id: 'preview', name: 'Preview server', executable: '/example/node', args: ['scripts/server.mjs', 'two words', ''], enabled: true, ttlMs: 3600000, startupTimeoutMs: 30000, readyText: 'Server listening', restart: { maxAttempts: 2, backoffMs: 1000 } }] });
/** @returns {import('../../src/worker/application/tool-policy').ToolAccessView} */
const view = () => ({ schemaVersion: 1, revision: 2, builtins: { files: false, commands: [], cliTools: [], webOrigins: [] }, mcp: [], canEdit: true, saveBlockedReason: null, workerNode: '/example/node' });
function fixture(t, configured = false) {
  const initial = view(); if (configured) initial.services = policy();
  const state = reactive({ view: initial, unlocked: true, epoch: 0 }); const calls = [];
  let write = async command => { state.view = { ...state.view, revision: state.view.revision + 1, services: command.services }; return state.view; };
  const editor = createToolAccessEditor({ view: () => state.view, unlocked: () => state.unlocked, epoch: () => state.epoch,
    write: async command => { calls.push(JSON.parse(JSON.stringify(command))); return write(command); }, discover: async () => state.view, refresh: async () => {} });
  t.after(editor.dispose);
  return { ...editor, state, calls, onWrite: fn => { write = fn; } };
}

test('legacy grants load service access disabled without manufacturing an edit', t => {
  const e = fixture(t);
  assert.equal(e.draft.services.enabled, false); assert.equal(e.draft.services.maxActive, 4);
  assert.deepEqual(e.draft.services.presets, []); assert.equal(e.dirty.value, false); assert.equal(e.canSave.value, false);
  e.addService(); const preset = e.draft.services.presets[0];
  assert.equal(preset.enabled, false); assert.equal(preset.executable, '/example/node');
  assert.equal(preset.lifetimeMinutes, 60); assert.equal(preset.startupSeconds, 30); assert.equal(preset.restartAttempts, 0);
  assert.match(e.validation.value, /name/);
});

test('service grants share the existing guarded save and preserve exact fixed arguments', async t => {
  const e = fixture(t, true); e.draft.services.presets[0].lifetimeMinutes = 90;
  e.state.view.canEdit = false; await e.save(); assert.equal(e.calls.length, 0);
  e.state.view.canEdit = true; await e.save(); assert.equal(e.calls.length, 1);
  const saved = e.calls[0]; assert.equal(saved.expectedRevision, 2); assert.equal(saved.services.enabled, true);
  assert.equal(saved.services.presets[0].ttlMs, 5400000);
  assert.deepEqual(saved.services.presets[0].args, ['scripts/server.mjs', 'two words', '']);
  assert.equal('cwd' in saved.services.presets[0], false); assert.equal('env' in saved.services.presets[0], false);
  assert.equal(e.dirty.value, false);
});

test('disabled service access retains configured presets so revocation does not erase them', async t => {
  const e = fixture(t, true); e.draft.services.enabled = false; await e.save();
  assert.equal(e.calls[0].services.enabled, false); assert.equal(e.calls[0].services.presets.length, 1);
  assert.equal(e.calls[0].services.presets[0].enabled, true);
});

test('service drafts survive polling and reject a conflicting saved revision', async t => {
  const e = fixture(t, true); e.draft.services.presets[0].name = 'Unsaved preview';
  e.state.view = { ...view(), revision: 3, services: policy() }; await nextTick();
  assert.equal(e.draft.services.presets[0].name, 'Unsaved preview'); assert.equal(e.stale.value, true);
  await e.save(); assert.equal(e.calls.length, 0);
  e.reload(); assert.equal(e.draft.services.presets[0].name, 'Preview server'); assert.equal(e.stale.value, false);
});

test('an uncertain service save retries the identical grant, lifetime and revision', async t => {
  const e = fixture(t, true), pending = deferred(); e.draft.services.presets[0].restartAttempts = 3;
  e.onWrite(() => pending.promise); const saving = e.save(); await e.save(); assert.equal(e.calls.length, 1);
  pending.reject(Error('Connection interrupted')); await saving; assert.equal(e.locked.value, true);
  e.onWrite(async command => ({ ...view(), revision: 3, services: command.services })); await e.retry();
  assert.deepEqual(e.calls[0], e.calls[1]); assert.equal(e.draft.uncertain, null);
});

test('explicit Lock clears service drafts and rejects late save acknowledgements', async t => {
  const e = fixture(t, true), pending = deferred(); e.draft.services.presets[0].name = 'Changed'; e.onWrite(() => pending.promise);
  const saving = e.save(); e.state.epoch++; e.state.unlocked = false;
  pending.resolve({ ...view(), services: policy() }); await saving;
  assert.equal(e.draft.services.enabled, false); assert.deepEqual(e.draft.services.presets, []); assert.equal(e.draft.notice, '');
});

test('duration units round-trip every saved millisecond and preserve literal readiness text', () => {
  const value = policy(); value.presets[0].ttlMs = 3600001; value.presets[0].startupTimeoutMs = 101; value.presets[0].restart.backoffMs = 103; value.presets[0].readyText = ' ready ';
  assert.deepEqual(servicePolicyFromDraft(servicePolicyDraft(value)), value);
});

test('invalid service command and lifetime drafts remain explicit and cannot be saved', () => {
  /** @type {Array<[string, string | number, RegExp]>} */
  const invalid = [
    ['executable', 'node', /absolute/], ['arguments', '[1]', /fixed arguments/], ['arguments', 'node server', /JSON array/],
    ['lifetimeMinutes', 1441, /24 hours/], ['lifetimeMinutes', '', /lifetime/], ['startupSeconds', 61, /startup wait/],
    ['restartAttempts', 6, /0–5/], ['restartAttempts', '', /0–5/], ['backoffSeconds', 0, /restart delay/],
  ];
  for (const [key, value, expected] of invalid) {
    const draft = servicePolicyDraft(policy()); Object.assign(draft.presets[0], { [key]: value });
    assert.match(serviceDraftError(draft), expected); assert.throws(() => servicePolicyFromDraft(draft));
  }
  const draft = servicePolicyDraft(policy()); draft.presets[0].lifetimeMinutes = 1 / 60;
  assert.match(serviceDraftError(draft), /no longer than/);
  draft.maxActive = 17; assert.match(serviceDraftError(draft), /1–16/);
});

test('duplicate service IDs and excess presets are refused without silently dropping grants', () => {
  const draft = servicePolicyDraft(policy()); draft.presets.push({ ...draft.presets[0] }); assert.match(serviceDraftError(draft), /unique ID/);
  draft.presets = Array.from({ length: 17 }, (_, index) => ({ ...draft.presets[0], id: 'service-' + index }));
  assert.match(serviceDraftError(draft), /up to 16/);
});
