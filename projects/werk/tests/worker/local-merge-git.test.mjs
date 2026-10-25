import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { createLocalMergeGit } from '../../src/worker/dist/worker/infrastructure/local-merge-git.js';
import { FeatureGitIo } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';
import { runLocalMerge } from '../../src/worker/dist/worker/application/local-merge-runtime.js';
import { publication } from './remote-delivery-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';
prepareNativeProcessFixture();
const signal = () => AbortSignal.timeout(30000);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function fixture(t, diverged = true, conflicting = false, queuePath = 'queue.md') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-local-merge-'))), repository = join(directory, 'main'), candidatePath = join(directory, 'candidate'), remote = join(directory, 'remote.git');
  cleanup(t, () => rm(directory, { recursive: true, force: true })); await mkdir(repository); await mkdir(remote);
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'value.txt'), 'baseline\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline'); const baseline = git(repository, 'rev-parse', 'HEAD');
  git(repository, 'worktree', 'add', '-b', 'werk/delivery/feature-one', candidatePath, baseline);
  await writeFile(join(candidatePath, 'value.txt'), 'verified feature\n'); git(candidatePath, 'commit', '-am', 'Candidate feature');
  const candidateCommit = git(candidatePath, 'rev-parse', 'HEAD'), tree = git(candidatePath, 'rev-parse', 'HEAD^{tree}');
  if (diverged) { await mkdir(dirname(join(repository, queuePath)), { recursive: true }); await writeFile(join(repository, conflicting ? 'value.txt' : queuePath), conflicting ? 'teammate change\n' : 'Feature queue progress\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Queue progress'); }
  const head = git(repository, 'rev-parse', 'HEAD'); git(remote, 'init', '--bare'); git(repository, 'remote', 'add', 'origin', remote); git(repository, 'push', 'origin', 'main');
  const io = new FeatureGitIo({ repository, stateDirectory: join(directory, 'state'), remote: 'origin', literalObjects: true });
  const port = createLocalMergeGit({ repository, branch: 'main', metadataPaths: [queuePath], stateDirectory: join(directory, 'state') }, io);
  /** @type {import('../../src/worker/application/local-merge-contracts.ts').LocalMergeOperation} */
  const operation = { operationId: 'approved-local-merge', status: 'pending', repositoryId: 'project-one', checkoutPath: repository, mainBranch: 'main', mainHead: head, candidate: { ...publication().candidate, baseline, branch: 'werk/delivery/feature-one', candidateCommit, tree }, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z', detail: 'Approved exact destination.' };
  const events = [];
  /** @param {'execute'|'reconcile'} [mode] */
  const run = (mode = 'execute') => runLocalMerge({ operation, mode, port, signal: signal(), authorize(mutation) { events.push(mutation ? 'authorize-write' : 'authorize-read'); }, prepared(value) { events.push('prepared-durable'); operation.preparation = structuredClone(value); } });
  return { directory, repository, candidatePath, remote, head, port, operation, events, io, run };
}

test('explicit local merge preserves shared queue progress and produces a clean non-FF merge without pushing main', async t => {
  const h = await fixture(t), beforeCandidate = git(h.candidatePath, 'rev-parse', 'HEAD');
  const apply = h.port.apply; h.port.apply = async (...args) => { assert.equal(h.events.includes('prepared-durable'), true); assert.ok(h.operation.preparation); await apply(...args); };
  const result = await h.run(); assert.equal(result.status, 'confirmed'); assert.equal(result.receipt.previousHead, h.head); assert.equal(result.receipt.candidateCommit, h.operation.candidate.candidateCommit);
  assert.equal(git(h.repository, 'rev-parse', 'HEAD'), result.receipt.mergeCommit); assert.equal(git(h.repository, 'rev-list', '--parents', '-n', '1', 'HEAD'), [result.receipt.mergeCommit, h.head, h.operation.candidate.candidateCommit].join(' '));
  assert.equal(await readFile(join(h.repository, 'value.txt'), 'utf8'), 'verified feature\n'); assert.equal(await readFile(join(h.repository, 'queue.md'), 'utf8'), 'Feature queue progress\n');
  assert.equal(git(h.repository, 'status', '--porcelain'), ''); assert.equal(git(h.candidatePath, 'rev-parse', 'HEAD'), beforeCandidate); assert.equal(git(h.remote, 'rev-parse', 'refs/heads/main'), h.head);
  const reads = h.events.length; assert.equal((await h.run('reconcile')).status, 'confirmed'); assert.deepEqual(h.events.slice(reads), ['authorize-read']);
});

