import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { SharedFeatureAuthoring } from '../../src/worker/dist/worker/application/feature-authoring.js';
import { validateFeatureRequestReference } from '../../src/worker/dist/worker/application/feature-request-reference.js';
import { manageFeature } from '../../src/worker/dist/worker/application/feature-management.js';
import { advisoryResult } from '../../src/worker/dist/worker/application/request-review-protocol.js';
import { featureInput, parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { markdownCommands } from '../../src/worker/dist/worker/infrastructure/features/markdown-contract.js';

const note = (fields = {}) => '---\n' + stringify({ schema: 'worker.request/v1', id: 'FR-1', title: 'Preserve request identity', intent: 'submit', paths: ['src/'], ...fields }) + '---\n## Outcome\n\nKeep the same request throughout implementation.\n';
const candidate = 'a'.repeat(40), inputHash = 'b'.repeat(64);

test('authoring rejects non-string actions and publication statuses before accessing repository configuration', async () => {
  let bindingReads = 0;
  const unavailable = () => { throw Error('No adapter may run for malformed input.'); };
  const authoring = new SharedFeatureAuthoring({ binding: () => { bindingReads++; return null; }, repository: unavailable, loadWorkflow: unavailable,
    documents: { prepare: unavailable, status: unavailable, inspect: unavailable, ready: unavailable }, sync: unavailable });
  for (const action of [['prepare'], ['publish'], null, 1])
    await assert.rejects(authoring.command({ action, operationId: 'malformed-command' }), { code: 'invalid_input' });
  for (const status of [['draft'], ['ready'], null, 1])
    await assert.rejects(authoring.command({ action: 'publish', operationId: 'malformed-status', status }), { code: 'invalid_input' });
  assert.equal(bindingReads, 0);
  await assert.rejects(authoring.command({ action: 'prepare', operationId: 'valid-command' }), { code: 'conflict' });
  assert.equal(bindingReads, 1, 'Valid commands still reach the configured authority check.');
});

test('a non-string source cannot create a second canonical identity with a matching forged digest', () => {
  for (const source of [['folder'], ['interaction'], ['shared_git'], ['orchestrator']]) {
    const id = 'request', scope = 'project', key = 'fr-' + createHash('sha256').update(JSON.stringify([source, scope, id])).digest('hex');
    assert.throws(() => validateFeatureRequestReference({ id, scope, source, key }), { code: 'invalid_input' });
  }
});

test('local management does not coerce an action before reading or changing the canonical note', async () => {
  let reads = 0;
  const unavailable = () => { throw Error('No document or queue operation may run.'); };
  const context = { documents: { read: () => { reads++; throw Error('Unexpected read.'); }, validate: unavailable, ready: unavailable, write: unavailable, remove: unavailable },
    index: { version: /** @type {const} */ (1), owner: 'owner', records: [] }, queue: { submit: unavailable, inspect: unavailable }, persist: unavailable };
  await assert.rejects(manageFeature({ action: ['get'], name: 'request.md' }, context), { code: 'invalid_input' });
  assert.equal(reads, 0);
});

test('canonical request intent, mode and priority require their documented scalar values', () => {
  assert.equal(featureInput(parseFeature(note()), 'claude-cli').mode, 'patch');
  assert.equal(featureInput(parseFeature(note({ priority: 'urgent' })), 'claude-cli').priority, 3);
  for (const intent of [['draft'], ['submit']]) assert.throws(() => parseFeature(note({ intent })), /explicit intent/);
  for (const mode of [['chat'], ['patch']]) assert.throws(() => featureInput(parseFeature(note({ mode, paths: [] })), 'claude-cli'), /mode must/);
  for (const priority of [['low'], ['urgent']]) assert.throws(() => featureInput(parseFeature(note({ priority })), 'claude-cli'), /priority must/);
});

test('Markdown controls reject sequence-valued decisions before a command receipt can be reserved', () => {
  const fields = [
    { control: { command_id: 'C-1', action: ['cancel'], run_id: 'run' } },
    { review: { command_id: 'C-2', decision: ['accept'], request_revision: 1, candidate_commit: candidate } },
    { review: { command_id: 'C-3', decision: 'accept', request_revision: 1, candidate_commit: candidate,
      human_checks: [{ criterion_id: 'human:1:bbbbbbbbbbbb', outcome: ['pass'], note: 'Inspected.' }] } },
    { readiness_decision: { command_id: 'C-4', request_revision: 1, input_hash: inputHash, assessment_id: 'assessment', proposal_id: 'proposal', decision: ['accepted'], note: 'Use this interpretation.' } },
    { criterion_decision: { command_id: 'C-5', request_revision: 1, run_id: 'run', candidate_commit: candidate, criterion_id: 'check:unit', kind: ['not_applicable'], reason: 'Inspected scope.' } },
  ];
  for (const field of fields) assert.throws(() => markdownCommands(parseFeature(note(field))), /action|decision|checks/);
  const valid = markdownCommands(parseFeature(note({ control: { command_id: 'C-6', action: 'cancel' } })));
  assert.equal(valid[0].action, 'cancel');
});

test('malformed reviewer finding types remain a provider protocol error before journal persistence', () => {
  for (const kind of [['question'], ['issue'], ['gap']]) {
    const text = JSON.stringify({ schemaVersion: 1, findings: [{ kind, message: 'Which behavior is required?', blocking: true }] });
    assert.throws(() => advisoryResult({ type: 'completed', text }, { kind: 'chat', title: 'Review', message: 'Describe the behavior.' }, 'ready', 'review'), { code: 'protocol' });
  }
});
