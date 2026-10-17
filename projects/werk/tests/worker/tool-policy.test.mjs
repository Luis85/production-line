import { taskboardRuntime, reviewOptions } from './runtime-fixtures.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';
import { testErrorCode, testListeningAddress } from '../helpers/typed-boundaries.mjs';
import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { defaultToolPolicy, updateToolPolicy, discoveredToolPolicy, validateToolPolicy, publicToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { WorkerSessions, workspaceModelFactory } from './application-fixtures.mjs';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { modelCapabilities, prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
const definition = { name: 'fixture_read', description: 'Read fixture data.\nNo mutation.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const httpConnection = (extra = {}) => ({ id: 'fixture', name: 'Fixture service', transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '', allowedTools: [], ...extra });
/** @returns {import('../../src/worker/application/tool-policy.js').ToolAccessUpdate} */
const edit = (policy, changes = {}) => ({ expectedRevision: policy.revision, builtins: structuredClone(policy.builtins), mcp: publicToolPolicy(policy).mcp.map(({ discoveredTools, hasSecret, ...item }) => item), ...changes });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); } throw Error('Fixture did not settle'); }
async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'werk-tool-policy-'))); cleanup(t, () => rm(path, { recursive: true, force: true })); return path; }

test('MCP discovery never grants tools and changed tool definitions revoke only affected grants', () => {
  let policy = updateToolPolicy(defaultToolPolicy(), { expectedRevision: 0, builtins: defaultToolPolicy().builtins, mcp: [httpConnection()] });
  policy = discoveredToolPolicy(policy, 'fixture', policy.revision, [definition]);
  assert.deepEqual(policy.mcp[0].allowedTools, []);
  let input = edit(policy); input.mcp[0].allowedTools = [definition.name]; policy = updateToolPolicy(policy, input);
  const same = discoveredToolPolicy(policy, 'fixture', policy.revision, [definition]); assert.deepEqual(same.mcp[0].allowedTools, [definition.name]);
  const changed = discoveredToolPolicy(same, 'fixture', same.revision, [{ ...definition, description: 'Changed authority.' }]); assert.deepEqual(changed.mcp[0].allowedTools, []);
  assert.throws(() => updateToolPolicy(changed, input), error => testErrorCode(error) === 'conflict');
  assert.throws(() => updateToolPolicy(changed, { ...edit(changed), mcp: [{ ...edit(changed).mcp[0], allowedTools: ['unknown'] }] }), /discovered MCP catalog/);
});

test('tool policy validates concrete command, origin, credential and aggregate grant limits', () => {
  const defaults = defaultToolPolicy();
  for (const builtins of [{ files: true, commands: [{ id: 'bad', name: 'Bad', executable: 'relative-command', args: [], enabled: true }], webOrigins: [] }, { ...defaults.builtins, webOrigins: ['https://example.test/private/path'] }, { ...defaults.builtins, unknown: true }]) assert.throws(() => updateToolPolicy(defaults, { ...edit(defaults), builtins }));
  for (const secretEnv of ['NODE_OPTIONS', 'HOME', 'WERK_ADMIN_TOKEN']) assert.throws(() => updateToolPolicy(defaults, { ...edit(defaults), mcp: [{ ...httpConnection(), transport: 'stdio', command: process.execPath, url: '', secretEnv }] }), /dedicated MCP credential/);
  assert.throws(() => updateToolPolicy(defaults, { ...edit(defaults), mcp: [httpConnection({ url: 'http://remote.example.test/mcp' })] }), /HTTPS/);
  const definitions = Array.from({ length: 64 }, (_, i) => ({ ...definition, name: 'tool_' + i }));
  assert.throws(() => validateToolPolicy({ ...defaults, builtins: { ...defaults.builtins, files: true }, mcp: [{ ...httpConnection(), secret: '', discoveredTools: definitions, allowedTools: definitions.map(item => item.name) }] }), /at most 64/);
});

