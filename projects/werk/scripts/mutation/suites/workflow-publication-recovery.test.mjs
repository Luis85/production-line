import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemotePublication } from '../../../.mutation-build/worker/application/remote-delivery-runtime.js';
import { requestPublicationResult } from '../../../.mutation-build/worker/infrastructure/journal/requests/publication.js';
import { acceptedRequest, publication } from './workflow-fixture.mjs';

/** @param {'push'|'pull_request'} [action] */
function fixture(action = 'push') {
  const saved = publication(), calls = [], mutations = [];
  saved.action = action; saved.status = 'pending'; delete saved.observation;
  const prior = publication(); saved.predecessor = { candidate: prior.candidate, branch: prior.candidate.branch, pullRequest: prior.observation.pullRequest };
  saved.candidate = { ...saved.candidate, branch: 'werk/delivery/revised', candidateCommit: '4'.repeat(40) };
  let branch = action === 'push' ? prior.candidate.candidateCommit : saved.candidate.candidateCommit;
  let pull = structuredClone(prior.observation.pullRequest);
  /** @type {import('../../../src/worker/application/remote-delivery-contracts.ts').RemoteDeliveryPort} */
  const port = {
    async verify() { calls.push('verify'); }, async branch() { calls.push('branch'); return branch; },
    async push(_target, _candidate, _signal, previous) { calls.push('push'); assert.deepEqual(previous, { branch: prior.candidate.branch, commit: prior.candidate.candidateCommit }); branch = saved.candidate.candidateCommit; },
    async findPullRequest(value, _signal, previous) { calls.push(previous ? 'find-previous' : 'find'); if (action === 'push') assert.equal(value.candidate.candidateCommit, prior.candidate.candidateCommit); return pull; },
    async updatePullRequest() { calls.push('update'); }, async createPullRequest() { calls.push('create'); },
  };
  /** @param {'execute'|'reconcile'} [mode] */
  const run = (mode = 'execute') => runRemotePublication({ publication: saved, mode, port, authority: { authorize(_id, _digest, mutation) { mutations.push(mutation); } }, title: 'Rework', body: 'Exact revised evidence', signal: new AbortController().signal });
  return { saved, calls, mutations, port, run, setBranch(value) { branch = value; }, setPull(value) { pull = value; } };
}

test('retained PR branch updates require its exact old head and same open PR before the only CAS mutation', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.status, 'confirmed'); assert.equal(result.observation.branch, f.saved.predecessor.branch);
  assert.deepEqual(f.calls, ['verify', 'branch', 'find', 'push', 'branch']); assert.deepEqual(f.mutations, [false, false, false, true, false]);
  for (const change of [h => h.setBranch(null), h => h.setBranch('f'.repeat(40)), h => h.setPull(null), h => h.setPull({ ...h.saved.predecessor.pullRequest, number: 99 }), h => h.setPull({ ...h.saved.predecessor.pullRequest, state: 'closed' })]) {
    const h = fixture(); change(h); assert.equal((await h.run()).status, 'failed'); assert.equal(h.calls.includes('push'), false); assert.equal(h.mutations.includes(true), false);
  }
  for (const after of [null, '2'.repeat(40), 'f'.repeat(40)]) {
    const h = fixture(); h.port.push = async () => { h.calls.push('push'); h.setBranch(after); throw Error('Unknown push acknowledgement'); };
    const result = await h.run(); assert.equal(result.status, after === 'f'.repeat(40) ? 'failed' : 'not_observed'); assert.equal(h.calls.filter(value => value === 'push').length, 1);
  }
});

test('same PR evidence updates reconcile after lost acknowledgements without creating a replacement PR', async () => {
  const f = fixture('pull_request'); f.port.updatePullRequest = async () => { f.calls.push('update'); throw Error('Lost acknowledgement'); };
  assert.equal((await f.run()).status, 'confirmed'); assert.deepEqual(f.calls, ['verify', 'branch', 'find-previous', 'update', 'find']); assert.equal(f.mutations.filter(Boolean).length, 1);
  const recovered = fixture('pull_request'); assert.equal((await recovered.run('reconcile')).status, 'confirmed'); assert.deepEqual(recovered.calls, ['branch', 'find']); assert.equal(recovered.mutations.includes(true), false);
  for (const change of [h => h.setPull(null), h => h.setPull({ ...h.saved.predecessor.pullRequest, number: 99 }), h => h.setPull({ ...h.saved.predecessor.pullRequest, state: 'closed' }), h => { delete h.port.updatePullRequest; }]) {
    const h = fixture('pull_request'); change(h); assert.ok(['unknown', 'not_observed'].includes((await h.run()).status)); assert.equal(h.calls.includes('create'), false); assert.equal(h.calls.includes('update'), false);
  }
  const invisible = fixture('pull_request'); invisible.port.updatePullRequest = async () => { invisible.calls.push('update'); invisible.setPull(null); };
  assert.equal((await invisible.run()).status, 'not_observed'); assert.equal(invisible.calls.includes('create'), false);
});

