import { toolPropertyDescription } from './model-fixtures.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolRuntime, mcpToolName } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { defaultToolPolicy, publicToolPolicy, updateToolPolicy, validateToolPolicy, discoveredToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { workspaceModelFactory } from './application-fixtures.mjs';
import { modelCapabilities } from '../../src/worker/dist/worker/application/model-contract.js';

const signal = () => new AbortController().signal;
const decoded = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
const edit = (policy, changes = {}) => ({ expectedRevision: policy.revision, builtins: structuredClone(policy.builtins), mcp: publicToolPolicy(policy).mcp.map(({ discoveredTools, hasSecret, ...item }) => item), ...changes });
const cwdPreset = (extra = {}) => ({ id: 'cwd', name: 'Working directory', executable: process.execPath, args: ['-e', 'console.log(process.cwd())'], enabled: true, ...extra });
const definition = { name: 'where', description: 'Report the server directory', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
// Minimal stdio MCP server whose tool reports its working directory, or an error when `fail` is set.
const server = (fail = false) => `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result;if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[${JSON.stringify(definition)}]};if(m.method==='tools/call')result=${fail ? "{content:[{type:'text',text:'project config not found'}],isError:true}" : "{content:[{type:'text',text:process.cwd()}]}"};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
const stdio = (args, extra = {}) => ({ id: 'local', name: 'Local project server', transport: 'stdio', enabled: true, command: process.execPath, args, url: '', secretEnv: 'MCP_AUTH_TOKEN', secret: '', allowedTools: [definition.name], discoveredTools: [definition], ...extra });

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-chat-directory-')));
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository'), worktree = join(directory, 'worktree'), state = join(directory, 'state');
  await Promise.all([mkdir(repository), mkdir(worktree), mkdir(state)]);
  const repositories = [{ id: 'project', path: repository }];
  const runtime = (policy, options = {}) => { const value = createToolRuntime({ policy, currentRevision: () => policy.revision, directory: state, repositories: () => repositories, ...options }); cleanup(t, () => value.close()); return value; };
  return { directory, repository, worktree, state, repositories, runtime };
}
const policyWith = (mutate) => { const policy = defaultToolPolicy(); mutate(policy); return validateToolPolicy(policy); };

test('chat directory is an opt-in repository reference validated against current assignments when saved', () => {
  const base = defaultToolPolicy();
  const saved = updateToolPolicy(base, edit(base, { builtins: { ...base.builtins, commands: [cwdPreset({ chatDirectory: 'repository:project' })] } }), ['project']);
  assert.equal(saved.builtins.commands[0].chatDirectory, 'repository:project');
  const plain = updateToolPolicy(base, edit(base, { builtins: { ...base.builtins, commands: [cwdPreset()] } }));
  assert.equal('chatDirectory' in plain.builtins.commands[0], false, 'the default is omitted, keeping the 0.9.0 document shape');
  assert.doesNotMatch(JSON.stringify(plain), /chatDirectory/);
  for (const chatDirectory of ['/srv/project', 'C:\\Projects\\app', 'project', 'repository:', 'repository:../other', 'repository:a/b', 'workspace', 42, null])
    assert.throws(() => updateToolPolicy(base, edit(base, { builtins: { ...base.builtins, commands: [cwdPreset({ chatDirectory })] } }), ['project']), /chatDirectory must be "repository:<assigned repository ID>"/, String(chatDirectory));
  assert.throws(() => updateToolPolicy(base, edit(base, { builtins: { ...base.builtins, commands: [cwdPreset({ chatDirectory: 'repository:other' })] } }), ['project']), /repository "other", which is not assigned/);
  assert.throws(() => updateToolPolicy(base, edit(base, { builtins: { ...base.builtins, commands: [cwdPreset({ chatDirectory: 'repository:project' })] } })), /not assigned/, 'without assignments nothing can be selected');
  const { discoveredTools, secret, ...mcp } = stdio([], { chatDirectory: 'repository:project', allowedTools: [] });
  assert.equal(updateToolPolicy(base, edit(base, { mcp: [mcp] }), ['project']).mcp[0].chatDirectory, 'repository:project');
  assert.throws(() => updateToolPolicy(base, edit(base, { mcp: [{ ...mcp, transport: 'http', command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '' }] }), ['project']), /HTTP MCP connections have no working directory/);
  // A saved policy stays loadable after its repository is unassigned; calls refuse it and the next save names it.
  assert.equal(validateToolPolicy(saved).builtins.commands[0].chatDirectory, 'repository:project');
  assert.throws(() => updateToolPolicy(saved, edit(saved), []), /Command preset "cwd" runs chat calls in repository "project", which is not assigned/);
});

test('chat calls of an opted-in preset and stdio MCP server start in the assigned repository checkout', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const runtime = f.runtime(policyWith(policy => { policy.builtins.commands = [cwdPreset({ chatDirectory: 'repository:project' })]; policy.mcp = [stdio(['-e', server()], { chatDirectory: 'repository:project' })]; }));
  const result = decoded(await runtime.call('werk_command_run', { preset: 'cwd' }, signal()));
  assert.equal(result.stdout.trim(), await realpath(f.repository));
  assert.equal(result.workingDirectory, 'live checkout of repository "project"');
  const mcp = await runtime.call(mcpToolName('local', definition.name), {}, signal());
  assert.equal(mcp.isError, undefined, JSON.stringify(mcp)); assert.equal(mcp.content[0].text, await realpath(f.repository));
  const manifest = JSON.stringify(runtime.manifest);
  assert.match(manifest, /live checkout of repository \\"project\\"/); assert.match(manifest, /live checkout of assigned repository \\"project\\"/);
  assert.equal(manifest.includes(f.repository), false, 'dispatch evidence names the repository ID, never its host path');
  await assert.rejects(access(join(f.state, 'chat-workspace')), 'the private workspace is not needed');
});

test('without the option chat keeps the private workspace and says so; task invocations keep the pinned worktree unchanged', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const chat = f.runtime(policyWith(policy => { policy.builtins.commands = [cwdPreset(), { id: 'fails', name: 'Needs project', executable: process.execPath, args: ['-e', 'process.exit(2)'], enabled: true }]; policy.mcp = [stdio(['-e', server()])]; }));
  const result = decoded(await chat.call('werk_command_run', { preset: 'cwd' }, signal()));
  assert.equal(result.stdout.trim(), join(f.state, 'chat-workspace'));
  assert.equal(result.workingDirectory, 'private chat workspace, no project files'); assert.equal(result.hint, undefined);
  assert.match(decoded(await chat.call('werk_command_run', { preset: 'fails' }, signal())).hint, /empty private chat workspace, which has no project files.*chat directory to an assigned repository/);
  assert.equal((await chat.call(mcpToolName('local', definition.name), {}, signal())).content[0].text, join(f.state, 'chat-workspace'));
  const tools = Object.fromEntries(chat.manifest.tools.map(tool => [tool.name, tool]));
  assert.match(tools.werk_command_run.description, /empty private chat workspace, which has no project files/);
  assert.match(toolPropertyDescription(tools.werk_command_run, 'preset'), /cwd: Working directory \(private chat workspace, no project files\)/);
  assert.match(tools[mcpToolName('local', definition.name)].description, /\(Chat: starts in an empty private workspace without project files\.\)$/);

  const optedIn = policyWith(policy => { policy.builtins.commands = [cwdPreset({ chatDirectory: 'repository:project' })]; policy.mcp = [stdio(['-e', server()], { chatDirectory: 'repository:project' })]; });
  const task = f.runtime(optedIn, { worktree: f.worktree });
  const output = decoded(await task.call('werk_command_run', { preset: 'cwd' }, signal()));
  assert.deepEqual(Object.keys(output), ['preset', 'exitCode', 'stdout', 'stderr'], 'task results keep their 0.9.0 shape');
  assert.equal(output.stdout.trim(), f.worktree);
  assert.equal((await task.call(mcpToolName('local', definition.name), {}, signal())).content[0].text, f.worktree);
  const taskTools = Object.fromEntries(task.manifest.tools.map(tool => [tool.name, tool]));
  assert.equal(taskTools.werk_command_run.description, 'Run one operator-approved executable with its fixed arguments, as the worker account. Starts in the task worktree or private chat workspace. Commands may change files or access resources outside that directory. No extra arguments or shell expansion.');
  assert.equal(toolPropertyDescription(taskTools.werk_command_run, 'preset'), 'cwd: Working directory');
  assert.equal(taskTools[mcpToolName('local', definition.name)].description, '[Local project server] Report the server directory');
});

test('chat MCP failures from the private workspace explain the missing project files', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const runtime = f.runtime(policyWith(policy => { policy.mcp = [stdio(['-e', 'process.exit(3)']), stdio(['-e', server(true)], { id: 'reports' })]; }));
  const exited = await runtime.call(mcpToolName('local', definition.name), {}, signal());
  assert.equal(exited.isError, true); assert.match(exited.content[0].text, /^Tool execution failed\..*empty private chat workspace, which has no project files/);
  const reported = await runtime.call(mcpToolName('reports', definition.name), {}, signal());
  assert.equal(reported.isError, true); assert.equal(reported.content[0].text, 'project config not found');
  assert.match(reported.content.at(-1).text, /chat directory to an assigned repository under Tool access/);
  const opted = f.runtime(policyWith(policy => { policy.mcp = [stdio(['-e', 'process.exit(3)'], { chatDirectory: 'repository:project' })]; }));
  assert.doesNotMatch((await opted.call(mcpToolName('local', definition.name), {}, signal())).content[0].text, /private chat workspace/);
});

test('a removed or moved repository assignment refuses chat calls before any process starts', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const marker = join(f.directory, 'started.txt');
  const preset = cwdPreset({ id: 'mark', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], chatDirectory: 'repository:project' });
  const policy = policyWith(value => { value.builtins.commands = [preset]; value.mcp = [stdio(['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], { chatDirectory: 'repository:project' })]; });
  const runtime = f.runtime(policy);
  f.repositories.length = 0;
  for (const name of ['werk_command_run', mcpToolName('local', definition.name)]) {
    const result = await runtime.call(name, name === 'werk_command_run' ? { preset: 'mark' } : {}, signal());
    assert.equal(result.isError, true); assert.match(result.content[0].text, /Repository "project" is no longer assigned to this worker, so this chat tool was not started/);
  }
  f.repositories.push({ id: 'project', path: f.worktree });
  const moved = await runtime.call('werk_command_run', { preset: 'mark' }, signal());
  assert.match(moved.content[0].text, /assignment of repository "project" changed during this reply/);
  const missing = f.runtime(policy, { repositories: () => [{ id: 'project', path: join(f.directory, 'deleted') }] });
  assert.match((await missing.call('werk_command_run', { preset: 'mark' }, signal())).content[0].text, /checkout of assigned repository "project" is unavailable/);
  await assert.rejects(access(marker), 'no refused call started its process');
  assert.equal(JSON.stringify(runtime.manifest).includes(f.directory), false);
});

test('worker settings validate chat directories against assignments and model scopes pass them to chat tools only', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const settings = new WorkerSettings(f.state, '', '', '', { pollMs: 30000, items: [{ id: 'project', path: f.repository, remote: 'origin', watch: false }] }); await settings.init();
  await assert.rejects(settings.updateToolAccess(edit(settings.toolPolicy(), { builtins: { ...defaultToolPolicy().builtins, commands: [cwdPreset({ chatDirectory: 'repository:other' })] } })), /not assigned to this worker/);
  await settings.updateToolAccess(edit(settings.toolPolicy(), { builtins: { ...defaultToolPolicy().builtins, commands: [cwdPreset({ chatDirectory: 'repository:project' })] } }));
  assert.match(await readFile(join(f.state, 'tool-access.json'), 'utf8'), /"chatDirectory":"repository:project"/);
  const runtimes = [];
  const factory = workspaceModelFactory(f.state, settings, (connection, directory, transport, options) => { runtimes.push(options.tools()); return { configuration: { id: connection.id, model: '', instruction: '' }, capabilities: modelCapabilities, async reply() { throw Error('Not invoked'); } }; });
  factory(settings.provider('openai-api'), { sessionId: 'default' });
  factory(settings.provider('openai-api'), { worktree: f.worktree });
  cleanup(t, () => Promise.all(runtimes.map(runtime => runtime.close())));
  assert.equal(decoded(await runtimes[0].call('werk_command_run', { preset: 'cwd' }, signal())).stdout.trim(), await realpath(f.repository));
  assert.equal(decoded(await runtimes[1].call('werk_command_run', { preset: 'cwd' }, signal())).stdout.trim(), f.worktree);
});

test('Dashboard editor offers assigned repositories, saves the private workspace as no field and flags revoked choices', async t => {
  const { reactive } = await import('vue');
  const { frontend } = await import('../ui/helpers/frontend-loader.mjs');
  const { createToolAccessEditor } = await frontend('src/worker/webview/tool-access-editor.ts');
  const preset = (extra = {}) => ({ id: 'cwd', name: 'Working directory', executable: process.execPath, args: [], enabled: true, ...extra });
  const view = commands => ({ schemaVersion: 1, revision: 0, builtins: { files: false, commands, webOrigins: [] }, mcp: [], canEdit: true, saveBlockedReason: null });
  const state = reactive({ view: view([preset(), preset({ id: 'repo', chatDirectory: 'repository:project' })]), repositories: ['project'] });
  /** @type {import('../../src/worker/application/tool-policy.js').ToolAccessUpdate} */
  let submitted;
  const editor = createToolAccessEditor({ view: () => state.view, unlocked: () => true, epoch: () => 0, write: async command => { submitted = command; return undefined; }, discover: async () => state.view, refresh: async () => {}, repositories: () => state.repositories });
  t.after(editor.dispose);
  assert.deepEqual(editor.draft.commands.map(item => item.chatDirectory), ['workspace', 'repository:project']);
  assert.deepEqual(editor.chatDirectories('workspace').map(item => item.value), ['workspace', 'repository:project']);
  assert.match(editor.chatDirectories('workspace')[1].label, /Live checkout.*not isolated/);
  editor.draft.commands[0].name = 'Renamed'; await editor.save();
  assert.equal('chatDirectory' in submitted.builtins.commands[0], false, 'the private workspace is the omitted default');
  assert.equal(submitted.builtins.commands[1].chatDirectory, 'repository:project');
  editor.resolveUncertain(); state.repositories = [];
  editor.draft.commands[0].name = 'Renamed again';
  assert.match(editor.validation.value, /no longer assigned/); assert.equal(editor.canSave.value, false);
  assert.match(editor.chatDirectories('repository:project').at(-1).label, /no longer assigned/);
});

test('discovering an opted-in stdio MCP connection starts the server in the assigned repository', { timeout: 60000 }, async t => {
  const { execFileSync } = await import('node:child_process');
  const { SnapshotJournal } = await import('../../src/worker/dist/worker/infrastructure/journal/snapshots.js');
  const { WorkerWorkspace } = await import('../../src/worker/dist/worker/status/workspace.js');
  const f = await fixture(t);
  execFileSync('git', ['init', '-b', 'main'], { cwd: f.repository, stdio: 'ignore' });
  const journal = new SnapshotJournal(f.state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = workerStatus(), worker = new WorkerWorkspace({ stateDir: f.state, projectDir: f.directory, pollMs: 1000, timeoutMs: 60000 }, journal, () => current); await worker.init();
  cleanup(t, async () => { await worker.close(); journal.close(); });
  await worker.updateSettings({ board: { paused: true }, repositories: { items: [{ id: 'project', path: f.repository, remote: 'origin', watch: false }] } });
  const catalog = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result;if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'where',description:process.cwd(),inputSchema:{type:'object'}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
  const { discoveredTools, secret, ...connection } = stdio(['-e', catalog], { allowedTools: [], chatDirectory: 'repository:project' });
  await worker.updateToolAccess(edit(worker.settings.toolPolicy(), { mcp: [connection] }));
  const view = await worker.discoverToolAccess({ id: 'local', expectedRevision: worker.settings.toolPolicy().revision });
  assert.equal(view.mcp[0].discoveredTools[0].description, await realpath(f.repository));
  assert.equal(view.mcp[0].chatDirectory, 'repository:project');
  const privateUpdate = edit(worker.settings.toolPolicy()); delete privateUpdate.mcp[0].chatDirectory;
  const cleared = await worker.updateToolAccess(privateUpdate);
  assert.deepEqual(cleared.mcp[0].discoveredTools, []);
  const privateView = await worker.discoverToolAccess({ id: 'local', expectedRevision: worker.settings.toolPolicy().revision });
  assert.equal(privateView.mcp[0].discoveredTools[0].description, await realpath(join(f.state, 'chat-workspace')), 'default discovery uses the same private directory as chat calls');
});


test('changing an MCP chat directory clears its catalog and grants while preserving the same server secret and timeout', () => {
  const initial = defaultToolPolicy();
  const { discoveredTools, ...connection } = stdio([], { allowedTools: [], secret: 'fixture-secret', timeoutMs: 45000 });
  let policy = updateToolPolicy(initial, edit(initial, { mcp: [connection] }), ['project']);
  policy = discoveredToolPolicy(policy, 'local', policy.revision, [definition]);
  const grant = edit(policy); grant.mcp[0].allowedTools = ['where'];
  policy = updateToolPolicy(policy, grant, ['project']);
  assert.deepEqual(policy.mcp[0].allowedTools, ['where']);
  const moved = edit(policy); moved.mcp[0].chatDirectory = 'repository:project';
  const changed = updateToolPolicy(policy, moved, ['project']);
  assert.deepEqual(changed.mcp[0].allowedTools, []); assert.deepEqual(changed.mcp[0].discoveredTools, []);
  assert.equal(changed.mcp[0].secret, 'fixture-secret'); assert.equal(changed.mcp[0].timeoutMs, 45000);
  const rediscovered = discoveredToolPolicy(changed, 'local', changed.revision, [definition]);
  assert.deepEqual(rediscovered.mcp[0].allowedTools, [], 'discovery does not silently restore authority');
});

test('a replaced directory or symlink at an unchanged repository assignment cannot start chat tools', { timeout: 120000 }, async t => {
  for (const replacement of ['directory', 'link']) {
    const f = await fixture(t), marker = join(f.directory, 'unexpected-process.txt');
    const args = ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"started")'];
    const runtime = f.runtime(policyWith(policy => {
      policy.builtins.commands = [cwdPreset({ args, chatDirectory: 'repository:project' })];
      policy.mcp = [stdio(args, { chatDirectory: 'repository:project' })];
    }));
    await rename(f.repository, f.repository + '-original');
    if (replacement === 'directory') await mkdir(f.repository);
    else await symlink(f.worktree, f.repository, process.platform === 'win32' ? 'junction' : 'dir');
    for (const name of ['werk_command_run', mcpToolName('local', definition.name)]) {
      const result = await runtime.call(name, name === 'werk_command_run' ? { preset: 'cwd' } : {}, signal());
      assert.equal(result.isError, true); assert.match(result.content[0].text, /checkout of assigned repository "project".*(changed|unavailable or replaced)/);
    }
    await assert.rejects(access(marker), 'neither preset nor MCP server started in the replacement');
  }
});
