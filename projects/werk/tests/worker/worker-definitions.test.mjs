import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerDefinitions, previewDefinition, definitionConnection } from './application-fixtures.mjs';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { LocalTaskboard } from './application-fixtures.mjs';
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
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'werk-definitions-')); cleanup(t, () => rm(path, { recursive: true, force: true })); return path; }
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
  const sessions = new WorkerSessions(path, settings, model); await sessions.init(); cleanup(t, () => sessions.close());
  const result = await sessions.definitions.action({ action: 'import', name: 'Reviewer', yaml: source }); const id = result.definitions[0].id;
  await sessions.action({ action: 'create', title: 'Review task', provider: 'openai-api', definitionId: id, agent: 'root' }); const sessionId = sessions.current.id;
  await sessions.start('Review this plan'); await idle(sessions);
  await sessions.definitions.action({ action: 'delete', id });
  await sessions.start('Explain the alternatives'); await idle(sessions);
  assert.equal(seen.length, 2); assert.equal(seen[1].connection.instruction, 'Give a concise answer.\n\nExplain tradeoffs.'); assert.equal(seen[1].connection.model, 'gpt-test'); assert.equal(seen[1].messages.length, 3);
  const recovered = new WorkerSessions(path, settings, model); await recovered.init(); cleanup(t, () => recovered.close()); assert.equal(recovered.current.id, sessionId); assert.equal(recovered.current.definition.name, 'Reviewer');
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
  const path = await directory(t), settings = new WorkerSettings(path); await settings.init(); const sessions = new WorkerSessions(path, settings, () => undefined); await sessions.init(); cleanup(t, () => sessions.close());
  const { definitions: [entry] } = await sessions.definitions.action({ action: 'import', name: 'Large', yaml: 'agents:\n  root:\n    instruction: ' + 'x'.repeat(15000) });
  for (let n = 0; n < 10; n++) await sessions.action({ action: 'create', title: 'Task ' + n, provider: 'openai-api', definitionId: entry.id });
  assert.ok((await readFile(join(path, 'sessions.json'))).length > 131072);
  const recovered = new WorkerSessions(path, settings, () => undefined); await recovered.init(); cleanup(t, () => recovered.close()); assert.equal(recovered.view().records.length, 11);
});
test('explicit file tasks preserve their definition for execution and retries without editing files', async t => {
  const path = await directory(t), repo = join(path, 'repo'); await mkdir(repo); await writeFile(join(repo, 'a.txt'), 'old');
  const settings = new WorkerSettings(path); await settings.init(); const sessions = new WorkerSessions(path, settings, () => undefined); await sessions.init(); cleanup(t, () => sessions.close());
  const { definitions: [entry] } = await sessions.definitions.action({ action: 'import', name: 'Reviewer', yaml: source }); let used;
  const board = new LocalTaskboard(path, settings, sessions, connection => ({ async reply() { used = connection; return JSON.stringify({ summary: 'Proposed edit', files: [{ path: 'a.txt', content: 'new' }] }); } })); await board.init(); cleanup(t, () => board.close());
  await board.create({ title: 'Edit', instruction: 'Change file', repository: repo, paths: ['a.txt'], provider: 'openai-api', definitionId: entry.id }); await sessions.definitions.action({ action: 'delete', id: entry.id }); await board.tick();
  for (let n = 0; n < 100 && board.active; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(board.view().tasks[0].status, 'review'); assert.equal(used.instruction, 'Give a concise answer.\n\nExplain tradeoffs.'); assert.equal(used.model, 'gpt-test'); assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'old'); assert.equal(sessions.detail(board.view().tasks[0].sessionId).session.definition.name, 'Reviewer');
});

