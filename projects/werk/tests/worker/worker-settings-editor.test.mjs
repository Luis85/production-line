import { normalizeSource } from '../helpers/source-text.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { nextTick } from 'vue';
const root = fileURLToPath(new URL('../../', import.meta.url));
async function editor(t) {
  const component = normalizeSource(await readFile(join(root, 'src/worker/webview/components/SettingsPanel.vue'), 'utf8'));
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import U(?:Button|Input|Select).*\n/gm, '')
    .replace(/^import \{ state,.*\n/gm, '')
    .replace(/^defineProps.*\n/gm, '');
  const fixture = { unlocked: true, settings: { defaultProvider: 'codex-cli', providers: [{ id: 'codex-cli', executable: '/old/codex', model: 'old-model', hasApiKey: false }], connection: { enabled: true, url: 'http://old.example', hasEnrollmentToken: true } } };
  const harness = `import { reactive } from 'vue';
export const state = reactive(${JSON.stringify(fixture)});
let action = async () => undefined;
export function onSave(handler) { action = handler; }
const workspaceAction = (...args) => action(...args);
const request = async () => ({ message: 'Checked', authentication: 'signed-in', checkedAt: '2026-10-14T00:00:00Z' });
const date = value => value;
${script}
export { providerCommand, authenticationMode, accountConnectionKey, provider, executable, model, effort, defaultProvider, defaultBaseline, defaultNotice, defaultDirty, fillDefault, key, clearKey, url, enrollment, busy, checking, message, providerNotice, connectionNotice, editingLocked, dirty, connectionDirty, fillProvider, fillConnection, save };
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
  const e = await editor(t); const { promise: held, resolve: finish } = Promise.withResolvers(); const submissions = [];
  e.onSave(async (path, body) => { submissions.push(body); await held; return e.state.settings; });
  e.key.value = 'submitted-key'; e.enrollment.value = 'other-form-token';
  const body = { provider: { id: e.provider.value, executable: e.executable.value, model: e.model.value, apiKey: e.key.value } };
  const saving = e.save(body); assert.equal(e.editingLocked.value, true);
  body.provider.apiKey = 'mutated-object'; e.key.value = 'newer-unsaved-key';
  await e.save(body); assert.equal(submissions.length, 1); assert.equal(submissions[0].provider.apiKey, 'submitted-key');
  finish(undefined); await saving;
  assert.equal(e.key.value, 'newer-unsaved-key'); assert.equal(e.enrollment.value, 'other-form-token'); assert.equal(e.editingLocked.value, false);
  e.onSave(async () => e.state.settings);
  await e.save({ provider: { id: e.provider.value, apiKey: e.key.value } });
  assert.equal(e.key.value, ''); assert.equal(e.enrollment.value, 'other-form-token');
  e.key.value = 'other-provider-secret';
  await e.save({ connection: { enabled: true, url: e.url.value, enrollmentToken: e.enrollment.value } });
  assert.equal(e.enrollment.value, ''); assert.equal(e.key.value, 'other-provider-secret');
});
test('lock during an outstanding settings save clears secrets and does not publish stale success', async t => {
  const e = await editor(t); const { promise: held, resolve: finish } = Promise.withResolvers();
  e.onSave(async () => { await held; return e.state.settings; });
  e.key.value = 'private-key'; e.enrollment.value = 'private-enrollment';
  const saving = e.save({ provider: { id: e.provider.value, apiKey: e.key.value } });
  e.state.unlocked = false; await nextTick();
  assert.equal(e.key.value, ''); assert.equal(e.enrollment.value, '');
  finish(undefined); await saving; assert.equal(e.message.value, ''); assert.equal(e.busy.value, false);
});


test('model effort and default provider drafts survive polling and save the expected baseline', async t => {
  const e = await editor(t); e.effort.value = 'high';
  Object.assign(e.state.settings.providers[0], { effort: 'low' }); await nextTick();
  assert.equal(e.effort.value, 'high'); assert.match(e.providerNotice.value, /changed elsewhere/);
  e.fillProvider(); assert.equal(e.effort.value, 'low');
  e.defaultProvider.value = 'claude-cli'; e.state.settings.defaultProvider = 'cursor-cli'; await nextTick();
  assert.equal(e.defaultProvider.value, 'claude-cli'); assert.equal(e.defaultBaseline.value, 'codex-cli'); assert.match(e.defaultNotice.value, /changed elsewhere/);
  e.fillDefault(); assert.equal(e.defaultProvider.value, 'cursor-cli'); assert.equal(e.defaultDirty.value, false);
  e.defaultProvider.value = 'claude-cli'; let submitted;
  e.onSave(async (path, body) => { submitted = body; e.state.settings.defaultProvider = body.defaultProvider; return e.state.settings; });
  await e.save({ defaultProvider: e.defaultProvider.value, expectedDefaultProvider: e.defaultBaseline.value });
  assert.deepEqual(submitted, { defaultProvider: 'claude-cli', expectedDefaultProvider: 'cursor-cli' });
  assert.equal(e.defaultDirty.value, false); assert.equal(e.defaultNotice.value, '');
});


test('Cursor optional key save and removal use the guarded provider command and invalidate account evidence', async t => {
  const e = await editor(t), submitted = [];
  e.state.settings.providers.push({ id: 'cursor-cli', executable: '/bin/agent', model: 'auto', effort: 'default', hasApiKey: false, authenticationMode: 'cli-account' });
  e.provider.value = 'cursor-cli'; await nextTick(); const before = e.accountConnectionKey.value;
  e.onSave(async (path, body) => { submitted.push(structuredClone(body)); e.state.settings.providers[1].hasApiKey = !body.provider.clearApiKey; e.state.settings.providers[1].authenticationMode = body.provider.authenticationMode; return e.state.settings; });
  e.authenticationMode.value = 'api-key'; e.key.value = 'illustrative-key'; await e.save(e.providerCommand());
  assert.deepEqual(submitted[0], { provider: { id: 'cursor-cli', executable: '/bin/agent', model: 'auto', effort: 'default', authenticationMode: 'api-key', apiKey: 'illustrative-key', clearApiKey: false } });
  assert.equal(e.key.value, ''); assert.notEqual(e.accountConnectionKey.value, before); assert.doesNotMatch(e.accountConnectionKey.value, /illustrative-key/);
  const saved = e.accountConnectionKey.value; e.authenticationMode.value = 'cli-account'; e.clearKey.value = true; await e.save(e.providerCommand());
  assert.equal(submitted[1].provider.authenticationMode, 'cli-account'); assert.equal(submitted[1].provider.clearApiKey, true); assert.equal(submitted[1].provider.apiKey, ''); assert.equal(e.clearKey.value, false);
  assert.notEqual(e.accountConnectionKey.value, saved);
});
