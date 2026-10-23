import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
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
  const valid = { candidateApprovedFileMaxBytes: [1000, 24000, 8388608], candidateApprovedTotalMaxBytes: [8388608, 67108864], candidateReviewPatchMaxBytes: [10000, 120000, 4194304] };
  for (const [field, values] of Object.entries(valid)) for (const value of values)
    assert.equal(validateExecutionPolicy({ maxRuntimeMs: 1000, candidateApprovedTotalMaxBytes: 67108864, [field]: value })[field], value, `${field}=${value}`);
  const invalid = { candidateApprovedFileMaxBytes: [999, 8388609, 1.5, '24000', null], candidateApprovedTotalMaxBytes: [999, 67108865, '48000'], candidateReviewPatchMaxBytes: [9999, 4194305, 67108864, 2.5, null] };
  for (const [field, values] of Object.entries(invalid)) for (const value of values)
    assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, candidateApprovedFileMaxBytes: 1000, candidateApprovedTotalMaxBytes: 67108864, [field]: value }), error => error instanceof Error && error.message.startsWith(`execution.${field} must be an integer from `), `${field}=${String(value)}`);
  assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, candidateReviewPatchMaxBytes: 4194305 }), { message: 'execution.candidateReviewPatchMaxBytes must be an integer from 10000 to 4194304 (4 MiB).' }, 'a stored patch must leave room in the 16 MiB taskboard');
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
  await assert.rejects(settings.update({ execution: { candidateReviewPatchMaxBytes: 4194305 } }), error => testErrorCode(error) === 'invalid_input' && error instanceof Error && error.message === 'execution.candidateReviewPatchMaxBytes must be an integer from 10000 to 4194304 (4 MiB).');
  await assert.rejects(settings.update({ execution: { candidateApprovedTotalMaxBytes: 32000 } }), error => testErrorCode(error) === 'invalid_input' && error instanceof Error && /candidateApprovedTotalMaxBytes \(32000\) must be at least execution\.candidateApprovedFileMaxBytes \(64000\)/.test(error.message));
  await settings.update({ execution: { candidateSourceMaxFiles: 30000 }, expectedCandidateInspection: { candidateSourceMaxBytes: 67108864, candidateSourceMaxFiles: 20000, candidateFileMaxBytes: 8388608 } });
  assert.equal(settings.publicView().execution.candidateApprovedFileMaxBytes, 64000, 'the inspection guard keeps its three fields and leaves review limits alone');
  const restarted = new WorkerSettings(directory); await restarted.init();
  assert.deepEqual(pick(restarted.publicView().execution), raised);
  await restarted.update({ execution: defaults });
  for (const key of Object.keys(defaults)) assert.equal((await saved())[key], undefined);
});

async function fixture(t, files, approvedPaths, committed = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-review-limits-'))), repository = join(directory, 'repo');
  await mkdir(join(repository, 'gen'), { recursive: true }); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'readme.md'), 'notes\n');
  for (const [path, body] of Object.entries(committed)) { await mkdir(join(repository, path, '..'), { recursive: true }); await writeFile(join(repository, path), body); }
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  // Cold containment startup belongs to fixture setup, not the unchanged Git operation budget.
  await prepareProcessRuntime(repository, t.signal);
  const prepared = await createRepositoryWorktree(await repositoryRoot(repository, signal()), 'project', 'review', signal());
  for (const [path, body] of Object.entries(files)) { await mkdir(join(prepared.path, path, '..'), { recursive: true }); await writeFile(join(prepared.path, path), body); }
  const info = await lstat(prepared.path), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  let policy = defaultToolPolicy();
  policy.builtins.files = true; policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: ['-e', ''], enabled: true, verification: true }]; policy = validateToolPolicy(policy);
  const scope = freezeDevelopmentScope(prepared.baseCommit, approvedPaths, policy);
  const create = limits => createDevelopmentRuntime({ scope, worktree: prepared.path, worktreeIdentity, repository, currentPolicy: () => policy, checkpoint: async () => {}, verifyWorkspace: async () => {}, ...limits });
  return Object.assign(create, { worktree: prepared.path, tools: development => createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree: prepared.path, worktreeIdentity, development }) });
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

