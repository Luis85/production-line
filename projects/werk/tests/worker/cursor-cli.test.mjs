import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { prepareModelRequest, executeModel, requireModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { FileModelSessionStore } from '../../src/worker/dist/worker/infrastructure/model-session-store.js';
import { sessionDigest } from '../../src/worker/dist/worker/application/model-session.js';
import { ProviderAccountChecks, parseProviderAccount } from '../../src/worker/dist/worker/infrastructure/provider-account.js';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';
import { fixture as reviewerFixture, input as reviewerInput } from './ready-review-fixtures.mjs';

const native = { skip: process.platform === 'win32', timeout: 30000 };
/** @param {string} text @param {string} [id] */
const message = (text, id = text) => ({ id, role: /** @type {const} */ ('user'), text, state: /** @type {const} */ ('complete'), at: '2026-10-18T00:00:00Z' });
/** @returns {import('../../src/worker/application/model-session.js').ModelSessionBinding} */
const binding = (id = 'cursor-feature') => ({ schemaVersion: 1, logicalSessionId: id, featureRequestKey: 'fr-' + 'a'.repeat(64), providerId: 'cursor-cli', generation: 1 });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-cursor-test-')), log = join(directory, 'calls.jsonl'), mode = join(directory, 'mode');
  const executable = join(directory, 'agent-fixture'), store = new FileModelSessionStore(directory);
  await writeFile(mode, 'success');
  await writeFile(executable, '#!' + process.execPath + '\n' + `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const args=process.argv.slice(2);
const log=${JSON.stringify(log)}, mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');
if(args.includes('--version')){console.log('2026.10.18-fixture');process.exit(0)}
if(args.includes('status')){fs.appendFileSync(log,JSON.stringify({kind:'status'})+'\\n');console.log('Logged in as '+(process.env.CURSOR_API_KEY==='rotated-private-key'?'rotated':'worker')+'@example.test');console.error('private diagnostic '+process.env.CURSOR_API_KEY);process.exit(0)}
if(args.includes('create-chat')){const id=crypto.randomUUID();fs.appendFileSync(log,JSON.stringify({kind:'create',id,cwd:process.cwd()})+'\\n');console.log(id);process.exit(0)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
const id=args[args.indexOf('--resume')+1],plugin=args.includes('--plugin-dir')?args[args.indexOf('--plugin-dir')+1]:null;
const pluginManifest=plugin?JSON.parse(fs.readFileSync(path.join(plugin,'.cursor-plugin/plugin.json'),'utf8')):null;
const mcp=plugin?JSON.parse(fs.readFileSync(path.join(plugin,'mcp.json'),'utf8')):null;
fs.appendFileSync(log,JSON.stringify({kind:'run',args,id,input,cwd:process.cwd(),pluginManifest,mcp,hasKey:process.env.CURSOR_API_KEY==='fixture-private-key'})+'\\n');
if(mode==='deny'){console.error('permission denied secret '+process.env.CURSOR_API_KEY);process.exit(2)}
if(mode==='hang'){const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(directory, 'child.pid'))},String(child.pid));setInterval(()=>{},1000);return}
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:mode==='wrong-id'?crypto.randomUUID():id,result:'Implemented fixture.',usage:{input_tokens:999},total_cost_usd:999}));
});`, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  /** @param {import('../../src/worker/application/model-session.js').ModelSessionBinding} [scope] @param {import('../../src/worker/infrastructure/provider-tool-session.js').ProviderOptions} [options] @param {string} [modelName] */
  const create = (scope = binding(), options = {}, modelName = 'accepted-model') => {
    const model = modelFor({ id: 'cursor-cli', executable, model: modelName, apiKey: 'fixture-private-key', effort: 'default' }, directory, undefined, { ...options, session: { binding: scope, store } });
    assert.ok(model); return model;
  };
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, log, mode, executable, store, create, calls };
}

