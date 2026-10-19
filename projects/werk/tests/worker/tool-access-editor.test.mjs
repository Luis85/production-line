import { requiredValue } from '../ui/helpers/required-value.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createToolAccessEditor } = await frontend('src/worker/webview/tool-access-editor.ts');
const connection = () => ({ id: 'docs', name: 'Documentation', transport: 'http', enabled: false, command: '', args: [], url: 'https://tools.example.com/mcp', secretEnv: '', hasSecret: true, allowedTools: [], discoveredTools: [{ name: 'search', description: 'Search documentation', inputSchema: { type: 'object', properties: {} } }] });
const view = (revision = 0) => ({ schemaVersion: 1, revision, builtins: { files: false, commands: [], webOrigins: [] }, mcp: [connection()], canEdit: true, saveBlockedReason: null });
function editor(t) {
  const state = reactive({ unlocked: true, epoch: 0, view: view() });
  let write = async command => { state.view = { ...view(state.view.revision + 1), builtins: command.builtins, mcp: command.mcp.map(({ secret, clearSecret, ...item }) => ({ ...item, hasSecret: !!secret || !clearSecret, discoveredTools: connection().discoveredTools })) }; return state.view; }, discover = async (_command) => state.view, refresh = async () => {};
  const e = createToolAccessEditor({ view: () => state.view, unlocked: () => state.unlocked, epoch: () => state.epoch, write: async command => { const result = await write(command); if (result && state.unlocked) state.view = result; return result; }, discover: command => discover(command), refresh: () => refresh() });
  t.after(e.dispose);
  return { ...e, state, onWrite: fn => { write = fn; }, onDiscover: fn => { discover = fn; }, onRefresh: fn => { refresh = fn; } };
}
test('tool access defaults are off and saved updates require paused drained authority', async t => {
  const e = editor(t); assert.equal(e.draft.files, false); assert.deepEqual(e.draft.mcp[0].allowedTools, []); assert.equal(e.canSave.value, false);
  e.draft.files = true; e.state.view.canEdit = false; let writes = 0; e.onWrite(async () => { writes++; }); await e.save(); assert.equal(writes, 0);
  e.state.view.canEdit = true; assert.equal(e.canSave.value, true); e.onWrite(async command => { assert.equal(command.expectedRevision, 0); assert.equal(command.builtins.files, true); return { ...view(1), builtins: command.builtins }; }); await e.save(); assert.equal(e.dirty.value, false); assert.match(e.draft.notice, /saved/);
});
test('background updates preserve unsaved grants and force explicit conflict reconciliation', async t => {
  const e = editor(t); e.draft.files = true; e.state.view = view(1); await nextTick(); assert.equal(e.draft.files, true); assert.equal(e.stale.value, true); assert.equal(e.canSave.value, false);
  e.reload(); assert.equal(e.draft.files, false); assert.equal(e.stale.value, false);
  e.draft.files = true; e.onWrite(async () => { throw Object.assign(Error('Access changed'), { status: 409 }); }); e.onRefresh(async () => { e.state.view = view(2); }); await e.save(); assert.equal(e.draft.uncertain, null); assert.equal(e.draft.files, true); assert.equal(e.stale.value, true);
});
test('secret inputs preserve, replace and remove without trusting a changed server destination', async t => {
  const e = editor(t); let submitted = /** @type {{ value?: import('../../src/worker/application/tool-policy.js').ToolAccessUpdate }} */ ({}); e.onWrite(async command => { submitted.value = command; return undefined; });
  e.draft.mcp[0].enabled = true; e.draft.mcp[0].allowedTools = ['search']; await e.save(); assert.equal('secret' in requiredValue(submitted.value).mcp[0], false); assert.equal('clearSecret' in requiredValue(submitted.value).mcp[0], false);
  e.resolveUncertain(); e.draft.mcp[0].secret = 'replacement-fixture'; await e.save(); assert.equal(requiredValue(submitted.value).mcp[0].secret, 'replacement-fixture');
  e.resolveUncertain(); e.draft.mcp[0].clearSecret = true; await e.save(); assert.equal(requiredValue(submitted.value).mcp[0].clearSecret, true);
  e.resolveUncertain(); e.draft.mcp[0].url = 'https://other.example.com/mcp'; e.draft.mcp[0].allowedTools = ['search']; assert.equal(e.destinationChanged(e.draft.mcp[0]), true); await e.save(); assert.deepEqual(requiredValue(submitted.value).mcp[0].allowedTools, []);
});
test('local MCP connections may omit the secret variable unless a secret is entered', async t => {
  const e = editor(t); e.addMcp(); const item = e.draft.mcp[1]; Object.assign(item, { name: 'Local', command: '/usr/bin/mcp-server', secretEnv: '' });
  assert.equal(e.validation.value, '');
  let submitted = /** @type {{ value?: import('../../src/worker/application/tool-policy.js').ToolAccessUpdate }} */ ({}); e.onWrite(async command => { submitted.value = command; return undefined; }); await e.save(); assert.equal(requiredValue(submitted.value).mcp[1].secretEnv, ''); assert.equal('secret' in requiredValue(submitted.value).mcp[1], false);
  e.resolveUncertain(); e.draft.mcp.push({ ...item, id: 'local-secret', secret: 'fixture-secret' }); assert.match(e.validation.value, /Name the environment variable/);
  e.draft.mcp[e.draft.mcp.length - 1].secretEnv = 'lower'; assert.match(e.validation.value, /uppercase/);
  e.draft.mcp[e.draft.mcp.length - 1].secretEnv = 'LOCAL_TOKEN'; assert.equal(e.validation.value, '');
});
test('fixed command arguments preserve spaces and empty strings while rejecting malformed inputs', async t => {
  const e = editor(t); e.addCommand(); Object.assign(e.draft.commands[0], { name: 'Test', executable: '/usr/bin/tool', arguments: '["a b","", "  keep  "]', enabled: true });
  e.onWrite(async command => { assert.deepEqual(command.builtins.commands[0].args, ['a b', '', '  keep  ']); return { ...view(1), builtins: command.builtins }; }); await e.save();
  e.draft.commands[0].arguments = 'test --arg'; assert.match(e.validation.value, /JSON array/); e.draft.commands[0].arguments = '[]'; e.draft.commands[0].executable = 'tool'; assert.match(e.validation.value, /absolute/);
  e.draft.commands = []; e.draft.webOrigins = 'https://example.com/path'; assert.match(e.validation.value, /origins/);
});
test('discovery runs only against saved clean configuration and never grants returned tools', async t => {
  const e = editor(t); let discoveries = 0; e.onDiscover(async command => { discoveries++; assert.deepEqual(command, { id: 'docs', expectedRevision: 0 }); e.state.view = view(1); return e.state.view; });
  e.draft.mcp[0].name = 'Unsaved'; await e.discover('docs'); assert.equal(discoveries, 0); e.reload(); await e.discover('docs'); assert.equal(discoveries, 1); assert.deepEqual(e.draft.mcp[0].allowedTools, []); assert.match(e.draft.notice, /Select the tools/);
});
test('lost acknowledgements lock edits and permit an exact single-flight retry', async t => {
  const e = editor(t), first = deferred(), commands = []; e.draft.files = true;
  e.onWrite(async command => { commands.push(JSON.parse(JSON.stringify(command))); return first.promise; }); const saving = e.save(); await e.save(); assert.equal(commands.length, 1); first.reject(Error('Connection lost')); await saving;
  assert.equal(e.locked.value, true); e.onWrite(async command => { commands.push(JSON.parse(JSON.stringify(command))); return { ...view(1), builtins: command.builtins }; }); await e.retry(); assert.deepEqual(commands[0], commands[1]); assert.equal(e.draft.uncertain, null);
});
test('expiry clears secret input; explicit Lock clears all drafts and suppresses late acknowledgements', async t => {
  const e = editor(t); e.draft.files = true; e.draft.mcp[0].secret = 'private-fixture'; e.state.unlocked = false; e.state.view = null; await nextTick(); assert.equal(e.draft.files, true); assert.equal(e.draft.mcp[0].secret, '');
  e.state.unlocked = true; e.state.view = view(); await nextTick(); const pending = deferred(); e.onWrite(() => pending.promise); const saving = e.save(); e.state.epoch++; e.state.unlocked = false; e.state.view = null; pending.resolve(view(1)); await saving; assert.equal(e.draft.files, false); assert.deepEqual(e.draft.mcp, []); assert.equal(e.draft.notice, ''); assert.equal(e.draft.uncertain, null);
});


