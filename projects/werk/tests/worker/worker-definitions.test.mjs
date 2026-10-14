import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerDefinitions, previewDefinition, definitionConnection } from '../../src/worker/dist/worker/application/definitions.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from '../../src/worker/dist/worker/application/sessions.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { LocalTaskboard } from '../../src/worker/dist/worker/application/local-tasks.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
const source = `version: '16'
models:
  chosen:
    provider: openai
    model: gpt-test
agents:
  root:
    description: Reviews architecture
    model: chosen
    instruction:
      - Give a concise answer.
      - Explain tradeoffs.
  writer:
    model: anthropic/claude-test
    instruction: Write clear documentation.
`;
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'werk-definitions-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function idle(sessions) { for (let n = 0; n < 200 && sessions.busy; n++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(sessions.busy, false); }
test('Docker Agent schema 16 instructions and named/inline models are parsed without execution', () => {
  const value = previewDefinition(source); assert.equal(value.compatibility, 'instruction-profile'); assert.equal(value.agents[0].instruction, 'Give a concise answer.\n\nExplain tradeoffs.'); assert.equal(value.agents[0].model, 'gpt-test'); assert.equal(value.agents[0].requiresAdaptation, false); assert.equal(value.agents[1].provider, 'anthropic');
});
test('unsupported Docker execution/model controls remain visible and require explicit adaptation', async t => {
  const definitions = new WorkerDefinitions(await directory(t)); await definitions.init();
  const imported = await definitions.action({ action: 'import', name: 'Tool agent', yaml: `agents:\n  root:\n    instruction: Explain the task.\n    model: local\n    toolsets:\n      - type: shell\n    sub_agents: [writer]\nmodels:\n  local:\n    provider: dmr\n    model: ai/qwen\n    temperature: 0.2\nhooks:\n  post_tool:\n    command: touch SHOULD-NOT-EXIST\n` });
  const definition = imported.definitions[0]; assert.ok(definition.agents[0].unsupported.includes('agents.root.toolsets')); assert.ok(definition.agents[0].unsupported.includes('document.hooks')); assert.throws(() => definitions.select({ definitionId: definition.id }), /Use instructions only/);
  const snapshot = definitions.select({ definitionId: definition.id, useInstructionsOnly: true }); assert.equal(snapshot.adapted, true); assert.equal(snapshot.model, ''); assert.equal(definitionConnection({ id: 'openai-api', model: 'configured', executable: '', apiKey: 'secret' }, snapshot).model, 'configured');
});
test('malformed, ambiguous, deeply nested or credential-bearing YAML is rejected before preview', () => {
  const invalid = [
    'agents: {root: {instruction: hi, instruction: duplicate}}',
    'agents: {root: {instruction: hi}}\n---\nagents: {}',
    'agents: {root: {instruction: &x hi}, next: *x}',
    'agents: {root: {instruction: !custom hi}}',
    'agents: {root: {instruction: "${API_KEY}"}}',
    'agents: {root: {instruction: hi, env: {SECRET: value}}}',
    'agents: {root: {instruction: hi, api_key: abc}}',
    'agents: {__proto__: {instruction: hi}}',
    'agents: {root: {instruction: hi, constructor: bad}}',
    'agents: {root: {instruction: "sk-proj-123456789012345678901234567890"}}',
    'agents: {root: {instruction: hi, nested: ' + '['.repeat(30) + '0' + ']'.repeat(30) + '}}',
    'agents: {root: {instruction: hi, model: broken}}\nmodels: {broken: {provider: 123, model: x}}',
    'x'.repeat(65537)
  ]; for (const yaml of invalid) assert.throws(() => previewDefinition(yaml), undefined, yaml.slice(0, 100));
  const missing = previewDefinition('agents: {root: {instruction: hi, model: broken}}\nmodels: {broken: {}}'); assert.equal(missing.agents[0].requiresAdaptation, true);
});
test('definition snapshots survive deletion, task followups and worker restart, and reach injected model', async t => {
  const path = await directory(t), settings = new WorkerSettings(path); await settings.init();
  const seen = []; const model = connection => ({ async reply(messages) { seen.push({ connection, messages }); return 'Reviewed.'; } });
  const sessions = new WorkerSessions(path, settings, model); await sessions.init(); t.after(() => sessions.close());
  const result = await sessions.definitions.action({ action: 'import', name: 'Reviewer', yaml: source }); const id = result.definitions[0].id;
  await sessions.action({ action: 'create', title: 'Review task', provider: 'openai-api', definitionId: id, agent: 'root' }); const sessionId = sessions.current.id;
  await sessions.start('Review this plan'); await idle(sessions);
  await sessions.definitions.action({ action: 'delete', id });
  await sessions.start('Explain the alternatives'); await idle(sessions);
  assert.equal(seen.length, 2); assert.equal(seen[1].connection.instruction, 'Give a concise answer.\n\nExplain tradeoffs.'); assert.equal(seen[1].connection.model, 'gpt-test'); assert.equal(seen[1].messages.length, 3);
  const recovered = new WorkerSessions(path, settings, model); await recovered.init(); t.after(() => recovered.close()); assert.equal(recovered.current.id, sessionId); assert.equal(recovered.current.definition.name, 'Reviewer');
  await recovered.start('Continue'); await idle(recovered); assert.equal(seen[2].connection.model, 'gpt-test');
});
test('definition selection cannot silently switch provider families or credentials', async t => {
  const definitions = new WorkerDefinitions(await directory(t)); await definitions.init(); const { definitions: [entry] } = await definitions.action({ action: 'import', name: 'Profile', yaml: source });
  const snapshot = definitions.select({ definitionId: entry.id, agent: 'writer' });
  assert.throws(() => definitionConnection({ id: 'codex-cli', executable: '/codex', model: '', apiKey: '' }, snapshot), /matching worker provider/);
  const result = definitionConnection({ id: 'anthropic-api', executable: '', model: 'old', apiKey: 'private' }, snapshot); assert.equal(result.apiKey, 'private'); assert.equal(result.model, 'claude-test');
});
test('actual API requests use immutable definition instruction and model in provider protocol', async () => {
  for (const id of ['openai-api', 'anthropic-api']) {
    let body;
    const model = modelFor({ id, apiKey: 'private', executable: '', model: 'definition-model', instruction: 'Explain design decisions.' }, '/tmp', async (_url, options) => { body = JSON.parse(options.body); return Response.json(id === 'openai-api' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] }); });
    assert.equal(await model.reply([{ role: 'user', text: 'Help' }], new AbortController().signal), 'Done'); assert.equal(body.model, 'definition-model'); assert.match(id === 'openai-api' ? body.instructions : body.system, /Explain design decisions\./); assert.match(id === 'openai-api' ? body.instructions : body.system, /Werk interaction protocol version 1/);
  }
});
test('large definition task snapshots remain restartable beyond the old 128 KiB catalog limit', async t => {
  const path = await directory(t), settings = new WorkerSettings(path); await settings.init(); const sessions = new WorkerSessions(path, settings, () => undefined); await sessions.init(); t.after(() => sessions.close());
  const { definitions: [entry] } = await sessions.definitions.action({ action: 'import', name: 'Large', yaml: 'agents:\n  root:\n    instruction: ' + 'x'.repeat(15000) });
  for (let n = 0; n < 10; n++) await sessions.action({ action: 'create', title: 'Task ' + n, provider: 'openai-api', definitionId: entry.id });
  assert.ok((await readFile(join(path, 'sessions.json'))).length > 131072);
  const recovered = new WorkerSessions(path, settings, () => undefined); await recovered.init(); t.after(() => recovered.close()); assert.equal(recovered.view().records.length, 11);
});
test('explicit file tasks preserve their definition for execution and retries without editing files', async t => {
  const path = await directory(t), repo = join(path, 'repo'); await mkdir(repo); await writeFile(join(repo, 'a.txt'), 'old');
  const settings = new WorkerSettings(path); await settings.init(); const sessions = new WorkerSessions(path, settings, () => undefined); await sessions.init(); t.after(() => sessions.close());
  const { definitions: [entry] } = await sessions.definitions.action({ action: 'import', name: 'Reviewer', yaml: source }); let used;
  const board = new LocalTaskboard(path, settings, sessions, connection => ({ async reply() { used = connection; return JSON.stringify({ summary: 'Proposed edit', files: [{ path: 'a.txt', content: 'new' }] }); } })); await board.init(); t.after(() => board.close());
  await board.create({ title: 'Edit', instruction: 'Change file', repository: repo, paths: ['a.txt'], provider: 'openai-api', definitionId: entry.id }); await sessions.definitions.action({ action: 'delete', id: entry.id }); await board.tick();
  for (let n = 0; n < 100 && board.active; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(board.view().tasks[0].status, 'review'); assert.equal(used.instruction, 'Give a concise answer.\n\nExplain tradeoffs.'); assert.equal(used.model, 'gpt-test'); assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'old'); assert.equal(sessions.detail(board.view().tasks[0].sessionId).session.definition.name, 'Reviewer');
});

