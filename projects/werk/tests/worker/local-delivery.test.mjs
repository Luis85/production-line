import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalDelivery } from '../../src/worker/dist/worker/infrastructure/local-delivery.js';
import { createDevelopmentRuntime } from '../../src/worker/dist/worker/infrastructure/candidate-tools.js';
import { createRepositoryWorktree, repositoryRoot, removeRepositoryWorktree, worktreeName } from '../../src/worker/dist/worker/infrastructure/repositories-git.js';
import { defaultToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { freezeDevelopmentScope } from '../../src/worker/dist/worker/application/development.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { assertDeliveryAcceptance, assertDeliverySubject, buildDeliveryReview } from '../../src/worker/dist/worker/application/delivery-review.js';
import { cleanup } from './fixture-cleanup.mjs';
import { fixture as journalFixture, provider } from './request-gate-fixtures.mjs';
import { retainDeliveryCheckpoint } from '../../src/worker/dist/worker/application/delivery-task-checkpoint.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';

const git = (directory, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const signal = () => new AbortController().signal;
const environment = { platform: process.platform, architecture: process.arch, nodeVersion: process.version };
async function fixture(t, protectedGate = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-delivery-'))), repository = join(directory, 'repo');
  cleanup(t, () => rm(directory, { recursive: true, force: true })); await mkdir(repository);
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'core.autocrlf', 'false');
  git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(join(repository, 'test.mjs'), "import {value} from './value.mjs'; if (value !== 2) process.exit(1);\n");
  await writeFile(join(repository, 'user.txt'), 'original\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  await writeFile(join(repository, 'user.txt'), 'staged\n'); git(repository, 'add', 'user.txt');
  await writeFile(join(repository, 'user.txt'), 'unstaged\n'); await writeFile(join(repository, 'untracked.txt'), 'keep me\n');
  const before = { head: git(repository, 'rev-parse', 'HEAD'), status: git(repository, 'status', '--porcelain=v1'), index: git(repository, 'write-tree') };
  const root = await repositoryRoot(repository, signal());
  const workspace = await createRepositoryWorktree(root, 'local', 'request-one', signal());
  const info = await lstat(workspace.path), policy = defaultToolPolicy(); policy.builtins.files = true;
  policy.builtins.commands = [{ id: 'test', name: 'Unit tests', executable: process.execPath, args: ['test.mjs'], enabled: true, verification: true }];
  const scope = freezeDevelopmentScope(workspace.baseCommit, ['value.mjs', 'test.mjs', 'tests/'], policy);
  if (protectedGate) scope.verificationInputs = ['test.mjs', 'tests/'];
  let evidence;
  const runtime = createDevelopmentRuntime({ scope, worktree: workspace.path, repository,
    worktreeIdentity: { dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs }, currentPolicy: () => policy,
    checkpoint: async value => { evidence = structuredClone(value); },
    verifyWorkspace: async abort => { await createRepositoryWorktree(root, 'local', 'request-one', abort, workspace.baseCommit); },
  });
  const adapter = createLocalDelivery({ repository, stateDirectory: join(directory, 'state'), reviewDirectory: join(repository, 'reviews') });
  const input = candidate => ({ requestId: 'request-one', inputRevision: 1, inputHash: 'a'.repeat(64), runId: 'run-one', title: 'Deliver value two', scope, candidate, policyDigest: 'b'.repeat(64) });
  const reviewInput = candidate => ({ candidate, scope, evidence, criteria: ['The displayed value is two'], title: 'Deliver value two', summary: 'Implemented value two.', environment });
  return { directory, repository, workspace, scope, runtime, adapter, before, input, reviewInput, get evidence() { return evidence; } };
}
async function passing(f) {
  await writeFile(join(f.workspace.path, 'value.mjs'), 'export const value = 2;\n');
  assert.equal((await f.runtime.check('test', signal())).status, 'passed');
  return f.runtime.capture(signal());
}

test('local delivery preserves dirty checkout and publishes exact verified tree and human review without a remote', async t => {
  const f = await fixture(t), captured = await passing(f);
  assert.equal(git(f.repository, 'remote'), '');
  assert.match(git(f.workspace.path, 'branch', '--show-current'), /^werk\/workspaces\//);
  const candidate = await f.adapter.checkpoint(f.input(captured), signal());
  const replayed = await f.adapter.checkpoint(f.input(captured), signal());
  assert.deepEqual(replayed, candidate, 'same request/run/candidate reconciles the existing immutable commit');
  assert.equal(git(f.repository, 'show', `${candidate.candidateCommit}:value.mjs`), 'export const value = 2;');
  assert.equal(git(f.repository, 'rev-parse', `${candidate.candidateCommit}^`), f.workspace.baseCommit);
  assert.equal(git(f.repository, 'rev-parse', `${candidate.candidateCommit}^{tree}`), candidate.tree);
  assert.equal(git(f.workspace.path, 'rev-parse', 'HEAD'), f.workspace.baseCommit, 'packaging does not alter execution baseline');
  const review = await f.adapter.package(f.reviewInput(candidate), signal());
  assert.equal(review.publication, 'local_only'); assert.match(review.markdown, /No branch was pushed/);
  assert.equal(await readFile(review.reviewNotePath, 'utf8'), review.markdown);
  const evidence = JSON.parse(await readFile(review.reviewNotePath.replace(/\.md$/, '.evidence.json'), 'utf8'));
  assert.equal(evidence.candidate.candidateCommit, candidate.candidateCommit); assert.equal(evidence.checks[0].exitCode, 0);
  assert.equal(evidence.checks[0].environment.platform, process.platform);
  assert.equal(review.results.find(item => item.criterionId.startsWith('human:')).status, 'pending_human');
  assert.equal((await f.adapter.package(f.reviewInput(candidate), signal())).reviewNotePath, review.reviewNotePath);
  assert.equal(git(f.repository, 'write-tree'), f.before.index); assert.equal(git(f.repository, 'rev-parse', 'HEAD'), f.before.head);
  assert.equal(git(f.repository, 'branch', '--show-current'), 'main');
  assert.equal(await readFile(join(f.repository, 'user.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await readFile(join(f.repository, 'untracked.txt'), 'utf8'), 'keep me\n');
  assert.equal(git(f.repository, 'status', '--porcelain=v1').replace(/\n?\?\? reviews\//, ''), f.before.status);
  const after = await f.runtime.capture(signal()); assert.equal(after.digest, captured.digest, 'note packaging leaves tested source unchanged');
});

test('partial failing implementation has an inspectable checkpoint but cannot produce a review package', async t => {
  const f = await fixture(t); await writeFile(join(f.workspace.path, 'value.mjs'), 'export const value = 3;\n');
  assert.equal((await f.runtime.check('test', signal())).status, 'failed');
  const candidate = await f.adapter.checkpoint(f.input(await f.runtime.capture(signal())), signal());
  assert.equal(git(f.repository, 'show', `${candidate.candidateCommit}:value.mjs`), 'export const value = 3;');
  await assert.rejects(f.adapter.package(f.reviewInput(candidate), signal()), /current worker verification/);
  const repaired = await passing(f), next = await f.adapter.checkpoint(f.input(repaired), signal());
  assert.notEqual(next.candidateCommit, candidate.candidateCommit); await f.adapter.verify(candidate, signal());
});

test('candidate acceptance rejects stale identities and requires every manual outcome', async t => {
  const f = await fixture(t), candidate = await f.adapter.checkpoint(f.input(await passing(f)), signal());
  const review = buildDeliveryReview(f.reviewInput(candidate));
  const current = { inputRevision: 1, inputHash: candidate.inputHash, candidateCommit: candidate.candidateCommit,
    candidateDigest: candidate.candidateDigest, policyDigest: candidate.policyDigest, humanOutcomes: [] };
  assert.throws(() => assertDeliveryAcceptance(review, current), /every mandatory human/);
  const criterionId = review.criteria.find(item => item.evaluator === 'human').id;
  const outcome = { criterionId, outcome: /** @type {const} */ ('passed'), actor: 'operator', reason: 'Verified in the application.', at: new Date().toISOString() };
  assert.doesNotThrow(() => assertDeliveryAcceptance(review, { ...current, humanOutcomes: [outcome] }));
  assert.throws(() => assertDeliveryAcceptance(review, { ...current, humanOutcomes: [{ ...outcome, actor: 'model' }] }), /operator/);
  assert.throws(() => assertDeliveryAcceptance(review, { ...current, humanOutcomes: [{ ...outcome, outcome: 'exempted' }] }), /every mandatory human/);
  assert.throws(() => assertDeliveryAcceptance(review, { ...current, candidateCommit: 'c'.repeat(40), humanOutcomes: [outcome] }), /exact current candidate commit/);
  const missingCommit = { ...current, humanOutcomes: [outcome] }; Reflect.deleteProperty(missingCommit, 'candidateCommit');
  assert.throws(() => assertDeliveryAcceptance(review, missingCommit), /exact current candidate commit/);
  assert.throws(() => assertDeliverySubject(candidate, { ...current, inputRevision: 2 }), /changed/);
  assert.throws(() => assertDeliverySubject(candidate, { ...current, baseline: 'd'.repeat(40) }), /changed/);
  assert.throws(() => assertDeliverySubject(candidate, { ...current, checkDefinitionDigest: 'e'.repeat(64) }), /changed/);
  await writeFile(join(f.workspace.path, 'value.mjs'), 'export const value = 4;\n');
  const changed = await f.runtime.capture(signal());
  assert.throws(() => assertDeliverySubject(candidate, { ...current, candidateDigest: changed.digest }), /changed/);
  assert.throws(() => buildDeliveryReview(f.reviewInput(candidate)), /current worker verification/);
});

test('changed delivery branch and tampered review artifact are preserved and block retry', async t => {
  const f = await fixture(t), captured = await passing(f), candidate = await f.adapter.checkpoint(f.input(captured), signal());
  const review = await f.adapter.package(f.reviewInput(candidate), signal());
  await writeFile(review.reviewNotePath, 'human review annotation\n');
  await assert.rejects(f.adapter.package(f.reviewInput(candidate), signal()), /existing review artifact changed/);
  assert.equal(await readFile(review.reviewNotePath, 'utf8'), 'human review annotation\n');
  git(f.repository, 'update-ref', `refs/heads/${candidate.branch}`, candidate.baseline);
  await assert.rejects(f.adapter.verify(candidate, signal()), /changed/);
  await assert.rejects(f.adapter.checkpoint(f.input(captured), signal()), /changed/);
  assert.equal(git(f.repository, 'rev-parse', `refs/heads/${candidate.branch}`), candidate.baseline);
});

test('approved changes cannot silently weaken protected verification inputs', async t => {
  const f = await fixture(t, true);
  await writeFile(join(f.workspace.path, 'value.mjs'), 'export const value = 3;\n');
  await writeFile(join(f.workspace.path, 'test.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('gate-ran.txt', 'executed');\n");
  const receipt = await f.runtime.check('test', signal());
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.exitCode, null); assert.match(receipt.stderr, /Protected verification input/);
  await assert.rejects(readFile(join(f.workspace.path, 'gate-ran.txt')), { code: 'ENOENT' });
  assert.equal(receipt.presetFingerprint, f.scope.checks[0].fingerprint);
  assert.equal(gateDigest(f.evidence.checks), gateDigest([receipt]));
});

test('new regression tests within protected folders remain eligible for verification', async t => {
  const f = await fixture(t, true); await mkdir(join(f.workspace.path, 'tests'));
  await writeFile(join(f.workspace.path, 'tests', 'regression.mjs'), 'export const regression = true;\n');
  await writeFile(join(f.workspace.path, 'value.mjs'), 'export const value = 2;\n');
  const receipt = await f.runtime.check('test', signal());
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.exitCode, 0);
  const captured = await f.runtime.capture(signal());
  assert.ok(captured.changedPaths.includes('tests/regression.mjs'));
});


test('delivery rejects missing tree proof and source conversions after otherwise passing checks', async t => {
  const f = await fixture(t), captured = await passing(f);
  const withoutProof = { ...captured }; delete withoutProof.treeDigest;
  await assert.rejects(f.adapter.checkpoint(f.input(withoutProof), signal()), /captured candidate/);
  git(f.repository, 'config', 'core.autocrlf', 'true');
  await writeFile(join(f.workspace.path, 'value.mjs'), 'export const value = 2;\r\n');
  assert.equal((await f.runtime.check('test', signal())).status, 'passed');
  const normalized = await f.runtime.capture(signal());
  await assert.rejects(f.adapter.checkpoint(f.input(normalized), signal()), /Git conversion changed the tested source bytes/);
  assert.equal(git(f.repository, 'for-each-ref', '--format=%(refname)', 'refs/heads/werk/delivery/'), '');
});

test('review folders are configurable and cannot overlap tested source or an execution worktree', async t => {
  const f = await fixture(t), candidate = await f.adapter.checkpoint(f.input(await passing(f)), signal());
  await assert.rejects(f.adapter.package({ ...f.reviewInput(candidate), reviewDirectory: 'tests/reviews' }, signal()), /overlaps approved/);
  const unsafe = createLocalDelivery({ repository: f.repository, stateDirectory: join(f.directory, 'other-state'), reviewDirectory: join(f.workspace.path, 'reviews') });
  await assert.rejects(unsafe.package(f.reviewInput(candidate), signal()), /outside implementation worktrees/);
  const review = await f.adapter.package({ ...f.reviewInput(candidate), reviewDirectory: 'team/reviews' }, signal());
  assert.ok(review.reviewNotePath.startsWith(join(f.repository, 'team', 'reviews')));
  const published = JSON.parse(await readFile(review.reviewNotePath.replace(/\.md$/, '.evidence.json'), 'utf8'));
  assert.equal(published.checks[0].stdout, undefined); assert.equal(published.checks[0].command, undefined);
  assert.ok(published.checks[0].commandFingerprint);
});


test('a colliding branch is never adopted and an unconfirmed branch is retained on cleanup', async t => {
  const f = await fixture(t), root = await repositoryRoot(f.repository, signal());
  const collision = worktreeName('local', 'collision'), branch = `werk/workspaces/${collision}`;
  git(f.repository, 'branch', branch, f.workspace.baseCommit);
  await assert.rejects(createRepositoryWorktree(root, 'local', 'collision', signal()), /without verified ownership/);
  assert.equal(git(f.repository, 'rev-parse', branch), f.workspace.baseCommit);
  await assert.rejects(readFile(join(root.commonDirectory, 'werk-worktrees', collision + '.json')), { code: 'ENOENT' });
  const name = worktreeName('local', 'request-one'), marker = join(root.commonDirectory, 'werk-worktrees', name + '.json');
  const owner = JSON.parse(await readFile(marker, 'utf8')); assert.equal(owner.branchOwned, true);
  delete owner.branchOwned; await writeFile(marker, JSON.stringify(owner));
  assert.equal((await removeRepositoryWorktree(root, name, signal())).outcome, 'removed');
  assert.equal(git(f.repository, 'rev-parse', owner.branch), f.workspace.baseCommit, 'uncertain branch creation cannot authorize deletion');
});


test('settled failing source gets an inspectable durable checkpoint while unknown operations are not inspected', async t => {
  const f = await fixture(t), { journal } = await journalFixture(t), policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  const request = journal.ensure({ owner: { sessionId: 'checkpoint-session', rootTurnId: 'root', taskId: 'checkpoint-task' }, provider, policy,
    input: { kind: 'patch', title: 'Retain failed source', message: 'Implement and retain the source candidate for inspection.', files: [{ path: 'value.mjs', bytes: 1 }], context: { implementation: f.scope } } });
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn'); journal.prepareExecution(request.id, 'turn', 'invocation'); journal.startExecution(request.id, 'turn', 'invocation');
  const run = journal.get(request.id).delivery;
  journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: run.id, stepId: 'implementation', phase: 'implementing', invocationRunId: 'invocation', turnId: 'turn' });
  await writeFile(join(f.workspace.path, 'value.mjs'), 'export const value = 3;\n');
  journal.deliveryUpdate(request.id, { action: 'finish', deliveryRunId: run.id, stepId: 'implementation', status: 'completed', result: { type: 'completed', text: 'Partial result' } });
  const host = /** @type {Parameters<typeof retainDeliveryCheckpoint>[0]} */ (/** @type {unknown} */ ({ sessions: { requests: journal }, delivery: () => f.adapter }));
  const task = /** @type {Parameters<typeof retainDeliveryCheckpoint>[1]} */ (/** @type {unknown} */ ({ requestId: request.id, repository: f.repository, title: 'Retain failed source', implementation: f.scope }));
  const checkpoint = await retainDeliveryCheckpoint(host, task, f.runtime, signal());
  assert.equal(git(f.repository, 'show', checkpoint.candidateCommit + ':value.mjs'), 'export const value = 3;');
  assert.equal((await f.runtime.check('test', signal())).status, 'failed');
  assert.deepEqual(journal.get(request.id).delivery.checkpoints, [checkpoint]);
  assert.equal(journal.get(request.id).delivery.review, undefined, 'A committed checkpoint does not confer verification.');
  const revision = journal.get(request.id).revision;
  await retainDeliveryCheckpoint(host, task, f.runtime, signal());
  assert.equal(journal.get(request.id).revision, revision, 'Repeated observation does not append checkpoint events.');
  journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: run.id, stepId: 'verification', phase: 'verifying' });
  journal.deliveryUpdate(request.id, { action: 'stopped', deliveryRunId: run.id, confirmed: false });
  let inspected = 0;
  await retainDeliveryCheckpoint(host, task, { ...f.runtime, async capture() { inspected++; throw Error('Uncertain source must not be inspected.'); } }, signal());
  assert.equal(inspected, 0); assert.equal(journal.get(request.id).delivery.checkpoints.length, 1);
});