test('equivalent HTTP MCP addresses retain explicit grants and saved-secret preservation', async t => {
  const e = editor(t);
  e.state.view.mcp[0].url = 'https://tools.example.com/';
  e.state.view.mcp[0].allowedTools = ['search'];
  e.reload();
  e.draft.mcp[0].url = 'https://TOOLS.example.com:443';
  assert.equal(e.destinationChanged(e.draft.mcp[0]), false);
  let submitted = /** @type {{ value?: import('../../src/worker/application/tool-policy.js').ToolAccessUpdate }} */ ({});
  e.onWrite(async command => { submitted.value = command; return undefined; });
  await e.save();
  assert.deepEqual(requiredValue(submitted.value).mcp[0].allowedTools, ['search']);
  assert.equal('secret' in requiredValue(submitted.value).mcp[0], false);
  assert.equal('clearSecret' in requiredValue(submitted.value).mcp[0], false);
});

test('CLI tools are edited as one rule per line and saved as an argument policy', async t => {
  const { parseCliRules, formatCliRules } = await frontend('src/worker/webview/tool-access-editor.ts');
  const rules = [{ command: 'help', requireOneOf: [], refusedOptions: [] }, { command: 'backlog set', requireOneOf: ['--dry-run'], refusedOptions: [] }, { command: 'eol', requireOneOf: [], refusedOptions: ['--fix', '--hook'] }, { command: 'codegen', requireOneOf: ['--check', '--dry-run'], refusedOptions: ['--write'] }];
  assert.equal(formatCliRules(rules), 'help\nbacklog set requires --dry-run\neol refuses --fix --hook\ncodegen requires --check --dry-run refuses --write');
  assert.deepEqual(parseCliRules(formatCliRules(rules) + '\n\n'), rules);
  assert.throws(() => parseCliRules('backlog set requires dry-run'), /options such as --dry-run/);
  assert.throws(() => parseCliRules('one two three'), /one or two words/);
  const e = editor(t); e.state.view.workerNode = '/opt/node/bin/node'; e.addCliTool();
  assert.equal(e.draft.cliTools[0].executable, '/opt/node/bin/node', 'new CLI tools start with the worker Node.js');
  assert.equal(e.draft.cliTools[0].enabled, false, 'new CLI tools start disabled');
  Object.assign(e.draft.cliTools[0], { name: 'Harness', arguments: '["bin/harness.mjs"]', commands: 'help\nbacklog set requires --dry-run', refusedOptions: '--root, --config', enabled: true });
  let submitted = /** @type {{ value?: import('../../src/worker/application/tool-policy.js').ToolAccessUpdate }} */ ({}); e.onWrite(async command => { submitted.value = command; return undefined; }); await e.save();
  assert.deepEqual(requiredValue(submitted.value).builtins.cliTools, [{ id: 'cli-1', name: 'Harness', description: '', enabled: true, executable: '/opt/node/bin/node', args: ['bin/harness.mjs'], commands: [{ command: 'help', requireOneOf: [], refusedOptions: [] }, { command: 'backlog set', requireOneOf: ['--dry-run'], refusedOptions: [] }], refusedOptions: ['--root', '--config'], maxArgs: 24, maxArgLength: 500, outputKiB: 32, truncationHint: 'Narrow the command, for example with a filter, limit or summary option.', timeoutMs: null }]);
  e.resolveUncertain(); e.addCliTool();
  for (const [change, pattern] of /** @type {const} */ ([[{ executable: 'C:\\tools\\run.cmd' }, /\.bat or \.cmd/], [{ executable: 'C:\\Windows\\System32\\CMD.EXE' }, /cannot run cmd\.exe/], [{ executable: 'c:/windows/system32/cmd.exe' }, /cannot run cmd\.exe/],[{ executable: 'node' }, /absolute executable/], [{ commands: '' }, /at least one command/], [{ commands: 'help\nhelp' }, /once/], [{ commands: 'a b c' }, /one or two words/], [{ refusedOptions: 'root' }, /option names/], [{ outputKiB: 65 }, /output limit/], [{ maxArgs: 0 }, /maximum arguments/]])) {
    Object.assign(e.draft.cliTools[0], { name: 'Other', executable: '/opt/node/bin/node', commands: 'help', refusedOptions: '', outputKiB: 32, maxArgs: 24, id: 'cli-2' }, change);
    assert.match(e.validation.value, pattern, JSON.stringify(change));
  }
});


