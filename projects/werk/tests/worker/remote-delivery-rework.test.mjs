import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { createRemoteDeliveryGit } from '../../src/worker/dist/worker/infrastructure/remote-delivery-git.js';
import { createGitHubPublication } from '../../src/worker/dist/worker/infrastructure/remote-delivery-github.js';
import { FeatureGitIo } from '../../src/worker/dist/worker/infrastructure/features/git-io.js';
import { candidatePublicationMarker, publicationMarker, runRemotePublication } from '../../src/worker/dist/worker/application/remote-delivery-runtime.js';
import { reviewReworkInput } from '../../src/worker/dist/worker/application/remote-delivery-rework.js';
import { remotePublicationBranch } from '../../src/worker/dist/worker/application/remote-delivery-contracts.js';
import { validateRemoteDeliveryPolicy } from '../../src/worker/dist/worker/application/remote-delivery-policy.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { publication, target, readyPublication, publicationCommand } from './remote-delivery-fixtures.mjs';
import { fixture } from './request-gate-fixtures.mjs';
import { cleanup } from './fixture-cleanup.mjs';

prepareNativeProcessFixture();
const signal = () => new AbortController().signal;
const pr = { number: 17, url: 'https://github.com/example/project/pull/17', state: /** @type {const} */ ('open') };
function revisedPublication() {
  const original = publication('pull_request'), item = structuredClone(original);
  item.candidate = { ...item.candidate, candidateCommit: '9'.repeat(40), branch: 'werk/delivery/reworked', runId: 'delivery-two' };
  item.predecessor = { candidate: original.candidate, branch: original.candidate.branch, pullRequest: pr };
  return item;
}

test('automatic publication is an explicit policy choice without changing legacy canonical values', () => {
  assert.deepEqual(validateRemoteDeliveryPolicy(target), target);
  assert.equal(validateRemoteDeliveryPolicy({ ...target, automatic: true }).automatic, true);
  assert.throws(() => validateRemoteDeliveryPolicy({ ...target, automatic: 'true' }));
  assert.throws(() => validateRemoteDeliveryPolicy({ ...target, automatic: true, pullRequest: false }));
});

test('rework uses the retained branch, exact old head and same PR; lost acknowledgements reconcile without another mutation', async () => {
  const item = revisedPublication(), calls = [];
  let head = item.predecessor.candidate.candidateCommit, evidenceUpdated = false;
  /** @type {import('../../src/worker/application/remote-delivery-contracts.ts').RemoteDeliveryPort} */
  const port = {
    async verify() { calls.push('verify'); },
    async branch(_target, branch) { assert.equal(branch, item.predecessor.branch); return head; },
    async push(_target, candidate, _signal, previous) { assert.deepEqual(previous, { branch: item.predecessor.branch, commit: head }); head = candidate.candidateCommit; calls.push('push'); throw Error('Lost push acknowledgement'); },
    async findPullRequest(value, _signal, previousEvidence) {
      assert.equal(remotePublicationBranch(value), item.predecessor.branch);
      if (value.candidate.candidateCommit === item.predecessor.candidate.candidateCommit || previousEvidence || evidenceUpdated) return pr;
      throw Error('Current evidence not observed');
    },
    async createPullRequest() { throw Error('Must never create another PR'); },
    async updatePullRequest() { calls.push('update'); evidenceUpdated = true; throw Error('Lost update acknowledgement'); },
  };
  const authority = { authorize() {} };
  const run = mode => runRemotePublication({ publication: item, mode, title: 'Reworked candidate', body: 'New quality evidence.', port, authority, signal: signal() });
  item.action = 'push';
  const pushed = await run('execute'); assert.equal(pushed.status, 'confirmed'); assert.equal(pushed.observation.branch, item.predecessor.branch);
  await run('reconcile'); assert.equal(calls.filter(call => call === 'push').length, 1);
  item.action = 'pull_request';
  const updated = await run('execute'); assert.equal(updated.status, 'confirmed'); assert.equal(updated.observation.pullRequest.number, 17);
  await run('reconcile'); assert.equal(calls.filter(call => call === 'update').length, 1);
  assert.equal(item.candidate.branch, 'werk/delivery/reworked', 'Local candidate identity is never rewritten to the remote destination branch');
});