function journalFixture() {
  const request = acceptedRequest(), saved = publication(), prior = publication(), saves = [];
  saved.status = 'pending'; delete saved.observation;
  saved.predecessor = { candidate: prior.candidate, branch: prior.candidate.branch, pullRequest: prior.observation.pullRequest };
  saved.candidate = { ...saved.candidate, branch: 'werk/delivery/revised', candidateCommit: '4'.repeat(40) };
  request.delivery.publications = [saved];
  const result = { status: 'confirmed', detail: 'Confirmed exact retained PR.', recoveryEvidence: 'complete_pull_request_lookup', observation: { branch: saved.predecessor.branch, commit: saved.candidate.candidateCommit, pullRequest: structuredClone(saved.predecessor.pullRequest) } };
  const store = /** @type {import('../../../src/worker/infrastructure/journal/requests/store.ts').RequestStore} */ (/** @type {unknown} */ ({ save(_request, event, metadata) { saves.push({ event, metadata }); } }));
  const apply = value => requestPublicationResult(store, request, { action: 'publication_result', deliveryRunId: request.delivery.id, operationId: saved.operationId, result: value });
  return { request, saved, result, saves, apply };
}

test('journal confirmation binds retained PR number, exact destination and immutable successful observation', () => {
  for (const corrupt of [value => { value.observation.pullRequest.number = 18; value.observation.pullRequest.url = 'https://github.com/example/project/pull/18'; }, value => { value.observation.pullRequest.number = 0; }, value => { value.observation.pullRequest.number = 1.5; }, value => { value.observation.pullRequest.state = 'unknown'; }, value => { value.observation.pullRequest.url = 'https://github.com/foreign/project/pull/17'; }, value => { delete value.observation.pullRequest; }, value => { value.observation.branch = 'werk/delivery/revised'; }, value => { value.observation.commit = 'f'.repeat(40); }]) {
    const h = journalFixture(); corrupt(h.result); assert.throws(() => h.apply(h.result), { code: 'conflict' }); assert.equal(h.saves.length, 0);
  }
  const h = journalFixture(); h.apply(h.result); assert.equal(h.saves.length, 1); assert.notEqual(h.saved.observation, h.result.observation);
  h.apply(h.result); assert.equal(h.saves.length, 1, 'Exact replay is idempotent');
  const changed = structuredClone(h.result); changed.observation.pullRequest.state = 'closed'; assert.throws(() => h.apply(changed), { code: 'conflict' });
  h.result.observation.pullRequest.number = 99; assert.equal(h.saved.observation.pullRequest.number, 17);
});

test('unknown reconciliation retains duplicate evidence and only known complete lookup clears uncertainty', () => {
  const h = journalFixture(); h.apply({ status: 'unknown', detail: 'Duplicate observed.', integrityIncident: 'duplicate_publication' });
  assert.equal(h.saved.integrityIncident, 'duplicate_publication'); assert.deepEqual(h.saves[0].metadata.observations.map(value => value.kind), ['recovery', 'integrity_incident']); assert.equal(h.saves[0].metadata.observations[0].duplicateActions, true);
  h.saved.lastReconciliationOperationId = 'reconcile-one'; h.apply(h.result); assert.equal(h.saves[1].metadata.observations[0].outcome, 'known'); assert.equal(h.saves[1].metadata.observations[0].duplicateActions, true);
  const clean = journalFixture(); clean.saved.lastReconciliationOperationId = 'reconcile-clean'; clean.apply(clean.result); assert.equal(clean.saves[0].metadata.observations[0].duplicateActions, false);
  for (const invalid of [{ status: 'failed', detail: 'Bad incident.', integrityIncident: 'duplicate_publication' }, { status: 'unknown', detail: 'Bad evidence.', recoveryEvidence: 'complete_pull_request_lookup' }, { status: 'confirmed', detail: 'Wrong action evidence.', recoveryEvidence: 'single_remote_ref' }, { status: 'failed', detail: 'Unconfirmed receipt.' }]) {
    const next = journalFixture(), value = { ...next.result, ...invalid }; if (value.status === 'unknown') delete value.observation;
    assert.throws(() => next.apply(value)); assert.equal(next.saves.length, 0);
  }
});
