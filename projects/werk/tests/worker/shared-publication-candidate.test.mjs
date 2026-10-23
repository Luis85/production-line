import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDevelopmentRuntime } from '../../src/worker/dist/worker/infrastructure/candidate-tools.js';
import { createRepositoryWorktree, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { GitFeatureRepository } from '../../src/worker/dist/worker/infrastructure/features/git-repository.js';
import { defaultToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { developmentScopeView, developmentVerified, freezeDevelopmentScope, validateDevelopmentState } from '../../src/worker/dist/worker/application/development.js';
import { sharedFeaturePublicationIssue, sharedFeaturePublicationLimits } from '../../src/worker/dist/worker/application/shared-feature-publication-limits.js';
import { cleanup } from './fixture-cleanup.mjs';

prepareNativeProcessFixture();

const signal = () => new AbortController().signal;
const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
// The in-run refusal wraps the exact message that blocks publication after verification.
const inRun = issue => `Shared publication limit: ${issue} Reduce the change before verification; required checks fail while it exceeds the limit.`;
const patchError = size => inRun(`The retained candidate patch is ${size} bytes; shared feature publication allows at most 131,072 bytes (128 KiB).`);
const filesError = count => inRun(`The retained candidate changes ${count} files; shared feature publication allows at most 32 changed files.`);
// Raised approved-content limits let a candidate reach the publication bound before the review bounds.
const raised = { candidateApprovedFileMaxBytes: 200000, candidateApprovedTotalMaxBytes: 400000, candidateReviewPatchMaxBytes: 400000 };

function policyFixture(marker = '') {
  const policy = defaultToolPolicy();
  policy.builtins.files = true; policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: marker ? ['-e', 'require("node:fs").appendFileSync(process.argv[1], "checked\\n")', marker] : ['-e', ''], enabled: true, verification: true }];
  return validateToolPolicy(policy);
}

async function fixture(t, files, { shared, publication = undefined } = { shared: false }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-publication-'))), repository = join(directory, 'repo');
  await mkdir(repository, { recursive: true }); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'readme.md'), 'notes\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  const prepared = await createRepositoryWorktree(await repositoryRoot(repository, signal()), 'project', 'publication', signal());
  for (const [path, body] of Object.entries(files)) { await mkdir(join(prepared.path, path, '..'), { recursive: true }); await writeFile(join(prepared.path, path), body); }
  const info = await lstat(prepared.path), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  const marker = join(directory, 'check-runs.txt');
  const policy = policyFixture(marker), scope = freezeDevelopmentScope(prepared.baseCommit, ['gen/'], policy, { sharedPublication: shared });
  if (publication) scope.sharedPublication = publication;
  const development = createDevelopmentRuntime({ scope, worktree: prepared.path, worktreeIdentity, repository, currentPolicy: () => policy, checkpoint: async () => {}, verifyWorkspace: async () => {}, ...raised });
  const tools = createToolRuntime({ policy, currentRevision: () => policy.revision, directory, worktree: prepared.path, worktreeIdentity, development, ...raised });
  cleanup(t, () => tools.close());
  const call = async (name, args) => { const result = await tools.call(name, args, signal()); return { isError: result.isError === true, value: JSON.parse(result.content.map(item => item.text).join('\n')) }; };
  return { scope, development, call, marker };
}
const manyFiles = count => Object.fromEntries(Array.from({ length: count }, (_, index) => [`gen/file-${String(index).padStart(2, '0')}.ts`, `export const value = ${index};\n`]));
const largeFile = { 'gen/large.ts': Array.from({ length: 1400 }, (_, index) => String(index).padStart(99, 'x')).join('\n') + '\n' };

