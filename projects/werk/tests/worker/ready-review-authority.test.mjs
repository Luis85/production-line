import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './ready-review-fixtures.mjs';
import { readyReviewProfile } from '../../src/worker/dist/worker/application/ready-review-selection.js';
import { validateReadyReviewInput } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
import { DomainError } from '../../src/worker/dist/shared/errors.js';
const authority = { repositoryId: 'shared', configurationDigest: 'a'.repeat(64) };
/** @returns {import('../../src/worker/application/definitions.js').DefinitionSnapshot} */
const definition = () => ({ definitionId: 'imported', ref: 'team-reviewer', agent: 'root', name: 'Team reviewer', digest: 'b'.repeat(64), instruction: 'Accepted team instructions.', model: '', provider: '', adapted: false, unsupported: [] });
/** @type {import('../../src/worker/application/provider-contract.js').ProviderConnection} */
const connection = { id: 'openai-api', executable: '', model: 'new-default', effort: 'high', authenticationMode: 'api-key', apiKey: 'not-sent', instruction: 'Current machine instruction.' };

test('Ready Check freezes imported profile instructions across scheduling, changes and reconstruction', async t => {
  let lookups = 0;
  const f = await fixture(t, { profile: value => readyReviewProfile(value, connection, () => { lookups++; return { ...definition(), instruction: 'Changed definition.' }; }) });
  const accepted = input(); accepted.definition = definition(); accepted.definitionRef = 'team-reviewer'; accepted.selection = { provider: 'openai-api', model: 'original-model', effort: 'default', authenticationMode: 'api-key' };
  const attempt = await f.schedule(accepted); await f.settle();
  assert.equal(f.calls[0].provider.instruction, 'Accepted team instructions.'); assert.equal(lookups, 0);
  assert.equal(f.calls[0].provider.model, 'original-model'); assert.equal(f.calls[0].provider.authenticationMode, 'api-key'); assert.equal(f.calls[0].policy.tools, 'none');
  await f.restart(); assert.deepEqual(await f.schedule(accepted), attempt); assert.equal(f.calls.length, 1);
  const next = { ...input('feature-one', 2), definition: definition(), selection: accepted.selection }; await f.schedule(next); await f.settle();
  assert.equal(f.calls[1].provider.instruction, 'Accepted team instructions.'); assert.equal(lookups, 0);
});
test('explicitly absent profile definition prevents later imported defaults and changed billing fails closed', () => {
  const accepted = input(); accepted.definition = null; accepted.definitionRef = 'later-reference'; accepted.selection = { provider: 'openai-api', model: 'original-model', effort: 'default', authenticationMode: 'api-key' };
  assert.equal(readyReviewProfile(accepted, connection, () => { throw Error('No mutable definition lookup is permitted'); }).instruction, connection.instruction);
  const legacy = input(); let lookups = 0; readyReviewProfile(legacy, connection, () => { lookups++; return definition(); }); assert.equal(lookups, 1);
  const subscription = { ...accepted, provider: /** @type {const} */ ('claude-cli'), selection: { provider: /** @type {const} */ ('claude-cli'), model: '', effort: /** @type {const} */ ('default'), authenticationMode: /** @type {const} */ ('cli-account') } };
  assert.throws(() => readyReviewProfile(subscription, { ...connection, id: 'claude-cli', authenticationMode: 'api-key' }, () => undefined), /authentication and billing changed/);
  assert.throws(() => validateReadyReviewInput({ ...accepted, definition: { ...definition(), digest: 'invalid' } }), /snapshot/);
  assert.throws(() => validateReadyReviewInput({ ...accepted, deliveryAuthority: { ...authority, repositoryId: 'other-project' } }), /accepted project/);
});
test('revoking the exact project while a Ready Check waits for capacity prevents its paid call and durable replay', async t => {
  let approved = true, inspected = 0;
  const f = await fixture(t, { authorize: value => { inspected++; assert.deepEqual(value, authority); if (!approved) throw new DomainError('conflict', 'The pinned project policy was revoked.'); } });
  const accepted = { ...input(), deliveryAuthority: authority };
  const release = await f.sessions.executor.acquire('implementation', new AbortController().signal);
  const attempt = await f.schedule(accepted); assert.equal(f.calls.length, 0); assert.equal(inspected, 1);
  approved = false; release(); await f.settle();
  assert.equal(f.calls.length, 0); assert.equal(f.manager.inspect(accepted).state, 'failed'); assert.equal(f.manager.inspect(accepted).error, 'conflict');
  assert.equal(f.sessions.runs.get(attempt.runId).outcome, 'failed'); assert.equal(f.consumption.status().measuredTokens, 0);
  assert.deepEqual(await f.schedule(accepted), attempt); assert.equal(f.calls.length, 0);
  await assert.rejects(f.schedule({ ...input('new-generation', 2), deliveryAuthority: authority }), /revoked/);
  approved = true; await f.schedule({ ...input('new-generation', 2), deliveryAuthority: authority }); await f.settle(); assert.equal(f.calls.length, 1);
});
test('expanded Ready Check authority cannot dispatch through a composition without an approval checker', async t => {
  const f = await fixture(t); await assert.rejects(f.schedule({ ...input(), deliveryAuthority: authority }), /cannot be verified/); assert.equal(f.calls.length, 0); assert.equal(f.manager.active, 0);
});