test('incomplete or repeated CLI permission clauses cannot be saved as unrestricted commands', async t => {
  const { parseCliRules } = await frontend('src/worker/webview/tool-access-editor.ts');
  const e = editor(t), writes = [];
  e.state.view.workerNode = '/opt/node/bin/node'; e.addCliTool();
  Object.assign(e.draft.cliTools[0], { name: 'Project CLI', enabled: true });
  e.onWrite(async command => { writes.push(structuredClone(command)); return { ...view(1), builtins: command.builtins }; });
  for (const line of [
    'backlog set requires', 'check refuses', 'backlog set requires refuses --write',
    'check refuses requires --dry-run', 'backlog set requires --dry-run refuses',
    'check requires --dry-run requires --check', 'check refuses --write refuses --fix',
    'check requires --dry-run refuses --write requires --check', 'check requires,,,',
  ]) {
    assert.throws(() => parseCliRules(line), /at least one option|only once/, line);
    e.draft.cliTools[0].commands = line;
    assert.match(e.validation.value, /at least one option|only once/, line);
    assert.equal(e.canSave.value, false, line);
    await e.save();
    assert.equal(e.draft.cliTools[0].commands, line, 'keep the invalid draft for correction');
  }
  assert.equal(writes.length, 0, 'no invalid policy reaches the worker');
  e.draft.cliTools[0].commands = 'backlog set requires --dry-run --check refuses --write --fix';
  assert.equal(e.canSave.value, true); await e.save();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].builtins.cliTools[0].commands, [{ command: 'backlog set', requireOneOf: ['--dry-run', '--check'], refusedOptions: ['--write', '--fix'] }]);
  assert.equal(e.dirty.value, false);
});

