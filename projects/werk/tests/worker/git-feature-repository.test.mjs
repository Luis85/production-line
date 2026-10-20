import { featureGitIo } from './runtime-fixtures.mjs';
import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { GitFeatureRepository } from '../../src/worker/dist/worker/infrastructure/features/git-repository.js';
import { prepareRepositoryWorktree } from '../../src/worker/dist/worker/infrastructure/repositories.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'user.name=Werk Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = text => createHash('sha256').update(text).digest('hex');
const request = '---\nschemaVersion: 1\ntitle: Shared feature\nstatus: ready\nmode: patch\npaths: [file.txt]\n---\n# Goal\n\nImprove the file.\n';
const claimed = (worker = 'one') => request.replace('status: ready', `id: shared-one\nstatus: claimed\nwerk:\n  owner: ${worker}`);
const patch = (path = 'file.txt') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-initial\n+implemented\n`;
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-shared-git-'))), remote = join(directory, 'remote.git'), producer = join(directory, 'producer'), repository = join(directory, 'worker');
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'clone', '--', remote, producer);
  await mkdir(join(producer, 'features')); await mkdir(join(producer, '.werk'));
  await writeFile(join(producer, 'features', 'request.md'), request);
  await writeFile(join(producer, 'features', '_ignored.md'), 'generated artifact');
  await writeFile(join(producer, '.werk', 'feature-workflow.json'), '{"schemaVersion":1}\n');
  await writeFile(join(producer, 'file.txt'), 'initial\n');
  git(producer, 'add', '.'); git(producer, 'commit', '-m', 'Base'); git(producer, 'push', 'origin', 'main');
  git(directory, 'clone', '--', remote, repository);
  const sourceCommit = git(producer, 'rev-parse', 'HEAD'), clients = [];
  const options = { repository, remote: 'origin', branch: 'main', requestsDirectory: 'features', reviewDirectory: 'feature-reviews', stateDirectory: join(directory, 'state'), workerId: 'worker-one' };
  const client = overrides => { const value = new GitFeatureRepository({ ...options, ...overrides }); clients.push(value); return value; };
  const main = () => git(remote, 'rev-parse', 'refs/heads/main');
  async function teammate(path, content) {
    git(producer, 'pull', '--ff-only', 'origin', 'main');
    await mkdir(join(producer, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(producer, path), content); git(producer, 'add', '--', path); git(producer, 'commit', '-m', 'Teammate update'); git(producer, 'push', 'origin', 'main'); return main();
  }
  const lifecycle = (operationId = 'claim-one', content = claimed()) => ({ operationId, request: { path: 'features/request.md', expectedRevision: hash(request), content }, artifacts: [{ path: 'feature-reviews/shared-one.md', expectedRevision: null, content: '# Claimed\n\nWorker owns this request.\n' }] });
  const publication = (operationId = 'publish-one') => ({ operationId, featureId: 'shared-one', sourceCommit, patch: patch(), approvedPaths: ['file.txt'] });
  t.after(async () => { for (const value of clients) await value.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, remote, producer, repository, sourceCommit, options, client, main, teammate, lifecycle, publication };
}

test('shared intake reads the remote commit without touching dirty developer files, staging or branch', async t => {
  const f = await fixture(t), adapter = f.client();
  await writeFile(join(f.repository, 'file.txt'), 'developer staged\n'); git(f.repository, 'add', 'file.txt');
  await writeFile(join(f.repository, 'file.txt'), 'developer working edit\n');
  const index = git(f.repository, 'write-tree'), head = git(f.repository, 'rev-parse', 'HEAD');
  const latest = await f.teammate('features/teammate.md', request.replace('Shared feature', 'Teammate feature'));
  const snapshot = await adapter.snapshot();
  assert.equal(snapshot.commit, latest); assert.equal(snapshot.files.length, 2); assert.equal(snapshot.files[0].revision, hash(request));
  assert.equal(await adapter.readBlob(snapshot.commit, '.werk/feature-workflow.json'), '{"schemaVersion":1}\n');
  assert.equal(await adapter.readBlob(snapshot.commit, 'missing.json'), null);
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), head); assert.equal(git(f.repository, 'write-tree'), index);
  assert.equal(await readFile(join(f.repository, 'file.txt'), 'utf8'), 'developer working edit\n');
  assert.equal(git(f.repository, 'branch', '--show-current'), 'main');
});

test('one of two competing clones claims a request; a losing claim never overwrites the winner', async t => {
  const f = await fixture(t), other = join(f.directory, 'other'); git(f.directory, 'clone', '--', f.remote, other);
  const first = f.client(), second = f.client({ repository: other, workerId: 'worker-two', stateDirectory: join(f.directory, 'state-two') });
  const outcomes = await Promise.allSettled([first.publishLifecycle(f.lifecycle('claim-one', claimed('one'))), second.publishLifecycle(f.lifecycle('claim-two', claimed('two')))]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(value => value.status === 'rejected'); assert.equal(rejected.reason.code, 'conflict');
  const winner = outcomes[0].status === 'fulfilled' ? 'one' : 'two';
  assert.equal(git(f.remote, 'show', 'main:features/request.md') + '\n', claimed(winner));
  assert.equal(git(f.remote, 'ls-tree', '--name-only', 'main:feature-reviews/_operations').split('\n').length, 1);
  assert.equal(await readFile(join(f.repository, 'features', 'request.md'), 'utf8'), request);
});

test('publication retries a concurrent teammate commit and preserves both histories', async t => {
  const f = await fixture(t), adapter = f.client(), push = featureGitIo(adapter).push.bind(featureGitIo(adapter)); let teammateCommit;
  featureGitIo(adapter).push = async (...args) => { if (!teammateCommit) teammateCommit = await f.teammate('teammate.txt', 'concurrent work\n'); return push(...args); };
  const result = await adapter.publishLifecycle(f.lifecycle());
  assert.equal(result.head, f.main()); assert.equal(result.commit, f.main());
  assert.equal(git(f.remote, 'show', 'main:teammate.txt'), 'concurrent work');
  git(f.remote, 'merge-base', '--is-ancestor', teammateCommit, result.head);
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), f.sourceCommit);
  assert.deepEqual(await readdir(join(f.options.stateDirectory, 'worktrees')), []);
});

test('a teammate edit to the same request stops stale publication without changing that edit', async t => {
  const f = await fixture(t), adapter = f.client(), push = featureGitIo(adapter).push.bind(featureGitIo(adapter)); let changed;
  featureGitIo(adapter).push = async (...args) => { if (!changed) changed = await f.teammate('features/request.md', request.replace('Improve the file.', 'Preserve this revised goal.')); return push(...args); };
  await assert.rejects(adapter.publishLifecycle(f.lifecycle()), error => testErrorCode(error) === 'conflict');
  assert.equal(f.main(), changed); assert.match(git(f.remote, 'show', 'main:features/request.md'), /revised goal/);
  assert.equal(git(f.remote, 'ls-tree', '--name-only', 'main', 'feature-reviews'), '');
});

test('a lost push acknowledgement and a restarted adapter replay the same lifecycle operation once', async t => {
  const f = await fixture(t), adapter = f.client(), push = featureGitIo(adapter).push.bind(featureGitIo(adapter));
  featureGitIo(adapter).push = async (...args) => { await push(...args); throw Error('Simulated connection loss after receive-pack accepted the commit'); };
  const input = f.lifecycle(), result = await adapter.publishLifecycle(input), head = f.main();
  assert.equal(result.head, head);
  await adapter.close();
  const restarted = f.client(), repeated = await restarted.publishLifecycle(input);
  assert.equal(repeated.replayed, true); assert.equal(repeated.commit, result.commit); assert.equal(f.main(), head);
  await assert.rejects(restarted.publishLifecycle({ ...input, artifacts: [{ ...input.artifacts[0], content: 'different intent' }] }), error => testErrorCode(error) === 'conflict');
});

test('lifecycle publication cannot overwrite developer body, other paths or changed review notes', async t => {
  const f = await fixture(t), adapter = f.client();
  await assert.rejects(adapter.publishLifecycle(f.lifecycle('bad-body', claimed().replace('Improve the file.', 'Overwritten goal'))), /only the request ID/);
  assert.throws(() => adapter.publishLifecycle({ ...f.lifecycle(), artifacts: [{ path: 'file.txt', expectedRevision: null, content: 'wrong' }] }), /configured review or Task directories/);
  await f.teammate('feature-reviews/shared-one.md', 'Developer review note\n');
  await assert.rejects(adapter.publishLifecycle(f.lifecycle()), error => testErrorCode(error) === 'conflict');
  assert.equal(git(f.remote, 'show', 'main:feature-reviews/shared-one.md'), 'Developer review note');
});

test('a validated patch publishes a separate feature branch and never includes incidental worktree mutations', async t => {
  const f = await fixture(t), adapter = f.client(), task = join(f.directory, 'task');
  git(f.repository, 'worktree', 'add', '--detach', '--', task, f.sourceCommit);
  await writeFile(join(task, 'file.txt'), 'incidental preset change\n'); await writeFile(join(task, 'unapproved.txt'), 'must not publish\n');
  const before = f.main(), input = f.publication(), result = await adapter.publishPatch(input);
  assert.equal(f.main(), before); assert.equal(git(f.remote, 'show', `${result.branch}:file.txt`), 'implemented');
  assert.equal(git(f.remote, 'diff', '--name-only', f.sourceCommit, result.commit), 'file.txt');
  assert.equal(git(f.remote, 'rev-parse', `${result.commit}^`), f.sourceCommit);
  assert.equal(git(task, 'rev-parse', 'HEAD'), f.sourceCommit); assert.equal(await readFile(join(task, 'file.txt'), 'utf8'), 'incidental preset change\n');
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), f.sourceCommit);
  const replay = await f.client().publishPatch(input); assert.equal(replay.replayed, true); assert.equal(replay.commit, result.commit);
  git(f.repository, 'worktree', 'remove', '--force', task);
});

test('explicit approved regular-file deletion publishes once without deleting source or teammate files', async t => {
  const f = await fixture(t), adapter = f.client();
  const deletion = 'diff --git a/file.txt b/file.txt\ndeleted file mode 100644\n--- a/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-initial\n';
  const input = { ...f.publication('delete-approved-file'), patch: deletion };
  await assert.rejects(adapter.publishPatch({ ...input, approvedPaths: ['other.txt'] }), /unapproved path/);
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/werk'), '');
  const main = await f.teammate('file.txt', 'newer teammate content\n');
  const result = await adapter.publishPatch(input);
  assert.equal(git(f.remote, 'ls-tree', '--name-only', result.commit, '--', 'file.txt'), '');
  assert.equal(git(f.remote, 'diff', '--name-status', f.sourceCommit, result.commit), 'D\tfile.txt');
  assert.equal(git(f.remote, 'rev-parse', result.commit + '^'), f.sourceCommit);
  assert.equal(f.main(), main); assert.equal(git(f.remote, 'show', 'main:file.txt'), 'newer teammate content');
  assert.equal(await readFile(join(f.repository, 'file.txt'), 'utf8'), 'initial\n');
  const replay = await f.client().publishPatch(input);
  assert.equal(replay.replayed, true); assert.equal(replay.commit, result.commit);
  assert.equal(git(f.remote, 'rev-parse', result.branch), result.commit);
});

test('feature publication confirms a lost acknowledgement and preserves an existing conflicting branch', async t => {
  const f = await fixture(t), adapter = f.client(), push = featureGitIo(adapter).push.bind(featureGitIo(adapter));
  featureGitIo(adapter).push = async (...args) => { await push(...args); throw Error('Lost acknowledgement'); };
  const input = f.publication(), result = await adapter.publishPatch(input);
  await assert.rejects(f.client().publishPatch({ ...input, patch: patch().replace('+implemented', '+different') }), error => testErrorCode(error) === 'conflict');
  assert.equal(git(f.remote, 'rev-parse', result.branch), result.commit);
  assert.equal(git(f.remote, 'show', `${result.branch}:file.txt`), 'implemented');
});

test('patch path and file-mode validation fails before any remote branch is published', async t => {
  const f = await fixture(t), adapter = f.client(), input = f.publication();
  await assert.rejects(adapter.publishPatch({ ...input, approvedPaths: ['other.txt'] }), /unapproved path/);
  assert.throws(() => adapter.publishPatch({ ...input, approvedPaths: ['../file.txt'] }), /repository-relative/);
  const link = 'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+outside\n';
  await assert.rejects(adapter.publishPatch({ ...input, patch: link, approvedPaths: ['link'] }), /file type/);
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/werk'), '');
  assert.equal(f.main(), f.sourceCommit);
});

test('a folder approval publishes files below it, never outside it or in protected storage', async t => {
  const f = await fixture(t), adapter = f.client(), input = f.publication('publish-folder');
  const created = 'diff --git a/src/app/new.ts b/src/app/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/app/new.ts\n@@ -0,0 +1 @@\n+created\n';
  await assert.rejects(adapter.publishPatch({ ...input, approvedPaths: ['src/'] }), /unapproved path/);
  for (const approvedPaths of [['features/'], ['feature-reviews/drafts/'], ['.werk/']]) assert.throws(() => adapter.publishPatch({ ...input, patch: created, approvedPaths }), /cannot modify/, approvedPaths[0]);
  assert.throws(() => f.client({ requestsDirectory: 'docs/features' }).publishPatch({ ...input, patch: created, approvedPaths: ['docs/'] }), /cannot modify/, 'a folder containing the request queue is refused');
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/werk'), '');
  const result = await adapter.publishPatch({ ...input, patch: created + patch(), approvedPaths: ['src/', 'file.txt'] });
  assert.deepEqual(git(f.remote, 'diff', '--name-only', f.sourceCommit, result.commit).split('\n'), ['file.txt', 'src/app/new.ts']);
});

test('committed symlink intake and unsafe Git metadata paths are refused; cancellation never publishes', async t => {
  const f = await fixture(t), adapter = f.client();
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.producer, input: '../file.txt', encoding: 'utf8' }).trim();
  git(f.producer, 'update-index', '--add', '--cacheinfo', '120000', blob, 'features/link.md');
  git(f.producer, 'update-index', '--add', '--cacheinfo', '120000', blob, 'prompts/ready.md');
  git(f.producer, 'update-index', '--add', '--cacheinfo', '160000', f.sourceCommit, 'prompts/done.txt');
  git(f.producer, 'commit', '-m', 'Symlink request'); git(f.producer, 'push', 'origin', 'main');
  await assert.rejects(adapter.snapshot(), /regular tracked files/);
  for (const path of ['prompts/ready.md', 'prompts/done.txt']) await assert.rejects(adapter.readBlob(f.main(), path), /regular tracked files/);
  await assert.rejects(adapter.readBlob(f.sourceCommit, '.git/config'), /Git control metadata/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.publishLifecycle(f.lifecycle(), controller.signal));
  assert.equal(git(f.remote, 'ls-tree', '--name-only', 'main', 'feature-reviews'), '');
});


test('missing intake directories are empty; case aliases cannot overwrite existing review content', async t => {
  const f = await fixture(t), adapter = f.client();
  assert.deepEqual(await adapter.list(f.sourceCommit, 'not-created'), []);
  await assert.rejects(adapter.list(f.sourceCommit, 'file.txt'), /tracked directory/);
  await f.teammate('Feature-Reviews/Shared-One.md', 'Preserve developer case-sensitive content\n');
  await assert.rejects(adapter.publishLifecycle(f.lifecycle()), /collides/);
  assert.equal(git(f.remote, 'show', 'main:Feature-Reviews/Shared-One.md'), 'Preserve developer case-sensitive content');
  assert.equal(git(f.remote, 'show', 'main:features/request.md') + '\n', request);
});


test('copied operation metadata cannot make a different feature tree pass replay verification', async t => {
  const f = await fixture(t), adapter = f.client(), input = f.publication();
  const original = await adapter.publishPatch(input);
  const message = git(f.remote, 'show', '-s', '--format=%B', original.commit);
  await writeFile(join(f.producer, 'file.txt'), 'different unverified implementation\n');
  git(f.producer, 'add', 'file.txt');
  const tree = git(f.producer, 'write-tree');
  const replacement = git(f.producer, 'commit-tree', tree, '-p', f.sourceCommit, '-m', message);
  git(f.producer, 'push', '--force', 'origin', replacement + ':refs/heads/' + original.branch);
  await assert.rejects(f.client().publishPatch(input), error => testErrorCode(error) === 'conflict');
  assert.equal(git(f.remote, 'rev-parse', original.branch), replacement, 'A conflicting remote branch is retained for human review.');
  assert.equal(f.main(), f.sourceCommit);
});

test('feature patches cannot modify intake, review notes or frozen workflow assets', async t => {
  const f = await fixture(t), adapter = f.client({ protectedPaths: ['fr-ready-check.json', 'fr-done-check.json', 'Feature Requests.base', 'prompts/ready.md', 'prompts/done.txt'] });
  for (const path of ['features/request.md', 'features/_templates/feature-request.md', 'feature-reviews/claimed.md', 'FEATURE-REVIEWS/claimed.md', 'fr-ready-check.json', 'fr-done-check.json', 'Feature Requests.base', 'prompts/ready.md', 'PROMPTS/READY.MD', 'prompts/done.txt'])
    assert.throws(() => adapter.publishPatch({ ...f.publication(), approvedPaths: [path] }), /workflow configuration/);
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/werk'), '');
});


test('deep publication and later task worktrees support committed receipt paths beyond Windows MAX_PATH', async t => {
  const f = await fixture(t);
  // Keep the worktree root below MAX_PATH while its tracked receipt exceeds it.
  // Local false overrides runner defaults, so both Git wrappers must opt in.
  const parent = join(f.directory, 'nested-' + 'x'.repeat(Math.max(8, 115 - f.directory.length)));
  await mkdir(parent); const repository = join(parent, 'worker');
  git(parent, 'clone', '--', f.remote, repository); git(repository, 'config', 'core.longpaths', 'false');
  const taskRepository = join(parent, 'task-' + 'r'.repeat(35));
  git(parent, 'clone', '--', f.remote, taskRepository); git(taskRepository, 'config', 'core.longpaths', 'false');
  const taskHead = git(taskRepository, 'rev-parse', 'HEAD'), taskIndex = await readFile(join(taskRepository, '.git', 'index'));
  const stateDirectory = join(repository, '.werk', 'worker', 'shared-git', 'a'.repeat(64));
  const adapter = f.client({ repository, stateDirectory }), input = f.lifecycle('deep-first');
  // Observe only this controlled local checkout's stderr, without replacing the
  // production runner, arguments, environment, cancellation or output limits.
  const diagnostics = [], originalSpawn = childProcess.spawn;
  const spy = t.mock.method(childProcess, 'spawn', function (executable, args, options) {
    const child = Reflect.apply(originalSpawn, this, [executable, args, options]);
    let invoked = executable, commandArgs = args;
    if ([repository, taskRepository].includes(options?.cwd) && options?.env?.WERK_PROVIDER_LAUNCH) {
      // The Windows job supervisor carries the original command as data. Observe it without substituting execution.
      const launch = JSON.parse(Buffer.from(options.env.WERK_PROVIDER_LAUNCH, 'base64').toString('utf8'));
      invoked = launch.executable; commandArgs = launch.arguments;
    } else if ([repository, taskRepository].includes(options?.cwd) && Array.isArray(args) && args[0] === 'werk-supervisor-v1' && args[1] === 'argv') {
      // The cached native supervisor carries the same command in its argv envelope.
      invoked = args[2]; commandArgs = args.slice(3);
    }
    const command = Array.isArray(commandArgs) ? commandArgs.indexOf('worktree') : -1;
    if ((invoked === 'git' || basename(invoked).toLowerCase() === 'git.exe') && [repository, taskRepository].includes(options?.cwd) && command >= 0 && commandArgs[command + 1] === 'add') {
      const diagnostic = { targetLength: commandArgs.at(-2).length, gitDirBytes: Buffer.byteLength(join(commandArgs.at(-2), '.git')), exitCode: null, stderr: '' }; diagnostics.push(diagnostic);
      child.stderr.on('data', chunk => { diagnostic.stderr = (diagnostic.stderr + chunk.toString('utf8')).slice(0, 8192); });
      child.once('close', code => { diagnostic.exitCode = code; });
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  async function checkoutDiagnostic(operation) {
    try { return await operation(); }
    catch (error) {
      const detail = JSON.stringify(diagnostics.map(value => ({ ...value, stderr: value.stderr.replaceAll(f.directory, '<fixture>').replaceAll(f.directory.replaceAll('\\', '/'), '<fixture>') })));
      throw new Error('Controlled Git checkout diagnostic: ' + detail, { cause: error });
    }
  }
  // Observe the actual paths while exercising the unmodified production runner.
  const publicationPaths = [], originalGit = featureGitIo(adapter).git.bind(featureGitIo(adapter));
  featureGitIo(adapter).git = async (cwd, args, ...options) => {
    if (args[0] === 'worktree' && args[1] === 'add') publicationPaths.push(resolve(cwd, args.at(-2)));
    return originalGit(cwd, args, ...options);
  };
  const initialHead = git(repository, 'rev-parse', 'HEAD');
  const initialIndex = await readFile(join(repository, '.git', 'index'));
  const first = await checkoutDiagnostic(() => adapter.publishLifecycle(input));
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].exitCode, 0);
  assert.ok(diagnostics[0].gitDirBytes <= 220);
  const receipt = 'feature-reviews/_operations/' + hash(input.operationId) + '.json';
  assert.equal(publicationPaths.length, 1);
  assert.ok(join(publicationPaths[0], '.git').length < 260);
  assert.ok(join(publicationPaths[0], receipt).length > 260);
  const second = await checkoutDiagnostic(() => adapter.publishLifecycle({ operationId: 'deep-second', request: { path: input.request.path, expectedRevision: hash(input.request.content), content: input.request.content.replace('status: claimed', 'status: completed') } }));
  assert.notEqual(second.commit, first.commit);
  assert.equal(JSON.parse(git(f.remote, 'show', second.head + ':' + receipt)).operationId, input.operationId);
  assert.match(git(f.remote, 'show', second.head + ':' + input.request.path), /status: completed/);
  git(taskRepository, 'fetch', 'origin', 'main');
  const worktree = await checkoutDiagnostic(() => prepareRepositoryWorktree(taskRepository, 'later-feature-with-receipt', new AbortController().signal, second.head));
  assert.ok(Buffer.byteLength(join(worktree.path, '.git')) > 220); assert.ok(join(worktree.path, '.git').length < 260);
  assert.ok(diagnostics.at(-1).gitDirBytes <= 220);
  assert.ok(join(worktree.path, receipt).length > 260);
  assert.equal(JSON.parse(await readFile(join(worktree.path, receipt), 'utf8')).operationId, input.operationId);
  assert.equal(worktree.baseCommit, second.head); assert.equal(git(repository, 'rev-parse', 'HEAD'), initialHead);
  assert.deepEqual(await readFile(join(repository, '.git', 'index')), initialIndex);
  assert.equal(git(repository, 'config', '--local', 'core.longpaths'), 'false', 'Command-scoped support must not change operator Git configuration.');
  assert.equal(git(taskRepository, 'config', '--local', 'core.longpaths'), 'false');
  assert.equal(git(taskRepository, 'rev-parse', 'HEAD'), taskHead); assert.deepEqual(await readFile(join(taskRepository, '.git', 'index')), taskIndex);
});


test('Windows shared publication rejects an excessive metadata path before reserving a worktree', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), stateDirectory = join(f.directory, 'state-' + 'x'.repeat(120), 'nested-' + 'y'.repeat(120));
  const adapter = f.client({ stateDirectory }), originalGit = featureGitIo(adapter).git.bind(featureGitIo(adapter)); let checkoutAttempted = false;
  featureGitIo(adapter).git = async (...args) => {
    if (args[1][0] === 'worktree' && args[1][1] === 'add') checkoutAttempted = true;
    return originalGit(...args);
  };
  await assert.rejects(adapter.publishLifecycle(f.lifecycle('excessive-path')), /shorter worker state directory/);
  assert.equal(checkoutAttempted, false); assert.equal(f.main(), f.sourceCommit);
  await assert.rejects(readdir(join(stateDirectory, 'worktrees')), { code: 'ENOENT' });
});

const addedFilePatch = (path, line) => `diff --git ${JSON.stringify('a/' + path)} ${JSON.stringify('b/' + path)}\nnew file mode 100644\n--- /dev/null\n+++ ${JSON.stringify('b/' + path)}\n@@ -0,0 +1,1 @@\n+${line}\n`;
test('a quoted Unicode vault path publishes under its exact NFC name', async t => {
  const f = await fixture(t), path = "docs/Kunden's Änderungen (Größe) & Fristen – Prüfung → Freigabe.md";
  const result = await f.client().publishPatch({ ...f.publication('publish-unicode'), patch: addedFilePatch(path, 'Prüfung'), approvedPaths: [path] });
  const listed = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', result.commit, '--', 'docs/'], { cwd: f.remote, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.deepEqual(listed, [path]);
  assert.equal(git(f.remote, 'show', `${result.commit}:${path}`), 'Prüfung');
});
test('a published file cannot alias a tracked name that differs only by Unicode normalization', { skip: process.platform === 'darwin' && 'APFS resolves both normalization forms to the same file' }, async t => {
  const f = await fixture(t), path = 'docs/Übersicht.md';
  const sourceCommit = await f.teammate(path.normalize('NFD'), 'decomposed\n');
  git(f.repository, 'fetch', 'origin');
  await assert.rejects(f.client().publishPatch({ ...f.publication('publish-alias'), sourceCommit, patch: addedFilePatch(path, 'composed'), approvedPaths: [path] }), error => testErrorCode(error) === 'conflict' && /Unicode normalization/.test(testErrorMessage(error)));
});

test('publication refuses new approved paths with colliding parent spellings', async t => {
  const f = await fixture(t), approvedPaths = ['Änderungen/a.md', 'änderungen/b.md'];
  const patch = approvedPaths.map(path => addedFilePatch(path, 'content')).join('');
  assert.throws(() => f.client().publishPatch({ ...f.publication('publish-parent-alias'), approvedPaths, patch }), error => testErrorCode(error) === 'invalid_input' && /folder aliases/.test(testErrorMessage(error)));
  assert.equal(f.main(), f.sourceCommit);
});


test('configured Task artifacts use guarded updates and cannot become feature patch targets', async t => {
  const f = await fixture(t), adapter = f.client({ tasksDirectory: 'team/actions' });
  const path = 'team/actions/answer.md', initial = '# Task\n\nWaiting for an answer.\n';
  const requestWrite = { path: 'features/request.md', expectedRevision: hash(request), content: request };
  await adapter.publishLifecycle({ operationId: 'task-create', request: requestWrite, artifacts: [{ path, expectedRevision: null, content: initial }] });
  const edited = '# Task\n\nHuman answer.\n'; await f.teammate(path, edited);
  await assert.rejects(adapter.publishLifecycle({ operationId: 'stale-task', request: requestWrite, artifacts: [{ path, expectedRevision: hash(initial), content: '# Incorrect overwrite\n' }] }), /changed before publication/);
  const acknowledged = edited + '\nProcessed.\n';
  await adapter.publishLifecycle({ operationId: 'task-ack', request: requestWrite, artifacts: [{ path, expectedRevision: hash(edited), content: acknowledged }] });
  assert.equal(git(f.remote, 'show', 'main:' + path) + '\n', acknowledged);
  assert.throws(() => adapter.publishPatch({ ...f.publication('task-patch-denied'), approvedPaths: [path], patch: patch(path) }), /workflow configuration/);
  assert.throws(() => adapter.publishLifecycle({ operationId: 'outside-task', request: requestWrite, artifacts: [{ path: 'another/actions/answer.md', expectedRevision: null, content: initial }] }), /configured review or Task directories/);
  assert.equal(git(f.remote, 'show', 'main:features/request.md') + '\n', request);
});