test('a wide approved folder lists changed files and at most 200 others; specific hashes are available by path', async t => {
  const committed = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`gen/file-${String(index).padStart(3, '0')}.ts`, `export const value${index} = ${index};\n`]));
  const create = await fixture(t, { 'gen/new.ts': 'export const created = true;\n' }, ['gen/', 'readme.md'], committed), runtime = create();
  const status = await runtime.capture(signal());
  assert.equal(status.files.length, 202, 'readme.md, the changed gen/new.ts and 200 unchanged folder files');
  assert.equal(status.omittedFiles, 5);
  assert.ok(status.files.some(file => file.path === 'gen/new.ts') && status.files.some(file => file.path === 'readme.md'));
  assert.equal(status.files.some(file => file.path === 'gen/file-204.ts'), false);
  const requested = await runtime.capture(signal(), ['gen/file-204.ts', 'gen/missing.ts']);
  const hash = requested.files.find(file => file.path === 'gen/file-204.ts')?.hash;
  assert.match(hash ?? '', /^[a-f0-9]{64}$/); assert.equal(requested.files.find(file => file.path === 'gen/missing.ts')?.hash, null);
  await assert.rejects(runtime.capture(signal(), ['other.ts']), /at most 32 approved paths/);
  const applied = /** @type {{ files: Array<{ path: string }>; omittedFiles: number }} */ (await runtime.apply({ path: 'gen/file-204.ts', content: 'export const value204 = 0;\n', expectedHash: hash ?? null }, signal()));
  assert.equal(applied.files.length, 203, 'the edited file is now changed and always listed'); assert.equal(applied.omittedFiles, 4);
  const broker = create.tools(runtime); cleanup(t, () => broker.close());
  const result = JSON.parse((await broker.call('werk_candidate_status', { paths: ['gen/file-203.ts'] }, signal())).content[0].text);
  assert.equal(result.omittedFiles, 3); assert.match(result.filesNote, /3 more unchanged files below approved folders are not listed\. Call werk_candidate_status with paths/);
  assert.ok(result.files.some(file => file.path === 'gen/file-203.ts'));
});

test('werk_candidate_apply uses the frozen approved file and total limits and names the setting', async t => {
  const create = await fixture(t, { 'gen/a.ts': lines(200) }, ['gen/']), runtime = create();
  await assert.rejects(runtime.apply({ path: 'gen/new.ts', content: 'x'.repeat(24001), expectedHash: null }, signal()), { message: 'Approved candidate file "gen/new.ts" is 24,001 bytes; the approved file limit is 24,000 bytes (execution.candidateApprovedFileMaxBytes).' });
  await runtime.apply({ path: 'gen/b.ts', content: 'x'.repeat(24000), expectedHash: null }, signal());
  await assert.rejects(runtime.apply({ path: 'gen/c.ts', content: 'x'.repeat(5000), expectedHash: null }, signal()), { message: 'Approved candidate text is 49,000 bytes; the approved content limit is 48,000 bytes (execution.candidateApprovedTotalMaxBytes).' });
  const raised = (await fixture(t, { 'gen/a.ts': lines(200) }, ['gen/']))({ candidateApprovedFileMaxBytes: 30000, candidateApprovedTotalMaxBytes: 50000 });
  await assert.rejects(raised.apply({ path: 'gen/new.ts', content: 'x'.repeat(30001), expectedHash: null }, signal()), /is 30,001 bytes; the approved file limit is 30,000 bytes/);
  const result = await raised.apply({ path: 'gen/new.ts', content: 'x'.repeat(29000), expectedHash: null }, signal());
  const view = /** @type {{ changedFileCount: number; files: Array<{ path: string; changed?: true }> }} */ (result);
  assert.ok(view.files.some(file => file.path === 'gen/new.ts' && file.changed) && view.changedFileCount === 2, 'content above the default per-file bound is accepted under the frozen raised limit');
});

test('implementation dispatches freeze the approved content limits, record them as evidence and size the apply schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-review-dispatch-')); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const info = await lstat(directory), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  const captured = { candidateApprovedFileMaxBytes: 64000, candidateApprovedTotalMaxBytes: 4 * MiB, candidateReviewPatchMaxBytes: 4 * MiB };
  const settings = { value: { execution: { ...validateExecutionPolicy({ maxRuntimeMs: 900000 }), ...captured }, repositories: { pollMs: 30000, items: [] } }, toolPolicy: () => policy };
  const unused = () => { throw Error('Metadata inspection must not inspect the candidate'); };
  const development = { capture: unused, apply: unused, check: unused, evidence: unused };
  const factory = workspaceModelFactory(directory, settings, (saved, path, _transport, options) => modelFor(saved, path, async () => { throw Error('No provider call'); }, options));
  /** @type {import('../../src/worker/application/provider-contract.js').ProviderConnection} */
  const connection = { id: 'openai-api', apiKey: 'fixture-only', executable: '', model: 'fixture' };
  /** @type {import('../../src/worker/application/conversation-contracts.js').ChatMessage[]} */
  const messages = [{ id: 'u', role: 'user', text: 'Implement.', state: 'complete', at: '2026-10-19T00:00:00Z' }];
  /** @param {{ tools: Array<{ name: string; inputSchema: unknown }> }} manifest */
  const contentSchema = manifest => {
    const apply = manifest.tools.find(tool => tool.name === 'werk_candidate_apply'); assert.ok(apply);
    return /** @type {{ properties: { content: { maxLength: number; description: string } } }} */ (apply.inputSchema).properties.content;
  };
  /** @param {{ tools: Array<{ name: string; inputSchema: unknown }> }} manifest */
  const maxLength = manifest => contentSchema(manifest).maxLength;
  const request = prepareModelRequest(factory(connection, { sessionId: 'task', worktree: directory, worktreeIdentity, development }), messages, 'patch', 900000);
  assert.deepEqual(pick(request.policy), captured);
  assert.deepEqual(request.toolManifest.limits.candidateReview, captured);
  assert.equal(maxLength(request.toolManifest), 64000, 'the model learns the frozen approved file bound');
  assert.match(contentSchema(request.toolManifest).description, /at most 64000 bytes; characters outside ASCII use 2–4 bytes each/, 'the schema states bytes, not characters');
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

