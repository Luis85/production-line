import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalMerge } from '../../../.mutation-build/worker/application/local-merge-runtime.js';
import { localRequest, preparation } from './workflow-local-fixture.mjs';

function fixture() {
  const request = localRequest(), calls = [];
  /** @type {import('../../../src/worker/application/local-merge-contracts.ts').LocalMergeOperation} */
  const operation = { operationId: 'local-one', status: 'pending', repositoryId: 'repo-one', checkoutPath: '/assigned/project', mainBranch: 'main', mainHead: '1'.repeat(40), candidate: request.delivery.review.candidate, createdAt: request.createdAt, updatedAt: request.updatedAt, detail: 'Saved approval.' };
  let current = { branch: 'main', head: operation.mainHead, tree: 'd'.repeat(40), clean: true, candidateIncluded: false };
  /** @type {import('../../../src/worker/application/local-merge-contracts.ts').LocalMergePort} */
  const port = { async inspect() { calls.push('inspect'); return current; }, async prepare() { calls.push('prepare'); return structuredClone(preparation); }, async apply(value) { calls.push('apply'); assert.deepEqual(value.preparation, preparation); current = { ...current, head: preparation.mergeCommit, tree: preparation.tree, candidateIncluded: true }; } };
  const input = { operation, mode: /** @type {'execute'|'reconcile'} */ ('execute'), port, signal: new AbortController().signal,
    authorize(mutation) { calls.push(mutation ? 'authorize-write' : 'authorize-read'); }, prepared(value) { calls.push('persist-preparation'); assert.deepEqual(value, preparation); } };
  return { operation, port, calls, input, setCurrent(value) { current = value; }, current: () => current };
}

test('explicit local merge durably prepares before its only checkout mutation and returns exact immutable receipt identity', async () => {
  const h = fixture(), result = await runLocalMerge(h.input);
  assert.equal(result.status, 'confirmed'); assert.deepEqual(h.calls, ['authorize-read', 'inspect', 'authorize-write', 'prepare', 'persist-preparation', 'authorize-write', 'apply', 'authorize-read', 'inspect']);
  assert.deepEqual({ ...result.receipt, mergedAt: 'time' }, { ...preparation, branch: 'main', previousHead: '1'.repeat(40), candidateCommit: '2'.repeat(40), mergedAt: 'time' }); assert.ok(Number.isFinite(Date.parse(result.receipt.mergedAt)));
  assert.notEqual(h.operation.preparation, preparation); assert.equal(h.operation.preparation.mergeCommit, 'b'.repeat(40));
});

test('dirty, changed-head or changed-branch main checkouts cannot produce a prepared commit or checkout write', async () => {
  for (const change of [{ clean: false }, { branch: 'other' }, { head: 'f'.repeat(40) }]) {
    const h = fixture(); h.setCurrent({ ...h.current(), ...change }); assert.equal((await runLocalMerge(h.input)).status, 'failed'); assert.deepEqual(h.calls, ['authorize-read', 'inspect']);
  }
});

test('read-only reconciliation distinguishes exact known checkout, untouched before state and every uncertain dimension', async () => {
  const original = fixture(); original.input.mode = 'reconcile'; assert.equal((await runLocalMerge(original.input)).status, 'not_observed'); assert.deepEqual(original.calls, ['authorize-read', 'inspect']);
  const exact = { branch: 'main', head: preparation.mergeCommit, tree: preparation.tree, clean: true, candidateIncluded: true };
  for (const change of [{}, { branch: 'other' }, { head: 'f'.repeat(40) }, { tree: 'f'.repeat(40) }, { clean: false }, { candidateIncluded: false }]) {
    const h = fixture(); h.operation.preparation = structuredClone(preparation); h.input.mode = 'reconcile'; h.setCurrent({ ...exact, ...change }); const result = await runLocalMerge(h.input);
    assert.equal(result.status, Object.keys(change).length ? 'unknown' : 'confirmed'); assert.deepEqual(h.calls, ['authorize-read', 'inspect']);
  }
  const unprepared = fixture(); unprepared.input.mode = 'reconcile'; unprepared.setCurrent(exact); assert.equal((await runLocalMerge(unprepared.input)).status, 'unknown');
});

test('unknown push-style acknowledgement is observed, while preparation or observation persistence failures never retry checkout', async () => {
  const acknowledged = fixture(), apply = acknowledged.port.apply; acknowledged.port.apply = async (...args) => { await apply(...args); throw Error('Lost acknowledgement'); };
  assert.equal((await runLocalMerge(acknowledged.input)).status, 'confirmed'); assert.equal(acknowledged.calls.filter(value => value === 'apply').length, 1);
  const invisible = fixture(); invisible.port.apply = async () => { invisible.calls.push('apply'); throw Error('Not observed'); }; assert.equal((await runLocalMerge(invisible.input)).status, 'not_observed');
  const persistence = fixture(); persistence.input.prepared = () => { throw Error('Journal unavailable'); }; assert.equal((await runLocalMerge(persistence.input)).status, 'unknown'); assert.equal(persistence.calls.includes('apply'), false);
  const denied = fixture(); let permissions = 0; denied.input.authorize = mutation => { if (mutation && ++permissions === 2) throw Error('Revoked before checkout'); }; assert.equal((await runLocalMerge(denied.input)).status, 'unknown'); assert.equal(denied.calls.includes('apply'), false);
  const aborted = fixture(), controller = new AbortController(); controller.abort(); aborted.input.signal = controller.signal; assert.equal((await runLocalMerge(aborted.input)).status, 'unknown'); assert.deepEqual(aborted.calls, []);
});