test('CLI grant drafts survive concurrent policy changes and explicit Lock clears them', async t => {
  const e = editor(t); e.state.view.workerNode = '/opt/node/bin/node'; e.addCliTool();
  Object.assign(e.draft.cliTools[0], { name: 'Project CLI', commands: 'check requires --dry-run', enabled: true });
  e.state.view = { ...view(1), workerNode: '/opt/node/bin/node' }; await nextTick();
  assert.equal(e.draft.cliTools[0].commands, 'check requires --dry-run');
  assert.equal(e.stale.value, true); assert.equal(e.canSave.value, false);
  e.state.epoch++; assert.deepEqual(e.draft.cliTools, []);
});

test('required feature checks are explicit, survive guarded saves, and remain distinct from command enablement', async t => {
  const e = editor(t); e.state.view.builtins.commands = [{ id: 'tests', name: 'Tests', executable: '/usr/bin/node', args: ['--test'], enabled: true }]; e.reload();
  assert.equal(e.draft.commands[0].verification, false, 'legacy command has no required-check authority');
  e.draft.commands[0].verification = true;
  let submitted = /** @type {{ value?: import('../../src/worker/application/tool-policy.js').ToolAccessUpdate }} */ ({}); e.onWrite(async command => { submitted.value = command; return { ...view(1), builtins: command.builtins }; }); await e.save();
  assert.equal(requiredValue(submitted.value).builtins.commands[0].verification, true); assert.equal(e.draft.commands[0].verification, true);
  e.draft.commands[0].enabled = false; await e.save();
  assert.equal(requiredValue(submitted.value).builtins.commands[0].verification, true); assert.equal(requiredValue(submitted.value).builtins.commands[0].enabled, false);
  e.addCommand(); assert.equal(e.draft.commands.at(-1).verification, false);
});
test('a required-check edit cannot overwrite a concurrent saved verification plan', async t => {
  const e = editor(t); e.state.view.builtins.commands = [{ id: 'tests', name: 'Tests', executable: '/usr/bin/node', args: ['--test'], enabled: true }]; e.reload();
  e.draft.commands[0].verification = true; e.state.view = view(1); await nextTick();
  assert.equal(e.stale.value, true); assert.equal(e.draft.commands[0].verification, true);
  let writes = 0; e.onWrite(async () => { writes++; }); await e.save(); assert.equal(writes, 0);
  e.state.epoch++; assert.deepEqual(e.draft.commands, []);
});


