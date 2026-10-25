import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { parseFeature, featureInput, featureRequestContext } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { markdownCommands } from '../../src/worker/dist/worker/infrastructure/features/markdown-contract.js';
import { featureInputHash } from '../../src/worker/dist/worker/application/feature-markdown.js';
import { reconcileFeatureSource } from '../../src/worker/dist/worker/application/feature-source.js';
import { deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { fixture } from './request-gate-fixtures.mjs';
import { featureRecord } from './feature-fixtures.mjs';
import { readyPublication } from './remote-delivery-fixtures.mjs';
import { acceptRelease } from './release-fixtures.mjs';

const note = `---
schema: worker.request/v1
id: request-one
title: Merge the reviewed increment
intent: submit
mode: patch
paths: [source.txt]
priority: low
---
## Goal
Implement the approved change.
## Acceptance criteria
- Source value is two.
`;
const merge = (overrides = {}) => ({ command_id: 'merge-main-one', action: 'merge_local_candidate', run_id: 'run-one', request_revision: 1,
  candidate_commit: 'a'.repeat(40), main_checkout: '/assigned/project', main_branch: 'main', main_head: 'b'.repeat(40), ...overrides });
const observe = (overrides = {}) => ({ command_id: 'observe-main-one', action: 'reconcile_local_merge', run_id: 'run-one', request_revision: 1,
  candidate_commit: 'a'.repeat(40), operation_id: 'merge-main-one', ...overrides });
const document = value => parseFeature(note.replace('priority: low\n', 'priority: low\n' + stringify({ local_merge: value })));

test('canonical local_merge preserves explicit checkout approval and does not change semantic request input', () => {
  const source = parseFeature(note), base = featureInput(source, 'claude-cli');
  for (const checkout of ['/assigned/project', 'C:\\Work\\project', '\\\\server\\share\\project']) {
    const parsed = document(merge({ main_checkout: checkout })), input = featureInput(parsed, 'claude-cli');
    assert.deepEqual(markdownCommands(parsed), [{ commandId: 'merge-main-one', action: 'merge_local_candidate', runId: 'run-one', requestRevision: 1,
      candidateCommit: 'a'.repeat(40), mainCheckout: checkout, mainBranch: 'main', mainHead: 'b'.repeat(40) }]);
    assert.equal(featureInputHash(input), featureInputHash(base));
    assert.deepEqual(featureRequestContext(parsed.data, input), featureRequestContext(source.data, base));
  }
  const sha256 = markdownCommands(document(merge({ candidate_commit: 'c'.repeat(64), main_head: 'd'.repeat(64) })))[0];
  assert.equal(sha256.candidateCommit.length, 64); assert.equal(sha256.mainHead.length, 64);
  assert.deepEqual(markdownCommands(document(observe())), [{ commandId: 'observe-main-one', action: 'reconcile_local_merge', runId: 'run-one',
    requestRevision: 1, candidateCommit: 'a'.repeat(40), localMergeOperationId: 'merge-main-one' }]);
});

test('local_merge strictly validates command, revision, full commits and action-specific destination fields', () => {
  for (const field of ['command_id', 'action', 'run_id', 'request_revision', 'candidate_commit', 'main_checkout', 'main_branch', 'main_head']) {
    const value = merge(); delete value[field]; assert.throws(() => markdownCommands(document(value)), field);
  }
  for (const fields of [{ action: 'merge_candidate' }, { action: ['merge_local_candidate'] }, { command_id: '../escape' }, { run_id: '' },
    { request_revision: '1' }, { request_revision: 0 }, { request_revision: 1.5 }, { request_revision: Number.MAX_SAFE_INTEGER + 1 },
    { candidate_commit: 'a'.repeat(41) }, { candidate_commit: 'A'.repeat(40) }, { main_head: 'b'.repeat(39) },
    { main_checkout: 'relative/project' }, { main_checkout: 'C:relative' }, { main_checkout: '/project\nother' }, { main_checkout: '/' + 'a'.repeat(4096) },
    { main_branch: '-main' }, { main_branch: 'main..next' }, { main_branch: '/main' }, { main_branch: 'main.lock' },
    { operation_id: 'unrelated' }, { force: true }]) assert.throws(() => markdownCommands(document(merge(fields))), JSON.stringify(fields));
  for (const fields of [{ operation_id: undefined }, { operation_id: '../escape' }, { main_checkout: '/other' }, { main_branch: 'other' }, { main_head: 'b'.repeat(40) }, { force: true }])
    assert.throws(() => markdownCommands(document(observe(fields))), JSON.stringify(fields));
});

async function ready(t) {
  const { journal } = await fixture(t);
  const proxy = new Proxy(journal, { get(target, key) {
    if (key !== 'ensure') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; }
    return input => { const context = input.input.context, configuration = context.deliveryPolicy.configuration;
      delete configuration.remoteDelivery; configuration.localMerge = true;
      context.deliveryPolicy = deliveryPolicySnapshot(configuration, context.deliveryPolicy.baseline); return target.ensure(input); };
  } });
  const request = acceptRelease(journal, readyPublication(proxy)), candidate = request.delivery.review.candidate;
  const fields = merge({ run_id: candidate.runId, request_revision: request.inputRevision, candidate_commit: candidate.candidateCommit });
  const parsed = document(fields), input = featureInput(parsed, 'claude-cli');
  const record = featureRecord({ input, inputHash: featureInputHash(input), semanticRevision: 1, submitted: true });
  const file = { name: record.name, id: record.id, revision: 'canonical-source', input, commands: markdownCommands(parsed) };
  return { journal, request, fields, record, file };
}

