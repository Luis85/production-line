import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { normalizeSource } from '../helpers/source-text.mjs';
import { reactive, ref, computed, watch, nextTick, defineComponent } from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { validateApprovedPaths } = await frontend('src/worker/application/approved-paths.ts');
const { buildWorkerCapacityView } = await frontend('src/worker/webview/worker-capacity.ts');
// Compile the actual unified composer; keep its production validation and worker port under test.
async function editorFixture(action, sourceTransform = source => source) {
  const source = normalizeSource(sourceTransform(await readFile(new URL('../../src/worker/webview/components/TaskIntake.vue', import.meta.url), 'utf8')));
  const { descriptor, errors } = parse(source, { filename: 'TaskIntake.vue' }); assert.deepEqual(errors, []);
  const scripts = compileScript(descriptor, { id: 'request-editor-fixture', genDefaultAs: 'EditorComponent' }).content.replace(/^import .*\n/gm, '');
  const state = reactive({ draftEpoch: 0, unlocked: true, workspaceBusy: false, draft: 'Existing follow-up draft', actionError: '', settings: { repositories: { items: [] }, providers: [{ id: 'codex-cli', configured: true }, { id: 'claude-cli', configured: true }] }, sessions: { selected: 'one', records: [{ id: 'one', provider: 'codex-cli' }, { id: 'two', provider: 'claude-cli' }] }, definitions: [], toolAccess: null });
  const javascript = ts.transpile(scripts, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const focused = [], events = [];
  const ports = { _defineComponent: defineComponent, reactive, ref, computed, watch, watchPrivateDraft: watch, nextTick, state, workerState: state, createFeatureRequest: action, validateApprovedPaths, buildWorkerCapacityView, getCapacityFreshness: () => 'fresh', document: { getElementById: id => ({ focus: () => focused.push(id) }) }, UButton: null, UInput: null, USelect: null, UTextarea: null, RunTask: null };
  // The emit closure is deliberately injected as part of the component's real setup context.
  const result = new Function(...Object.keys(ports), 'events', `${javascript}\nreturn EditorComponent.setup({}, { expose() {}, emit(...args) { events.push(args); } });`)(...Object.values(ports), events);
  Object.assign(result.intake, { message: 'Clarify the navigation.', title: 'Change', repository: '/project', paths: 'src/a.ts' });
  return { ...result, state, focused, events };
}
test('one instructions/provider draft survives task switching and expiry; explicit Lock clears file approval too', async () => {
  const f = await editorFixture(async () => undefined); f.intake.fileChanges = true;
  f.state.sessions.selected = 'two'; f.state.draft = 'Other request follow-up';
  assert.equal(f.intake.provider, 'codex-cli'); assert.equal(f.intake.message, 'Clarify the navigation.');
  f.state.unlocked = false; await nextTick(); assert.equal(f.intake.repository, '/project'); assert.equal(f.canCreate.value, false);
  f.state.draftEpoch++; assert.equal(f.intake.message, ''); assert.equal(f.intake.repository, ''); assert.equal(f.intake.fileChanges, false); assert.equal(f.intake.pending, null);
});
test('file edits are opt-in and use the single request command, with duplicate submission suppressed', async () => {
  const commands = [], pending = deferred();
  const f = await editorFixture(command => { commands.push(structuredClone(command)); return pending.promise; });
  f.intake.fileChanges = true; const creating = f.create(); await f.create();
  assert.equal(commands.length, 1); assert.equal(commands[0].action, 'create'); assert.deepEqual(commands[0].files, { repository: '/project', paths: ['src/a.ts'] });
  assert.equal(commands[0].message, 'Clarify the navigation.'); assert.equal(commands[0].provider, 'codex-cli');
  pending.resolve({ session: { id: 'local-' + commands[0].id }, chat: {} }); await creating;
  assert.equal(f.state.draft, 'Existing follow-up draft'); assert.equal(f.intake.message, ''); assert.equal(f.intake.fileChanges, false);
  assert.ok(f.events.some(([event, id]) => event === 'created' && id === 'local-' + commands[0].id));
});
test('ordinary requests omit file permissions even when repository paths were drafted earlier', async () => {
  let submitted; const f = await editorFixture(async command => { submitted = command; return { session: { id: command.id }, chat: {} }; });
  assert.equal(f.intake.fileChanges, false); await f.create(); assert.equal(submitted.files, undefined); assert.equal(submitted.message, 'Clarify the navigation.');
});
test('provider mismatch and missing adaptation block the unified request; rejected input stays editable', async () => {
  let calls = 0; const f = await editorFixture(async () => { calls++; throw Object.assign(Error('Invalid repository'), { status: 400 }); });
  f.intake.fileChanges = true; f.state.definitions = [{ id: 'agent', agents: [{ name: 'root', provider: 'anthropic', requiresAdaptation: true }] }];
  f.intake.definitionId = 'agent'; await nextTick(); await f.create(); assert.equal(calls, 0);
  f.intake.provider = 'claude-cli'; await f.create(); assert.equal(calls, 0);
  f.intake.adapt = true; await f.create(); assert.equal(calls, 1); assert.equal(f.intake.pending, null);
  assert.equal(f.intake.error, 'Invalid repository'); assert.equal(f.intake.message, 'Clarify the navigation.'); assert.equal(f.intake.repository, '/project');
});
for (const status of [undefined, 409, 500, 401]) test(`ambiguous admission ${status ?? 'network'} keeps the exact operation and original input for retry`, async () => {
  const commands = []; let fail = true;
  const f = await editorFixture(async command => { commands.push(structuredClone(command)); if (fail) throw Object.assign(Error('Acknowledgement unavailable'), status ? { status } : {}); return { session: { id: 'accepted-request' }, chat: {} }; });
  f.intake.fileChanges = true; await f.create(); assert.ok(f.intake.pending); const id = f.intake.pending.id;
  f.intake.message = 'A later programmatic edit'; f.intake.paths = 'src/another.ts'; fail = false; await f.create();
  assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]); assert.equal(commands[1].id, id); assert.equal(f.intake.message, 'A later programmatic edit');
});
test('collapsing optional repository fields retains input and the single composer can restore keyboard focus', async () => {
  const f = await editorFixture(async () => undefined); f.intake.fileChanges = true; f.filesOpen.value = true; f.filesOpen.value = false;
  assert.equal(f.intake.repository, '/project'); assert.equal(f.intake.paths, 'src/a.ts'); assert.equal(f.intake.message, 'Clarify the navigation.');
  await f.focusInstructions(); assert.equal(f.focused.at(-1), 'new-task-instructions');
});
test('assigned IDs, unsafe paths and duplicates are validated before granting file changes', async () => {
  let submitted; const f = await editorFixture(async command => { submitted = command; return { session: { id: command.id }, chat: {} }; });
  f.state.settings.repositories.items = [{ id: 'web', path: '/projects/web' }, { id: 'api', path: '/projects/api' }]; f.intake.fileChanges = true;
  f.intake.repository = 'missing'; assert.equal(f.canCreate.value, false); f.intake.repository = 'web';
  for (const paths of ['../secret', '.env', 'src/a.ts\nsrc/a.ts', 'secrets.json', '']) { f.intake.paths = paths; assert.equal(f.canCreate.value, false, paths); }
  f.intake.paths = 'src/a.ts\nsrc/new.ts'; assert.equal(f.canCreate.value, true); await f.create(); assert.equal(submitted.files.repository, 'web');
});
test('explicit lock during creation clears the operation and ignores its late identity', async () => {
  const pending = deferred(), f = await editorFixture(() => pending.promise); const creating = f.create();
  f.state.draftEpoch++; f.state.unlocked = false; pending.resolve({ session: { id: 'late-private' }, chat: {} }); await creating;
  assert.equal(f.intake.pending, null); assert.equal(f.intake.message, ''); assert.equal(f.intake.error, ''); assert.ok(!f.events.some(([event]) => event === 'created'));
});


test('CRLF checkout source executes the real unified composer and preserves an ambiguous operation for retry', async () => {
  const commands = []; let fail = true;
  const f = await editorFixture(async command => {
    commands.push(structuredClone(command));
    if (fail) throw Error('Acknowledgement unavailable');
    return { session: { id: 'local-' + command.id }, chat: {} };
  }, source => source.replace(/\r?\n/g, '\r\n'));
  f.intake.fileChanges = true; await f.create();
  assert.ok(f.intake.pending); assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].files, { repository: '/project', paths: ['src/a.ts'] });
  fail = false; await f.create();
  assert.deepEqual(commands[1], commands[0]);
  assert.equal(f.intake.pending, null);
  assert.ok(f.events.some(([event, id]) => event === 'created' && id === 'local-' + commands[0].id));
  assert.equal(f.state.draft, 'Existing follow-up draft');
});