test('rework never recreates missing refs or updates a closed, foreign or raced PR branch', async () => {
  const item = revisedPublication(); item.action = 'push';
  for (const current of [null, 'f'.repeat(40), item.predecessor.candidate.candidateCommit]) {
    let mutations = 0;
    const result = await runRemotePublication({ publication: item, mode: 'execute', title: 'Rework', body: 'Review.', signal: signal(), authority: { authorize() {} },
      port: { async verify() {}, async branch() { return current; }, async push() { mutations++; }, async findPullRequest() { return { ...pr, state: 'closed' }; }, async createPullRequest() { mutations++; } } });
    assert.equal(result.status, 'failed'); assert.equal(mutations, 0);
  }
});

test('Git rework compare-and-swap preserves a concurrent branch update and the developer checkout', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-rework-'))), repository = join(directory, 'repo'), remote = join(directory, 'remote.git');
  cleanup(t, () => rm(directory, { recursive: true, force: true })); await mkdir(repository); await mkdir(remote);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(remote, 'init', '--bare'); git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'value.txt'), 'old'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Old candidate');
  const old = git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'value.txt'), 'new'); git(repository, 'commit', '-am', 'New candidate'); const current = git(repository, 'rev-parse', 'HEAD');
  const io = new FeatureGitIo({ repository, stateDirectory: join(directory, 'state'), remote: 'origin' }), output = io.output.bind(io);
  io.output = (cwd, args, abort, input) => args[0] === 'remote' ? Promise.resolve('https://github.com/example/project.git\n') : output(cwd, args.map(arg => arg === 'https://github.com/example/project.git' ? remote : arg), abort, input);
  const adapter = createRemoteDeliveryGit({ repository, stateDirectory: join(directory, 'state') }, io), item = revisedPublication();
  const candidate = { ...item.candidate, candidateCommit: current }, branch = item.predecessor.branch;
  git(repository, 'push', remote, `${old}:refs/heads/${branch}`);
  await writeFile(join(repository, 'value.txt'), 'developer changes'); const before = git(repository, 'status', '--porcelain=v1');
  await adapter.push(target, candidate, signal(), { branch, commit: old });
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), current);
  await assert.rejects(adapter.push(target, { ...candidate, candidateCommit: old }, signal(), { branch, commit: old }));
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), current); assert.equal(git(repository, 'status', '--porcelain=v1'), before);
});

test('GitHub rework updates the exact retained PR only after verifying its current head and old evidence', async () => {
  const item = revisedPublication(), calls = [];
  const response = { number: 17, html_url: pr.url, state: 'open', merged_at: null,
    head: { ref: item.predecessor.branch, sha: item.candidate.candidateCommit, repo: { full_name: target.repository } },
    base: { ref: target.base, repo: { full_name: target.repository } }, body: candidatePublicationMarker({ candidate: item.predecessor.candidate, target }) };
  const adapter = createGitHubPublication({ cwd: process.cwd(), executable: process.execPath }, async (_executable, args, options) => {
    calls.push(args);
    if (args[4] === 'PATCH') { response.body = JSON.parse(String(options.input)).body; return { exitCode: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) }; }
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify([response])), stderr: Buffer.alloc(0) };
  });
  assert.equal(await adapter.findPullRequest(item, signal()), null, 'Old evidence permits an explicit retry without claiming current candidate publication');
  assert.equal((await adapter.findPullRequest(item, signal(), true)).number, 17);
  await adapter.updatePullRequest(item, 'Reworked request', 'New evidence', signal());
  assert.match(response.body, /New evidence/); assert.ok(response.body.includes(publicationMarker(item)));
  assert.equal((await adapter.findPullRequest(item, signal())).number, 17);
  assert.equal(calls.filter(args => args[4] === 'PATCH').length, 1);
  assert.ok(calls.some(args => args[5] === 'repos/example/project/pulls/17'));
  await assert.rejects(adapter.createPullRequest(item, 'Duplicate', 'Wrong', signal()), /retained pull request/);
});

/** @param {import('../../src/worker/application/journal-ports.ts').RequestJournal} journal
 * @param {import('../../src/worker/application/request-gates.ts').WorkerRequest} request */