test('fast-forward local merge and lost checkout acknowledgement reconcile exactly once', async t => {
  const h = await fixture(t, false), apply = h.port.apply; let writes = 0;
  h.port.apply = async (...args) => { writes++; await apply(...args); throw Error('Lost final acknowledgement'); };
  const result = await h.run(); assert.equal(result.status, 'confirmed'); assert.equal(result.receipt.mergeCommit, h.operation.candidate.candidateCommit);
  assert.equal((await h.run('reconcile')).status, 'confirmed'); assert.equal(writes, 1);
});

test('dirty, staged, untracked, stale-head and changed-branch approvals preserve every checkout', async t => {
  for (const kind of ['dirty', 'staged', 'untracked', 'stale', 'branch']) {
    const h = await fixture(t);
    if (kind === 'dirty' || kind === 'staged') { await writeFile(join(h.repository, 'value.txt'), 'private edit\n'); if (kind === 'staged') git(h.repository, 'add', 'value.txt'); }
    if (kind === 'untracked') await writeFile(join(h.repository, 'untracked.txt'), 'private untracked\n');
    if (kind === 'stale') git(h.repository, 'commit', '--allow-empty', '-m', 'Concurrent head');
    if (kind === 'branch') git(h.repository, 'switch', '-c', 'other');
    const before = git(h.repository, 'status', '--porcelain'), head = git(h.repository, 'rev-parse', 'HEAD'), result = await h.run();
    assert.ok(['failed', 'unknown'].includes(result.status)); assert.equal(git(h.repository, 'status', '--porcelain'), before); assert.equal(git(h.repository, 'rev-parse', 'HEAD'), head); assert.equal(h.operation.preparation, undefined);
  }
});

test('merge conflicts never touch main or candidate and leave no merge-in-progress state', async t => {
  const h = await fixture(t, true, true), before = await readFile(join(h.repository, 'value.txt'), 'utf8');
  const result = await h.run(); assert.equal(result.status, 'failed'); assert.match(result.detail, /conflicts/); assert.equal(git(h.repository, 'rev-parse', 'HEAD'), h.head); assert.equal(git(h.repository, 'status', '--porcelain'), ''); assert.equal(await readFile(join(h.repository, 'value.txt'), 'utf8'), before);
  assert.equal(git(h.candidatePath, 'status', '--porcelain'), '');
});

test('CAS head race and tracked-file race before checkout update are preserved', async t => {
  const h = await fixture(t), prepare = h.port.prepare;
  h.port.prepare = async (...args) => { const result = await prepare(...args); git(h.repository, 'commit', '--allow-empty', '-m', 'Concurrent main advancement'); return result; };
  const result = await h.run(); assert.equal(result.status, 'unknown'); assert.notEqual(git(h.repository, 'rev-parse', 'HEAD'), h.head); assert.equal(await readFile(join(h.repository, 'value.txt'), 'utf8'), 'baseline\n');
  const raced = await fixture(t), output = raced.io.output.bind(raced.io);
  raced.io.output = async (cwd, args, abort, input) => { if (args[0] === 'read-tree') await writeFile(join(raced.repository, 'value.txt'), 'Concurrent private edit\n'); return output(cwd, args, abort, input); };
  const outcome = await raced.run(); assert.equal(outcome.status, 'unknown'); assert.equal(git(raced.repository, 'rev-parse', 'HEAD'), raced.head); assert.equal(await readFile(join(raced.repository, 'value.txt'), 'utf8'), 'Concurrent private edit\n');
});

