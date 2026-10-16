import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createSharedIntakeEditor, defaultSharedIntakeConfig } = await frontend('src/worker/webview/shared-intake-editor.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const base = () => ({ revision: 0, workerId: 'worker-a', config: defaultSharedIntakeConfig(), canEdit: true, blockedReason: null, state: 'disabled', error: null, lastSyncedAt: null, sourceCommit: null, workflow: null, requests: [] });
function harness() {
  const access = reactive({ unlocked: true, epoch: 0, repositories: [{ id: 'project' }] });
  let saved = base(), reads = 0;
  const writes = [], notes = [];
  const io = { read: async () => { reads++; return clone(saved); }, write: async command => { writes.push(clone(command)); if (command.action === 'configure') saved = { ...saved, config: clone(command.config), revision: saved.revision + 1, state: command.config.enabled ? 'idle' : 'disabled' }; return clone(saved); }, note: async id => { notes.push(id); return { path: 'reviews/' + id + '.md', markdown: '# Review\n\nKeep the evidence.' }; } };
  const editor = createSharedIntakeEditor({ unlocked: () => access.unlocked, epoch: () => access.epoch, repositories: () => access.repositories, read: () => io.read(), write: command => io.write(command), note: id => io.note(id) });
  const enable = () => { editor.draft.config.enabled = true; editor.draft.config.repositoryId = 'project'; };
  return { access, editor, io, writes, notes, enable, saved: () => saved, setSaved: value => { saved = value; }, reads: () => reads };
}
test('shared intake stays disabled until an explicit revision-guarded local binding save', async () => {
  const h = harness(); await h.editor.load();
  assert.equal(h.editor.draft.config.enabled, false); assert.deepEqual(h.writes, []);
  h.enable(); await h.editor.save();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].expectedRevision, 0); assert.equal(h.writes[0].action, 'configure');
  assert.deepEqual(h.writes[0].config, { enabled: true, repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 });
  assert.equal(h.editor.dirty.value, false); assert.equal(h.editor.draft.revision, 1); h.editor.dispose();
});
test('unassigned repositories, unsafe paths and out-of-range intervals cannot be saved', async () => {
  const h = harness(); await h.editor.load(); h.enable();
  for (const path of ['../workflow.json', '/tmp/workflow.json', 'C:/workflow.json', 'nested\\workflow.json', 'a/./b.json', 'a//b.json']) { h.editor.draft.config.workflowPath = path; assert.equal(h.editor.canSave.value, false, path); }
  h.editor.draft.config.workflowPath = '.werk/feature-workflow.json';
  for (const pollMs of [0, 999, 300001, NaN]) { h.editor.draft.config.pollMs = pollMs; assert.equal(h.editor.canSave.value, false); }
  h.editor.draft.config.pollMs = 300000; assert.equal(h.editor.canSave.value, true);
  h.access.repositories = []; assert.equal(h.editor.canSave.value, false); await h.editor.save(); assert.equal(h.writes.length, 0); h.editor.dispose();
});
test('polling preserves edited settings and exposes revision conflicts without overwriting drafts', async () => {
  const h = harness(); await h.editor.load(); h.enable(); h.editor.draft.config.branch = 'release';
  h.setSaved({ ...h.saved(), revision: 1, config: { ...h.saved().config, branch: 'team' } }); await h.editor.load();
  assert.equal(h.editor.draft.config.branch, 'release'); assert.equal(h.editor.stale.value, true); assert.equal(h.editor.canSave.value, false);
  h.editor.reloadSaved(); assert.equal(h.editor.draft.config.branch, 'team'); assert.equal(h.editor.dirty.value, false); h.editor.dispose();
});
test('pause-and-drain restriction blocks saving while allowing a retained draft', async () => {
  const h = harness(); h.setSaved({ ...h.saved(), canEdit: false, blockedReason: 'Pause and drain first.' }); await h.editor.load(); h.enable();
  assert.equal(h.editor.dirty.value, true); await h.editor.save(); assert.equal(h.writes.length, 0);
  h.setSaved({ ...h.saved(), canEdit: true, blockedReason: null }); await h.editor.load(); assert.equal(h.editor.canSave.value, true); h.editor.dispose();
});
test('uncertain saves are confirmed by reading saved settings rather than submitted twice', async () => {
  const h = harness(); await h.editor.load(); h.enable();
  h.io.write = async command => { h.writes.push(clone(command)); h.setSaved({ ...h.saved(), revision: 1, config: clone(command.config), state: 'idle' }); throw Error('Connection closed before acknowledgement.'); };
  await h.editor.save(); assert.ok(h.editor.draft.uncertain); await h.editor.save(); assert.equal(h.writes.length, 1);
  const saved = h.saved(); h.setSaved({ ...saved, config: { pollMs: saved.config.pollMs, workflowPath: saved.config.workflowPath, branch: saved.config.branch, remote: saved.config.remote, repositoryId: saved.config.repositoryId, enabled: saved.config.enabled } });
  await h.editor.load(); assert.equal(h.editor.draft.uncertain, null); assert.equal(h.editor.dirty.value, false); assert.match(h.editor.draft.notice, /confirmed/); h.editor.dispose();
});
test('a rejected save preserves edits and a background read never publishes', async () => {
  const h = harness(); await h.editor.load(); h.enable();
  h.io.write = async () => { throw Object.assign(Error('Settings changed.'), { status: 409 }); };
  await h.editor.save(); assert.equal(h.editor.draft.uncertain, null); assert.equal(h.editor.dirty.value, true); assert.equal(h.editor.draft.config.repositoryId, 'project');
  await h.editor.load(); assert.equal(h.writes.length, 0); assert.equal(h.reads(), 2); h.editor.dispose();
});
test('manual sync uses saved configuration while preserving an unsaved connection draft', async () => {
  const h = harness(); h.setSaved({ ...h.saved(), config: { ...h.saved().config, enabled: true, repositoryId: 'project' }, state: 'idle' }); await h.editor.load();
  h.editor.draft.config.branch = 'draft-branch'; await h.editor.sync();
  assert.deepEqual(h.writes, [{ action: 'sync' }]); assert.equal(h.editor.draft.config.branch, 'draft-branch'); assert.equal(h.editor.dirty.value, true); h.editor.dispose();
});
test('review note lookup accepts only listed request IDs and ignores superseded responses', async () => {
  const h = harness(); h.setSaved({ ...h.saved(), requests: [{ id: 'one', reviewNote: 'reviews/one.md' }, { id: 'two', reviewNote: 'reviews/two.md' }] }); await h.editor.load();
  await h.editor.openNote('../../private'); assert.deepEqual(h.notes, []);
  const first = deferred(); h.io.note = id => id === 'one' ? first.promise : Promise.resolve({ path: 'reviews/two.md', markdown: '# Second' });
  const pending = h.editor.openNote('one'); await h.editor.openNote('two'); first.resolve({ path: 'reviews/one.md', markdown: '# First' }); await pending;
  assert.equal(h.editor.draft.note.path, 'reviews/two.md'); h.editor.closeNote(); assert.equal(h.editor.draft.note, null); h.editor.dispose();
});
test('locking invalidates in-flight reads and clears saved private view and draft state', async () => {
  const h = harness(); await h.editor.load(); h.enable(); const pending = deferred(); h.io.read = () => pending.promise;
  const load = h.editor.load(); h.access.unlocked = false; h.access.epoch++;
  pending.resolve({ ...base(), workerId: 'private-old-worker' }); await load;
  assert.equal(h.editor.view.value, null); assert.equal(h.editor.draft.revision, -1); assert.equal(h.editor.draft.config.enabled, false); assert.equal(h.editor.draft.loading, false); h.editor.dispose();
});