function finishRework(journal, request) {
  journal.evaluate(request.id, 'ready'); journal.bindTurn(request.id, 'turn-rework');
  const prepared = journal.prepareExecution(request.id, 'turn-rework', 'invocation-rework');
  const candidate = { ...request.deliveryHistory.at(-1).review.candidate, inputRevision: prepared.inputRevision, inputHash: prepared.inputHash, runId: prepared.delivery.id,
    branch: 'werk/delivery/new-attempt', candidateCommit: '9'.repeat(40), candidateDigest: 'f'.repeat(64) };
  journal.deliveryUpdate(request.id, { action: 'review', deliveryRunId: candidate.runId, review: { ...request.deliveryHistory.at(-1).review, candidate } });
  journal.deliveryUpdate(request.id, { action: 'start', deliveryRunId: candidate.runId, stepId: 'new-package', phase: 'packaging' });
  journal.deliveryUpdate(request.id, { action: 'finish', deliveryRunId: candidate.runId, stepId: 'new-package', status: 'completed' });
  journal.startExecution(request.id, 'turn-rework', 'invocation-rework');
  return journal.recordResult(request.id, 'turn-rework', 'invocation-rework', { type: 'completed', text: 'Reworked.' },
    { 'output.nonEmpty': true, 'output.protocolValid': true, 'output.patchPresent': true, 'output.verificationPassed': true, 'output.requiredCheckCount': 1, 'output.candidateDigest': candidate.candidateDigest });
}

test('journal freezes predecessor authority across rework, restart and lost acknowledgements without inheriting acceptance', async t => {
  const { journal, directory } = await fixture(t); let request = readyPublication(journal);
  const original = structuredClone(request.delivery.review.candidate);
  for (const action of /** @type {const} */ (['push_candidate', 'create_pull_request'])) {
    const operationId = 'first-' + action;
    request = journal.command(publicationCommand(request, action, operationId)).request;
    request = journal.deliveryUpdate(request.id, { action: 'publication_result', deliveryRunId: request.delivery.id, operationId,
      result: { status: 'confirmed', detail: 'Fixture remote confirmation.', observation: { branch: original.branch, commit: original.candidateCommit, ...(action === 'create_pull_request' ? { pullRequest: pr } : {}) } } });
  }
  const feedback = { action: /** @type {const} */ ('request_changes'), requestId: request.id, expectedRevision: request.revision, operationId: 'review-feedback',
    inputRevision: request.inputRevision, candidateCommit: original.candidateCommit, candidateDigest: original.candidateDigest, note: 'Adjust the visible value.' };
  request = journal.command(feedback).request;
  assert.throws(() => reviewReworkInput(request, { ...feedback, candidateDigest: '0'.repeat(64) }), /exact saved/);
  const rework = reviewReworkInput(request, feedback);
  assert.deepEqual(rework.context, request.input.context); assert.deepEqual(rework.files, request.input.files); assert.deepEqual(rework.criteria, request.input.criteria);
  request = journal.reviseInput(request.id, rework);
  assert.equal(reviewReworkInput(request, feedback), null);
  assert.equal(journal.command(feedback).duplicate, true);
  assert.equal(request.attestation, null); assert.equal(request.deliveryHistory.at(-1).publications.length, 2);
  request = finishRework(journal, request);
  const command = publicationCommand(request, 'push_candidate', 'push-rework');
  request = journal.command(command).request;
  const saved = request.delivery.publications[0];
  assert.equal(saved.predecessor.pullRequest.number, 17); assert.equal(saved.predecessor.branch, original.branch);
  assert.equal(saved.predecessor.candidate.candidateCommit, original.candidateCommit);
  journal.close(); const recovered = new WorkerRequestJournal(directory); await recovered.init(); cleanup(t, () => recovered.close());
  request = recovered.get(request.id); assert.equal(request.delivery.publications[0].status, 'unknown');
  assert.equal(recovered.command(command).duplicate, true);
  request = recovered.command({ ...publicationCommand(request, 'reconcile_publication', 'reconcile-rework'), publicationOperationId: 'push-rework' }).request;
  request = recovered.deliveryUpdate(request.id, { action: 'publication_result', deliveryRunId: request.delivery.id, operationId: 'push-rework',
    result: { status: 'confirmed', detail: 'Observed retained branch new head.', observation: { branch: original.branch, commit: request.delivery.review.candidate.candidateCommit } } });
  assert.equal(request.attestation, null); assert.equal(request.phase, 'review');
  assert.deepEqual(request.deliveryHistory.at(-1).review.candidate, original);
  request = recovered.command(publicationCommand(request, 'create_pull_request', 'update-retained-pr')).request;
  assert.throws(() => recovered.deliveryUpdate(request.id, { action: 'publication_result', deliveryRunId: request.delivery.id, operationId: 'update-retained-pr',
    result: { status: 'confirmed', detail: 'Wrong PR must not satisfy rework.', observation: { branch: original.branch, commit: request.delivery.review.candidate.candidateCommit,
      pullRequest: { number: 18, url: 'https://github.com/example/project/pull/18', state: 'open' } } } }), /exact GitHub/);
});
