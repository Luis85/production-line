import test from 'node:test';
import assert from 'node:assert/strict';
import { localMergeSubject } from '../../../.mutation-build/worker/application/local-merge-view.js';
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


/** Obtain the real domain conflict through the accepted-policy boundary, without a second error class. */
function policyConflict() {
  try { localMergeSubject(localRequest(false)); } catch (error) {
    assert.equal(/** @type {{code?: unknown}} */ (error).code, 'conflict'); return /** @type {Error} */ (error);
  }
  assert.fail('A disabled accepted merge policy must refuse authority.');
}

test('an untouched head on a different branch or dirty checkout remains unknown during read-only recovery', async () => {
  for (const prepared of [false, true]) for (const change of [{ branch: 'teammate-branch' }, { clean: false }, { branch: 'teammate-branch', clean: false }]) {
    const h = fixture(); if (prepared) h.operation.preparation = structuredClone(preparation);
    h.input.mode = 'reconcile'; h.setCurrent({ ...h.current(), ...change }); const saved = structuredClone(h.operation);
    const result = await runLocalMerge(h.input);
    assert.equal(result.status, 'unknown'); assert.equal(result.receipt, undefined); assert.deepEqual(h.operation, saved);
    assert.deepEqual(h.calls, ['authorize-read', 'inspect'], 'An uncertain before-state cannot retry preparation or checkout.');
  }
});

test('a domain conflict after checkout cannot become a failed attempt and later observation does not repeat the write', async () => {
  for (const stage of ['observation', 'authorization']) {
    const h = fixture(), inspect = h.port.inspect, authorize = h.input.authorize, conflict = policyConflict(); let reads = 0;
    if (stage === 'observation') h.port.inspect = async (...args) => { if (++reads === 2) throw conflict; return inspect(...args); };
    else h.input.authorize = mutation => { authorize(mutation); if (!mutation && h.calls.includes('apply')) throw conflict; };
    const result = await runLocalMerge(h.input);
    assert.equal(result.status, 'unknown'); assert.equal(result.receipt, undefined); assert.notEqual(result.detail, conflict.message);
    assert.equal(h.calls.filter(value => value === 'apply').length, 1); assert.deepEqual(h.operation.preparation, preparation);
    h.port.inspect = inspect; h.input.authorize = authorize; h.input.mode = 'reconcile'; const writes = h.calls.filter(value => value === 'authorize-write').length;
    const recovered = await runLocalMerge(h.input); assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.receipt.mergeCommit, preparation.mergeCommit);
    assert.equal(h.calls.filter(value => value === 'apply').length, 1); assert.equal(h.calls.filter(value => value === 'authorize-write').length, writes);
  }
});

test('only a real pre-mutation domain conflict is a known failure; transport conflict-shaped errors remain unknown and private', async () => {
  const known = fixture(), conflict = policyConflict(); known.port.prepare = async () => { throw conflict; };
  const rejected = await runLocalMerge(known.input); assert.equal(rejected.status, 'failed'); assert.equal(rejected.detail, conflict.message); assert.equal(known.calls.includes('apply'), false);
  const invalid = fixture(), malformed = localRequest(), context = /** @type {{deliveryPolicy: import('../../../src/worker/application/delivery-policy.ts').DeliveryPolicySnapshot}} */ (malformed.input.context); context.deliveryPolicy.configurationDigest = '0'.repeat(64);
  let validationError; try { localMergeSubject(malformed); } catch (error) { assert.equal(/** @type {{code?: unknown}} */ (error).code, 'invalid_input'); validationError = /** @type {Error} */ (error); }
  assert.ok(validationError); invalid.port.prepare = async () => { throw validationError; }; const uncertain = await runLocalMerge(invalid.input); assert.equal(uncertain.status, 'unknown'); assert.notEqual(uncertain.detail, validationError.message); assert.equal(invalid.calls.includes('apply'), false);
  const denied = fixture(); let approvals = 0; denied.input.authorize = mutation => { if (mutation && ++approvals === 2) throw policyConflict(); };
  assert.equal((await runLocalMerge(denied.input)).status, 'failed'); assert.deepEqual(denied.operation.preparation, preparation); assert.equal(denied.calls.includes('apply'), false);
  for (const error of [Object.assign(new Error('private-host-token'), { code: 'conflict' }), { code: 'conflict', message: 'private-host-token' }, new Error('private-host-token'), null]) {
    const h = fixture(); h.port.prepare = async () => { throw error; };
    const result = await runLocalMerge(h.input); assert.equal(result.status, 'unknown'); assert.equal(result.receipt, undefined); assert.doesNotMatch(result.detail, /private-host-token/); assert.equal(h.calls.includes('apply'), false);
  }
});

test('cancellation while asynchronous approval returns prevents even a checkout observation', async () => {
  const h = fixture(), controller = new AbortController(), authorize = h.input.authorize; h.input.signal = controller.signal;
  h.input.authorize = mutation => { authorize(mutation); controller.abort(); };
  const result = await runLocalMerge(h.input); assert.equal(result.status, 'unknown'); assert.equal(result.receipt, undefined);
  assert.deepEqual(h.calls, ['authorize-read']); assert.equal(h.operation.preparation, undefined);
});