test('interruption between checkout and ref commit remains unknown; reconciliation performs no write or discard', async t => {
  const h = await fixture(t), output = h.io.output.bind(h.io); let writes = 0;
  h.io.output = async (cwd, args, abort, input) => { const result = await output(cwd, args, abort, input); if (args[0] === 'read-tree') { writes++; throw Error('Interrupted before ref commit'); } return result; };
  assert.equal((await h.run()).status, 'unknown'); assert.equal(git(h.repository, 'rev-parse', 'HEAD'), h.head); assert.equal(await readFile(join(h.repository, 'value.txt'), 'utf8'), 'verified feature\n');
  const before = git(h.repository, 'status', '--porcelain'); assert.equal((await h.run('reconcile')).status, 'unknown'); assert.equal(writes, 1); assert.equal(git(h.repository, 'status', '--porcelain'), before);
});


test('literal candidate objects ignore replacement refs, and hidden index entries prevent clean claims', async t => {
  const h = await fixture(t);
  git(h.repository, 'replace', h.operation.candidate.candidateCommit, h.head);
  assert.equal(git(h.repository, 'rev-parse', h.operation.candidate.candidateCommit + '^{tree}'), git(h.repository, 'rev-parse', h.head + '^{tree}'), 'Fixture replacement disguises the candidate tree for ordinary Git');
  const result = await h.run(); assert.equal(result.status, 'confirmed'); assert.equal(await readFile(join(h.repository, 'value.txt'), 'utf8'), 'verified feature\n');
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const next = await fixture(t); git(next.repository, 'update-index', flag, 'value.txt'); await writeFile(join(next.repository, 'value.txt'), 'Hidden operator edit\n');
    assert.equal(git(next.repository, 'status', '--porcelain'), '', 'Fixture hides its changed file from ordinary status');
    const outcome = await next.run(); assert.equal(outcome.status, 'failed'); assert.match(outcome.detail, /index/); assert.equal(await readFile(join(next.repository, 'value.txt'), 'utf8'), 'Hidden operator edit\n'); assert.equal(git(next.repository, 'rev-parse', 'HEAD'), next.head);
  }
});


test('unverified source divergence is refused while only explicitly retained workflow metadata can differ from the candidate tree', async t => {
  const h = await fixture(t); await writeFile(join(h.repository, 'source.ts'), 'teammate source change\n'); git(h.repository, 'add', '.'); git(h.repository, 'commit', '-m', 'Source advanced'); h.operation.mainHead = git(h.repository, 'rev-parse', 'HEAD');
  assert.equal((await h.run()).status, 'failed'); assert.equal(await readFile(join(h.repository, 'value.txt'), 'utf8'), 'baseline\n'); assert.equal(git(h.repository, 'status', '--porcelain'), '');
  const strict = await fixture(t); strict.port = createLocalMergeGit({ repository: strict.repository, branch: 'main', stateDirectory: join(strict.directory, 'state') });
  await assert.rejects(strict.port.prepare(strict.operation, signal()), /combined source/);
  const frozen = await fixture(t), protectedPort = createLocalMergeGit({ repository: frozen.repository, branch: 'main', stateDirectory: join(frozen.directory, 'state'), metadataPaths: ['queue.md'], protectedPaths: ['queue.md'] });
  await assert.rejects(protectedPort.prepare(frozen.operation, signal()), /combined source/);
});


