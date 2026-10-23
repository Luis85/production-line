import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { compareBaselineChecks } from '../../src/worker/dist/worker/application/development-baseline-comparison.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observeTaskBaseline } from '../../src/worker/dist/worker/application/local-task-baseline.js';
import { validateDevelopmentBaseline } from '../../src/worker/dist/worker/application/development-baseline.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { freezeDevelopmentScope, developmentVerified } from '../../src/worker/dist/worker/application/development.js';
import { createDevelopmentRuntime } from '../../src/worker/dist/worker/infrastructure/candidate-tools.js';
import { approvedTaskFiles } from '../../src/worker/dist/worker/infrastructure/journal/workspace-files.js';
import { prepareRepositoryWorktree, removeRepositoryWorktree, repositoryRoot, worktreeName } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';

prepareNativeProcessFixture();
const run = promisify(execFile);
const git = async (repo, ...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { windowsHide: true })).stdout.trim();
const budget = process.platform === 'win32' ? 180000 : 30000;

async function fixture(t, script) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-baseline-'))), repository = join(root, 'repo');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(repository);
  await git(repository, 'init', '--initial-branch=main'); await git(repository, 'config', 'user.name', 'Fixture'); await git(repository, 'config', 'user.email', 'fixture@example.invalid'); await git(repository, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repository, 'source.txt'), 'baseline\n'); await git(repository, 'add', '.'); await git(repository, 'commit', '-m', 'Baseline');
  const baseline = await git(repository, 'rev-parse', 'HEAD'), signal = new AbortController().signal;
  const candidate = await prepareRepositoryWorktree(repository, 'candidate', signal, baseline);
  await writeFile(join(candidate.path, 'source.txt'), 'candidate\n'); await writeFile(join(repository, 'source.txt'), 'developer work\n');
  const policy = defaultToolPolicy(); policy.builtins.files = true;
  policy.builtins.commands = [{ id: 'verify', name: 'Required check', executable: process.execPath, args: ['--input-type=module', '-e', script], enabled: true, verification: true }];
  const scope = freezeDevelopmentScope(baseline, ['source.txt'], policy); assert.ok(scope);
  /** @type {import('../../src/worker/application/local-task-contracts.ts').LocalTask} */
  const task = { id: 'fixture', title: 'Fixture', instruction: 'Implement source', sessionId: 'fixture', provider: 'codex-cli', model: '', repository, worktree: candidate.path, files: [], status: 'running', priority: 1, createdAt: new Date().toISOString(), finishedAt: null, error: null, summary: null, patch: null, archived: false };
  const preparations = [], removals = [];
  /** @type {import('../../src/worker/application/local-task-contracts.ts').LocalTaskWorkspaces} */
  const workspaces = {
    async prepareWorktree(selector, key, bounded, commit, limits) { const prepared = await prepareRepositoryWorktree(selector, key, bounded, commit, limits); preparations.push(prepared.path); return prepared; },
    verifyWorktree: (selector, key, bounded, commit, limits) => prepareRepositoryWorktree(selector, key, bounded, commit, { ...limits, reuseOnly: true }),
    async removeWorktree(selector, key, bounded, expected) { removals.push(expected); return removeRepositoryWorktree(await repositoryRoot(selector, bounded), worktreeName('local', key), bounded, 30000, { expect: { taskKey: key, path: expected.path, baseCommit: expected.baseCommit }, discardChanges: expected.discardChanges }); },
  };
  const host = { workspaces, files: approvedTaskFiles, development: createDevelopmentRuntime };
  const options = { scope, repository, worktree: candidate.path, worktreeIdentity: await approvedTaskFiles.identity(candidate.path), currentPolicy: () => policy, verifyWorkspace: async () => {}, checkpoint: async () => {}, commandTimeoutMs: 10000 };
  return { root, repository, candidate, baseline, task, host, options, preparations, removals, signal };
}

test('baseline failures are separately observed on unchanged committed input and do not exempt candidate gates', { timeout: budget }, async t => {
  const f = await fixture(t, "import { readFileSync } from 'node:fs'; console.log(readFileSync('source.txt','utf8')); process.exit(1);");
  const result = await observeTaskBaseline(f.host, f.task, f.options, f.signal);
  assert.equal(result.status, 'observed', result.reason); assert.equal(result.checks[0].status, 'failed'); assert.match(result.checks[0].stdout, /baseline/); assert.doesNotMatch(result.checks[0].stdout, /candidate|developer/);
  assert.equal(result.baseline, f.baseline); validateDevelopmentBaseline(f.options.scope, result);
  assert.equal(await readFile(join(f.repository, 'source.txt'), 'utf8'), 'developer work\n'); assert.equal(await readFile(join(f.candidate.path, 'source.txt'), 'utf8'), 'candidate\n');
  assert.equal(result.retainedWorktree, undefined); assert.equal(f.removals.length, 1); assert.equal(f.removals[0].discardChanges, false); await assert.rejects(access(f.preparations[0]));
  const digest = 'c'.repeat(64), evidence = { schemaVersion: /** @type {const} */ (1), candidateDigest: digest, changedPaths: ['source.txt'], checks: [{ ...result.checks[0], candidateDigest: digest }], updatedAt: new Date().toISOString(), baseline: result };
  assert.equal(compareBaselineChecks(f.options.scope, evidence)[0].classification, 'pre_existing');
  assert.equal(developmentVerified(f.options.scope, { patch: 'fixture', digest, changedPaths: ['source.txt'] }, evidence), false);
  assert.throws(() => validateDevelopmentBaseline({ ...f.options.scope, baseCommit: 'd'.repeat(40) }, result), /verification plan/);
});

test('a baseline check that edits source stays unavailable and its owned dirty checkout is retained', { timeout: budget }, async t => {
  const f = await fixture(t, "import { writeFileSync } from 'node:fs'; writeFileSync('source.txt','changed by verification\\n');");
  const result = await observeTaskBaseline(f.host, f.task, f.options, f.signal);
  assert.equal(result.status, 'unavailable'); assert.match(result.reason, /changed committed source/); assert.ok(result.retainedWorktree);
  assert.equal(await readFile(join(result.retainedWorktree, 'source.txt'), 'utf8'), 'changed by verification\n');
  assert.equal(f.removals[0].discardChanges, false);
  assert.equal(await readFile(join(f.repository, 'source.txt'), 'utf8'), 'developer work\n'); assert.equal(await readFile(join(f.candidate.path, 'source.txt'), 'utf8'), 'candidate\n');
});

test('baseline authority revocation prevents preparation and missing observations cannot classify a regression', { timeout: budget }, async t => {
  const f = await fixture(t, "throw Error('must not execute');");
  const result = await observeTaskBaseline({ ...f.host, authorizeDelivery: () => { throw Error('Project policy approval was revoked.'); } }, f.task, f.options, f.signal);
  assert.equal(result.status, 'unavailable'); assert.match(result.reason, /revoked/); assert.equal(f.preparations.length, 0); assert.equal(result.checks.length, 0);
  assert.equal(compareBaselineChecks(f.options.scope)[0].classification, 'unknown');
});
