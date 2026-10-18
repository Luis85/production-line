import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createFeatureAuthoringEditor, emptyFeatureAuthoringEditor } = await frontend('src/worker/webview/feature-authoring-editor.ts');
const binding = () => ({ repositoryId: 'project', remote: 'origin', branch: 'team', workflowPath: '.werk/feature-workflow.json' });
const result = overrides => ({ featureId: 'fr-one', name: 'fr-one.md', path: 'features/fr-one.md', markdown: 'Draft Markdown', revision: null, status: 'draft', readiness: { valid: true, errors: [] }, workflowDigest: 'policy-a', binding: binding(), ...overrides });
const seed = { title: 'Export orders', message: 'Add CSV export.', provider: 'codex-cli', paths: ['src/export.ts'] };
function fixture() {
  const state = emptyFeatureAuthoringEditor(), calls = [], control = { active: true, epoch: 0, binding: binding(), response: async () => result() };
  let count = 0;
  const editor = createFeatureAuthoringEditor({ state, binding: () => control.binding, active: () => control.active, epoch: () => control.epoch,
    uuid: () => 'operation-' + ++count, command: async command => { calls.push(structuredClone(command)); return control.response(); } });
  return { state, calls, control, editor };
}
test('preparing instructions targets one bound Feature Request without task admission', async () => {
  const f = fixture(); await f.editor.prepare(seed);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], { action: 'prepare', operationId: 'operation-1', seed, expectedBinding: binding() });
  assert.equal(f.state.result.featureId, 'fr-one'); assert.equal(f.state.result.revision, null); assert.match(f.state.notice, /Draft prepared/);
});
test('edited drafts recheck with the original revision, workflow and repository guards', async () => {
  const f = fixture(); f.control.response = async () => result({ revision: 'saved-a' }); await f.editor.reopen('fr-one.md');
  f.state.markdown = 'Edited same request'; f.control.response = async () => result({ markdown: f.state.markdown, revision: 'saved-a' });
  await f.editor.check();
  assert.deepEqual(f.calls[1], { action: 'prepare', operationId: 'operation-2', name: 'fr-one.md', markdown: 'Edited same request', expectedRevision: 'saved-a', expectedWorkflowDigest: 'policy-a', expectedBinding: binding() });
  assert.equal(f.state.savedMarkdown, 'Draft Markdown');
});
test('ready publication requires current passing readiness; draft publication does not', async () => {
  const f = fixture(); await f.editor.prepare(seed); f.state.markdown = 'Changed request';
  assert.equal(await f.editor.publish('ready'), undefined); assert.equal(f.calls.length, 1);
  f.control.response = async () => result({ markdown: 'Changed request', readiness: { valid: false, errors: [{ code: 'missing', message: 'Add acceptance criteria.' }] } });
  await f.editor.check(); assert.equal(await f.editor.publish('ready'), undefined);
  f.control.response = async () => result({ markdown: 'Changed request', revision: 'saved-b', publication: { commit: 'commit-b', head: 'commit-b' } });
  await f.editor.publish('draft'); assert.equal(f.calls.at(-1).status, 'draft'); assert.match(f.state.notice, /Draft committed and pushed/);
});
test('successful ready publication remains the same feature and does not invent a session', async () => {
  const f = fixture(); await f.editor.prepare(seed);
  f.control.response = async () => result({ status: 'ready', revision: 'ready-a', publication: { commit: 'commit-a', head: 'commit-a' } });
  await f.editor.publish('ready');
  assert.equal(f.calls[1].name, 'fr-one.md'); assert.equal(f.calls[1].status, 'ready'); assert.equal(f.state.result.featureId, 'fr-one');
  assert.equal(f.editor.editable(), false); assert.match(f.state.notice, /will claim it when eligible/);
});
test('a lost publication acknowledgement retains the exact immutable operation for explicit retry', async () => {
  const f = fixture(); await f.editor.prepare(seed); f.control.response = async () => { throw Error('Connection lost'); };
  await f.editor.publish('ready'); const pending = structuredClone(f.state.pending);
  f.state.markdown = 'Unexpected external edit'; f.control.response = async () => result({ status: 'ready', revision: 'ready-a' });
  await f.editor.retry(); assert.deepEqual(f.calls[2], pending); assert.equal(f.calls[2].operationId, f.calls[1].operationId); assert.equal(f.state.pending, null);
});
test('server revision conflict preserves the unsaved editor for reconciliation', async () => {
  const f = fixture(); await f.editor.prepare(seed); f.state.markdown = 'My retained draft';
  f.control.response = async () => { throw Object.assign(Error('Remote revision changed'), { status: 409 }); };
  await f.editor.publish('draft'); assert.equal(f.state.markdown, 'My retained draft'); assert.equal(f.state.pending, null); assert.match(f.state.error, /Remote revision/);
});
test('repository changes cannot redirect a pending publication retry', async () => {
  const f = fixture(); await f.editor.prepare(seed); f.control.response = async () => { throw Error('Connection lost'); }; await f.editor.publish('draft');
  f.control.binding = { ...binding(), repositoryId: 'another-project' }; assert.equal(await f.editor.retry(), undefined); assert.equal(f.calls.length, 2); assert.equal(f.editor.current(), false);
});
test('concurrent sends are suppressed and a lock discards late private results', async () => {
  const f = fixture(), pending = deferred(); f.control.response = () => pending.promise;
  const running = f.editor.prepare(seed); assert.equal(await f.editor.prepare(seed), undefined); assert.equal(f.calls.length, 1);
  f.control.epoch++; f.control.active = false; f.editor.reset(); pending.resolve(result()); await running;
  assert.deepEqual(f.state, emptyFeatureAuthoringEditor());
});
test('a result for a different repository never replaces the retained draft', async () => {
  const f = fixture(); f.control.response = async () => result({ binding: { ...binding(), branch: 'other' } }); await f.editor.prepare(seed);
  assert.equal(f.state.result, null); assert.ok(f.state.pending); assert.match(f.state.error, /connection changed/);
});
