import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive, nextTick } from 'vue';
import { frontend, deferred } from '../ui/helpers/frontend-loader.mjs';
const { createToolAccessEditor } = await frontend('src/worker/webview/tool-access-editor.ts');
const connection = () => ({ id: 'docs', name: 'Documentation', transport: 'http', enabled: false, command: '', args: [], url: 'https://tools.example.com/mcp', secretEnv: '', hasSecret: true, allowedTools: [], discoveredTools: [{ name: 'search', description: 'Search documentation', inputSchema: { type: 'object', properties: {} } }] });
const view = (revision = 0) => ({ schemaVersion: 1, revision, builtins: { files: false, commands: [], webOrigins: [] }, mcp: [connection()], canEdit: true, saveBlockedReason: null });
function editor(t) {
  const state = reactive({ unlocked: true, epoch: 0, view: view() });
  let write = async command => { state.view = { ...view(state.view.revision + 1), builtins: command.builtins, mcp: command.mcp.map(({ secret, clearSecret, ...item }) => ({ ...item, hasSecret: !!secret || !clearSecret, discoveredTools: connection().discoveredTools })) }; return state.view; }, discover = async () => state.view, refresh = async () => {};
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
  const e = editor(t); let submitted; e.onWrite(async command => { submitted = command; return undefined; });
  e.draft.mcp[0].enabled = true; e.draft.mcp[0].allowedTools = ['search']; await e.save(); assert.equal('secret' in submitted.mcp[0], false); assert.equal('clearSecret' in submitted.mcp[0], false);
  e.resolveUncertain(); e.draft.mcp[0].secret = 'replacement-fixture'; await e.save(); assert.equal(submitted.mcp[0].secret, 'replacement-fixture');
  e.resolveUncertain(); e.draft.mcp[0].clearSecret = true; await e.save(); assert.equal(submitted.mcp[0].clearSecret, true);
  e.resolveUncertain(); e.draft.mcp[0].url = 'https://other.example.com/mcp'; e.draft.mcp[0].allowedTools = ['search']; assert.equal(e.destinationChanged(e.draft.mcp[0]), true); await e.save(); assert.deepEqual(submitted.mcp[0].allowedTools, []);
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
  let submitted;
  e.onWrite(async command => { submitted = command; return undefined; });
  await e.save();
  assert.deepEqual(submitted.mcp[0].allowedTools, ['search']);
  assert.equal('secret' in submitted.mcp[0], false);
  assert.equal('clearSecret' in submitted.mcp[0], false);
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
  let submitted; e.onWrite(async command => { submitted = command; return undefined; }); await e.save();
  assert.deepEqual(submitted.builtins.cliTools, [{ id: 'cli-1', name: 'Harness', description: '', enabled: true, executable: '/opt/node/bin/node', args: ['bin/harness.mjs'], commands: [{ command: 'help', requireOneOf: [], refusedOptions: [] }, { command: 'backlog set', requireOneOf: ['--dry-run'], refusedOptions: [] }], refusedOptions: ['--root', '--config'], maxArgs: 24, maxArgLength: 500, outputKiB: 32, truncationHint: 'Narrow the command, for example with a filter, limit or summary option.', timeoutMs: 30000 }]);
  e.resolveUncertain(); e.addCliTool();
  for (const [change, pattern] of [[{ executable: 'C:\\tools\\run.cmd' }, /\.bat or \.cmd/], [{ executable: 'node' }, /absolute executable/], [{ commands: '' }, /at least one command/], [{ commands: 'help\nhelp' }, /once/], [{ commands: 'a b c' }, /one or two words/], [{ refusedOptions: 'root' }, /option names/], [{ outputKiB: 65 }, /output limit/], [{ maxArgs: 0 }, /maximum arguments/]]) {
    Object.assign(e.draft.cliTools[0], { name: 'Other', executable: '/opt/node/bin/node', commands: 'help', refusedOptions: '', outputKiB: 32, maxArgs: 24, id: 'cli-2' }, change);
    assert.match(e.validation.value, pattern, JSON.stringify(change));
  }
});
test('execution limits are edited in seconds, checked against the tool window and saved as milliseconds', async t => {
  const e = editor(t);
  assert.equal(e.draft.windowSeconds, 120, 'views saved before configurable limits show the default window');
  assert.equal(e.draft.mcp[0].timeoutSeconds, 30);
  e.addCommand(); Object.assign(e.draft.commands[0], { name: 'Unit tests', executable: '/usr/bin/npm', arguments: '["test"]', enabled: true });
  assert.equal(e.draft.commands[0].timeoutSeconds, 30);
  e.draft.commands[0].timeoutSeconds = 600; assert.match(e.validation.value, /command preset Unit tests \(600 s\) exceeds the tool window \(120 s\)/);
  e.draft.commands[0].timeoutSeconds = 901; e.draft.windowSeconds = 1800; assert.match(e.validation.value, /from 1 to 900 for the timeout of command preset Unit tests/);
  e.draft.commands[0].timeoutSeconds = 600; e.draft.mcp[0].timeoutSeconds = 301; assert.match(e.validation.value, /from 1 to 300 for the timeout of MCP connection Documentation/);
  e.draft.mcp[0].timeoutSeconds = 300; e.draft.windowSeconds = 5; assert.match(e.validation.value, /from 10 to 86,400 for the tool window/);
  e.draft.windowSeconds = 1800; assert.equal(e.validation.value, '');
  let submitted; e.onWrite(async command => { submitted = command; return undefined; }); await e.save();
  assert.deepEqual(submitted.limits, { windowMs: 1800000 });
  assert.equal(submitted.builtins.commands[0].timeoutMs, 600000); assert.equal(submitted.mcp[0].timeoutMs, 300000);
  e.state.view = { ...view(1), limits: { windowMs: 900000 }, builtins: { files: false, commands: [{ id: 'build', name: 'Build', executable: '/usr/bin/npm', args: ['run', 'build'], enabled: true, timeoutMs: 450000 }], webOrigins: [] } };
  e.resolveUncertain(); assert.equal(e.draft.windowSeconds, 900); assert.equal(e.draft.commands[0].timeoutSeconds, 450);
});
test('the tool window notes when the worker invocation limit would stop tools first', async t => {
  const state = reactive({ budget: 600000 });
  const e = createToolAccessEditor({ view: () => view(), unlocked: () => true, epoch: () => 0, write: async () => undefined, discover: async () => undefined, refresh: async () => {}, executionBudgetMs: () => state.budget });
  t.after(e.dispose);
  assert.equal(e.windowNote.value, '');
  e.draft.windowSeconds = 900; assert.match(e.windowNote.value, /invocation limit \(600 s\) is shorter than this window/);
  state.budget = 3600000; assert.equal(e.windowNote.value, '');
});
