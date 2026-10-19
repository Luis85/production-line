import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateApprovedPaths, approvedPathMatch } from '../../src/worker/dist/worker/application/approved-paths.js';
import { createDevelopmentRuntime } from '../../src/worker/dist/worker/infrastructure/candidate-tools.js';
import { createRepositoryWorktree, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { approvedTaskFiles } from '../../src/worker/dist/worker/infrastructure/journal/workspace-files.js';
import { defaultToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { assertFolderApprovals, developmentVerified, freezeDevelopmentScope, validateDevelopmentState } from '../../src/worker/dist/worker/application/development.js';
import { validateFeatureWorkflowApprovedPaths } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
import { defaultFeatureWorkflow } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { cleanup } from './fixture-cleanup.mjs';

const signal = () => new AbortController().signal;
const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const folders = { folders: true };

test('implementation approvals accept folder prefixes through the shared validator; proposals keep exact files', () => {
  const paths = ['src/frontend/src/app/features/auftrag/', 'src/app.ts', 'docs/Übersicht (Stand Q3)/'];
  assert.deepEqual(validateApprovedPaths(paths, 'Approved paths', folders), paths);
  assert.deepEqual(validateApprovedPaths(['src/Ä/'.normalize('NFD')], 'Approved paths', folders), ['src/Ä/']);
  assert.throws(() => validateApprovedPaths(['src/app/']), /1–32 safe relative non-secret file paths$/, 'exact-file consumers refuse folder entries');
  assert.throws(() => validateApprovedPaths(Array.from({ length: 33 }, (_, index) => `src/f${index}/`), 'Approved paths', folders), /folder paths ending in \//);
});

test('folder approvals obey the path safety rules and never name the repository root', () => {
  for (const path of ['/', '//', './', '../', 'docs/./', 'docs/../', 'a//b/', '.git/', 'src/.git/', 'src/.cache/', '.github/', 'config/secrets/', 'credentials/', 'keys/id_rsa/', 'certs/client.pem/', 'docs/con/', 'docs/trailing./', '-option/', 'docs/a:b/', 'x'.repeat(240) + '/'])
    assert.throws(() => validateApprovedPaths([path], 'Approved paths', folders), /safe relative non-secret file paths or folder paths ending in \//, JSON.stringify(path));
  for (const paths of [
    ['src/app', 'src/app/'],
    ['src/App/', 'src/app/x.ts'],
    ['src/app/', 'src/App/'],
    ['src/ä/', 'src/ä/'.normalize('NFD')],
    ['src/file.ts', 'src/file.ts/child/'],
  ]) assert.throws(() => validateApprovedPaths(paths, 'Approved paths', folders), /unique/, JSON.stringify(paths));
  assert.deepEqual(validateApprovedPaths(['src/app/', 'src/app/index.ts'], 'Approved paths', folders), ['src/app/', 'src/app/index.ts'], 'an exact entry may keep its snapshot inside an approved folder');
});

test('paths below an approved folder are approved only when they are safe', () => {
  const approved = ['src/app/', 'README.md'];
  for (const path of ['src/app/a.ts', 'src/app/deep/b.ts', 'README.md']) assert.equal(approvedPathMatch(approved, path), true, path);
  for (const path of ['src/app', 'src/apple.ts', 'src/App/a.ts', 'src/app/.env', 'src/app/secrets.json', 'src/app/deep/.cache/x', 'src/app/../x.ts', 'other/a.ts', 'readme.md'])
    assert.equal(approvedPathMatch(approved, path), false, path);
});

test('folder approvals require an implementation request', () => {
  const policy = defaultToolPolicy();
  assert.throws(() => assertFolderApprovals(['src/app/'], policy), /Folder approvals \(paths ending in \/\) require an implementation request/);
  assertFolderApprovals(['src/app.ts'], policy);
  policy.builtins.files = true; policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: ['-e', ''], enabled: true, verification: true }];
  assertFolderApprovals(['src/app/'], validateToolPolicy(policy));
  assert.throws(() => assertFolderApprovals(['src/app/'], validateToolPolicy(policy), false), /implementation request/, 'a missing Git worktree still refuses folders');
});

test('feature workflow storage cannot be approved through a folder', () => {
  const workflow = defaultFeatureWorkflow();
  validateFeatureWorkflowApprovedPaths(['src/app/', 'docs/'], workflow);
  for (const path of ['features/', 'feature-reviews/drafts/', 'feature-tasks/', 'features/_templates/', 'Feature Requests.base'])
    assert.throws(() => validateFeatureWorkflowApprovedPaths([path], workflow), /workflow configuration/, path);
  const nested = defaultFeatureWorkflow('workflow');
  assert.throws(() => validateFeatureWorkflowApprovedPaths(['workflow/'], nested), /workflow configuration/, 'a folder containing workflow storage is refused');
});

async function fixture(t, approvedPaths) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-approved-folder-'))), repository = join(directory, 'repo');
  await mkdir(repository); cleanup(t, () => rm(directory, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(repository, 'src', 'app'), { recursive: true });
  await writeFile(join(repository, 'src', 'app', 'existing.ts'), 'export const value = 1;\n');
  await writeFile(join(repository, 'src', 'app', 'remove.ts'), 'export const stale = true;\n');
  await writeFile(join(repository, 'src', 'other.ts'), 'export const other = 1;\n');
  await writeFile(join(repository, 'check.mjs'), "import { readFileSync } from 'node:fs'; if (!readFileSync('src/app/nested/component.ts', 'utf8').includes('component')) process.exit(1);\n");
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  const base = await repositoryRoot(repository, signal());
  const prepared = await createRepositoryWorktree(base, 'project', 'folder', signal());
  const info = await lstat(prepared.path), worktreeIdentity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  let policy = defaultToolPolicy();
  policy.builtins.files = true; policy.builtins.commands = [{ id: 'check', name: 'Check', executable: process.execPath, args: ['check.mjs'], enabled: true, verification: true }]; policy = validateToolPolicy(policy);
  const scope = freezeDevelopmentScope(prepared.baseCommit, approvedPaths, policy);
  let saved;
  const runtime = createDevelopmentRuntime({ scope, worktree: prepared.path, worktreeIdentity, repository, commandTimeoutMs: 30000, currentPolicy: () => policy, checkpoint: async value => { saved = structuredClone(value); },
    verifyWorkspace: abort => createRepositoryWorktree(base, 'project', 'folder', abort, prepared.baseCommit).then(() => {}) });
  return { directory, repository, worktree: prepared.path, scope, runtime, get saved() { return saved; } };
}

test('a candidate that adds and changes files below an approved folder verifies and appears in the review patch', async t => {
  const f = await fixture(t, ['src/app/']);
  validateDevelopmentState(f.scope);
  const status = await f.runtime.capture(signal());
  assert.deepEqual(status.files.map(file => file.path), ['src/app/existing.ts', 'src/app/remove.ts'], 'status lists every safe file below the folder with its hash');
  await f.runtime.apply({ path: 'src/app/nested/component.ts', content: 'export const component = true;\n', expectedHash: null }, signal());
  await f.runtime.apply({ path: 'src/app/existing.ts', content: null, expectedHash: status.files.find(file => file.path === 'src/app/existing.ts').hash }, signal());
  // A generator writing directly to disk is inspected the same way as tool edits.
  await writeFile(join(f.worktree, 'src', 'app', 'remove.ts'), 'export const stale = false;\n');
  await writeFile(join(f.worktree, 'src', 'app', 'generated.ts'), 'export const generated = true;\n');
  const receipt = await f.runtime.check('check', signal());
  assert.equal(receipt.status, 'passed', receipt.stderr);
  const candidate = await f.runtime.capture(signal());
  assert.deepEqual(candidate.changedPaths, ['src/app/existing.ts', 'src/app/generated.ts', 'src/app/nested/component.ts', 'src/app/remove.ts']);
  assert.equal(developmentVerified(f.scope, candidate, f.saved), true);
  for (const path of candidate.changedPaths) assert.ok(candidate.patch.includes(path), path);
  assert.doesNotMatch(candidate.patch, /src\/other\.ts|check\.mjs/, 'the patch holds only approved paths');
  const patch = join(f.directory, 'candidate.patch'); await writeFile(patch, candidate.patch);
  git(f.repository, 'apply', '--check', patch);
  assert.equal(await readFile(join(f.repository, 'src', 'app', 'existing.ts'), 'utf8'), 'export const value = 1;\n', 'the checkout is untouched');
});

test('changes outside an approved folder, and unsafe names below it, still fail the candidate', async t => {
  const f = await fixture(t, ['src/app/']);
  for (const path of ['src/other.ts', 'src/apple.ts', 'src/app/.env', 'src/app/secrets.json', 'check.mjs'])
    await assert.rejects(f.runtime.apply({ path, content: 'x', expectedHash: null }, signal()), /explicitly approved path/, path);
  await writeFile(join(f.worktree, 'src', 'other.ts'), 'export const other = 2;\n');
  await assert.rejects(f.runtime.capture(signal()), { message: 'The worktree contains changes outside the approved paths, including "src/other.ts". Inspect them before continuing; they will not be published.' });
  git(f.worktree, 'checkout', '--', 'src/other.ts');
  await writeFile(join(f.worktree, 'src', 'app', 'secrets.json'), '{}\n');
  await assert.rejects(f.runtime.capture(signal()), /outside the approved paths, including "src\/app\/secrets\.json"/);
});

test('the initial snapshot keeps exact file contents and records folder entries without contents', async t => {
  const f = await fixture(t, ['src/app/']);
  const prepared = { repository: f.repository, path: f.worktree, baseCommit: git(f.repository, 'rev-parse', 'HEAD') };
  const { files } = await approvedTaskFiles.snapshot(prepared, ['src/app/', 'src/other.ts', 'src/new/']);
  assert.deepEqual(files, [
    { path: 'src/app/', content: '', existed: true },
    { path: 'src/other.ts', content: 'export const other = 1;\n', existed: true },
    { path: 'src/new/', content: '', existed: false },
  ]);
  await assert.rejects(approvedTaskFiles.snapshot(prepared, ['src/other.ts/']), /Approved folders must be folders/);
  await assert.rejects(approvedTaskFiles.snapshot(prepared, ['src/App/']), /differs from an existing file or folder only by case/);
});
