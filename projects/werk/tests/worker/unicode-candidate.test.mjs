import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { requiredValue } from '../ui/helpers/required-value.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDevelopmentRuntime } from '../../src/worker/dist/worker/infrastructure/candidate-tools.js';
import { createRepositoryWorktree, repositoryRoot } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { defaultToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { freezeDevelopmentScope, developmentVerified } from '../../src/worker/dist/worker/application/development.js';
import { validateApprovedPaths } from '../../src/worker/dist/worker/application/approved-paths.js';
import { approvedTaskFiles } from '../../src/worker/dist/worker/infrastructure/journal/workspace-files.js';
import { cleanup } from './fixture-cleanup.mjs';

prepareNativeProcessFixture();

const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

test('Unicode candidate edits, additions and deletions retain verified evidence and produce an applicable patch', { timeout: process.platform === 'win32' ? 240000 : 120000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-unicode-candidate-'))), repository = join(directory, 'repo');
  cleanup(t, () => rm(directory, { recursive: true, force: true }));
  await mkdir(repository);
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false'); git(repository, 'config', 'core.eol', 'lf');
  git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  const existing = 'Überprüfung.md', added = "Größe/Kunden's Änderungen (Größe) & Fristen – Prüfung → Freigabe.md", removed = '取り消し.md';
  await writeFile(join(repository, existing), 'before\n'); await writeFile(join(repository, removed), 'delete me\n');
  await writeFile(join(repository, 'check.mjs'), [
    "import assert from 'node:assert/strict'; import { readFileSync, existsSync } from 'node:fs';",
    'assert.equal(readFileSync(' + JSON.stringify(existing) + ', "utf8"), "after\\n");',
    'assert.equal(readFileSync(' + JSON.stringify(added) + ', "utf8"), "created\\n");',
    'assert.equal(existsSync(' + JSON.stringify(removed) + '), false);',
    'console.log("Unicode candidate verified");',
  ].join('\n') + '\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Unicode baseline');
  const signal = new AbortController().signal, base = await repositoryRoot(repository, signal);
  const prepared = await createRepositoryWorktree(base, 'project', 'unicode-candidate', signal);
  const requested = [existing.normalize('NFD'), added.normalize('NFD'), removed], approved = validateApprovedPaths(requested);
  assert.notEqual(requested[0], existing, 'the request exercises decomposed Unicode input');
  assert.deepEqual(approved, [existing, added, removed]);
  const snapshot = await approvedTaskFiles.snapshot({ repository, path: prepared.path, baseCommit: prepared.baseCommit }, approved);
  assert.deepEqual(snapshot.files.map(file => ({ path: file.path, existed: file.existed })), [{ path: existing, existed: true }, { path: added, existed: false }, { path: removed, existed: true }]);
  const info = await lstat(prepared.path), identity = { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
  const configured = defaultToolPolicy(); configured.builtins.files = true;
  configured.builtins.commands = [{ id: 'check', name: 'Verify Unicode files', executable: process.execPath, args: ['check.mjs'], enabled: true, verification: true }];
  const policy = validateToolPolicy(configured), scope = freezeDevelopmentScope(prepared.baseCommit, snapshot.files.map(file => file.path), policy);
  const evidenceFile = join(directory, 'candidate-evidence.json');
  const retained = /** @type {{ value?: import('../../src/worker/application/development.js').DevelopmentEvidence }} */ ({});
  const runtime = () => createDevelopmentRuntime({ scope, worktree: prepared.path, worktreeIdentity: identity, repository, initialEvidence: retained.value, commandTimeoutMs: 30000, currentPolicy: () => policy,
    checkpoint: async value => { await writeFile(evidenceFile, JSON.stringify(value)); retained.value = structuredClone(value); },
    verifyWorkspace: async abort => {
      const retained = await createRepositoryWorktree(base, 'project', 'unicode-candidate', abort, prepared.baseCommit);
      assert.equal(retained.path, prepared.path); assert.equal(retained.reused, true);
    },
  });
  const candidate = runtime(), failed = await candidate.check('check', signal);
  assert.equal(failed.status, 'failed'); assert.notEqual(failed.exitCode, 0, 'the actual required check fails before the file changes');
  for (const [path, content] of [[existing, 'after\n'], [added, 'created\n'], [removed, null]]) {
    const current = await candidate.capture(signal);
    await candidate.apply({ path, content, expectedHash: current.files.find(file => file.path === path).hash }, signal);
    assert.deepEqual(requiredValue(retained.value).checks, [], 'each edit invalidates previous verification receipts');
  }
  const passed = await candidate.check('check', signal);
  assert.equal(passed.status, 'passed'); assert.equal(passed.exitCode, 0); assert.match(passed.stdout, /Unicode candidate verified/);
  const final = await candidate.capture(signal);
  assert.deepEqual(final.changedPaths, [existing, added, removed].sort()); assert.equal(developmentVerified(scope, final, requiredValue(retained.value)), true);
  retained.value = JSON.parse(await readFile(evidenceFile, 'utf8'));
  const restarted = runtime(), recovered = await restarted.capture(signal);
  assert.equal(recovered.digest, final.digest); assert.equal(recovered.patch, final.patch);
  assert.equal(developmentVerified(scope, recovered, restarted.evidence()), true, 'the exact Unicode paths and receipts survive recovery');
  assert.equal(await readFile(join(repository, existing), 'utf8'), 'before\n'); assert.equal(await readFile(join(repository, removed), 'utf8'), 'delete me\n');
  assert.equal(git(repository, 'status', '--porcelain'), '', 'candidate execution leaves the developer checkout untouched');
  const patch = join(directory, 'candidate.patch'); await writeFile(patch, final.patch);
  git(repository, 'apply', '--check', patch); git(repository, 'apply', '--index', patch);
  assert.equal(await readFile(join(repository, existing), 'utf8'), 'after\n'); assert.equal(await readFile(join(repository, added), 'utf8'), 'created\n');
  await assert.rejects(readFile(join(repository, removed)), { code: 'ENOENT' });
  assert.deepEqual(git(repository, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort(), [existing, added, removed].sort());
});
