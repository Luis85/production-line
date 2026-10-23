import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, provider } from './request-gate-fixtures.mjs';
import { readyPublication, publicationCommand } from './remote-delivery-fixtures.mjs';
import { runRemotePublication, publicationMarker } from '../../src/worker/dist/worker/application/remote-delivery-runtime.js';
import { createGitHubPublication } from '../../src/worker/dist/worker/infrastructure/remote-delivery-github.js';
import { buildDeliveryMetrics } from '../../src/worker/dist/worker/application/delivery-metrics.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
const signal = () => new AbortController().signal;
/** @param {import('../../src/worker/application/journal-ports').RequestJournal} journal @param {string} id */
function report(journal, id) { return buildDeliveryMetrics({ requests: [journal.get(id)], events: journal.events(id).events, runs: [], completeRequestIds: [id] }); }
/** @param {import('../../src/worker/application/journal-ports').RequestJournal} journal @param {import('../../src/worker/application/request-gates').WorkerRequest} request @param {string} operationId @param {import('../../src/worker/application/remote-delivery-contracts').RemotePublicationResult} result */
function save(journal, request, operationId, result) { return journal.deliveryUpdate(request.id, { action: 'publication_result', deliveryRunId: request.delivery.id, operationId, result }); }

 test('lost remote acknowledgement recovers through correlated read-only evidence without a second push', async t => {
  const { journal } = await fixture(t); let current = readyPublication(journal), branch = null, pushes = 0, unavailable = false;
  current = journal.command(publicationCommand(current, 'push_candidate', 'lost-push')).request;
  const intended = current.delivery.publications[0];
  /** @type {import('../../src/worker/application/remote-delivery-contracts').RemoteDeliveryPort} */
  const port = { async verify() {}, async branch() { if (unavailable) throw Error('Connection lost.'); return branch; },
    async push() { pushes++; branch = intended.candidate.candidateCommit; unavailable = true; throw Error('Acknowledgement lost.'); },
    async findPullRequest() { return null; }, async createPullRequest() { assert.fail('A push cannot create a PR.'); } };
  const first = await runRemotePublication({ publication: intended, mode: 'execute', title: '', body: '', port, authority: { authorize() {} }, signal: signal() });
  assert.equal(first.status, 'unknown'); current = save(journal, current, intended.operationId, first);
  assert.equal(report(journal, current.id).recovery.unknown, 1);
  unavailable = false;
  current = journal.command({ ...publicationCommand(current, 'reconcile_publication', 'read-only-recovery'), publicationOperationId: intended.operationId }).request;
  const recovered = await runRemotePublication({ publication: current.delivery.publications[0], mode: 'reconcile', title: '', body: '', port, authority: { authorize() {} }, signal: signal() });
  assert.equal(recovered.recoveryEvidence, 'single_remote_ref'); current = save(journal, current, intended.operationId, recovered);
  assert.equal(pushes, 1); assert.equal(report(journal, current.id).recovery.percent, 100);
  assert.equal(report(journal, current.id).integrity.incidents, 0); assert.equal(report(journal, current.id).integrity.auditedRequests, 0, 'No unaudited zero-incident guarantee is manufactured.');
  const count = journal.events(current.id).events.length; save(journal, current, intended.operationId, recovered); assert.equal(journal.events(current.id).events.length, count);
});

