import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import { createDevelopmentRuntime } from '../../src/worker/dist/worker/infrastructure/candidate-tools.js';
import { createRepositoryWorktree, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { workspaceModelFactory } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { defaultToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { freezeDevelopmentScope } from '../../src/worker/dist/worker/application/development.js';
import { validateExecutionPolicy } from '../../src/worker/dist/worker/application/execution-policy.js';
import { prepareModelRequest, requireModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { cleanup } from './fixture-cleanup.mjs';

const MiB = 1024 * 1024;
const signal = () => new AbortController().signal;
const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const defaults = { candidateApprovedFileMaxBytes: 24000, candidateApprovedTotalMaxBytes: 48000, candidateReviewPatchMaxBytes: 120000 };
const pick = value => Object.fromEntries(Object.keys(defaults).map(key => [key, value[key]]));

test('approved content settings keep the 0.13 defaults and enforce their ranges with named errors', () => {
  assert.deepEqual(pick(validateExecutionPolicy({ maxRuntimeMs: 1000 })), defaults, 'saved policies without the settings keep today\'s bounds');
  const valid = { candidateApprovedFileMaxBytes: [1000, 24000, 8388608], candidateApprovedTotalMaxBytes: [8388608, 67108864], candidateReviewPatchMaxBytes: [10000, 120000, 67108864] };
  for (const [field, values] of Object.entries(valid)) for (const value of values)
    assert.equal(validateExecutionPolicy({ maxRuntimeMs: 1000, candidateApprovedTotalMaxBytes: 67108864, [field]: value })[field], value, `${field}=${value}`);
  const invalid = { candidateApprovedFileMaxBytes: [999, 8388609, 1.5, '24000', null], candidateApprovedTotalMaxBytes: [999, 67108865, '48000'], candidateReviewPatchMaxBytes: [9999, 67108865, 2.5, null] };
  for (const [field, values] of Object.entries(invalid)) for (const value of values)
    assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, candidateApprovedFileMaxBytes: 1000, candidateApprovedTotalMaxBytes: 67108864, [field]: value }), error => error instanceof Error && error.message.startsWith(`execution.${field} must be an integer from `), `${field}=${String(value)}`);
  assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, candidateApprovedFileMaxBytes: 100000 }), { message: 'execution.candidateApprovedTotalMaxBytes (48000) must be at least execution.candidateApprovedFileMaxBytes (100000).' });
});

test('settings get shows approved content limits, saves only changed values and guards them with their own baseline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-review-settings-')); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const settings = new WorkerSettings(directory); await settings.init();
  assert.deepEqual(pick(settings.publicView().execution), defaults);
  const saved = async () => JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution;
  for (const key of Object.keys(defaults)) assert.equal((await saved())[key], undefined, 'defaults add no saved fields');
  const raised = { candidateApprovedFileMaxBytes: 64000, candidateApprovedTotalMaxBytes: 256000, candidateReviewPatchMaxBytes: 512000 };
  assert.deepEqual(pick((await settings.update({ execution: raised, expectedCandidateReview: defaults })).execution), raised);
  assert.deepEqual(pick(await saved()), raised);
  await assert.rejects(settings.update({ execution: { candidateApprovedFileMaxBytes: 1000 }, expectedCandidateReview: defaults }), error => testErrorCode(error) === 'conflict' && error instanceof Error && /Approved content limits changed in another session/.test(error.message));
  await assert.rejects(settings.update({ execution: { candidateApprovedFileMaxBytes: 1000 }, expectedCandidateReview: { candidateApprovedFileMaxBytes: 64000 } }), /complete approved content baseline/);
  await assert.rejects(settings.update({ execution: { maxToolCalls: 64 }, expectedCandidateReview: raised }), /requires new approved content or review patch limits/);
  await assert.rejects(settings.update({ execution: { candidateApprovedTotalMaxBytes: 32000 } }), error => testErrorCode(error) === 'invalid_input' && error instanceof Error && /candidateApprovedTotalMaxBytes \(32000\) must be at least execution\.candidateApprovedFileMaxBytes \(64000\)/.test(error.message));
  await settings.update({ execution: { candidateSourceMaxFiles: 30000 }, expectedCandidateInspection: { candidateSourceMaxBytes: 67108864, candidateSourceMaxFiles: 20000, candidateFileMaxBytes: 8388608 } });
  assert.equal(settings.publicView().execution.candidateApprovedFileMaxBytes, 64000, 'the inspection guard keeps its three fields and leaves review limits alone');
  const restarted = new WorkerSettings(directory); await restarted.init();
  assert.deepEqual(pick(restarted.publicView().execution), raised);
  await restarted.update({ execution: defaults });
  for (const key of Object.keys(defaults)) assert.equal((await saved())[key], undefined);
});