test('timeouts inherit by default and explicit overrides preserve millisecond precision and verification', async t => {
  const e = editor(t); e.state.view.workerNode = '/opt/node/bin/node';
  e.addCommand(); Object.assign(e.draft.commands[0], { name: 'Tests', executable: '/usr/bin/node', arguments: '["--test"]', verification: true, enabled: true });
  e.addCliTool(); Object.assign(e.draft.cliTools[0], { name: 'CLI', enabled: true });
  assert.equal(e.draft.commands[0].timeoutSeconds, ''); assert.equal(e.draft.cliTools[0].timeoutSeconds, ''); assert.equal(e.draft.mcp[0].timeoutSeconds, '');
  e.draft.commands[0].timeoutSeconds = '600'; e.draft.cliTools[0].timeoutSeconds = '1.501'; e.draft.mcp[0].timeoutSeconds = '45.125';
  let submitted = /** @type {{ value?: import('../../src/worker/application/tool-policy.js').ToolAccessUpdate }} */ ({}); e.onWrite(async command => { submitted.value = command; return undefined; }); await e.save();
  assert.equal(Object.hasOwn(requiredValue(submitted.value), 'limits'), false, 'Tool access has no competing invocation window.');
  assert.equal(requiredValue(submitted.value).builtins.commands[0].timeoutMs, 600000); assert.equal(requiredValue(submitted.value).builtins.commands[0].verification, true);
  assert.equal(requiredValue(submitted.value).builtins.cliTools[0].timeoutMs, 1501); assert.equal(requiredValue(submitted.value).mcp[0].timeoutMs, 45125);
});

test('clearing a saved timeout sends explicit null for every grant and lost acknowledgement retries that exact reset', async t => {
  const e = editor(t); e.state.view.workerNode = '/opt/node/bin/node'; e.addCommand(); e.addCliTool();
  Object.assign(e.draft.commands[0], { name: 'Tests', executable: '/usr/bin/node', enabled: true, verification: true, timeoutSeconds: 3 });
  Object.assign(e.draft.cliTools[0], { name: 'CLI', enabled: true, timeoutSeconds: 4 }); e.draft.mcp[0].timeoutSeconds = 5;
  await e.save(); assert.equal(e.dirty.value, false);
  e.draft.commands[0].timeoutSeconds = ''; e.draft.cliTools[0].timeoutSeconds = ''; e.draft.mcp[0].timeoutSeconds = '';
  const sent = []; e.onWrite(async command => { sent.push(JSON.parse(JSON.stringify(command))); throw Error('Acknowledgement lost'); });
  await e.save(); assert.equal(e.locked.value, true); await e.retry(); assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[0].builtins.commands[0].timeoutMs, null); assert.equal(sent[0].builtins.cliTools[0].timeoutMs, null); assert.equal(sent[0].mcp[0].timeoutMs, null);
  assert.equal(sent[0].builtins.commands[0].verification, true);
});

test('timeout bounds follow command and MCP transport ceilings without a second execution window', async t => {
  const e = editor(t); e.state.view.workerNode = '/opt/node/bin/node'; e.addCommand(); e.addCliTool();
  Object.assign(e.draft.commands[0], { name: 'Tests', executable: '/usr/bin/node' }); Object.assign(e.draft.cliTools[0], { name: 'CLI' });
  for (const item of [e.draft.commands[0], e.draft.cliTools[0]]) {
    item.timeoutSeconds = 3600; assert.equal(e.validation.value, '');
    for (const invalid of [3600.001, 0.999, 1.0001, 'invalid', Infinity]) { item.timeoutSeconds = invalid; assert.match(e.validation.value, /1–3,600 seconds/); assert.equal(e.canSave.value, false); }
    item.timeoutSeconds = '';
  }
  e.draft.mcp[0].timeoutSeconds = 300; assert.equal(e.validation.value, '');
  e.draft.mcp[0].timeoutSeconds = 300.001; assert.match(e.validation.value, /1–300 seconds/);
  Object.assign(e.draft.mcp[0], { transport: 'stdio', command: '/usr/bin/node', secretEnv: 'MCP_AUTH_TOKEN', timeoutSeconds: 900 });
  assert.equal(e.validation.value, ''); e.draft.mcp[0].timeoutSeconds = 900.001; assert.match(e.validation.value, /1–900 seconds/);
  e.draft.mcp[0].timeoutSeconds = ''; assert.equal(e.validation.value, '');
});

