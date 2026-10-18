import { requiredValue } from '../ui/helpers/required-value.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { normalizeSource } from '../helpers/source-text.mjs';
import { reactive, ref, computed, watch, nextTick, defineComponent } from 'vue';
import { parse, compileScript } from '@vue/compiler-sfc';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { providerSupportsDefinition } = await frontend('src/worker/application/provider-contract.ts');
const { validateApprovedPaths } = await frontend('src/worker/application/approved-paths.ts');
const { buildWorkerCapacityView } = await frontend('src/worker/webview/worker-capacity.ts');
// Compile the actual unified composer; keep its production validation and worker port under test.
async function editorFixture(action, sourceTransform = source => source) {
  const source = normalizeSource(sourceTransform(await readFile(new URL('../../src/worker/webview/components/TaskIntake.vue', import.meta.url), 'utf8')));
  const { descriptor, errors } = parse(source, { filename: 'TaskIntake.vue' }); assert.deepEqual(errors, []);
  const scripts = compileScript(descriptor, { id: 'request-editor-fixture', genDefaultAs: 'EditorComponent' }).content.replace(/^import .*\n/gm, '');
  const state = reactive({ draftEpoch: 0, unlocked: true, workspaceBusy: false, environment: {}, draft: 'Existing follow-up draft', actionError: '', settings: { repositories: { items: [] }, providers: [{ id: 'codex-cli', configured: true }, { id: 'claude-cli', configured: true }] }, sessions: { selected: 'one', records: [{ id: 'one', provider: 'codex-cli' }, { id: 'two', provider: 'claude-cli' }] }, definitions: [], toolAccess: null });
  const javascript = ts.transpile(scripts, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const focused = [], events = [];
  const ports = { _defineComponent: defineComponent, reactive, ref, computed, watch, watchPrivateDraft: watch, nextTick, state, workerState: state, createFeatureRequest: action, providerSupportsDefinition, validateApprovedPaths, buildWorkerCapacityView, getCapacityFreshness: () => 'fresh', document: { getElementById: id => ({ focus: () => focused.push(id) }) }, UButton: null, UInput: null, USelect: null, UTextarea: null, RunTask: null, SharedFeatureComposer: null, ModelSelectionFields: null };
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
  assert.equal(commands.length, 1); assert.equal(commands[0].action, 'create'); assert.equal(commands[0].background, true); assert.deepEqual(commands[0].files, { repository: '/project', paths: ['src/a.ts'] });
  assert.equal(commands[0].message, 'Clarify the navigation.'); assert.equal(commands[0].provider, 'codex-cli');
  pending.resolve({ session: { id: 'local-' + commands[0].id }, chat: {} }); await creating;
  assert.equal(f.state.draft, 'Existing follow-up draft'); assert.equal(f.intake.message, ''); assert.equal(f.intake.fileChanges, false);
  assert.ok(f.events.some(([event, id]) => event === 'created' && id === 'local-' + commands[0].id));
});
test('ordinary requests omit file permissions even when repository paths were drafted earlier', async () => {
  let submitted = /** @type {{ value?: import('../../src/worker/webview/store.ts').FeatureRequestCommand }} */ ({}); const f = await editorFixture(async command => { submitted.value = command; return { session: { id: command.id }, chat: {} }; });
  assert.equal(f.intake.fileChanges, false); await f.create(); assert.equal(requiredValue(submitted.value).files, undefined); assert.equal(requiredValue(submitted.value).message, 'Clarify the navigation.');
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
  let submitted = /** @type {{ value?: import('../../src/worker/webview/store.ts').FeatureRequestCommand }} */ ({}); const f = await editorFixture(async command => { submitted.value = command; return { session: { id: command.id }, chat: {} }; });
  f.state.settings.repositories.items = [{ id: 'web', path: '/projects/web' }, { id: 'api', path: '/projects/api' }]; f.intake.fileChanges = true;
  f.intake.repository = 'missing'; assert.equal(f.canCreate.value, false); f.intake.repository = 'web';
  for (const paths of ['../secret', '.env', 'src/a.ts\nsrc/a.ts', 'secrets.json', '']) { f.intake.paths = paths; assert.equal(f.canCreate.value, false, paths); }
  f.intake.paths = 'src/a.ts\nsrc/new.ts'; assert.equal(f.canCreate.value, true); await f.create(); assert.equal(requiredValue(requiredValue(submitted.value).files).repository, 'web');
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


test('the request composer reports CLI-only grants and returns to all tools off after revocation', async () => {
  const f = await editorFixture(async () => undefined);
  assert.equal(f.toolSummary.value, 'Access not loaded');
  f.state.toolAccess = { builtins: { files: false, commands: [], cliTools: [{ id: 'project', enabled: true }], webOrigins: [] }, mcp: [] };
  assert.equal(f.toolSummary.value, 'Grants configured');
  f.state.toolAccess.builtins.cliTools[0].enabled = false;
  assert.equal(f.toolSummary.value, 'All tools off');
  delete f.state.toolAccess.builtins.cliTools;
  assert.equal(f.toolSummary.value, 'All tools off', 'older snapshots grant no CLI access');
});

test('repository implementation preview requires file access and an enabled explicit fixed verification check', async () => {
  const source = normalizeSource(await readFile(new URL('../../src/worker/webview/components/RunTask.vue', import.meta.url), 'utf8'));
  const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
  const parsed = ts.createSourceFile('repository-options.ts', script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const body = ts.createPrinter().printFile(ts.factory.updateSourceFile(parsed, parsed.statements.filter(statement => !ts.isImportDeclaration(statement))));
  const state = reactive({ settings: { repositories: { items: [] } }, toolAccess: null });
  const values = new Function('computed', 'state', 'defineModel', ts.transpile(body, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }) + '\nreturn { requiredChecks, implementationEnabled };')(computed, state, name => ref(name === 'enabled' ? true : ''));
  assert.equal(values.implementationEnabled.value, false);
  state.toolAccess = { builtins: { files: true, commands: [{ id: 'test', name: 'Tests', enabled: true }], cliTools: [{ id: 'cli', enabled: true }] } };
  assert.equal(values.implementationEnabled.value, false, 'legacy presets and CLI grants do not become required checks');
  state.toolAccess.builtins.commands[0].verification = true;
  assert.equal(values.implementationEnabled.value, true); assert.equal(values.requiredChecks.value[0].name, 'Tests');
  state.toolAccess.builtins.commands[0].enabled = false; assert.equal(values.implementationEnabled.value, false);
  state.toolAccess.builtins.commands[0].enabled = true; state.toolAccess.builtins.files = false; assert.equal(values.implementationEnabled.value, false);
});


test('assigned repository choices display the complete checkout while the unified command submits its ID', async () => {
  let submitted = /** @type {{ value?: import('../../src/worker/webview/store.ts').FeatureRequestCommand }} */ ({});
  const f = await editorFixture(async command => { submitted.value = command; return { session: { id: command.id }, chat: {} }; });
  f.state.settings.repositories.items = [{ id: 'web', path: '/projects/long-checkout/web', remote: 'origin', watch: true }, { id: 'api', path: '/projects/api', remote: 'origin', watch: true }];
  f.intake.fileChanges = true; f.intake.repository = 'missing';
  assert.equal(f.canCreate.value, false);
  f.intake.repository = 'web'; assert.equal(f.canCreate.value, true);
  await f.create(); assert.equal(requiredValue(requiredValue(submitted.value).files).repository, 'web');
  const source = await readFile(new URL('../../src/worker/webview/components/RunTask.vue', import.meta.url), 'utf8');
  assert.match(source, /selectedRepository\.path/);
  assert.match(source, /:aria-describedby="[^"]*file-task-checkout/);
});


test('preparation progress retains instructions and operation until the durable session is confirmed', async () => {
  const pending = deferred();
  const progress = /** @type {{ value?: NonNullable<Parameters<typeof import('../../src/worker/webview/store.ts').createFeatureRequest>[1]> }} */ ({});
  const f = await editorFixture((command, observe) => { progress.value = observe; return pending.promise; });
  f.intake.fileChanges = true; const creating = f.create(); const id = f.intake.pending.id;
  const preparing = {
    id, title: 'Change', repository: '/project', error: null,
    createdAt: '2026-10-17T00:00:00Z', finishedAt: null,
  };
  requiredValue(progress.value)({ ...preparing, phase: 'worktree', state: 'preparing' });
  assert.equal(f.intake.message, 'Clarify the navigation.'); assert.equal(f.intake.paths, 'src/a.ts'); assert.equal(f.intake.pending.id, id);
  assert.match(f.preparationNote.value, /Git worktree/); assert.match(f.admissionNote.value, /has not joined the queue/); assert.equal(f.canCreate.value, false);
  assert.ok(!f.events.some(([event]) => event === 'created'));
  requiredValue(progress.value)({ ...preparing, phase: 'admission', state: 'preparing' }); assert.match(f.preparationNote.value, /Saving approved files/);
  pending.resolve({ session: { id: 'local-' + id }, chat: {} }); await creating;
  assert.equal(f.intake.pending, null); assert.equal(f.preparation.value, null); assert.equal(f.intake.message, '');
});


test('new FR model and effort choices are frozen in the same retry command', async () => {
  const commands = []; let fail = true;
  const f = await editorFixture(async command => { commands.push(structuredClone(command)); if (fail) throw Error('Lost acknowledgement'); return { session: { id: 'accepted' }, chat: {} }; });
  f.intake.model = 'chosen-model'; f.intake.effort = 'high'; await f.create();
  assert.equal(commands[0].model, 'chosen-model'); assert.equal(commands[0].effort, 'high');
  f.intake.model = 'later-edit'; f.intake.effort = 'low'; fail = false; await f.create();
  assert.deepEqual(commands[1], commands[0]);
});
test('inherited model and effort stay omitted while later default refresh keeps an operator choice', async () => {
  const commands = [];
  const f = await editorFixture(async command => { commands.push(command); return { session: { id: 'accepted' }, chat: {} }; });
  f.intake.provider = undefined;
  Object.assign(f.state.settings, { defaultProvider: 'claude-cli' });
  f.state.settings.providers = [...f.state.settings.providers]; await nextTick();
  assert.equal(f.intake.provider, 'claude-cli');
  f.intake.provider = 'codex-cli'; f.state.settings.providers = [...f.state.settings.providers]; await nextTick();
  assert.equal(f.intake.provider, 'codex-cli'); await f.create();
  assert.equal(commands[0].model, undefined); assert.equal(commands[0].effort, undefined);
});


test('new requests reset selection while active and explicitly chosen drafts survive default changes', async () => {
  const pending = deferred(); const f = await editorFixture(() => pending.promise);
  Object.assign(f.state.settings, { defaultProvider: 'codex-cli' });
  Object.assign(f.intake, { model: 'first-model', effort: 'high', selectionEdited: true });
  const creating = f.create(); Object.assign(f.state.settings, { defaultProvider: 'claude-cli' }); await nextTick();
  assert.equal(f.intake.provider, 'codex-cli'); assert.equal(f.intake.model, 'first-model'); assert.equal(f.intake.pending.effort, 'high');
  pending.resolve({ session: { id: 'accepted' }, chat: {} }); await creating;
  assert.equal(f.intake.provider, 'claude-cli'); assert.equal(f.intake.model, ''); assert.equal(f.intake.effort, '');
  Object.assign(f.state.settings, { defaultProvider: 'codex-cli' }); await nextTick(); assert.equal(f.intake.provider, 'codex-cli');
  f.intake.message = 'A started draft'; Object.assign(f.state.settings, { defaultProvider: 'claude-cli' }); await nextTick(); assert.equal(f.intake.provider, 'codex-cli');
  f.intake.message = ''; f.intake.selectionEdited = true; Object.assign(f.state.settings, { defaultProvider: 'codex-cli' }); await nextTick();
  Object.assign(f.state.settings, { defaultProvider: 'claude-cli' }); await nextTick(); assert.equal(f.intake.provider, 'codex-cli');
});