async function fixture(t, files, approvedPaths) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-review-limits-'))), repository = join(directory, 'repo');
  await mkdir(join(repository, 'gen'), { recursive: true }); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'readme.md'), 'notes\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  const prepared = await createRepositoryWorktree(await repositoryRoot(repository, signal()), 'project', 'review', signal());
  for (const [path, body] of Object.entries(files)) { await mkdir(join(prepared.path, path, '..'), { recursive: true }); await writeFile(join(prepared.path, path), body); }
  const info = await lstat(prepared.path), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  let policy = defaultToolPolicy();
  policy.builtins.files = true; policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: ['-e', ''], enabled: true, verification: true }]; policy = validateToolPolicy(policy);
  const scope = freezeDevelopmentScope(prepared.baseCommit, approvedPaths, policy);
  return limits => createDevelopmentRuntime({ scope, worktree: prepared.path, worktreeIdentity, repository, currentPolicy: () => policy, checkpoint: async () => {}, verifyWorkspace: async () => {}, ...limits });
}
const lines = (count, width = 99) => Array.from({ length: count }, (_, index) => String(index).padStart(width, 'x')).join('\n') + '\n';

test('one generated file above the approved file default fails with its size and passes when the setting is raised', async t => {
  const create = await fixture(t, { 'gen/large.ts': lines(300) }, ['gen/']);
  await assert.rejects(create().capture(signal()), { message: 'Approved candidate file "gen/large.ts" is 30,000 bytes; the approved file limit is 24,000 bytes (execution.candidateApprovedFileMaxBytes).' });
  const candidate = await create({ candidateApprovedFileMaxBytes: 32000 }).capture(signal());
  assert.deepEqual(candidate.changedPaths, ['gen/large.ts']);
  const exact = await fixture(t, { 'big.ts': lines(300) }, ['big.ts']);
  await assert.rejects(exact().capture(signal()), /"big\.ts" is 30,000 bytes; the approved file limit is 24,000 bytes/, 'exact entries use the same frozen bound');
  assert.equal((await exact({ candidateApprovedFileMaxBytes: 30000 }).capture(signal())).changedPaths[0], 'big.ts');
});

test('approved total and review patch limits fail at their defaults and pass when raised', async t => {
  const create = await fixture(t, { 'gen/a.ts': lines(200), 'gen/b.ts': lines(200), 'gen/c.ts': lines(200) }, ['gen/']);
  await assert.rejects(create().capture(signal()), { message: 'Approved candidate text is 60,000 bytes; the approved content limit is 48,000 bytes (execution.candidateApprovedTotalMaxBytes).' }, 'the whole approved size is reported');
  const raised = await create({ candidateApprovedTotalMaxBytes: 60000 }).capture(signal());
  assert.deepEqual(raised.changedPaths, ['gen/a.ts', 'gen/b.ts', 'gen/c.ts']);
  const many = await fixture(t, Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`gen/part-${index}.ts`, lines(230)])), ['gen/']);
  const total = { candidateApprovedTotalMaxBytes: 200000 };
  await assert.rejects(many(total).capture(signal()), /Candidate review patch is 1[0-9]{2},[0-9]{3} bytes; the review patch limit is 120,000 bytes \(execution\.candidateReviewPatchMaxBytes\)\./);
  const passed = await many({ ...total, candidateReviewPatchMaxBytes: 200000 }).capture(signal());
  assert.ok(Buffer.byteLength(passed.patch) > 120000 && passed.changedPaths.length === 6);
});

test('werk_candidate_apply uses the frozen approved file and total limits and names the setting', async t => {
  const create = await fixture(t, { 'gen/a.ts': lines(200) }, ['gen/']), runtime = create();
  await assert.rejects(runtime.apply({ path: 'gen/new.ts', content: 'x'.repeat(24001), expectedHash: null }, signal()), { message: 'Approved candidate file "gen/new.ts" is 24,001 bytes; the approved file limit is 24,000 bytes (execution.candidateApprovedFileMaxBytes).' });
  await runtime.apply({ path: 'gen/b.ts', content: 'x'.repeat(24000), expectedHash: null }, signal());
  await assert.rejects(runtime.apply({ path: 'gen/c.ts', content: 'x'.repeat(5000), expectedHash: null }, signal()), { message: 'Approved candidate text is 49,000 bytes; the approved content limit is 48,000 bytes (execution.candidateApprovedTotalMaxBytes).' });
  const raised = (await fixture(t, { 'gen/a.ts': lines(200) }, ['gen/']))({ candidateApprovedFileMaxBytes: 30000, candidateApprovedTotalMaxBytes: 50000 });
  await assert.rejects(raised.apply({ path: 'gen/new.ts', content: 'x'.repeat(30001), expectedHash: null }, signal()), /is 30,001 bytes; the approved file limit is 30,000 bytes/);
  const result = await raised.apply({ path: 'gen/new.ts', content: 'x'.repeat(29000), expectedHash: null }, signal());
  assert.ok(/** @type {{ changedPaths: string[] }} */ (result).changedPaths.includes('gen/new.ts'), 'content above the default per-file bound is accepted under the frozen raised limit');
});

