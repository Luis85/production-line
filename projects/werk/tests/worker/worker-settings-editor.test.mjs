import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { nextTick } from 'vue';
const root = fileURLToPath(new URL('../../', import.meta.url));
async function editor(t) {
  const component = await readFile(join(root, 'src/worker/webview/components/SettingsPanel.vue'), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import U(?:Button|Input|Select).*\n/gm, '')
    .replace(/^import \{ state,.*\n/gm, '')
    .replace(/^defineProps.*\n/gm, '');
  const fixture = { unlocked: true, settings: { providers: [{ id: 'codex-cli', executable: '/old/codex', model: 'old-model', hasApiKey: false }], connection: { enabled: true, url: 'http://old.example', hasEnrollmentToken: true } } };
  const harness = `import { reactive } from 'vue';
export const state = reactive(${JSON.stringify(fixture)});
let action = async () => undefined;
export function onSave(handler) { action = handler; }
const workspaceAction = (...args) => action(...args);
const request = async () => ({ message: 'Checked', authentication: 'signed-in', checkedAt: '2026-10-14T00:00:00Z' });
const date = value => value;
${script}
export { provider, executable, model, key, clearKey, url, enrollment, busy, checking, message, providerNotice, connectionNotice, editingLocked, dirty, connectionDirty, fillProvider, fillConnection, save };
`;
  await mkdir(join(root, 'work'), { recursive: true });
  const directory = await mkdtemp(join(root, 'work/settings-editor-')), path = join(directory, 'editor.mjs');
  await writeFile(path, ts.transpileModule(harness, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return import(pathToFileURL(path).href);
}
test('pristine settings editors adopt changed saved values, while dirty edits require explicit reload', async t => {
  const e = await editor(t);
  e.state.settings.providers[0].executable = '/new/codex';
  e.state.settings.connection.url = 'http://new.example'; await nextTick();
  assert.equal(e.executable.value, '/new/codex'); assert.equal(e.url.value, 'http://new.example');
  e.model.value = 'unsaved-model'; e.enrollment.value = 'unsaved-token';
  e.state.settings.providers[0].model = 'external-model';
  e.state.settings.connection.url = 'http://external.example'; await nextTick();
  assert.equal(e.model.value, 'unsaved-model'); assert.equal(e.enrollment.value, 'unsaved-token');
  assert.equal(e.url.value, 'http://new.example');
  assert.match(e.providerNotice.value, /changed elsewhere.*edits are kept/);
  assert.match(e.connectionNotice.value, /changed elsewhere.*edits are kept/);
  e.fillProvider(); e.fillConnection();
  assert.equal(e.model.value, 'external-model'); assert.equal(e.url.value, 'http://external.example');
  assert.equal(e.enrollment.value, ''); assert.equal(e.providerNotice.value, ''); assert.equal(e.connectionNotice.value, '');
});
test('saving snapshots input, prevents duplicate submission, and preserves newer edits and the other form secret', async t => {
  const e = await editor(t); let finish, submissions = [];
  e.onSave(async (path, body) => { submissions.push(body); await new Promise(resolve => { finish = resolve; }); return e.state.settings; });
  e.key.value = 'submitted-key'; e.enrollment.value = 'other-form-token';
  const body = { provider: { id: e.provider.value, executable: e.executable.value, model: e.model.value, apiKey: e.key.value } };
  const saving = e.save(body); assert.equal(e.editingLocked.value, true);
  body.provider.apiKey = 'mutated-object'; e.key.value = 'newer-unsaved-key';
  await e.save(body); assert.equal(submissions.length, 1); assert.equal(submissions[0].provider.apiKey, 'submitted-key');
  finish(); await saving;
  assert.equal(e.key.value, 'newer-unsaved-key'); assert.equal(e.enrollment.value, 'other-form-token'); assert.equal(e.editingLocked.value, false);
  e.onSave(async () => e.state.settings);
  await e.save({ provider: { id: e.provider.value, apiKey: e.key.value } });
  assert.equal(e.key.value, ''); assert.equal(e.enrollment.value, 'other-form-token');
  e.key.value = 'other-provider-secret';
  await e.save({ connection: { enabled: true, url: e.url.value, enrollmentToken: e.enrollment.value } });
  assert.equal(e.enrollment.value, ''); assert.equal(e.key.value, 'other-provider-secret');
});
test('lock during an outstanding settings save clears secrets and does not publish stale success', async t => {
  const e = await editor(t); let finish;
  e.onSave(async () => { await new Promise(resolve => { finish = resolve; }); return e.state.settings; });
  e.key.value = 'private-key'; e.enrollment.value = 'private-enrollment';
  const saving = e.save({ provider: { id: e.provider.value, apiKey: e.key.value } });
  e.state.unlocked = false; await nextTick();
  assert.equal(e.key.value, ''); assert.equal(e.enrollment.value, '');
  finish(); await saving; assert.equal(e.message.value, ''); assert.equal(e.busy.value, false);
});