test('field validation names the unexpected keys so an edited tool-access view can be fixed', () => {
  const defaults = defaultToolPolicy();
  assert.throws(() => updateToolPolicy(defaults, { ...edit(defaults), revision: 0, schemaVersion: 1 }), /Use the documented tool access update fields\. Unexpected: revision, schemaVersion\./);
  assert.throws(() => updateToolPolicy(defaults, { ...edit(defaults), mcp: [{ ...httpConnection(), hasSecret: true }] }), /Use the documented MCP connection fields\. Unexpected: hasSecret\./);
  assert.throws(() => updateToolPolicy(defaults, { ...edit(defaults), a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }), /Unexpected: a, b, c, d, e, …\./);
  assert.throws(() => updateToolPolicy(defaults, []), { message: 'Use the documented tool access update fields.' });
});

test('stdio MCP connections without a credential need no secret environment variable', () => {
  const defaults = defaultToolPolicy();
  const stdio = (extra = {}) => httpConnection({ transport: 'stdio', command: process.execPath, url: '', secretEnv: '', ...extra });
  const open = updateToolPolicy(defaults, { ...edit(defaults), mcp: [stdio()] });
  assert.equal(open.mcp[0].secretEnv, ''); assert.equal(open.mcp[0].secret, '');
  assert.equal(updateToolPolicy(defaults, { ...edit(defaults), mcp: [{ ...stdio(), secretEnv: undefined }] }).mcp[0].secretEnv, 'MCP_AUTH_TOKEN', 'an omitted variable keeps the documented default');
  assert.throws(() => updateToolPolicy(open, { ...edit(open), mcp: [{ ...edit(open).mcp[0], secret: 'fixture-secret' }] }), /Name the environment variable/);
  assert.throws(() => validateToolPolicy({ ...open, mcp: [{ ...open.mcp[0], secret: 'fixture-secret' }] }), /Name the environment variable/, 'a saved secret without a destination is refused');
  for (const secretEnv of ['NODE_OPTIONS', 'lowercase', ' ']) assert.throws(() => updateToolPolicy(defaults, { ...edit(defaults), mcp: [stdio({ secretEnv })] }), /dedicated MCP credential/);
  let policy = updateToolPolicy(defaults, { ...edit(defaults), mcp: [stdio({ secretEnv: 'FIXTURE_TOKEN', secret: 'fixture-stored-secret' })] });
  policy = discoveredToolPolicy(policy, 'fixture', policy.revision, [definition]);
  let input = edit(policy); input.mcp[0].allowedTools = [definition.name]; policy = updateToolPolicy(policy, input);
  input = edit(policy); input.mcp[0].secretEnv = '';
  const cleared = updateToolPolicy(policy, input);
  assert.equal(cleared.mcp[0].secretEnv, ''); assert.equal(cleared.mcp[0].secret, '', 'clearing the variable never keeps the stored secret');
  assert.deepEqual(cleared.mcp[0].allowedTools, []); assert.deepEqual(cleared.mcp[0].discoveredTools, []);
  input = edit(policy); input.mcp[0].secretEnv = 'OTHER_TOKEN';
  assert.equal(updateToolPolicy(policy, input).mcp[0].secret, '', 'a stored secret never moves to a different variable');
});

