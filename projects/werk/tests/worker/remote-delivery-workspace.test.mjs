import test from 'node:test';
import assert from 'node:assert/strict';
import { publishRequest, closePublications } from '../../src/worker/dist/worker/status/workspace-publication.js';
import { fixture } from './request-gate-fixtures.mjs';
import { readyPublication, publicationCommand } from './remote-delivery-fixtures.mjs';

/** Bounded composition fixture: real durable journal, injected repository/model boundaries.
 * @param {import('node:test').TestContext} t */
async function harness(t) {
  const { journal, directory } = await fixture(t), initial = readyPublication(journal), calls = [];
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    sessions: { requests: journal }, config: { stateDir: directory }, repositoryStop: new AbortController(),
    board: { async verifyDelivery(requestId, revision) { assert.equal(requestId, initial.id); assert.equal(revision, journal.get(initial.id).revision); calls.push('verify-current-worktree'); },
      executionDetail() { return { requestId: initial.id, repositoryId: 'repo-one', repository: process.cwd() }; } },
  }));
  /** @type {string|null} */ let branch = null;
  /** @type {import('../../src/worker/application/remote-delivery-contracts.ts').RemoteDeliveryPort} */
  const port = { async verify() { calls.push('verify-immutable-candidate'); }, async branch() { calls.push('observe-branch'); return branch; },
    async push(_target, candidate) {
      const retained = journal.get(initial.id).delivery.publications;
      assert.equal(retained.length, 1); assert.equal(retained[0].status, 'pending'); assert.equal(retained[0].candidate.candidateCommit, candidate.candidateCommit);
      calls.push('push'); branch = candidate.candidateCommit;
    }, async findPullRequest() { throw Error('Unexpected PR lookup'); }, async createPullRequest() { throw Error('Unexpected PR create'); } };
  /** @type {import('../../src/worker/application/remote-delivery-contracts.ts').RemotePublicationAuthorization} */
  const authority = { authorize(id, digest, mutation) { assert.equal(id, 'repo-one'); assert.match(digest, /^[a-f0-9]{64}$/); calls.push(mutation ? 'authorize-mutation' : 'authorize'); } };
  return { journal, initial, workspace, port, authority, calls };
}

test('composed publication persists intent before network and exact replay cannot repeat push', async t => {
  const h = await harness(t), command = publicationCommand(h.initial, 'push_candidate', 'composed-push');
  const first = await publishRequest(h.workspace, command, h);
  assert.equal(first.request.delivery.publications[0].status, 'confirmed'); assert.equal(first.request.attestation, null);
  assert.equal((await publishRequest(h.workspace, command, h)).duplicate, true);
  assert.equal(h.calls.filter(call => call === 'push').length, 1);
  await closePublications(h.workspace);
});

test('one active remote operation owns the request and shutdown drains its durable unknown result', async t => {
  const h = await harness(t), command = publicationCommand(h.initial, 'push_candidate', 'shutdown-push');
  const { promise: started, resolve: entered } = Promise.withResolvers();
  const { promise: released, resolve: finish } = Promise.withResolvers();
  h.port.push = async () => { entered(undefined); await released; };
  const pending = publishRequest(h.workspace, command, h); await started;
  await assert.rejects(publishRequest(h.workspace, { ...command, operationId: 'overlapping' }, h), /active remote observation/);
  h.workspace.repositoryStop.abort();
  let drained = false; const close = closePublications(h.workspace).then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  finish(undefined); const result = await pending; await close;
  assert.equal(drained, true); assert.equal(result.request.delivery.publications.length, 1); assert.equal(result.request.delivery.publications[0].status, 'unknown');
});

test('cancellation recorded during observation prevents the following remote mutation', async t => {
  const h = await harness(t), command = publicationCommand(h.initial, 'push_candidate', 'cancel-before-push');
  h.port.branch = async () => {
    const current = h.journal.get(h.initial.id);
    h.journal.command({ action: 'cancel', requestId: current.id, expectedRevision: current.revision, operationId: 'operator-cancel', deliveryRunId: current.delivery.id, inputRevision: current.inputRevision });
    return null;
  };
  const result = await publishRequest(h.workspace, command, h);
  assert.equal(result.request.delivery.publications[0].status, 'unknown'); assert.match(result.request.delivery.publications[0].detail, /cancellation/);
  assert.equal(h.calls.includes('push'), false); assert.equal(result.request.attestation, null);
});
