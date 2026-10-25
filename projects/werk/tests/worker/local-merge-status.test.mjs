import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeLocalRequest } from '../../src/worker/dist/worker/status/workspace-local-merge.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
import { fixture } from './request-gate-fixtures.mjs';
import { readyPublication } from './remote-delivery-fixtures.mjs';
import { deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { acceptRelease } from './release-fixtures.mjs';

async function harness(t) {
  const { journal, directory } = await fixture(t), repository = join(directory, 'project'); await mkdir(repository);
  const proxy = new Proxy(journal, { get(target, key) { if (key !== 'ensure') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } return input => { const context = input.input.context; context.deliveryPolicy.configuration.localMerge = true; context.deliveryPolicy = deliveryPolicySnapshot(context.deliveryPolicy.configuration, context.deliveryPolicy.baseline); return target.ensure(input); }; } });
  const canonical = await realpath(repository), request = acceptRelease(journal, readyPublication(proxy)), calls = [];
  const assignment = { id: 'repo-one', path: canonical, remote: 'origin', branch: 'main', watch: true };
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({ nativeWorkState: 'ready', acceptingTasks: true, config: { stateDir: directory }, repositoryStop: new AbortController(), sessions: { requests: journal },
    repositories: { resolve: () => assignment }, board: { executionDetail: () => ({ requestId: request.id, repositoryId: 'repo-one', repository: canonical }), async verifyDelivery(id, revision) { calls.push('verify'); assert.equal(id, request.id); assert.equal(journal.get(id).revision, revision); } } }));
  let applied = false;
  const preparation = { mergeCommit: 'b'.repeat(40), tree: 'c'.repeat(40) };
  /** @type {import('../../src/worker/application/local-merge-contracts.ts').LocalMergePort} */
  const port = { async inspect() { calls.push('inspect'); return { branch: 'main', head: applied ? preparation.mergeCommit : '1'.repeat(40), tree: applied ? preparation.tree : 'd'.repeat(40), clean: true, candidateIncluded: applied }; }, async prepare(operation) { calls.push('prepare'); const saved = journal.get(request.id).delivery.localMerge.operations.at(-1); assert.equal(saved.operationId, operation.operationId); assert.equal(saved.status, 'pending'); return preparation; }, async apply() { calls.push('apply'); assert.deepEqual(journal.get(request.id).delivery.localMerge.operations.at(-1).preparation, preparation); applied = true; } };
  const command = (action = 'merge_local_candidate', operationId = 'approved-main-merge') => {
    const value = journal.get(request.id), candidate = value.delivery.review.candidate;
    return /** @type {import('../../src/worker/application/request-gates.ts').RequestCommand} */ ({ action, requestId: request.id, expectedRevision: value.revision, operationId, deliveryRunId: value.delivery.id, inputRevision: value.inputRevision, candidateCommit: candidate.candidateCommit, candidateDigest: candidate.candidateDigest,
      ...(action === 'merge_local_candidate' ? { mainCheckout: canonical, mainBranch: 'main', mainHead: '1'.repeat(40) } : { localMergeOperationId: 'approved-main-merge' }) });
  };
  const injected = { port, authorize(mutation) { calls.push(mutation ? 'approve-write' : 'approve-read'); } };
  return { workspace, journal, directory, canonical, request, assignment, calls, port, command, injected };
}

test('composition retains intent and prepared commit before checkout mutation, with exact approval and duplicate replay', async t => {
  const h = await harness(t), command = h.command();
  const result = await mergeLocalRequest(h.workspace, command, h.injected); assert.equal(result.request.delivery.localMerge.merged.mergeCommit, 'b'.repeat(40)); assert.equal(h.calls.filter(value => value === 'apply').length, 1);
  const replay = await mergeLocalRequest(h.workspace, command, h.injected); assert.equal(replay.duplicate, true); assert.equal(h.calls.filter(value => value === 'apply').length, 1);
});

test('source hold or revoked private approval after preparation prevents the main checkout mutation', async t => {
  for (const kind of ['source', 'approval']) {
    const h = await harness(t), prepare = h.port.prepare; let revoked = false;
    h.port.prepare = async operation => { const result = await prepare(operation, new AbortController().signal); if (kind === 'source') h.journal.deliveryUpdate(h.request.id, { action: 'hold', code: 'source_missing', reason: 'Canonical source deleted.' }); else revoked = true; return result; };
    h.injected.authorize = mutation => { if (mutation && revoked) throw new DomainError('conflict', 'Private project approval was revoked.'); };
    const result = await mergeLocalRequest(h.workspace, h.command(), h.injected); assert.equal(result.request.delivery.localMerge.operations[0].status, 'failed'); assert.equal(h.calls.includes('apply'), false);
  }
});

test('physical checkout identity accepts parent aliases while reassignments cannot redirect saved approval', async t => {
  const h = await harness(t), alias = join(h.directory, 'project-alias');
  await symlink(h.canonical, alias, process.platform === 'win32' ? 'junction' : 'dir'); h.assignment.path = alias;
  assert.equal((await mergeLocalRequest(h.workspace, h.command(), h.injected)).request.delivery.localMerge.operations[0].status, 'confirmed');
  const changed = await harness(t), other = join(changed.directory, 'other-project'); await mkdir(other); const prepare = changed.port.prepare;
  changed.port.prepare = async operation => { const result = await prepare(operation, new AbortController().signal); changed.assignment.path = other; return result; };
  const result = await mergeLocalRequest(changed.workspace, changed.command(), changed.injected); assert.equal(result.request.delivery.localMerge.operations[0].status, 'failed'); assert.equal(changed.calls.includes('apply'), false);
});

test('unknown acknowledgement enables read-only reconciliation and never another checkout mutation', async t => {
  const h = await harness(t), inspect = h.port.inspect; let reads = 0;
  h.port.inspect = async (...args) => { if (++reads === 2) throw Error('Observation interrupted'); return inspect(...args); };
  let result = await mergeLocalRequest(h.workspace, h.command(), h.injected); assert.equal(result.request.delivery.localMerge.operations[0].status, 'unknown');
  h.port.inspect = async () => { throw new DomainError('conflict', 'Checkout inspection unavailable.'); };
  result = await mergeLocalRequest(h.workspace, h.command('reconcile_local_merge', 'observe-unavailable-checkout'), h.injected); assert.equal(result.request.delivery.localMerge.operations[0].status, 'unknown', 'Failed read-only inspection cannot settle an unknown merge as a known failure');
  h.port.inspect = inspect;
  result = await mergeLocalRequest(h.workspace, h.command('reconcile_local_merge', 'observe-known-checkout'), h.injected); assert.equal(result.request.delivery.localMerge.operations[0].status, 'confirmed'); assert.equal(h.calls.filter(value => value === 'apply').length, 1);
});


test('active repository admission blocks an explicit main checkout merge before any intent or mutation', async t => {
  const h = await harness(t); h.workspace.repositoryPreparations = 1;
  await assert.rejects(mergeLocalRequest(h.workspace, h.command(), h.injected), /admission/); assert.equal(h.journal.get(h.request.id).delivery.localMerge, undefined); assert.equal(h.calls.includes('apply'), false);
});