test('private tool policy migrates default-none, preserves and rotates secrets, and resets authority on destination changes', async t => {
  const path = await directory(t); let settings = new WorkerSettings(path); await settings.init(); assert.deepEqual(settings.toolPolicy(), defaultToolPolicy());
  await settings.updateToolAccess({ ...edit(settings.toolPolicy()), mcp: [httpConnection({ secret: 'fixture-private-secret' })] });
  assert.doesNotMatch(JSON.stringify(settings.toolAccess()), /fixture-private-secret/); assert.equal(settings.toolAccess().mcp[0].hasSecret, true);
  await settings.discoveredTools('fixture', 1, [definition]);
  let input = edit(settings.toolPolicy()); input.mcp[0].allowedTools = [definition.name]; input.mcp[0].url = 'https://mcp.example.test'; await settings.updateToolAccess(input);
  assert.equal(settings.toolPolicy().mcp[0].secret, 'fixture-private-secret'); assert.deepEqual(settings.toolPolicy().mcp[0].allowedTools, [definition.name], 'equivalent normalized destination preserves authority');
  settings = new WorkerSettings(path); await settings.init(); assert.equal(settings.toolPolicy().mcp[0].secret, 'fixture-private-secret');
  if (process.platform !== 'win32') assert.equal((await stat(join(path, 'tool-access.json'))).mode & 0o777, 0o600);
  input = edit(settings.toolPolicy()); input.mcp[0].secret = 'fixture-rotated-secret'; await settings.updateToolAccess(input); assert.equal(settings.toolPolicy().mcp[0].secret, 'fixture-rotated-secret');
  input = edit(settings.toolPolicy()); input.mcp[0].clearSecret = true; await settings.updateToolAccess(input); assert.equal(settings.toolPolicy().mcp[0].secret, '');
  input = edit(settings.toolPolicy()); input.mcp[0].secret = 'fixture-last-secret'; await settings.updateToolAccess(input);
  input = edit(settings.toolPolicy()); input.mcp[0].url = 'https://different.example.test/mcp'; await settings.updateToolAccess(input);
  assert.equal(settings.toolPolicy().mcp[0].secret, ''); assert.deepEqual(settings.toolPolicy().mcp[0].allowedTools, []); assert.deepEqual(settings.toolPolicy().mcp[0].discoveredTools, []);
  await writeFile(join(path, 'tool-access.json'), '{"schemaVersion":999}'); await assert.rejects(new WorkerSettings(path).init(), /saved tool policy/);
});

async function workspace(t) {
  const path = await directory(t), state = join(path, 'state'); await mkdir(state);
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const current = workerStatus(), worker = new WorkerWorkspace({ stateDir: state, projectDir: path, pollMs: 1000, timeoutMs: 60000 }, journal, () => current); await worker.init();
  const server = await statusServer(() => current, '127.0.0.1', 0, undefined, worker);
  cleanup(t, async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker.close(); journal.close(); });
  const base = 'http://127.0.0.1:' + testListeningAddress(server).port, headers = { Authorization: 'Bearer ' + (await readFile(join(state, 'webview-token'), 'utf8')).trim(), 'Content-Type': 'application/json' };
  const api = async (route, body) => { const response = await fetch(base + route, { headers, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  return { path, state, worker, current, base, api };
}

test('tool API authenticates, requires paused idle state, fences stale saves and discovers without granting', async t => {
  const f = await workspace(t);
  assert.equal((await fetch(f.base + '/api/tool-access')).status, 401);
  assert.equal((await fetch(f.base + '/api/tool-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await f.api('/api/tool-access')).value.canEdit, false);
  assert.equal((await f.api('/api/tool-access', edit(defaultToolPolicy()))).status, 409);
  await f.worker.updateSettings({ board: { paused: true } });
  const input = edit(defaultToolPolicy()); const responses = await Promise.all([f.api('/api/tool-access', input), f.api('/api/tool-access', input)]); assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
  f.current.activeTasks.push({ id: 'running', attempt: 1, profile: null }); assert.equal((await f.api('/api/tool-access', edit(f.worker.settings.toolPolicy()))).status, 409); f.current.activeTasks.length = 0;
  let calls = 0, catalog = [definition];
  const mcp = createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); calls++; assert.equal(req.headers.authorization, 'Bearer fixture-http-secret'); if (body.id === undefined) { res.writeHead(204); res.end(); return; } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: catalog } })); });
  await new Promise(resolve => mcp.listen(0, '127.0.0.1', () => resolve(undefined))); cleanup(t, async () => { mcp.closeAllConnections(); await new Promise(resolve => mcp.close(resolve)); });
  const saved = await f.api('/api/tool-access', { ...edit(f.worker.settings.toolPolicy()), mcp: [httpConnection({ url: 'http://127.0.0.1:' + testListeningAddress(mcp).port + '/mcp', secret: 'fixture-http-secret' })] }); assert.equal(saved.status, 200); assert.equal(calls, 0, 'saving a connection never launches or contacts it');
  const discovered = await f.api('/api/tool-access/discover', { id: 'fixture', expectedRevision: saved.value.revision }); assert.equal(discovered.status, 200); assert.equal(discovered.value.mcp[0].discoveredTools.length, 1); assert.deepEqual(discovered.value.mcp[0].allowedTools, []); assert.doesNotMatch(JSON.stringify(discovered.value), /fixture-http-secret/);
  let grant = edit(f.worker.settings.toolPolicy()); grant.mcp[0].allowedTools = [definition.name]; assert.equal((await f.api('/api/tool-access', grant)).status, 200);
  catalog = [{ ...definition, description: 'Changed permission description' }]; const changed = await f.api('/api/tool-access/discover', { id: 'fixture', expectedRevision: f.worker.settings.toolPolicy().revision }); assert.equal(changed.status, 200); assert.deepEqual(changed.value.mcp[0].allowedTools, []);
});