test('shared implementation scopes freeze the publisher limits; local scopes and saved scopes without them stay unbounded', () => {
  assert.deepEqual(sharedFeaturePublicationLimits, { patchMaxBytes: 131072, changedFilesMax: 32 });
  assert.ok(Object.isFrozen(sharedFeaturePublicationLimits));
  const policy = policyFixture(), base = 'a'.repeat(40);
  const shared = freezeDevelopmentScope(base, ['gen/'], policy, { sharedPublication: true });
  assert.deepEqual(shared.sharedPublication, { patchMaxBytes: 131072, changedFilesMax: 32 });
  assert.deepEqual(developmentScopeView(shared).sharedPublication, shared.sharedPublication, 'the model context names the bounds with the frozen scope');
  for (const local of [freezeDevelopmentScope(base, ['gen/'], policy), freezeDevelopmentScope(base, ['gen/'], policy, { sharedPublication: false })]) {
    assert.equal(Object.hasOwn(local, 'sharedPublication'), false);
    assert.equal(Object.hasOwn(developmentScopeView(local), 'sharedPublication'), false);
  }
  for (const sharedPublication of [null, 'shared', {}, { patchMaxBytes: 131072 }, { patchMaxBytes: 0, changedFilesMax: 32 }, { patchMaxBytes: 131072, changedFilesMax: 1.5 }, { patchMaxBytes: 131072, changedFilesMax: 32, extra: 1 }])
    assert.throws(() => validateDevelopmentState({ ...shared, sharedPublication }), /Saved implementation authority/, JSON.stringify(sharedPublication));
});

test('the shared publisher refuses a candidate patch with the same measurement the in-run check reports', () => {
  const directory = tmpdir();
  const adapter = new GitFeatureRepository({ repository: directory, stateDirectory: directory, remote: 'origin', branch: 'main', requestsDirectory: 'features', reviewDirectory: 'reviews', workerId: 'worker-1' });
  const patch = Object.keys(manyFiles(33)).map(path => `diff --git a/${path} b/${path}
new file mode 100644
`).join('');
  const input = { operationId: 'publish-1', featureId: 'feature-1', sourceCommit: 'a'.repeat(40), approvedPaths: ['gen/'], patch };
  assert.throws(() => adapter.publishPatch(input), { message: sharedFeaturePublicationIssue(patch) });
  assert.equal(inRun(sharedFeaturePublicationIssue(patch)), filesError(33));
});

test('a shared candidate above the changed-file bound fails verification with the named limit; status reports the bounds', async t => {
  const f = await fixture(t, manyFiles(33), { shared: true });
  const status = await f.call('werk_candidate_status', {});
  assert.equal(status.isError, false);
  assert.equal(status.value.changedFileCount, 33);
  const candidate = await f.development.capture(signal());
  assert.deepEqual(status.value.sharedPublication, { patchMaxBytes: 131072, changedFilesMax: 32, patchBytes: Buffer.byteLength(candidate.patch), changedFileCount: 33, error: inRun(sharedFeaturePublicationIssue(candidate.patch)) });
  assert.equal(status.value.sharedPublication.error, filesError(33));
  const check = await f.call('werk_candidate_check', { preset: 'check' });
  assert.equal(check.isError, true); assert.equal(check.value.status, 'failed'); assert.equal(check.value.exitCode, null);
  assert.equal(check.value.stderr, filesError(33));
  assert.equal(f.development.evidence().checks[0].status, 'failed', 'the durable receipt records the failed publication bound');
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' }, 'an unpublishable candidate never launches the required command');
  const extra = status.value.files.find(file => file.path === 'gen/file-32.ts');
  const edited = await f.call('werk_candidate_apply', { path: extra.path, content: null, expectedHash: extra.hash });
  assert.equal(edited.isError, false); assert.equal(edited.value.sharedPublication.changedFileCount, 32);
  assert.equal(edited.value.sharedPublication.error, undefined, 'the model can reduce the candidate within the same run');
  assert.deepEqual(f.development.evidence().checks, [], 'the edit clears the failed verification receipt');
  assert.equal((await f.call('werk_candidate_check', { preset: 'check' })).value.status, 'passed');
  assert.equal(await readFile(f.marker, 'utf8'), 'checked\n');
  assert.equal(developmentVerified(f.scope, await f.development.capture(signal()), f.development.evidence()), true);
});

