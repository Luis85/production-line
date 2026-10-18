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
import { defaultExecutionPolicy, validateExecutionPolicy } from '../../src/worker/dist/worker/application/execution-policy.js';
import { prepareModelRequest, requireModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { cleanup } from './fixture-cleanup.mjs';

const MiB = 1024 * 1024;
const signal = () => new AbortController().signal;
const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const defaults = { candidateSourceMaxBytes: 67108864, candidateSourceMaxFiles: 20000, candidateFileMaxBytes: 8388608 };

test('candidate inspection settings have explicit defaults, bounds and named errors', () => {
  assert.deepEqual(defaultExecutionPolicy(), { maxRuntimeMs: 21600000, maxToolCalls: 128, commandTimeoutMs: 300000, ...defaults });
  assert.deepEqual(validateExecutionPolicy({ maxRuntimeMs: 1000 }), { maxRuntimeMs: 1000, maxToolCalls: 128, commandTimeoutMs: 300000, ...defaults }, 'saved policies without the settings adopt today\'s bounds');
  const valid = { candidateSourceMaxBytes: [1048576, 67108864, 1073741824], candidateSourceMaxFiles: [1, 20000, 200000], candidateFileMaxBytes: [65536, 8388608] };
  for (const [field, values] of Object.entries(valid)) for (const value of values) assert.equal(validateExecutionPolicy({ maxRuntimeMs: 1000, candidateFileMaxBytes: 65536, [field]: value })[field], value);
  assert.equal(validateExecutionPolicy({ maxRuntimeMs: 1000, candidateSourceMaxBytes: 268435456, candidateFileMaxBytes: 268435456 }).candidateFileMaxBytes, 268435456);
  const invalid = { candidateSourceMaxBytes: [1048575, 1073741825, 1.5, '67108864', null, NaN], candidateSourceMaxFiles: [0, 200001, 1.5, '20000', null], candidateFileMaxBytes: [65535, 268435457, 1.5, '8388608', null] };
  for (const [field, values] of Object.entries(invalid)) for (const value of values)
    assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, candidateSourceMaxBytes: 1073741824, [field]: value }), error => error instanceof Error && error.message.startsWith(`execution.${field} must be an integer from `), `${field}=${String(value)}`);
  assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, candidateSourceMaxBytes: 1048576 }), { message: 'execution.candidateFileMaxBytes (8388608) cannot exceed execution.candidateSourceMaxBytes (1048576).' });
  assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, candidateUnknown: 1 }), /Invalid execution policy/);
});

test('settings get shows effective candidate limits, saves only changed values and refuses a file limit above the total', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-candidate-settings-')); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const settings = new WorkerSettings(directory); await settings.init();
  const effective = view => Object.fromEntries(Object.keys(defaults).map(key => [key, view.execution[key]]));
  assert.deepEqual(effective(settings.publicView()), defaults);
  const saved = async () => JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution;
  const initial = await saved();
  for (const key of Object.keys(defaults)) assert.equal(initial[key], undefined, 'defaults add no saved fields');
  const raised = { candidateSourceMaxBytes: 128 * MiB, candidateSourceMaxFiles: 40000, candidateFileMaxBytes: 32 * MiB };
  assert.deepEqual(effective(await settings.update({ execution: raised })), raised);
  const persisted = await saved();
  assert.deepEqual(Object.fromEntries(Object.keys(defaults).map(key => [key, persisted[key]])), raised);
  await assert.rejects(settings.update({ execution: { candidateSourceMaxBytes: 16 * MiB } }), error => testErrorCode(error) === 'invalid_input' && error instanceof Error && /execution\.candidateFileMaxBytes \(33554432\) cannot exceed execution\.candidateSourceMaxBytes \(16777216\)/.test(error.message));
  await assert.rejects(settings.update({ execution: { candidateSourceMaxFiles: 0 } }), /execution\.candidateSourceMaxFiles must be an integer from 1 to 200000/);
  const restarted = new WorkerSettings(directory); await restarted.init();
  assert.deepEqual(effective(restarted.publicView()), raised, 'a refused change leaves the saved limits intact');
  await restarted.update({ execution: defaults });
  const reset = await saved();
  for (const key of Object.keys(defaults)) assert.equal(reset[key], undefined);
});

async function fixture(t, files) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-candidate-limits-'))), repository = join(directory, 'repo');
  await mkdir(repository); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  for (const [path, body] of Object.entries(files)) await writeFile(join(repository, path), body);
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  const prepared = await createRepositoryWorktree(await repositoryRoot(repository, signal()), 'project', 'limits', signal());
  const info = await lstat(prepared.path), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  let policy = defaultToolPolicy();
  policy.builtins.files = true; policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: ['-e', ''], enabled: true, verification: true }]; policy = validateToolPolicy(policy);
  const scope = freezeDevelopmentScope(prepared.baseCommit, ['notes.txt'], policy);
  return limits => createDevelopmentRuntime({ scope, worktree: prepared.path, worktreeIdentity, repository, currentPolicy: () => policy, checkpoint: async () => {}, verifyWorkspace: async () => {}, ...limits });
}

test('a single source file above the default per-file limit fails with its size and passes when the setting is raised', async t => {
  const create = await fixture(t, { 'vault.pdf': Buffer.alloc(9 * MiB, 0x25), 'readme.md': 'notes\n' });
  await assert.rejects(create().capture(signal()), { message: 'Candidate file "vault.pdf" is 9,437,184 bytes; the per-file inspection limit is 8,388,608 bytes (execution.candidateFileMaxBytes).' });
  const candidate = await create({ candidateFileMaxBytes: 16 * MiB }).capture(signal());
  assert.match(candidate.digest, /^[a-f0-9]{64}$/); assert.equal(candidate.patch, '', 'large unapproved sources are fingerprinted, never published');
});