test('subscription CLIs receive the chosen definition model and instructions with no shell interpolation', { skip: process.platform === 'win32' }, async t => {
  const path = await directory(t);
  for (const id of ['codex-cli', 'claude-cli']) {
    const executable = join(path, id);
    await writeFile(executable, `#!/usr/bin/env node\nlet input='';for await(const chunk of process.stdin)input+=chunk;const args=process.argv.slice(2);if(args[args.indexOf('--model')+1]!=='definition-model')process.exit(2);if(!(${JSON.stringify(id)}==='codex-cli'?input:args[args.indexOf('--system-prompt')+1]).includes('Review carefully.'))process.exit(3);console.log(JSON.stringify(${JSON.stringify(id)}==='codex-cli'?{type:'item.completed',item:{type:'agent_message',text:'Profile applied'}}:{is_error:false,result:'Profile applied'}));`, { mode: 0o700 });
    const model = modelFor({ id, executable, apiKey: '', model: 'definition-model', instruction: 'Review carefully.' }, path);
    assert.equal(await model.reply([{ role: 'user', text: 'Help' }], AbortSignal.timeout(5000)), 'Profile applied');
  }
});

test('automation idempotency survives definition deletion without changing the frozen task profile', async t => {
  const path = await directory(t);
  const workspace = new WorkerWorkspace({ stateDir: path, pollMs: 1000, timeoutMs: 1000 }, {}, () => ({ activeTasks: [], queuedTasks: [] }));
  await workspace.init(); t.after(() => workspace.close());
  await workspace.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-only', model: 'fixture-model' }, board: { paused: true } });
  const { definitions: [entry] } = await workspace.definitions.action({ action: 'import', name: 'Profile', yaml: source });
  const command = { action: 'create', id: 'same-task', title: 'Review', provider: 'openai-api', message: 'Review this', definitionId: entry.id, agent: 'root' };
  const first = await workspace.task(command); assert.equal(first.chat.phase, 'queued');
  await workspace.definitions.action({ action: 'delete', id: entry.id });
  const repeated = await workspace.task(command); assert.equal(repeated.session.id, first.session.id); assert.equal(repeated.chat.messages.length, 2);
  await assert.rejects(workspace.task({ ...command, message: 'Different input' }), /different input/);
  await assert.rejects(workspace.task({ ...command, id: 'new-task' }), /definition not found/);
  await assert.rejects(workspace.task({ action: 'send', id: 'same-task', message: 'Followup', definitionId: entry.id }), /fixed when a task is created/);
  await workspace.task({ action: 'cancel', id: 'same-task' });
});
