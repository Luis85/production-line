import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input, passed, wait } from './ready-review-fixtures.mjs';
import { readyReviewSessionId } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
const authority = { repositoryId: 'shared', configurationDigest: 'a'.repeat(64) };
function gate() {
  let release;
  const promise = new Promise(resolve => { release = () => resolve(undefined); });
  return { promise, release: () => release() };
}

test('pending ownership verification reserves one Ready Check before yielding and duplicates share its acceptance', async t => {
  const admission = gate(); let verified = 0;
  const f = await fixture(t, { authorize: () => {}, verifyAuthority: async value => { assert.deepEqual(value, authority); if (++verified === 1) await admission.promise; } });
  const accepted = { ...input(), deliveryAuthority: authority }, sessionId = readyReviewSessionId(accepted);
  const first = f.schedule(accepted), duplicate = f.schedule(structuredClone(accepted));
  assert.equal(f.manager.active, 1); await wait(() => verified === 1);
  assert.equal(f.calls.length, 0); assert.equal(f.sessions.runs.list().rows.length, 0); assert.equal(f.sessions.executor.waiting, 0); assert.equal(f.sessions.interactions.operation(sessionId, accepted.operationId), undefined);
  await assert.rejects(f.schedule({ ...accepted, title: 'Changed while verifying' }), /already has an active Ready Check/);
  admission.release(); const [one, two] = await Promise.all([first, duplicate]); assert.deepEqual(one, two); await f.settle();
  assert.equal(verified, 2); assert.equal(f.calls.length, 1); assert.equal(f.sessions.runs.list().rows.length, 1); assert.equal(f.manager.inspect(accepted).state, 'completed');
});

test('rejected ownership admission creates no model turn or run and may be retried after ownership is repaired', async t => {
  let owned = false, verified = 0;
  const f = await fixture(t, { authorize: () => {}, verifyAuthority: async () => { verified++; if (!owned) throw new DomainError('conflict', 'Project ownership changed.'); } });
  const accepted = { ...input(), deliveryAuthority: authority };
  await assert.rejects(f.schedule(accepted), /ownership changed/); await f.settle();
  assert.equal(f.calls.length, 0); assert.equal(f.sessions.runs.list().rows.length, 0); assert.equal(f.manager.inspect(accepted), undefined); assert.equal(f.sessions.executor.busy, false);
  owned = true; await f.schedule(accepted); await f.settle(); assert.equal(f.calls.length, 1); assert.equal(verified, 3);
});

test('machine approval is rechecked after delayed ownership admission before preparing any model evidence', async t => {
  const admission = gate(); let approved = true, entered = false;
  const f = await fixture(t, { authorize: () => { if (!approved) throw new DomainError('conflict', 'Machine approval revoked.'); }, verifyAuthority: async () => { entered = true; await admission.promise; } });
  const accepted = { ...input(), deliveryAuthority: authority }, scheduled = f.schedule(accepted);
  await wait(() => entered); approved = false; const rejected = assert.rejects(scheduled, /approval revoked/); admission.release(); await rejected; await f.settle();
  assert.equal(f.calls.length, 0); assert.equal(f.sessions.runs.list().rows.length, 0); assert.equal(f.manager.inspect(accepted), undefined);
});

test('queued ownership is verified again after the execution permit and revocation blocks the paid call', async t => {
  const inspection = gate(); let verified = 0, owned = true;
  const f = await fixture(t, { authorize: () => {}, verifyAuthority: async () => { if (++verified === 2) await inspection.promise; if (!owned) throw new DomainError('conflict', 'Queued project ownership revoked.'); } });
  const release = await f.sessions.executor.acquire('implementation', new AbortController().signal);
  const accepted = { ...input(), deliveryAuthority: authority }, attempt = await f.schedule(accepted);
  assert.equal(verified, 1); assert.equal(f.calls.length, 0); release(); await wait(() => verified === 2);
  assert.equal(f.calls.length, 0); assert.equal(f.sessions.runs.get(attempt.runId).outcome, 'queued');
  owned = false; inspection.release(); await f.settle();
  assert.equal(f.calls.length, 0); assert.equal(f.manager.inspect(accepted).state, 'failed'); assert.equal(f.manager.inspect(accepted).error, 'conflict'); assert.equal(f.sessions.runs.get(attempt.runId).outcome, 'failed'); assert.equal(f.sessions.executor.busy, false); assert.equal(f.consumption.status().measuredTokens, 0);
});

test('shutdown during post-permit ownership verification fences the model and releases its permit', async t => {
  const inspection = gate(); let verified = 0;
  const f = await fixture(t, { authorize: () => {}, verifyAuthority: async () => { if (++verified === 2) await inspection.promise; } });
  const accepted = { ...input(), deliveryAuthority: authority }, attempt = await f.schedule(accepted); await wait(() => verified === 2);
  const closing = f.manager.close(); inspection.release(); await closing;
  assert.equal(f.calls.length, 0); assert.equal(f.manager.inspect(accepted).state, 'interrupted'); assert.equal(f.sessions.runs.get(attempt.runId).outcome, 'interrupted'); assert.equal(f.sessions.executor.busy, false);
});

test('async ownership verification preserves synchronous approval checks before each provider dispatch attempt', async t => {
  let approved = true, providerAttempts = 0, verified = 0;
  const f = await fixture(t, { authorize: () => { if (!approved) throw new DomainError('conflict', 'Approval revoked before retry.'); }, verifyAuthority: async () => { verified++; }, respond: async (_request, _signal, _observe, control) => {
    providerAttempts++; approved = false; control.beforeCall(); providerAttempts++; return passed();
  } });
  const accepted = { ...input(), deliveryAuthority: authority }; await f.schedule(accepted); await f.settle();
  assert.equal(verified, 2); assert.equal(providerAttempts, 1); assert.equal(f.calls.length, 1); assert.equal(f.manager.inspect(accepted).state, 'failed'); assert.equal(f.manager.inspect(accepted).error, 'conflict');
});
