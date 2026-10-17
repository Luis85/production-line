import test from 'node:test';
import assert from 'node:assert/strict';
import { observePublishedFeature } from './shared-intake-observation.mjs';

const previousCommit = 'a'.repeat(40), sourceCommit = 'b'.repeat(40);
/** @param {Partial<import('../../src/worker/application/shared-intake-contract.js').SharedIntakeView>} [overrides] */
function snapshot(overrides = {}) {
  return {
    revision: 1, workerId: 'fixture-worker', canEdit: true, blockedReason: null,
    config: { enabled: true, repositoryId: 'shared', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 300000 },
    state: /** @type {const} */ ('idle'), error: null, lastSyncedAt: '2026-10-17T00:00:00.000Z',
    sourceCommit, workflow: null,
    requests: [{ id: 'feature', name: 'feature.md', title: 'Fixture feature', status: 'queued', owner: 'fixture-worker', isLocal: true,
      sourceCommit, updatedAt: '2026-10-17T00:00:00.000Z', ready: { passed: true, issues: [] }, done: null,
      featureBranch: null, reviewNote: null, publication: /** @type {const} */ ('synced'), error: null, taskId: 'shared-feature-fixture' }],
    ...overrides,
  };
}
function expected(signal, diagnostic = (_message) => {}) { return { id: 'feature', previousCommit, sourceCommit, signal, diagnostic }; }

test('published-feature observation waits for a delayed pre-push poll, then requires a fresh generation', async t => {
  const entered = Promise.withResolvers();
  /** @type {PromiseWithResolvers<ReturnType<typeof snapshot>>} */
  const delayed = Promise.withResolvers();
  const old = snapshot({ sourceCommit: previousCommit, requests: [] }), current = snapshot();
  const diagnostics = [];
  let calls = 0;
  const observed = observePublishedFeature(async () => {
    calls++;
    if (calls === 1) { entered.resolve(undefined); return delayed.promise; }
    return current;
  }, expected(t.signal, message => diagnostics.push(message)));
  await entered.promise;
  assert.equal(calls, 1, 'The outstanding snapshot must settle before a fresh synchronization starts.');
  delayed.resolve(old);
  assert.equal(await observed, current);
  assert.equal(calls, 2); assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], new RegExp(previousCommit)); assert.match(diagnostics[0], new RegExp(sourceCommit));
});

test('published-feature observation accepts immutable request provenance after later lifecycle commits', async t => {
  const current = snapshot({ sourceCommit: 'c'.repeat(40) });
  let calls = 0;
  assert.equal(await observePublishedFeature(async () => { calls++; return current; }, expected(t.signal)), current);
  assert.equal(calls, 1);
});

test('published-feature observation fails closed without retrying errors, rejection, wrong provenance or unexpected heads', async t => {
  const rejected = snapshot(); rejected.requests[0].ready = { passed: false, issues: ['Missing criteria.'] };
  const wrong = snapshot(); wrong.requests[0].sourceCommit = previousCommit;
  const blocked = snapshot(); blocked.requests[0].status = 'blocked';
  const failed = snapshot(); failed.requests[0].error = 'Publication failed.';
  const unclaimed = snapshot(); unclaimed.requests[0].taskId = null;
  for (const value of [snapshot({ state: 'error', error: 'Remote unavailable.' }), rejected, wrong, blocked, failed, unclaimed,
    snapshot({ sourceCommit, requests: [] }), snapshot({ sourceCommit: 'c'.repeat(40), requests: [] })]) {
    let calls = 0;
    await assert.rejects(observePublishedFeature(async () => { calls++; return value; }, expected(t.signal)), { code: 'ERR_ASSERTION' });
    assert.equal(calls, 1);
  }
});

test('published-feature observation bounds a repeated stale snapshot and respects cancellation before work', async t => {
  let calls = 0;
  await assert.rejects(observePublishedFeature(async () => { calls++; return snapshot({ sourceCommit: previousCommit, requests: [] }); }, expected(t.signal)), /retained the pre-push snapshot/);
  assert.equal(calls, 2);
  const stop = new AbortController(); stop.abort(Error('Fixture cancelled.'));
  await assert.rejects(observePublishedFeature(async () => { calls++; return snapshot(); }, expected(stop.signal)), /Fixture cancelled/);
  assert.equal(calls, 2);
});