test('distinct observed candidate-marked PRs emit one actual incident; blocked replays and duplicate response rows do not', async t => {
  const { journal } = await fixture(t); let current = readyPublication(journal);
  const push = publicationCommand(current, 'push_candidate', 'push'); current = journal.command(push).request; assert.equal(journal.command(push).duplicate, true);
  assert.equal(report(journal, current.id).integrity.incidents, 0);
  current = save(journal, current, 'push', { status: 'confirmed', detail: 'Exact branch observed.', observation: { branch: current.delivery.review.candidate.branch, commit: current.delivery.review.candidate.candidateCommit } });
  current = journal.command(publicationCommand(current, 'create_pull_request', 'pr')).request;
  const intended = current.delivery.publications.find(item => item.operationId === 'pr');
  const row = number => ({ number, html_url: `https://github.com/example/project/pull/${number}`, state: 'open', merged_at: null,
    head: { ref: intended.candidate.branch, sha: intended.candidate.candidateCommit, repo: { full_name: intended.target.repository } },
    base: { ref: intended.target.base, repo: { full_name: intended.target.repository } }, body: publicationMarker(intended) });
  let response = [row(17), row(17)], creates = 0;
  const github = createGitHubPublication({ cwd: process.cwd(), executable: process.execPath }, async () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.alloc(0) }));
  const port = { verify: async () => {}, branch: async () => intended.candidate.candidateCommit, push: async () => { assert.fail('No push during PR reconciliation.'); }, findPullRequest: github.findPullRequest, createPullRequest: async () => { creates++; } };
  const run = () => runRemotePublication({ publication: intended, mode: 'reconcile', title: '', body: '', port, authority: { authorize() {} }, signal: signal() });
  const repeatedRow = await run(); assert.equal(repeatedRow.integrityIncident, undefined, 'A malformed duplicate list row is not proof of two PR side effects.');
  response = [row(17), row(18)]; const duplicate = await run(); assert.equal(duplicate.integrityIncident, 'duplicate_publication');
  current = save(journal, current, 'pr', duplicate);
  for (let attempt = 0; attempt < 2; attempt++) {
    current = journal.command({ ...publicationCommand(current, 'reconcile_publication', 'inspect-' + attempt), publicationOperationId: 'pr' }).request;
    current = save(journal, current, 'pr', duplicate);
  }
  assert.equal(report(journal, current.id).integrity.incidents, 1); assert.equal(report(journal, current.id).recovery.percent, 0); assert.equal(creates, 0);
  response = [row(17)]; current = journal.command({ ...publicationCommand(current, 'reconcile_publication', 'inspect-resolved'), publicationOperationId: 'pr' }).request;
  current = save(journal, current, 'pr', await run());
  assert.equal(report(journal, current.id).recovery.percent, 0, 'Resolving duplicates cannot erase the observed integrity failure.');
});

test('local interruption and operator stop confirmation never invent certainty about unrecorded side effects', async t => {
  const { journal } = await fixture(t), policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  let current = journal.ensure({ owner: { sessionId: 'local', rootTurnId: 'turn', taskId: 'task' }, provider, policy,
    input: { kind: 'patch', title: 'Local interruption', message: 'Implement the accepted behavior.', criteria: ['Visible behavior works.'], files: [{ path: 'source', bytes: 1 }], context: { implementation: { mode: 'development' } } } });
  journal.evaluate(current.id, 'ready'); journal.bindTurn(current.id, 'turn'); current = journal.prepareExecution(current.id, 'turn', 'run');
  current = journal.deliveryUpdate(current.id, { action: 'start', deliveryRunId: current.delivery.id, stepId: 'implement', phase: 'implementing', invocationRunId: 'run' });
  current = journal.command({ action: 'interrupt', operationId: 'stop', requestId: current.id, expectedRevision: current.revision, deliveryRunId: current.delivery.id, inputRevision: current.inputRevision }).request;
  current = journal.deliveryUpdate(current.id, { action: 'stopped', deliveryRunId: current.delivery.id, confirmed: false });
  let observations = journal.events(current.id).events.flatMap(event => event.measurement?.observations ?? []);
  assert.deepEqual(observations.filter(item => item.kind === 'recovery').at(-1), { kind: 'recovery', operationId: 'stop', outcome: 'unknown', duplicateActions: null });
  current = journal.command({ action: 'confirm_stopped', operationId: 'inspected', requestId: current.id, expectedRevision: current.revision, deliveryRunId: current.delivery.id, inputRevision: current.inputRevision, note: 'Inspected and stopped the owned process.' },
    { requestRevision: current.revision, deliveryRunId: current.delivery.id, inputRevision: current.inputRevision, candidateDigest: 'a'.repeat(64), observedAt: new Date().toISOString() }).request;
  observations = journal.events(current.id).events.flatMap(event => event.measurement?.observations ?? []);
  assert.deepEqual(observations.filter(item => item.kind === 'recovery').at(-1), { kind: 'recovery', operationId: 'stop', outcome: 'unknown', duplicateActions: null });
  assert.equal(report(journal, current.id).recovery.percent, null); assert.equal(report(journal, current.id).recovery.unknown, 1);
});