test('implementation dispatches freeze the approved content limits, record them as evidence and size the apply schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-review-dispatch-')); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const info = await lstat(directory), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  const captured = { candidateApprovedFileMaxBytes: 64000, candidateApprovedTotalMaxBytes: 4 * MiB, candidateReviewPatchMaxBytes: 8 * MiB };
  const settings = { value: { execution: { ...validateExecutionPolicy({ maxRuntimeMs: 900000 }), ...captured }, repositories: { pollMs: 30000, items: [] } }, toolPolicy: () => policy };
  const unused = () => { throw Error('Metadata inspection must not inspect the candidate'); };
  const development = { capture: unused, apply: unused, check: unused, evidence: unused };
  const factory = workspaceModelFactory(directory, settings, (saved, path, _transport, options) => modelFor(saved, path, async () => { throw Error('No provider call'); }, options));
  /** @type {import('../../src/worker/application/provider-contract.js').ProviderConnection} */
  const connection = { id: 'openai-api', apiKey: 'fixture-only', executable: '', model: 'fixture' };
  /** @type {import('../../src/worker/application/conversation-contracts.js').ChatMessage[]} */
  const messages = [{ id: 'u', role: 'user', text: 'Implement.', state: 'complete', at: '2026-10-19T00:00:00Z' }];
  /** @param {{ tools: Array<{ name: string; inputSchema: unknown }> }} manifest */
  const maxLength = manifest => {
    const apply = manifest.tools.find(tool => tool.name === 'werk_candidate_apply'); assert.ok(apply);
    return /** @type {{ properties: { content: { maxLength: number } } }} */ (apply.inputSchema).properties.content.maxLength;
  };
  const request = prepareModelRequest(factory(connection, { sessionId: 'task', worktree: directory, worktreeIdentity, development }), messages, 'patch', 900000);
  assert.deepEqual(pick(request.policy), captured);
  assert.deepEqual(request.toolManifest.limits.candidateReview, captured);
  assert.equal(maxLength(request.toolManifest), 64000, 'the model learns the frozen approved file bound');
  settings.value.execution = { ...settings.value.execution, ...defaults };
  const next = prepareModelRequest(factory(connection, { sessionId: 'task', worktree: directory, worktreeIdentity, development }), messages, 'patch', 900000);
  assert.deepEqual(next.toolManifest.limits.candidateReview, defaults, 'new attempts capture current settings');
  assert.equal(maxLength(next.toolManifest), 24000);
  const legacy = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree: directory, worktreeIdentity, development });
  assert.equal(legacy.manifest.limits?.candidateReview, undefined, 'a dispatch prepared without captured limits keeps its exact manifest');
  assert.equal(maxLength(legacy.manifest), 24000);
  await legacy.close();
  const chat = prepareModelRequest(factory(connection, { sessionId: 'chat' }), messages, 'chat', 900000);
  for (const key of Object.keys(defaults)) assert.equal(chat.policy[key], undefined, 'only implementation dispatches carry approved content limits');
  const changed = change => { const copy = structuredClone(request); change(copy); return copy; };
  requireModelRequest(changed(() => {}), connection.id);
  requireModelRequest(changed(value => { delete value.toolManifest.limits.candidateReview; for (const key of Object.keys(defaults)) delete value.policy[key]; }), connection.id);
  for (const change of [
    value => { value.policy.candidateApprovedFileMaxBytes = 999; },
    value => { value.policy.candidateApprovedTotalMaxBytes = value.policy.candidateApprovedFileMaxBytes - 1; },
    value => { value.policy.candidateReviewPatchMaxBytes = 67108865; },
    value => { delete value.toolManifest.limits.candidateReview.candidateReviewPatchMaxBytes; },
    value => { value.toolManifest.limits.candidateReview.candidateSourceMaxBytes = 67108864; },
  ]) assert.throws(() => requireModelRequest(changed(change), connection.id), { code: 'protocol' });
  assert.throws(() => requireModelRequest({ ...structuredClone(chat), policy: { ...chat.policy, ...captured } }, connection.id), { code: 'protocol' });
});