test('total source and file-count limits use the frozen values and name the measured value and setting', async t => {
  const create = await fixture(t, { 'a.md': 'a'.repeat(100), 'b.md': 'b'.repeat(100), 'c.md': 'c'.repeat(100) });
  await assert.rejects(create({ candidateSourceMaxBytes: 50, candidateFileMaxBytes: 50 }).capture(signal()), /Candidate file "a\.md" is 100 bytes; the per-file inspection limit is 50 bytes \(execution\.candidateFileMaxBytes\)\./);
  await assert.rejects(create({ candidateSourceMaxBytes: 150, candidateFileMaxBytes: 100 }).capture(signal()), { message: 'Candidate source is 300 bytes; the inspection limit is 150 bytes (execution.candidateSourceMaxBytes).' }, 'the whole source size is reported, so one settings change suffices');
  const counted = await create({ candidateSourceMaxBytes: 300, candidateFileMaxBytes: 100 }).capture(signal());
  // Paths include the approved, absent notes.txt: three sources plus one approved path.
  await assert.rejects(create({ candidateSourceMaxFiles: 3 }).capture(signal()), { message: 'Candidate source has 4 files; the inspection limit is 3 files (execution.candidateSourceMaxFiles).' });
  assert.equal((await create({ candidateSourceMaxFiles: 4 }).capture(signal())).digest, counted.digest, 'limits bound inspection; they never change the fingerprint');
  assert.equal((await create().capture(signal())).digest, counted.digest);
  assert.throws(() => create({ candidateSourceMaxBytes: 100, candidateFileMaxBytes: 101 }), /execution\.candidateFileMaxBytes \(101\) cannot exceed execution\.candidateSourceMaxBytes \(100\)/);
});

test('implementation dispatches freeze the captured candidate limits and record them as limit evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-candidate-dispatch-')); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  const info = await lstat(directory), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  const captured = { candidateSourceMaxBytes: 128 * MiB, candidateSourceMaxFiles: 40000, candidateFileMaxBytes: 16 * MiB };
  const settings = { value: { execution: { maxToolCalls: 40, maxRuntimeMs: 900000, commandTimeoutMs: 1500, ...captured }, repositories: { pollMs: 30000, items: [] } }, toolPolicy: () => policy };
  const unused = () => { throw Error('Metadata inspection must not inspect the candidate'); };
  const development = { capture: unused, apply: unused, check: unused, evidence: unused };
  const factory = workspaceModelFactory(directory, settings, (saved, path, _transport, options) => modelFor(saved, path, async () => { throw Error('No provider call'); }, options));
  /** @type {import('../../src/worker/application/provider-contract.js').ProviderConnection} */
  const connection = { id: 'openai-api', apiKey: 'fixture-only', executable: '', model: 'fixture' };
  /** @type {import('../../src/worker/application/conversation-contracts.js').ChatMessage[]} */
  const messages = [{ id: 'u', role: 'user', text: 'Implement.', state: 'complete', at: '2026-10-18T00:00:00Z' }];
  const request = prepareModelRequest(factory(connection, { sessionId: 'task', worktree: directory, worktreeIdentity, development }), messages, 'patch', 900000);
  assert.equal(request.policy.development, true);
  assert.deepEqual(Object.fromEntries(Object.keys(defaults).map(key => [key, request.policy[key]])), captured);
  assert.deepEqual(request.toolManifest.limits.candidateInspection, captured);
  assert.ok(Object.isFrozen(request.policy) && Object.isFrozen(request.toolManifest.limits.candidateInspection), 'accepted dispatch limits are immutable');
  settings.value.execution = { ...settings.value.execution, ...defaults };
  const next = prepareModelRequest(factory(connection, { sessionId: 'task', worktree: directory, worktreeIdentity, development }), messages, 'patch', 900000);
  assert.deepEqual(next.toolManifest.limits.candidateInspection, defaults, 'new attempts capture current settings');
  const legacy = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree: directory, worktreeIdentity, development });
  assert.ok(legacy.manifest.tools.some(tool => tool.name === 'werk_candidate_status'));
  assert.equal(legacy.manifest.limits?.candidateInspection, undefined, 'a dispatch prepared without captured candidate limits keeps its exact manifest and default bounds');
  await legacy.close();
  const chat = prepareModelRequest(factory(connection, { sessionId: 'chat' }), messages, 'chat', 900000);
  for (const key of Object.keys(defaults)) assert.equal(chat.policy[key], undefined, 'only implementation dispatches carry candidate limits');
  const changed = change => { const copy = structuredClone(request); change(copy); return copy; };
  for (const change of [
    value => { value.policy.candidateSourceMaxFiles = 0; },
    value => { value.policy.candidateFileMaxBytes = value.policy.candidateSourceMaxBytes + 1; },
    value => { value.toolManifest.limits.candidateInspection.candidateSourceMaxBytes = 1073741825; },
    value => { delete value.toolManifest.limits.candidateInspection.candidateFileMaxBytes; },
  ]) assert.throws(() => requireModelRequest(changed(change), connection.id), { code: 'protocol' });
  assert.throws(() => requireModelRequest({ ...structuredClone(chat), policy: { ...chat.policy, ...captured } }, connection.id), { code: 'protocol' });
});
