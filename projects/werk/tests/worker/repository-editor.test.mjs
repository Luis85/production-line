import { requiredValue } from '../ui/helpers/required-value.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { nextTick } from 'vue';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
await frontend('src/worker/webview/native-work-readiness.ts');
const root = fileURLToPath(new URL('../../', import.meta.url));
async function editor(t) {
  const component = (await readFile(join(root, 'src/worker/webview/components/RepositoryPanel.vue'), 'utf8')).replace(/\r\n/g, '\n');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import U(?:Button|Input).*\n/gm, '')
    .replace(/^import RepositoryDiscovery.*\n/gm, '')
    .replace(/^import \{ nativeWorkReadiness.*\n/gm, '')
    .replace(/^import \{ state,.*\n/gm, '');
  const fixture = { unlocked: true, draftEpoch: 0, settings: { repositories: { pollMs: 30000, items: [{ id: 'web', path: '/projects/web', remote: 'origin', watch: true }] } }, environment: { repositories: { items: [] } }, sessions: { execution: { queued: 0 } }, status: { activeTasks: [] } };
  const harness = `import { reactive } from 'vue';
import { nativeWorkReadiness } from ${JSON.stringify(pathToFileURL(join(root, 'src/worker/webview/native-work-readiness.ts')).href)};
export const state = reactive(${JSON.stringify(fixture)});
let action = async () => undefined;
export function onSave(handler) { action = handler; }
const workspaceAction = (...args) => action(...args);
const date = value => value;
${script}
export { entries, seconds, worktreeDirectory, busy, dirty, stale, notice, error, nativeReadiness, editingLocked, reload, save, sync };
`;
  await mkdir(join(root, 'work'), { recursive: true });
  const directory = await mkdtemp(join(root, 'work/repository-editor-')), path = join(directory, 'editor.mjs');
  await writeFile(path, ts.transpileModule(harness, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return import(pathToFileURL(path).href);
}
test('repository editor updates pristine data and protects unsaved assignments from external refresh', async t => {
  const e = await editor(t); assert.equal(e.dirty.value, false);
  e.state.settings.repositories.items[0].path = '/projects/updated'; await nextTick();
  assert.equal(e.entries.value[0].path, '/projects/updated');
  e.entries.value[0].branch = 'draft';
  e.state.settings.repositories.items[0].branch = 'external'; await nextTick();
  assert.equal(e.entries.value[0].branch, 'draft'); assert.equal(e.stale.value, true);
  let writes = 0; e.onSave(async () => { writes++; }); await e.save(); assert.equal(writes, 0);
  e.reload(); assert.equal(e.entries.value[0].branch, 'external'); assert.equal(e.stale.value, false); assert.equal(e.dirty.value, false);
});
test('repository editor snapshots assignments, prevents duplicate saves and clears after lock', async t => {
  const e = await editor(t); let submitted = /** @type {{ value?: {repositories: import('../../src/worker/application/repositories.js').RepositoryConfiguration} }} */ ({});
  e.entries.value[0].branch = 'main'; e.seconds.value = 15;
  const { promise: held, resolve: finish } = Promise.withResolvers();
  e.onSave(async (_, body) => { submitted.value = body; await held; return body; });
  const saving = e.save(); assert.equal(e.busy.value, true);
  await e.save(); assert.equal(requiredValue(submitted.value).repositories.pollMs, 15000); assert.equal(requiredValue(submitted.value).repositories.items[0].branch, 'main');
  e.state.unlocked = false; e.state.draftEpoch++; await nextTick();
  assert.deepEqual(e.entries.value, []); finish(undefined); await saving;
  assert.equal(e.notice.value, ''); assert.equal(e.busy.value, false);
});
test('repository editor blocks assignment replacement while tasks wait and retains failed drafts', async t => {
  const e = await editor(t); let writes = 0;
  e.onSave(async () => { writes++; return undefined; }); e.entries.value[0].branch = 'main';
  e.state.sessions.execution.queued = 1; await e.save(); assert.equal(writes, 0);
  e.state.sessions.execution.queued = 0; await e.save(); assert.equal(writes, 1);
  assert.equal(e.entries.value[0].branch, 'main'); assert.match(e.error.value, /edits are retained/);
});


test('worktree folder drafts survive polling, block saves during preparation, and clear on lock', async t => {
  const e = await editor(t); e.worktreeDirectory.value = '/worktrees/draft';
  e.state.settings.repositories = JSON.parse(JSON.stringify(e.state.settings.repositories)); await nextTick();
  assert.equal(e.worktreeDirectory.value, '/worktrees/draft'); assert.equal(e.stale.value, false);
  let writes = 0; e.onSave(async () => { writes++; }); e.state.board = { preparations: [{ state: 'preparing' }] };
  await e.save(); assert.equal(writes, 0);
  e.state.board.preparations = []; e.state.settings.repositories.worktreeDirectory = '/worktrees/external'; await nextTick();
  assert.equal(e.worktreeDirectory.value, '/worktrees/draft'); assert.equal(e.stale.value, true);
  e.reload(); assert.equal(e.worktreeDirectory.value, '/worktrees/external');
  e.worktreeDirectory.value = '/private/unsaved'; e.state.unlocked = false; e.state.draftEpoch++; await nextTick();
  assert.equal(e.worktreeDirectory.value, ''); assert.equal(e.dirty.value, false);
});


test('native preparation blocks save and sync without locking drafts, then ready restores actions', async t => {
  const e = await editor(t), writes = [];
  e.entries.value[0].branch = 'draft-branch'; e.worktreeDirectory.value = '/draft/worktrees';
  e.onSave(async (path, body) => { writes.push({ path, body }); return undefined; });
  for (const state of ['preparing', 'starting']) {
    e.state.environment.repositories.nativeWork = { state, message: 'Native work is pending.' }; await nextTick();
    assert.equal(e.editingLocked.value, false, 'startup cannot lock editable assignments');
    await e.save(); await e.sync('web'); assert.equal(writes.length, 0);
    assert.equal(e.entries.value[0].branch, 'draft-branch'); assert.equal(e.worktreeDirectory.value, '/draft/worktrees');
    assert.equal(e.stale.value, false); assert.equal(e.dirty.value, true);
  }
  e.state.environment.repositories.nativeWork = { state: 'ready', message: null }; await nextTick();
  assert.equal(e.nativeReadiness.value, null);
  await e.sync('web'); await e.save();
  assert.deepEqual(writes.map(item => item.path), ['/api/repositories', '/api/settings']);
  assert.equal(writes[1].body.repositories.items[0].branch, 'draft-branch');
  assert.equal(e.entries.value[0].branch, 'draft-branch', 'a failed save still retains the editable draft');
});