test('unchanged fractional overrides round-trip exactly and numeric input equivalence keeps a clean draft', async t => {
  const e = editor(t); e.state.view.builtins.commands = [{ id: 'tests', name: 'Tests', executable: '/usr/bin/node', args: ['--test'], enabled: true, timeoutMs: 1501 }]; e.reload();
  assert.equal(e.draft.commands[0].timeoutSeconds, 1.501);
  e.draft.commands[0].timeoutSeconds = '1.501'; assert.equal(e.dirty.value, false);
  e.draft.commands[0].timeoutSeconds = 'invalid'; assert.equal(e.dirty.value, true); assert.equal(e.canSave.value, false);
  e.draft.commands[0].timeoutSeconds = '1.501'; e.draft.files = true;
  let submitted = /** @type {{ value?: import('../../src/worker/application/tool-policy.js').ToolAccessUpdate }} */ ({}); e.onWrite(async command => { submitted.value = command; return undefined; }); await e.save(); assert.equal(requiredValue(submitted.value).builtins.commands[0].timeoutMs, 1501);
});

test('concurrent timeout policy refresh keeps the draft and refuses stale saves until explicit reload', async t => {
  const e = editor(t); e.draft.mcp[0].timeoutSeconds = 40;
  e.state.view = { ...view(1), mcp: [{ ...connection(), timeoutMs: 60000 }] }; await nextTick();
  assert.equal(e.draft.mcp[0].timeoutSeconds, 40); assert.equal(e.stale.value, true);
  let writes = 0; e.onWrite(async () => { writes++; }); await e.save(); assert.equal(writes, 0);
  e.reload(); assert.equal(e.draft.mcp[0].timeoutSeconds, 60); assert.equal(e.dirty.value, false);
  e.draft.mcp[0].timeoutSeconds = ''; e.state.epoch++; assert.deepEqual(e.draft.mcp, []);
});

test('effective timeout guidance follows saved command and invocation caps without changing grant drafts', async t => {
  const state = reactive({ command: 300000, invocation: 3600000 });
  const e = createToolAccessEditor({ view: () => view(), unlocked: () => true, epoch: () => 0, write: async () => undefined, discover: async () => undefined, refresh: async () => {}, commandTimeoutMs: () => state.command, executionBudgetMs: () => state.invocation }); t.after(e.dispose);
  assert.match(e.timeoutNote('', 'command'), /Effective cap: 300 s/); assert.match(e.timeoutNote(600, 'command'), /Effective cap: 300 s/);
  assert.match(e.timeoutNote('', 'mcp'), /Effective cap: 30 s/); assert.match(e.timeoutNote(45, 'mcp'), /Effective cap: 45 s/);
  state.command = 900000; assert.match(e.timeoutNote(600, 'command'), /Effective cap: 600 s/);
  state.invocation = 15000; assert.match(e.timeoutNote(600, 'command'), /Effective cap: 15 s/); assert.match(e.timeoutNote(45, 'mcp'), /Effective cap: 15 s/);
  assert.equal(e.draft.mcp[0].timeoutSeconds, ''); assert.equal(e.dirty.value, false);
});


test('a pristine saved grant with an unavailable repository explains the blocked save and permits explicit correction', async t => {
  const e = editor(t), writes = [];
  e.state.view.builtins.commands = [{ id: 'project-check', name: 'Project check', executable: '/usr/bin/node', args: ['--version'], enabled: true, chatDirectory: 'repository:removed-project' }];
  e.reload();
  assert.equal(e.dirty.value, false, 'loading an invalid saved grant does not manufacture an edit');
  assert.match(e.validation.value, /Project check.*repository is no longer assigned.*Choose an assigned repository or the private chat workspace/);
  assert.equal(e.canSave.value, false);
  e.onWrite(async command => { writes.push(command); return { ...view(1), builtins: command.builtins }; });
  await e.save(); assert.equal(writes.length, 0, 'invalid saved authority cannot be resubmitted');
  e.draft.commands[0].chatDirectory = 'workspace';
  assert.equal(e.validation.value, ''); assert.equal(e.canSave.value, true);
  await e.save(); assert.equal(writes.length, 1);
  assert.equal('chatDirectory' in writes[0].builtins.commands[0], false, 'the operator explicitly restored the private workspace');
  assert.equal(e.dirty.value, false);
});