test('canonical source maps the exact main checkout fields and replays a lost acknowledgement without another intent', async t => {
  const h = await ready(t); let record = h.record, durable = structuredClone(record), loseAck = true, calls = 0, duplicate = false;
  const queue = { async submit() {}, inspect: () => ({ status: h.journal.get(h.request.id).phase, request: h.journal.get(h.request.id) }),
    async request(_record, command) { calls++; const result = h.journal.command(command); duplicate ||= result.duplicate; if (loseAck) { loseAck = false; throw Error('Acknowledgement lost.'); } return result; } };
  const persist = async () => { durable = structuredClone(record); };
  await assert.rejects(reconcileFeatureSource(record, h.file, undefined, queue, persist, true), /Acknowledgement lost/);
  const reserved = durable.commandReceipts[0].command;
  assert.equal(reserved.action, 'merge_local_candidate'); assert.equal(reserved.mainCheckout, '/assigned/project');
  assert.equal(reserved.mainBranch, 'main'); assert.equal(reserved.mainHead, 'b'.repeat(40));
  assert.equal(reserved.candidateDigest, h.request.delivery.review.candidate.candidateDigest);
  assert.equal(h.journal.get(h.request.id).delivery.localMerge.operations.length, 1);
  record = structuredClone(durable); await reconcileFeatureSource(record, h.file, undefined, queue, persist, true);
  assert.equal(duplicate, true); assert.equal(record.commandReceipts[0].outcome, 'accepted');
  await reconcileFeatureSource(record, h.file, undefined, queue, persist, true); assert.equal(calls, 2);
  const changed = { ...h.file, commands: markdownCommands(document({ ...h.fields, main_head: 'c'.repeat(40) })) };
  await assert.rejects(reconcileFeatureSource(record, changed, undefined, queue, persist, true), /different content/);
  assert.equal(h.journal.get(h.request.id).delivery.localMerge.operations.length, 1);
});

test('canonical reconciliation selects the saved operation without substituting a fresh target', async t => {
  const h = await ready(t), commands = [];
  const queue = { async submit() {}, inspect: () => ({ status: h.journal.get(h.request.id).phase, request: h.journal.get(h.request.id) }),
    async request(_record, command) { commands.push(command); return h.journal.command(command); } };
  await reconcileFeatureSource(h.record, h.file, undefined, queue, async () => {}, true);
  const parsed = document(observe({ run_id: h.fields.run_id, request_revision: h.fields.request_revision, candidate_commit: h.fields.candidate_commit }));
  await reconcileFeatureSource(h.record, { ...h.file, commands: markdownCommands(parsed) }, undefined, queue, async () => {}, true);
  assert.equal(commands.length, 2); assert.equal(commands[1].action, 'reconcile_local_merge');
  assert.equal(commands[1].localMergeOperationId, 'merge-main-one'); assert.equal(commands[1].mainCheckout, undefined); assert.equal(commands[1].mainHead, undefined);
  assert.equal(h.journal.get(h.request.id).delivery.localMerge.operations.length, 1);
});

test('stale canonical request revisions cannot reserve a local merge or replace current candidate identity', async t => {
  const h = await ready(t); let calls = 0;
  const queue = { async submit() {}, inspect: () => ({ status: h.journal.get(h.request.id).phase, request: h.journal.get(h.request.id) }),
    async request(_record, command) { calls++; return h.journal.command(command); } };
  const staleRevision = { ...h.file, commands: markdownCommands(document({ ...h.fields, request_revision: h.fields.request_revision + 1 })) };
  await assert.rejects(reconcileFeatureSource(h.record, staleRevision, undefined, queue, async () => {}, true), /stale request revision/);
  assert.equal(calls, 0); assert.equal(h.journal.get(h.request.id).delivery.localMerge, undefined);
  const staleCandidate = { ...h.file, commands: markdownCommands(document({ ...h.fields, candidate_commit: 'f'.repeat(40) })) };
  await reconcileFeatureSource(h.record, staleCandidate, undefined, queue, async () => {}, true);
  assert.equal(h.record.commandReceipts[0].outcome, 'rejected'); assert.equal(h.journal.get(h.request.id).delivery.localMerge, undefined);
});