test('chat continuation takes current grants while retaining original provider instructions; reviewers receive no tools', async t => {
  const path = await directory(t), settings = new WorkerSettings(path); await settings.init();
  await settings.updateToolAccess({ ...edit(settings.toolPolicy()), builtins: { files: true, commands: [], webOrigins: ['https://example.test'] } });
  const requests = []; let instruction = 'Original instruction';
  /** @type {import('../../src/worker/infrastructure/workspace-services.js').WorkspaceProviderFactory} */
  const factory = (connection, directory, transport, options) => ({ configuration: { id: 'fixture', model: 'fixture-model', instruction }, capabilities: modelCapabilities, get toolManifest() { return options?.tools().manifest; }, async reply() { throw Error('Expected structured model'); }, async execute(request) { requests.push(request); return requests.length === 1 ? { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Continue?' } } : { type: 'completed', text: 'Finished' }; } });
  const sessions = WorkerSessions(path, settings, factory); await sessions.init(); cleanup(t, () => sessions.close());
  await sessions.start('Plan the change'); await until(() => !sessions.busy);
  assert.equal(requests[0].policy.tools, 'granted'); assert.deepEqual(requests[0].toolManifest.tools.map(item => item.name), ['werk_web_fetch'], 'chat has no worktree file access');
  await settings.updateToolAccess({ ...edit(settings.toolPolicy()), builtins: defaultToolPolicy().builtins }); instruction = 'New instruction'; await sessions.reloadProviders();
  const view = sessions.interactions.view('default'); await sessions.interact({ action: 'answer', sessionId: 'default', pendingId: view.pending.id, expectedRevision: view.revision, operationId: 'answer-grant-change', answer: 'Continue' }); await until(() => !sessions.busy);
  assert.equal(requests[1].policy.tools, 'none'); assert.equal(requests[1].toolManifest, undefined); assert.equal(requests[1].provider.instruction, 'Original instruction');
  const f = await workspace(t); await f.worker.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-no-request', model: 'fixture-model' }, board: { paused: true } }); await f.worker.updateToolAccess({ ...edit(f.worker.settings.toolPolicy()), builtins: { files: false, commands: [], webOrigins: ['https://example.test'] } });
  const provider = { id: 'openai-api', model: 'fixture-model', instruction: 'Review only' };
  const request = f.worker.sessions.requests.ensure({ owner: { sessionId: 'review', rootTurnId: 'review-turn' }, input: { kind: 'chat', title: 'Review', message: 'Review the request', criteria: [], files: [], context: {} }, provider });
  const reviewer = reviewOptions(f.worker.reviews).model(provider, request);
  assert.equal(prepareModelRequest(reviewer, [{ id: 'review', role: 'user', text: 'Review', state: 'complete', at: '2026-10-16T00:00:00Z' }]).policy.tools, 'none');
});

test('approved-file task grants read access to its retained worktree, never the original checkout', async t => {
  const f = await workspace(t), repository = join(f.path, 'repository'); await mkdir(repository);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); await writeFile(join(repository, 'approved.txt'), 'committed fixture\n'); git('add', '.'); git('commit', '-m', 'Fixture'); await writeFile(join(repository, 'approved.txt'), 'dirty original\n');
  await f.worker.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-never-sent', model: 'fixture-model' }, board: { paused: true }, repositories: { items: [{ id: 'project', path: repository, remote: 'origin', watch: false }] } });
  await f.worker.updateToolAccess({ ...edit(f.worker.settings.toolPolicy()), builtins: { files: true, commands: [], webOrigins: [] } });
  const runtimes = []; taskboardRuntime(f.worker.board).model = workspaceModelFactory(f.path, f.worker.settings, (connection, directory, transport, options) => { const runtime = options?.tools(); if (runtime) runtimes.push(runtime); return { configuration: { id: connection.id, model: connection.model, instruction: '' }, capabilities: modelCapabilities, toolManifest: runtime?.manifest, async reply() { throw Error('Paused fixture must not invoke a provider'); } }; });
  await f.worker.board.create({ title: 'Read approved file', instruction: 'Inspect committed context', repository: 'project', paths: ['approved.txt'], provider: 'openai-api' });
  const task = f.worker.board.detail(f.worker.board.view().tasks[0].id), runtime = runtimes.at(-1);
  assert.notEqual(task.worktree, repository); assert.deepEqual(runtime.manifest.tools.map(item => item.name), ['werk_files_list', 'werk_files_read', 'werk_files_search']);
  const result = await runtime.call('werk_files_read', { path: 'approved.txt' }, new AbortController().signal); assert.match(JSON.stringify(result), /committed fixture/); assert.doesNotMatch(JSON.stringify(result), /dirty original/); await runtime.close();
});


test('MCP discovery API returns actionable sanitized failures without saving a failed catalog', async t => {
  const f = await workspace(t); await f.worker.updateSettings({ board: { paused: true } });
  let mode = 'remote_error';
  const mcp = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    if (body.id === undefined) { res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'remote_error') { res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'fixture-private-discovery-secret must not reach the browser' } })); return; }
    const result = body.method === 'initialize'
      ? { protocolVersion: mode === 'protocol' ? 'unsupported-version' : body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [{ ...definition, inputSchema: { type: 'object', description: 'x'.repeat(17000) } }] };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => mcp.listen(0, '127.0.0.1', () => resolve(undefined))); cleanup(t, async () => { mcp.closeAllConnections(); await new Promise(resolve => mcp.close(resolve)); });
  await f.worker.updateToolAccess({ ...edit(f.worker.settings.toolPolicy()), mcp: [httpConnection({ url: 'http://127.0.0.1:' + testListeningAddress(mcp).port + '/mcp', secret: 'fixture-private-discovery-secret' })] });
  const revision = f.worker.settings.toolPolicy().revision;
  for (const [nextMode, status, message] of /** @type {const} */ ([['remote_error', 503, /connection failed/], ['protocol', 503, /unsupported or malformed/], ['oversize', 400, /exceeds the worker limit/]])) {
    mode = nextMode;
    const response = await f.api('/api/tool-access/discover', { id: 'fixture', expectedRevision: revision });
    assert.equal(response.status, status); assert.match(response.value.error, message); assert.doesNotMatch(JSON.stringify(response.value), /fixture-private-discovery-secret/);
    assert.equal(f.worker.settings.toolPolicy().revision, revision); assert.deepEqual(f.worker.settings.toolPolicy().mcp[0].discoveredTools, []);
    assert.equal(f.worker.toolAccess().canEdit, true, 'discovery failure releases the configuration lock');
  }
});