test('hundreds of changed files below a folder keep status and apply results under the tool result limit', async t => {
  const name = index => `gen/generated/components/feature-module-${String(index).padStart(3, '0')}.generated.ts`;
  const committed = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [name(index), `export const removed${index} = ${index};\n`]));
  const added = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [name(300 + index), `export const added${index} = ${index};\n`]));
  const create = await fixture(t, added, ['gen/', 'readme.md'], committed);
  for (const path of Object.keys(committed)) await rm(join(create.worktree, path));
  const runtime = create({ candidateReviewPatchMaxBytes: 1024 * 1024 }), broker = create.tools(runtime); cleanup(t, () => broker.close());
  /** @param {{ content: Array<{ text: string }>; isError?: boolean }} result */
  const view = result => { assert.equal(result.isError, undefined, result.content[0].text); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100 * 1024); return JSON.parse(result.content[0].text); };
  const status = view(await broker.call('werk_candidate_status', {}, signal()));
  assert.equal(status.changedFileCount, 600); assert.equal(status.evidence.changedPaths, undefined, 'evidence does not repeat the changed paths');
  const hashed = status.files.filter(file => file.changed).map(file => file.path), unhashed = status.changedPathsWithoutHashes ?? [];
  assert.ok(hashed.length > 0 && unhashed.length > 0, 'beyond the budget, changed paths are listed without hashes');
  assert.equal(new Set([...hashed, ...unhashed]).size, hashed.length + unhashed.length, 'each changed path appears once');
  assert.equal(hashed.length + unhashed.length + (status.omittedChangedPaths ?? 0), 600);
  assert.ok(status.files.some(file => file.path === 'readme.md' && /^[a-f0-9]{64}$/.test(file.hash)), 'exact entries keep their hashes');
  assert.match(status.filesNote, /changed paths are listed without hashes.*Call werk_candidate_status with paths/);
  const requested = view(await broker.call('werk_candidate_status', { paths: [unhashed.at(-1)] }, signal()));
  assert.ok(requested.files.some(file => file.path === unhashed.at(-1) && file.changed && 'hash' in file), 'requested paths keep their hashes');
  const applied = view(await broker.call('werk_candidate_apply', { path: 'gen/new-module.ts', content: 'export const created = true;\n', expectedHash: null }, signal()));
  assert.equal(applied.changedFileCount, 601); assert.match(applied.filesNote, /Call werk_candidate_status with paths/);
  assert.equal(await readFile(join(create.worktree, 'gen/new-module.ts'), 'utf8'), 'export const created = true;\n');
  assert.equal((await runtime.capture(signal())).changedPaths.length, 601, 'the internal candidate keeps every changed path');
});

test('a staged move from outside an approved folder into it fails the outside-scope check', async t => {
  const create = await fixture(t, {}, ['gen/'], { 'other.ts': 'export const other = 1;\n' });
  await mkdir(join(create.worktree, 'gen'), { recursive: true }); git(create.worktree, 'mv', 'other.ts', 'gen/moved.ts');
  await assert.rejects(create().capture(signal()), { message: 'The worktree contains changes outside the approved paths, including "other.ts". Inspect them before continuing; they will not be published.' });
});

test('apply refuses ignored paths below a folder but keeps exact entries; non-UTF-8 files are named', async t => {
  const create = await fixture(t, {}, ['gen/', 'build/exact.js'], { '.gitignore': 'dist/\nbuild/\n' }), runtime = create();
  await assert.rejects(runtime.apply({ path: 'gen/dist/bundle.js', content: 'x\n', expectedHash: null }, signal()), { message: '"gen/dist/bundle.js" is ignored by the repository\'s Git ignore rules, so it would not be reviewed or published. Choose a path that is not ignored, approve it as an exact file, or change the ignore rules in the base commit.' });
  await assert.rejects(readFile(join(create.worktree, 'gen/dist/bundle.js')), { code: 'ENOENT' });
  const exact = /** @type {{ changedFileCount: number }} */ (await runtime.apply({ path: 'build/exact.js', content: 'x\n', expectedHash: null }, signal()));
  assert.equal(exact.changedFileCount, 1, 'an ignored exact entry is still fingerprinted and published');
  await mkdir(join(create.worktree, 'gen'), { recursive: true }); await writeFile(join(create.worktree, 'gen/binary.ts'), Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(runtime.capture(signal()), { message: 'Approved candidate file "gen/binary.ts" is not UTF-8 text without NUL characters; approved files are reviewed as text, so replace or delete it.' });
});
