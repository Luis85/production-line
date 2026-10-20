import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, admit } from './request-gate-fixtures.mjs';
import { featureRecord } from './feature-fixtures.mjs';
import { reconcileFeatureSource } from '../../src/worker/dist/worker/application/feature-source.js';
import { featureInputHash, featureCommandDigest } from '../../src/worker/dist/worker/application/feature-markdown.js';
/** @type {import('../../src/worker/application/feature-requests.js').FeatureInput} */
const input = { title: 'Clarify retry semantics', mode: 'chat', provider: 'claude-cli', priority: 1, message: 'Explain retry behavior.' };

test('Markdown command reservation survives a lost acknowledgement without repeating a journal operation', async t => {
  const { journal } = await fixture(t), request = admit(journal);
  let record = featureRecord({ input, semanticRevision: 1, inputHash: featureInputHash(input), submitted: true, sessionId: 'session' });
  /** @type {import('../../src/worker/application/feature-requests.js').FeatureFile} */
  const file = { name: record.name, id: record.id, revision: 'source', input, commands: [{ commandId: 'CMD-cancel', action: 'cancel' }] };
  let durable = structuredClone(record), loseAck = true, calls = 0;
  const queue = { async submit() {}, inspect: () => ({ status: journal.get(request.id).phase, request: journal.get(request.id) }),
    async request(_record, command) { calls++; const result = journal.command(command); if (loseAck) { loseAck = false; throw Error('Acknowledgement lost.'); } return result; } };
  const persist = async () => { durable = structuredClone(record); };
  await assert.rejects(reconcileFeatureSource(record, file, undefined, queue, persist, true), /Acknowledgement lost/);
  assert.equal(journal.get(request.id).phase, 'cancelled'); assert.equal(durable.commandReceipts[0].outcome, undefined);
  record = structuredClone(durable);
  await reconcileFeatureSource(record, file, undefined, queue, persist, true);
  assert.equal(record.commandReceipts[0].outcome, 'accepted'); assert.equal(calls, 2);
  await reconcileFeatureSource(record, file, undefined, queue, persist, true); assert.equal(calls, 2);
  const changed = { ...file, commands: [{ commandId: 'CMD-cancel', action: /** @type {const} */ ('reopen') }] };
  await assert.rejects(reconcileFeatureSource(record, changed, undefined, queue, persist, true), /different content/);
  assert.equal(journal.get(request.id).phase, 'cancelled');
});

test('source holds happen before continuation and terminal source edits never invoke revision hooks', async t => {
  const { journal } = await fixture(t), request = admit(journal);
  journal.command({ action: 'cancel', requestId: request.id, expectedRevision: request.revision, operationId: 'initial-cancel' });
  const record = featureRecord({ input, semanticRevision: 1, inputHash: featureInputHash(input), submitted: true });
  const events = [], queue = { async submit() {}, inspect: () => ({ status: 'cancelled', request: journal.get(request.id) }),
    async source(_record, issue) { events.push(issue?.code ?? 'clear'); }, async revise() { events.push('revise'); return true; } };
  await reconcileFeatureSource(record, { name: record.name, revision: 'changed', input: { ...input, message: 'Changed requirement.' } }, undefined, queue, async () => {}, true);
  assert.deepEqual(events, ['changed_input']); assert.equal(record.pendingInput.message, 'Changed requirement.');
  await reconcileFeatureSource(record, undefined, { code: 'missing_source', reason: 'Restore source.' }, queue, async () => {}, true);
  assert.equal(events.at(-1), 'missing_source'); assert.equal(journal.get(request.id).phase, 'cancelled');
});


test('a retained Markdown receipt cannot replay a command for another request or action', async t => {
  const { journal } = await fixture(t), request = admit(journal);
  const record = featureRecord({ input, semanticRevision: 1, inputHash: featureInputHash(input), submitted: true });
  const value = { commandId: 'CMD-cancel', action: /** @type {const} */ ('cancel') };
  /** @type {import('../../src/worker/application/feature-requests.js').FeatureFile} */
  const file = { name: record.name, id: record.id, revision: 'source', input, commands: [value] };
  const command = { action: /** @type {const} */ ('cancel'), requestId: 'another-request', expectedRevision: request.revision, operationId: value.commandId };
  record.commandReceipts = [{ commandId: value.commandId, digest: featureCommandDigest(value), command }];
  let calls = 0;
  const queue = { async submit() {}, inspect: () => ({ status: request.phase, request }), async request() { calls++; } };
  await assert.rejects(reconcileFeatureSource(record, file, undefined, queue, async () => {}, true), /does not belong/);
  record.commandReceipts[0].command = { ...command, requestId: request.id, action: 'reopen' };
  await assert.rejects(reconcileFeatureSource(record, file, undefined, queue, async () => {}, true), /does not belong/);
  assert.equal(calls, 0); assert.deepEqual(journal.get(request.id), request);
});