test('frozen workflow directory exceptions permit ordinary note progress and refuse executable or linked metadata', async t => {
  const h = await fixture(t, true, false, 'features/one.md');
  const port = createLocalMergeGit({ repository: h.repository, branch: 'main', stateDirectory: join(h.directory, 'state'), metadataPaths: ['features/'] });
  h.port.prepare = port.prepare; h.port.apply = port.apply;
  const result = await h.run(); assert.equal(result.status, 'confirmed'); assert.deepEqual(result.receipt.metadataPaths, ['features/one.md']); assert.equal(await readFile(join(h.repository, 'features/one.md'), 'utf8'), 'Feature queue progress\n');
  const linked = await fixture(t), linkBlob = git(linked.repository, 'hash-object', '-w', 'queue.md'); git(linked.repository, 'update-index', '--cacheinfo', '120000', linkBlob, 'queue.md'); git(linked.repository, 'commit', '-m', 'Linked metadata'); linked.operation.mainHead = git(linked.repository, 'rev-parse', 'HEAD');
  await assert.rejects(linked.port.prepare(linked.operation, signal()), /regular non-executable/); assert.equal(git(linked.repository, 'rev-parse', 'HEAD'), linked.operation.mainHead);
  const executable = await fixture(t); git(executable.repository, 'update-index', '--chmod=+x', 'queue.md'); git(executable.repository, 'commit', '-m', 'Executable metadata'); executable.operation.mainHead = git(executable.repository, 'rev-parse', 'HEAD');
  assert.equal((await executable.run()).status, 'failed'); assert.equal(git(executable.repository, 'rev-parse', 'HEAD'), executable.operation.mainHead);
});


test('applicable external merge drivers and filters cannot execute while preparing or applying a main checkout merge', async t => {
  const command = '"' + process.execPath + '" -e "require(\'node:fs\').writeFileSync(\'external-transform-marker.txt\',\'unsafe\');process.stdin.pipe(process.stdout)"';
  for (const attribute of ['merge', 'filter']) {
    for (const suffix of attribute === 'merge' ? ['driver'] : ['clean', 'smudge', 'process']) {
      const h = await fixture(t, true, attribute === 'merge');
      await writeFile(join(h.repository, '.gitattributes'), `value.txt ${attribute}=guard\n`); git(h.repository, 'add', '.gitattributes'); git(h.repository, 'commit', '-m', 'Selected transform'); h.operation.mainHead = git(h.repository, 'rev-parse', 'HEAD');
      git(h.repository, 'config', `${attribute}.guard.${suffix}`, command);
      const result = await h.run(); assert.equal(result.status, 'failed'); assert.match(result.detail, /external Git merge driver/); assert.equal(await readFile(join(h.repository, 'external-transform-marker.txt'), 'utf8').catch(() => null), null); assert.equal(git(h.repository, 'rev-parse', 'HEAD'), h.operation.mainHead);
    }
  }
  const late = await fixture(t, false); late.operation.preparation = await late.port.prepare(late.operation, signal()); await writeFile(join(late.repository, '.git/info/attributes'), 'value.txt filter=late\n'); git(late.repository, 'config', 'filter.late.clean', command); await assert.rejects(late.port.apply(late.operation, signal()), /external Git merge driver/); assert.equal(await readFile(join(late.repository, 'external-transform-marker.txt'), 'utf8').catch(() => null), null); assert.equal(git(late.repository, 'rev-parse', 'HEAD'), late.operation.mainHead);
  const future = await fixture(t, false); await writeFile(join(future.candidatePath, '.gitattributes'), 'value.txt filter=future\n'); git(future.candidatePath, 'add', '.gitattributes'); git(future.candidatePath, 'commit', '-m', 'Reviewed attributes'); future.operation.candidate.candidateCommit = git(future.candidatePath, 'rev-parse', 'HEAD'); future.operation.candidate.tree = git(future.candidatePath, 'rev-parse', 'HEAD^{tree}'); git(future.repository, 'config', 'filter.future.smudge', command); assert.equal((await future.run()).status, 'failed'); assert.equal(await readFile(join(future.repository, 'external-transform-marker.txt'), 'utf8').catch(() => null), null);
  const h = await fixture(t); git(h.repository, 'config', 'filter.unused.clean', command);
  assert.equal((await h.run()).status, 'confirmed', 'An unused host registration such as Git LFS does not disable an ordinary checkout.');
});