test('Cursor creates one explicit session per FR, freezes selection, resumes only new input and reports unknown usage', native, async t => {
  const f = await fixture(t), model = f.create(), first = prepareModelRequest(model, [message('First accepted request')]);
  assert.equal(first.policy.tools, 'provider_native'); assert.equal(first.policy.filesystem, 'provider_permissions');
  assert.equal(first.capabilities.nativeResume, true); assert.match(first.protocolInstructions, /Werk does not restrict native access/);
  const observations = [];
  await executeModel(model, first, t.signal, value => observations.push(value), { beforeCall() { assert.equal(observations.length, 0); } });
  const saved = await f.store.load(binding()); assert.equal(saved.status, 'idle'); assert.ok(saved.checkpoint.nativeId);
  const next = prepareModelRequest(model, [...first.messages, message('Only this follow-up is new')]);
  await executeModel(f.create(binding(), {}, 'changed-setting-must-not-win'), next, t.signal, value => observations.push(value));
  await assert.rejects(executeModel(model, next, t.signal), { code: 'session_conflict' });
  const calls = await f.calls(), runs = calls.filter(call => call.kind === 'run');
  assert.equal(calls.filter(call => call.kind === 'create').length, 1); assert.equal(runs.length, 2);
  assert.equal(runs[0].id, saved.checkpoint.nativeId); assert.equal(runs[1].id, runs[0].id);
  assert.doesNotMatch(runs[1].input, /First accepted request/); assert.match(runs[1].input, /Only this follow-up is new/);
  for (const run of runs) {
    assert.equal(run.args[run.args.indexOf('--model') + 1], 'accepted-model');
    assert.equal(run.args[run.args.indexOf('--mode') + 1], 'ask'); assert.equal(run.hasKey, true);
    for (const flag of ['--force', '--yolo', '--approve-mcps', '--trust', '--sandbox', '--continue', '--api-key', '--effort']) assert.ok(!run.args.includes(flag));
    assert.doesNotMatch(JSON.stringify(run.args), /accepted request|fixture-private-key/);
  }
  assert.ok(observations.every(value => value.source === 'unavailable' && value.inputTokens === null && value.providerReportedCostUsd === null));
  const checkpoint = join(f.directory, 'model-sessions', sessionDigest([binding().logicalSessionId, 1]) + '.json');
  assert.doesNotMatch(await readFile(checkpoint, 'utf8'), /fixture-private-key|First accepted request/);
});

test('Cursor native implementation requires the retained worktree and keeps supplemental tools invocation-local', native, async t => {
  const f = await fixture(t), worktree = join(f.directory, 'candidate'); await mkdir(worktree);
  let admitted = 0, closed = 0;
  /** @type {import('../../src/worker/application/tool-runtime.js').ToolRuntime} */
  const runtime = { manifest: { revision: 1, tools: [{ name: 'werk_candidate_apply', description: 'Candidate edit', inputSchema: { type: 'object' } }] },
    async nativeWorkspace() { admitted++; return worktree; }, async call() { return { content: [] }; }, async close() { closed++; } };
  const model = f.create(binding(), { tools: () => runtime });
  const request = prepareModelRequest(model, [message('Implement safely')], 'patch');
  assert.equal(request.policy.development, true); assert.equal(request.policy.tools, 'provider_native');
  await executeModel(model, request, t.signal);
  const run = (await f.calls()).find(call => call.kind === 'run');
  assert.equal(admitted, 1); assert.equal(closed, 1); assert.equal(run.cwd, worktree); assert.ok(!run.args.includes('--mode'));
  assert.equal(run.pluginManifest.name, 'werk-worker'); assert.equal(run.pluginManifest.mcpServers, 'mcp.json');
  assert.equal(run.mcp.mcpServers.werk.command, process.execPath);
  const plugin = run.args[run.args.indexOf('--plugin-dir') + 1]; await assert.rejects(access(plugin), { code: 'ENOENT' });
  await assert.rejects(access(join(worktree, '.cursor')), { code: 'ENOENT' });
  const withoutWorktree = { ...runtime, nativeWorkspace: undefined };
  const blocked = f.create(binding('blocked'), { tools: () => withoutWorktree });
  await assert.rejects(executeModel(blocked, prepareModelRequest(blocked, [message('Blocked')], 'patch'), t.signal), { code: 'tool_access' });
  assert.equal((await f.calls()).filter(call => call.kind === 'run').length, 1);
});

for (const mode of ['deny', 'wrong-id']) test(`Cursor ${mode} fails once and fences the unknown session without changing permissions`, native, async t => {
  const f = await fixture(t); await writeFile(f.mode, mode);
  const model = f.create(), request = prepareModelRequest(model, [message('Run once')]);
  await assert.rejects(executeModel(model, request, t.signal), error => {
    assert.doesNotMatch(String(error), /fixture-private-key|permission denied secret/); return true;
  });
  assert.equal((await f.store.load(binding())).status, 'unknown');
  await assert.rejects(executeModel(f.create(), prepareModelRequest(f.create(), [message('Try again')]), t.signal), { code: 'session_conflict' });
  const runs = (await f.calls()).filter(call => call.kind === 'run'); assert.equal(runs.length, 1); assert.ok(!runs[0].args.includes('--force'));
});

test('Cursor failed durable checkpoint prevents inference after non-inference chat allocation', native, async t => {
  const f = await fixture(t);
  const model = modelFor({ id: 'cursor-cli', executable: f.executable, model: 'accepted-model', apiKey: '' }, f.directory, undefined,
    { session: { binding: binding(), store: { load: value => f.store.load(value), async save() { throw Error('disk failed'); } } } });
  assert.ok(model);
  await assert.rejects(executeModel(model, prepareModelRequest(model, [message('Never dispatched')]), t.signal), { code: 'session_conflict' });
  assert.deepEqual((await f.calls()).map(call => call.kind), ['create']);
});