test('a shared candidate above the patch byte bound fails verification; within both bounds it passes and status shows its measurements', async t => {
  const f = await fixture(t, largeFile, { shared: true });
  const candidate = await f.development.capture(signal()), size = Buffer.byteLength(candidate.patch);
  assert.ok(size > 131072 && size < 200000);
  const check = await f.development.check('check', signal());
  assert.equal(check.status, 'failed'); assert.equal(check.stderr, patchError(size.toLocaleString('en-US')));
  const within = await fixture(t, manyFiles(32), { shared: true });
  const status = await within.call('werk_candidate_status', {});
  assert.deepEqual(Object.keys(status.value.sharedPublication).sort(), ['changedFileCount', 'changedFilesMax', 'patchBytes', 'patchMaxBytes']);
  assert.equal(status.value.sharedPublication.changedFileCount, 32);
  assert.equal((await within.development.check('check', signal())).status, 'passed');
});

test('the same candidates as local requests pass and status shows no publication bounds', async t => {
  for (const files of [manyFiles(33), largeFile]) {
    const f = await fixture(t, files, { shared: false });
    const status = await f.call('werk_candidate_status', {});
    assert.equal(status.isError, false); assert.equal(Object.hasOwn(status.value, 'sharedPublication'), false);
    const check = await f.call('werk_candidate_check', { preset: 'check' });
    assert.equal(check.isError, false); assert.equal(check.value.status, 'passed');
  }
});

test('developmentVerified refuses a shared-scope candidate above the publication bounds even with passing receipts', async t => {
  const f = await fixture(t, manyFiles(33), { shared: false });
  assert.equal((await f.development.check('check', signal())).status, 'passed');
  const candidate = await f.development.capture(signal()), evidence = f.development.evidence();
  assert.equal(developmentVerified(f.scope, candidate, evidence), true, 'A local request has no publication bound.');
  const shared = { ...f.scope, sharedPublication: { ...sharedFeaturePublicationLimits } };
  assert.equal(developmentVerified(shared, candidate, evidence), false, 'Defense in depth: the receipts alone never verify an unpublishable shared candidate.');
});

test('retained publication bounds govern checks, feedback and completion without weakening current publisher bounds', async t => {
  const f = await fixture(t, manyFiles(2), { shared: false });
  assert.equal((await f.development.check('check', signal())).status, 'passed');
  const candidate = await f.development.capture(signal()), evidence = f.development.evidence();
  for (const publication of [{ patchMaxBytes: 100, changedFilesMax: 32 }, { patchMaxBytes: 131072, changedFilesMax: 1 }]) {
    const bounded = await fixture(t, manyFiles(2), { shared: true, publication });
    const status = (await bounded.call('werk_candidate_status', {})).value.sharedPublication;
    assert.equal(status.error, inRun(sharedFeaturePublicationIssue(candidate.patch, publication)));
    assert.equal((await bounded.development.check('check', signal())).stderr, status.error);
    await assert.rejects(readFile(bounded.marker), { code: 'ENOENT' });
    assert.equal(developmentVerified({ ...f.scope, sharedPublication: publication }, candidate, evidence), false);
  }
  const wider = await fixture(t, manyFiles(33), { shared: true, publication: { patchMaxBytes: 999999, changedFilesMax: 100 } });
  const status = (await wider.call('werk_candidate_status', {})).value.sharedPublication;
  assert.equal(status.patchMaxBytes, 131072); assert.equal(status.changedFilesMax, 32);
  assert.equal((await wider.development.check('check', signal())).stderr, filesError(33));
  await assert.rejects(readFile(wider.marker), { code: 'ENOENT' });
});