test('disabling new intake keeps owned publication available without accepting new work', async () => {
  const h = harness(); h.setSaved({ ...h.saved(), requests: [{ id: 'owned', isLocal: true, reviewNote: null }] }); await h.editor.load();
  assert.equal(h.editor.view.value.config.enabled, false); assert.equal(h.editor.canSync.value, true); await h.editor.sync();
  assert.deepEqual(h.writes, [{ action: 'sync' }]); assert.equal(h.editor.draft.config.enabled, false); h.editor.dispose();
});

test('clearing a disabled binding stages a draft and uses an explicit revision-guarded save', async () => {
  const h = harness(); h.setSaved({ ...h.saved(), revision: 7, config: { ...h.saved().config, repositoryId: 'project' }, requests: [{ id: 'finished', isLocal: true, status: 'ready_for_review', publication: 'synced' }] }); await h.editor.load();
  assert.equal(h.editor.canClear.value, true); h.editor.clearConnection();
  assert.equal(h.editor.draft.config.repositoryId, ''); assert.equal(h.editor.draft.config.enabled, false); assert.deepEqual(h.writes, []); assert.equal(h.editor.dirty.value, true); assert.match(h.editor.draft.notice, /Local ready files may enter/);
  await h.editor.save(); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].expectedRevision, 7); assert.equal(h.writes[0].config.repositoryId, ''); assert.match(h.editor.draft.notice, /cleared/); h.editor.dispose();
});
test('clearing cannot bypass enabled intake, unfinished publication, pause/drain, stale drafts or lock', async () => {
  const cases = [
    { config: { ...defaultSharedIntakeConfig(), enabled: true, repositoryId: 'project' } },
    { canEdit: false, blockedReason: 'Pause and drain first.' },
    { requests: [{ id: 'active', isLocal: true, status: 'running', publication: 'synced' }] },
    { requests: [{ id: 'unpublished', isLocal: true, status: 'ready_for_review', publication: 'pending' }] },
  ];
  for (const extra of cases) { const h = harness(); h.setSaved({ ...h.saved(), config: { ...h.saved().config, repositoryId: 'project' }, ...extra }); await h.editor.load(); assert.equal(h.editor.canClear.value, false); h.editor.clearConnection(); assert.equal(h.editor.draft.config.repositoryId, 'project'); assert.deepEqual(h.writes, []); h.editor.dispose(); }
  const h = harness(); h.setSaved({ ...h.saved(), config: { ...h.saved().config, repositoryId: 'project' } }); await h.editor.load(); h.editor.draft.config.branch = 'draft'; assert.equal(h.editor.canClear.value, false); h.setSaved({ ...h.saved(), revision: 1 }); await h.editor.load(); assert.equal(h.editor.canClear.value, false); h.editor.reloadSaved(); assert.equal(h.editor.canClear.value, true); h.access.unlocked = false; assert.equal(h.editor.canClear.value, false); h.editor.dispose();
});