async function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'linux') return !/^\d+ \(.+\) Z/.test(await readFile('/proc/' + pid + '/stat', 'utf8').catch(() => '0 (gone) Z'));
  return true;
}
test('Cursor cancellation awaits process-tree cleanup and leaves an unknown checkpoint', native, async t => {
  const f = await fixture(t); await writeFile(f.mode, 'hang'); const controller = new AbortController(), model = f.create();
  const running = executeModel(model, prepareModelRequest(model, [message('Wait')]), controller.signal);
  const rejection = assert.rejects(running, { code: 'cancelled' });
  let pid = 0;
  for (let attempt = 0; attempt < 200 && !pid; attempt++) { await delay(25); pid = Number(await readFile(join(f.directory, 'child.pid'), 'utf8').catch(() => '')) || 0; }
  assert.ok(pid); controller.abort(); await rejection;
  for (let attempt = 0; attempt < 100 && await alive(pid); attempt++) await delay(20);
  assert.equal(await alive(pid), false); assert.equal((await f.store.load(binding())).status, 'unknown');
});

test('Cursor status/account probes never infer quota, expose credentials or make model calls', native, async t => {
  const f = await fixture(t), connection = { id: /** @type {const} */ ('cursor-cli'), executable: f.executable, model: 'accepted-model', apiKey: 'fixture-private-key' };
  const accounts = new ProviderAccountChecks(), status = new ProviderStatusChecks(); t.after(async () => { await accounts.close(); await status.close(); });
  const account = await accounts.check(connection), current = await status.check(connection);
  assert.equal(account.signedIn, true); assert.equal(account.email, 'worker@example.test'); assert.equal(account.subscription, null);
  assert.equal(current.authentication, 'authenticated'); assert.equal(current.version, '2026.10.18-fixture'); assert.match(current.message, /native permissions/);
  assert.doesNotMatch(JSON.stringify([account, current]), /fixture-private-key|private diagnostic/); assert.ok((await f.calls()).every(call => call.kind === 'status'));
  assert.equal((await f.calls()).length, 2);
  const rotated = { ...connection, apiKey: 'rotated-private-key' };
  assert.equal((await accounts.check(rotated)).email, 'rotated@example.test');
  assert.equal((await status.check(rotated)).authentication, 'authenticated');
  assert.equal((await f.calls()).length, 4, 'Credential rotation must refresh both caches immediately.');
  assert.doesNotMatch(JSON.stringify(await accounts.check(rotated)), /rotated-private-key/);
  assert.equal(parseProviderAccount('cursor-cli', 0, 'arbitrary private account output').signedIn, 'unknown');
  assert.equal(parseProviderAccount('cursor-cli', 1, 'Not authenticated').signedIn, false);
  assert.equal(parseProviderAccount('cursor-cli', 1, 'Logged in as worker@example.test').signedIn, 'unknown');
});

test('Cursor native capability cannot be relabeled as worker-enforced, and other providers cannot gain it', () => {
  const model = modelFor({ id: 'cursor-cli', executable: '/fixture/agent', model: 'selected', apiKey: '' }, '/fixture'); assert.ok(model);
  const request = prepareModelRequest(model, [message('Scope')]);
  assert.throws(() => requireModelRequest({ ...request, policy: { ...request.policy, tools: 'none', filesystem: 'read_only' }, capabilities: { ...request.capabilities, tools: 'none' } }, 'cursor-cli'));
  assert.throws(() => requireModelRequest({ ...request, provider: { ...request.provider, id: 'openai-api' } }, 'openai-api'));
  const unsupported = { ...model, configuration: { ...model.configuration, effort: 'high' } };
  assert.throws(() => prepareModelRequest(unsupported, [message('Unsupported effort')]));
});

test('Cursor Ready Check exposes native ask policy, strips supplemental grants and survives replay', async t => {
  const f = await reviewerFixture(t); f.selectedProfile.id = 'cursor-cli';
  const input = { ...reviewerInput(), provider: /** @type {const} */ ('cursor-cli') };
  await f.schedule(input); await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].policy.tools, 'provider_native'); assert.equal(f.calls[0].operation, 'chat');
  assert.equal(f.calls[0].policy.filesystem, 'provider_permissions'); assert.equal(f.calls[0].toolManifest, undefined);
  assert.equal(f.manager.inspect(input).state, 'completed'); await f.restart(); await f.schedule(input); assert.equal(f.calls.length, 1);
});