test('subscription CLIs receive the chosen definition model and instructions with no shell interpolation', { skip: process.platform === 'win32' }, async t => {
  const path = await directory(t);
  for (const id of ['codex-cli', 'claude-cli']) {
    const executable = join(path, id);
    await writeFile(executable, `#!/usr/bin/env node\nlet input='';for await(const chunk of process.stdin)input+=chunk;const args=process.argv.slice(2);if(args[args.indexOf('--model')+1]!=='definition-model')process.exit(2);if(!(${JSON.stringify(id)}==='codex-cli'?input:(await import('node:fs')).readFileSync(args[args.indexOf('--system-prompt-file')+1],'utf8')).includes('Review carefully.'))process.exit(3);console.log(JSON.stringify(${JSON.stringify(id)}==='codex-cli'?{type:'item.completed',item:{type:'agent_message',text:'Profile applied'}}:{is_error:false,result:'Profile applied'}));`, { mode: 0o700 });
    const model = modelFor({ id, executable, apiKey: '', model: 'definition-model', instruction: 'Review carefully.' }, path);
    assert.equal(await model.reply([{ role: 'user', text: 'Help' }], AbortSignal.timeout(5000)), 'Profile applied');
  }
});

test('automation idempotency survives definition deletion without changing the frozen task profile', async t => {
  const path = await directory(t);
  const workspace = new WorkerWorkspace({ stateDir: path, pollMs: 1000, timeoutMs: 1000 }, {}, () => ({ activeTasks: [], queuedTasks: [] }));
  await workspace.init(); cleanup(t, () => workspace.close());
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

test('stable definition references select a worker-local definition, move explicitly and survive restart', async t => {
  const path = await directory(t), definitions = new WorkerDefinitions(path); await definitions.init();
  const { definitions: [first] } = await definitions.action({ action: 'import', name: 'Reviewer v1', ref: 'team-reviewer', yaml: source });
  assert.equal(first.ref, 'team-reviewer');
  const byRef = definitions.select({ definitionRef: 'team-reviewer', agent: 'writer' });
  assert.equal(byRef.definitionId, first.id); assert.equal(byRef.ref, 'team-reviewer'); assert.equal(byRef.agent, 'writer'); assert.equal(byRef.digest, first.digest);
  assert.deepEqual(definitions.select({ definitionId: first.id, agent: 'writer' }), byRef, 'id and reference select the same snapshot');
  assert.throws(() => definitions.select({ definitionId: first.id, definitionRef: 'team-reviewer' }), /not both/);
  assert.throws(() => definitions.select({ definitionRef: 'Team_Reviewer' }), /lowercase/);
  assert.throws(() => definitions.select({ definitionRef: 'missing-profile' }), /definition ref/);
  await assert.rejects(definitions.action({ action: 'import', name: 'Duplicate', ref: 'team-reviewer', yaml: source }), /already selects Reviewer v1/);
  await assert.rejects(definitions.action({ action: 'import', name: 'Bad', ref: '-bad', yaml: source }), /lowercase/);
  const { definitions: [, second] } = await definitions.action({ action: 'import', name: 'Reviewer v2', yaml: source.replace('Give a concise answer.', 'Give a thorough answer.') });
  assert.equal(second.ref, undefined);
  const moved = await definitions.action({ action: 'ref', id: second.id, ref: 'team-reviewer' });
  assert.equal(moved.definitions.find(item => item.id === first.id).ref, undefined); assert.equal(moved.definitions.find(item => item.id === second.id).ref, 'team-reviewer');
  assert.match(definitions.select({ definitionRef: 'team-reviewer' }).instruction, /thorough/);
  assert.equal(byRef.definitionId, first.id, 'an earlier snapshot is not rewritten when its reference moves');
  await assert.rejects(definitions.action({ action: 'ref', id: 'missing', ref: 'other' }), /not found/);
  const recovered = new WorkerDefinitions(path); await recovered.init();
  assert.equal(recovered.select({ definitionRef: 'team-reviewer' }).definitionId, second.id);
  await recovered.action({ action: 'ref', id: second.id, ref: '' });
  assert.throws(() => recovered.select({ definitionRef: 'team-reviewer' }), /No agent definition/);
});

test('stored references are validated and unique when a worker loads its definitions', async t => {
  for (const refs of [['dup', 'dup'], ['Bad Ref']]) {
    const path = await directory(t), definitions = new WorkerDefinitions(path); await definitions.init();
    for (const [n] of refs.entries()) await definitions.action({ action: 'import', name: 'Profile ' + n, yaml: source });
    const file = join(path, 'agent-definitions.json'), saved = JSON.parse(await readFile(file, 'utf8'));
    saved.forEach((item, n) => { item.ref = refs[n]; }); await writeFile(file, JSON.stringify(saved));
    await assert.rejects(new WorkerDefinitions(path).init(), /references/);
  }
});

test('automation creates tasks by definition reference and replays them after the reference moves', async t => {
  const path = await directory(t);
  const workspace = new WorkerWorkspace({ stateDir: path, pollMs: 1000, timeoutMs: 1000 }, {}, () => ({ activeTasks: [], queuedTasks: [] }));
  await workspace.init(); cleanup(t, () => workspace.close());
  await workspace.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-only', model: 'fixture-model' }, board: { paused: true } });
  const { definitions: [entry] } = await workspace.definitions.action({ action: 'import', name: 'Profile', ref: 'shared-profile', yaml: source });
  const command = { action: 'create', id: 'ref-task', title: 'Review', provider: 'openai-api', message: 'Review this', definitionRef: 'shared-profile', agent: 'root' };
  const first = await workspace.task(command); assert.equal(first.session.definition.definitionId, entry.id); assert.equal(first.session.definition.ref, 'shared-profile');
  const { definitions: [, replacement] } = await workspace.definitions.action({ action: 'import', name: 'Replacement', yaml: source });
  await workspace.definitions.action({ action: 'ref', id: replacement.id, ref: 'shared-profile' });
  const repeated = await workspace.task(command); assert.equal(repeated.session.id, first.session.id); assert.equal(repeated.session.definition.definitionId, entry.id);
  await assert.rejects(workspace.task({ action: 'send', id: 'ref-task', message: 'Followup', definitionRef: 'shared-profile' }), /fixed when a task is created/);
  await workspace.task({ action: 'cancel', id: 'ref-task' });
});

test('definition update previews changes, requires the current revision and keeps the id and reference', async t => {
  const path = await directory(t), definitions = new WorkerDefinitions(path); await definitions.init();
  const { definitions: [entry] } = await definitions.action({ action: 'import', name: 'Reviewer', ref: 'team-reviewer', yaml: source });
  assert.match(entry.revision, /^[a-f0-9]{64}$/);
  const yaml = source.replace('Give a concise answer.', 'Give a thorough answer.').replace(/  writer:\n[\s\S]*$/, '  tester:\n    model: openai/gpt-test\n    instruction: Write tests first.\n');
  const file = join(path, 'agent-definitions.json'), before = await readFile(file, 'utf8');
  const preview = await definitions.action({ action: 'update', ref: 'team-reviewer', yaml, name: 'Reviewer v2', dryRun: true });
  assert.equal(preview.dryRun, true); assert.equal(preview.definition.id, entry.id); assert.equal(preview.definition.revision, entry.revision);
  assert.deepEqual(preview.changes.name, { from: 'Reviewer', to: 'Reviewer v2' }); assert.equal(preview.changes.unchanged, false);
  assert.deepEqual(preview.changes.agents, { added: ['tester'], removed: ['writer'], changed: [{ name: 'root', fields: ['instruction'] }] });
  assert.equal(await readFile(file, 'utf8'), before, 'a dry run never writes');
  assert.match(definitions.select({ definitionRef: 'team-reviewer' }).instruction, /concise/);
  await assert.rejects(definitions.action({ action: 'update', ref: 'team-reviewer', yaml }), /current definition revision/);
  await assert.rejects(definitions.action({ action: 'update', ref: 'team-reviewer', yaml, revision: 'a'.repeat(64) }), error => error.code === 'conflict');
  await assert.rejects(definitions.action({ action: 'update', ref: 'missing-profile', yaml, revision: entry.revision }), error => error.code === 'not_found' && /missing-profile/.test(error.message));
  await assert.rejects(definitions.action({ action: 'update', ref: 'missing-profile', yaml, dryRun: true }), error => error.code === 'not_found');
  await assert.rejects(definitions.action({ action: 'update', ref: 'team-reviewer', yaml: 'agents: {root: {instruction: "${KEY}"}}', revision: entry.revision }), /templates/);
  await assert.rejects(definitions.action({ action: 'import', name: 'X', yaml, dryRun: true }), /dryRun/);
  const result = await definitions.action({ action: 'update', ref: 'team-reviewer', yaml, name: 'Reviewer v2', revision: entry.revision });
  const [updated] = result.definitions;
  assert.equal(result.definitions.length, 1); assert.equal(updated.id, entry.id); assert.equal(updated.ref, 'team-reviewer'); assert.equal(updated.createdAt, entry.createdAt);
  assert.equal(updated.name, 'Reviewer v2'); assert.notEqual(updated.digest, entry.digest); assert.ok(Date.parse(updated.updatedAt));
  assert.equal(result.updated.revision, updated.revision); assert.equal(preview.definition.nextRevision, updated.revision);
  assert.match(definitions.select({ definitionRef: 'team-reviewer' }).instruction, /thorough/);
  await assert.rejects(definitions.action({ action: 'update', ref: 'team-reviewer', yaml: source, revision: entry.revision }), error => error.code === 'conflict', 'a stale revision cannot overwrite the update');
  const renamed = await definitions.action({ action: 'update', ref: 'team-reviewer', yaml, revision: updated.revision });
  assert.equal(renamed.updated.changes.unchanged, true); assert.equal(renamed.definitions[0].name, 'Reviewer v2', 'an omitted name keeps the current name');
  const recovered = new WorkerDefinitions(path); await recovered.init();
  assert.equal(recovered.view().definitions[0].revision, updated.revision); assert.equal(recovered.select({ definitionRef: 'team-reviewer', agent: 'tester' }).definitionId, entry.id);
});

test('existing tasks keep their accepted profile snapshot after an in-place definition update', async t => {
  const path = await directory(t);
  const workspace = new WorkerWorkspace({ stateDir: path, pollMs: 1000, timeoutMs: 1000 }, {}, () => ({ activeTasks: [], queuedTasks: [] }));
  await workspace.init(); cleanup(t, () => workspace.close());
  await workspace.updateSettings({ provider: { id: 'openai-api', apiKey: 'fixture-only', model: 'fixture-model' }, board: { paused: true } });
  const { definitions: [entry] } = await workspace.definitions.action({ action: 'import', name: 'Profile', ref: 'shared-profile', yaml: source });
  const command = { action: 'create', id: 'snapshot-task', title: 'Review', provider: 'openai-api', message: 'Review this', definitionRef: 'shared-profile', agent: 'root' };
  const first = await workspace.task(command);
  await workspace.definitions.action({ action: 'update', ref: 'shared-profile', yaml: source.replace('Give a concise answer.', 'Give a thorough answer.'), revision: entry.revision });
  const replay = await workspace.task(command);
  assert.equal(replay.session.id, first.session.id); assert.equal(replay.session.definition.digest, entry.digest); assert.match(replay.session.definition.instruction, /concise/);
  const later = await workspace.task({ ...command, id: 'snapshot-task-2' });
  assert.equal(later.session.definition.definitionId, entry.id); assert.notEqual(later.session.definition.digest, entry.digest); assert.match(later.session.definition.instruction, /thorough/);
  for (const id of ['snapshot-task', 'snapshot-task-2']) await workspace.task({ action: 'cancel', id });
});
