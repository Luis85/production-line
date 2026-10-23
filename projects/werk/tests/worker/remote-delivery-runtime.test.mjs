import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemotePublication } from '../../src/worker/dist/worker/application/remote-delivery-runtime.js';
import { validateRemoteDeliveryPolicy } from '../../src/worker/dist/worker/application/remote-delivery-policy.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, validateDeliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { publication, target } from './remote-delivery-fixtures.mjs';

/** @param {'push'|'pull_request'} [action] */
function harness(action = 'push') {
  const item = publication(action), calls = [];
  /** @type {string|null} */ let branch = action === 'pull_request' ? item.candidate.candidateCommit : null;
  /** @type {import('../../src/worker/application/remote-delivery-contracts.ts').RemotePublicationObservation['pullRequest']|null} */ let pr = null;
  /** @type {import('../../src/worker/application/remote-delivery-contracts.ts').RemoteDeliveryPort} */
  const port = { async verify() { calls.push('verify'); }, async branch() { calls.push('branch'); return branch; },
    async push() { calls.push('push'); branch = item.candidate.candidateCommit; }, async findPullRequest() { calls.push('find'); return pr; },
    async createPullRequest() { calls.push('create'); pr = { number: 17, url: 'https://github.com/example/project/pull/17', state: 'open' }; } };
  /** @type {import('../../src/worker/application/remote-delivery-contracts.ts').RemotePublicationAuthorization} */
  const authority = { authorize(repositoryId, digest, mutation) { assert.equal(repositoryId, item.repositoryId); assert.equal(digest, item.configurationDigest); calls.push(mutation ? 'authorize-mutation' : 'authorize'); } };
  /** @param {'execute'|'reconcile'} [mode] */
  const run = (mode = 'execute') => runRemotePublication({ publication: item, mode, title: 'Candidate', body: 'Inspect this candidate.', port, authority, signal: new AbortController().signal });
  return { item, calls, port, authority, run, setBranch(value) { branch = value; } };
}

test('remote policy is explicit and old snapshots keep absent remote configuration and digest', () => {
  const policy = defaultDeliveryProjectPolicy(), snapshot = deliveryPolicySnapshot(policy, '1'.repeat(40));
  assert.equal(Object.hasOwn(snapshot.configuration, 'remoteDelivery'), false);
  assert.deepEqual(validateDeliveryPolicySnapshot(snapshot), snapshot);
  assert.deepEqual(validateRemoteDeliveryPolicy(target), target);
  for (const change of [{ remote: '-upload-pack' }, { repository: 'https://github.com/example/project' }, { repository: 'example/project.git' },
    { base: '../main' }, { base: 'main.lock' }, { push: false }, { push: 'true' }, { draft: undefined }, { unsupported: true }]) {
    assert.throws(() => validateRemoteDeliveryPolicy({ ...target, ...change }));
  }
});

test('a lost push acknowledgement is confirmed by observation without duplicate mutation', async () => {
  const h = harness(), push = h.port.push;
  h.port.push = async (...args) => { await push(...args); throw Error('Lost acknowledgement with private token=secret'); };
  const result = await h.run();
  assert.equal(result.status, 'confirmed'); assert.equal(result.observation.commit, h.item.candidate.candidateCommit);
  assert.equal(h.calls.filter(call => call === 'push').length, 1);
  assert.equal(h.calls.filter(call => call === 'branch').length, 2);
  assert.equal(h.calls.includes('create'), false); assert.equal(result.observation.pullRequest, undefined);
  assert.equal((await h.run()).status, 'confirmed');
  assert.equal(h.calls.filter(call => call === 'push').length, 1);
});

test('a lost PR acknowledgement is reconciled and existing closed or merged PRs are never recreated', async () => {
  const h = harness('pull_request'), create = h.port.createPullRequest;
  h.port.createPullRequest = async (...args) => { await create(...args); throw Error('Acknowledgement lost.'); };
  assert.equal((await h.run()).observation.pullRequest.number, 17);
  assert.equal(h.calls.filter(call => call === 'create').length, 1);
  for (const state of /** @type {const} */ (['closed', 'merged'])) {
    h.port.findPullRequest = async () => ({ number: 17, url: 'https://github.com/example/project/pull/17', state });
    assert.equal((await h.run()).observation.pullRequest.state, state);
  }
  assert.equal(h.calls.filter(call => call === 'create').length, 1); assert.equal(h.calls.includes('push'), false);
});

test('reconciliation observes only and never verifies disturbed local candidate or repeats a mutation', async () => {
  for (const action of /** @type {const} */ (['push', 'pull_request'])) {
    const h = harness(action);
    h.port.verify = async () => { throw Error('Local branch disturbed after publication.'); };
    const result = await h.run('reconcile');
    assert.equal(result.status, 'not_observed');
    assert.equal(h.calls.some(call => ['verify', 'push', 'create'].includes(call)), false);
  }
});

test('divergent remote refs, unknown observations, and revoked policy cannot trigger a mutation', async () => {
  const changed = harness(); changed.setBranch('f'.repeat(40));
  assert.equal((await changed.run()).status, 'failed'); assert.equal(changed.calls.includes('push'), false);
  const unavailable = harness(); unavailable.port.branch = async () => { throw Error('https://secret@host/private'); };
  const unknown = await unavailable.run(); assert.equal(unknown.status, 'unknown'); assert.doesNotMatch(unknown.detail, /secret|host\/private/);
  assert.equal(unavailable.calls.includes('push'), false);
  const revoked = harness(); revoked.authority.authorize = (_id, _digest, mutation) => { if (mutation) throw new DomainError('conflict', 'Policy approval was revoked.'); };
  assert.equal((await revoked.run()).status, 'unknown'); assert.equal(revoked.calls.includes('push'), false);
});

test('an unknown post-mutation response requires read-only recovery and never claims acceptance', async () => {
  const h = harness(), branch = h.port.branch; let observations = 0;
  h.port.branch = async (...args) => { if (++observations === 2) throw Error('Connection dropped'); return branch(...args); };
  assert.equal((await h.run()).status, 'unknown');
  const recovered = await h.run('reconcile'); assert.equal(recovered.status, 'confirmed');
  assert.equal(h.calls.filter(call => call === 'push').length, 1);
  assert.match(recovered.detail, /No pull request, human acceptance or merge is implied/);
});