test('tool API saves CLI tools only while paused and idle, explains invalid policies and offers the worker Node.js', async t => {
  const f = await workspace(t);
  const cliTool = { id: 'harness', name: 'Project harness', enabled: true, executable: process.execPath, args: ['bin/harness.mjs'], commands: [{ command: 'check' }, { command: 'backlog set', requireOneOf: ['--dry-run'] }], refusedOptions: ['--root'] };
  const request = () => ({ ...edit(f.worker.settings.toolPolicy()), builtins: { ...defaultToolPolicy().builtins, cliTools: [cliTool] } });
  assert.equal((await f.api('/api/tool-access', request())).status, 409, 'running workers cannot gain CLI tools');
  await f.worker.updateSettings({ board: { paused: true } });
  const invalid = await f.api('/api/tool-access', { ...request(), builtins: { ...defaultToolPolicy().builtins, cliTools: [{ ...cliTool, commands: [{ command: 'backlog set', requireOneOf: ['--root'] }] }] } });
  assert.equal(invalid.status, 400); assert.match(invalid.value.error, /requires a flag that is also refused/);
  const saved = await f.api('/api/tool-access', request());
  assert.equal(saved.status, 200); assert.equal(saved.value.workerNode, process.execPath);
  assert.deepEqual(saved.value.builtins.cliTools[0].commands[1], { command: 'backlog set', requireOneOf: ['--dry-run'], refusedOptions: [] });
  assert.equal(saved.value.builtins.cliTools[0].maxArgs, 24);
  assert.equal(f.worker.capabilities().toolAccess.cliTools, 'argument_policy_in_task_worktree');
});


test('required feature checks are explicit, validated and survive a saved policy round trip', () => {
  const defaults = defaultToolPolicy();
  const preset = { id: 'tests', name: 'Project tests', executable: process.execPath, args: ['--test'], enabled: true };
  const update = verification => updateToolPolicy(defaults, { ...edit(defaults), builtins: { ...defaults.builtins, files: true, commands: [{ ...preset, ...verification }] } });
  assert.deepEqual(update({}).builtins.commands[0], preset);
  assert.deepEqual(update({ verification: false }).builtins.commands[0], preset);
  const required = update({ verification: true });
  assert.deepEqual(validateToolPolicy(JSON.parse(JSON.stringify(required))).builtins.commands[0], { ...preset, verification: true });
  for (const verification of ['true', 1, null, {}, []]) assert.throws(() => update({ verification }), /Required feature check/);
  const definitions = Array.from({ length: 58 }, (_, i) => ({ ...definition, name: 'reserved_' + i }));
  assert.throws(() => validateToolPolicy({ ...required, mcp: [{ ...httpConnection(), secret: '', discoveredTools: definitions, allowedTools: definitions.map(item => item.name) }] }), /at most 64/, 'reserve the three candidate tools alongside file and command tools');
});


test('tool API keeps invocation budgets separate and saves, preserves or clears per-grant deadlines', async t => {
  const f = await workspace(t); await f.worker.updateSettings({ board: { paused: true } });
  const before = structuredClone(f.worker.settings.value.execution);
  const command = { id: 'unit-tests', name: 'Unit tests', executable: process.execPath, args: ['--version'], enabled: true, verification: true, timeoutMs: 600000 };
  const request = timeoutMs => ({ ...edit(f.worker.settings.toolPolicy()), builtins: { ...defaultToolPolicy().builtins, commands: [{ ...command, timeoutMs }] } });
  const rejected = await f.api('/api/tool-access', request(3600001));
  assert.equal(rejected.status, 400); assert.match(rejected.value.error, /timeout.*1000 to 3600000/);
  const saved = await f.api('/api/tool-access', request(600000));
  assert.equal(saved.status, 200); assert.equal(saved.value.builtins.commands[0].timeoutMs, 600000); assert.equal(saved.value.builtins.commands[0].verification, true);
  assert.equal(saved.value.limits, undefined); assert.deepEqual(f.worker.settings.value.execution, before);
  const oldClient = request(undefined); delete oldClient.builtins.commands[0].timeoutMs;
  assert.equal((await f.api('/api/tool-access', oldClient)).value.builtins.commands[0].timeoutMs, 600000);
  const cleared = await f.api('/api/tool-access', request(null)); assert.equal(cleared.status, 200); assert.equal('timeoutMs' in cleared.value.builtins.commands[0], false);
  assert.equal(f.worker.capabilities().toolAccess.executionLimits, 'operator_configured_per_grant');
});
