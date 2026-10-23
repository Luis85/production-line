import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSelection, selectedConnection, validateModelSelection } from '../../src/worker/dist/worker/application/model-selection.js';
import { providerEfforts, validateModelEffort } from '../../src/worker/dist/worker/application/model-effort.js';
import { providerIds, providerSupportsDefinition } from '../../src/worker/dist/worker/application/provider-contract.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { fixture as gateFixture } from './request-gate-fixtures.mjs';

/** @type {import('../../src/worker/application/provider-contract.ts').ProviderConnection} */
const connection = { id: 'openai-api', executable: '', apiKey: 'private-original', model: 'configured-model', effort: 'medium', instruction: 'Base instructions' };
/** @type {import('../../src/worker/application/definitions.ts').DefinitionSnapshot} */
const profile = { definitionId: 'profile', agent: 'root', name: 'Team profile', digest: 'a'.repeat(64), instruction: 'Team instructions', model: 'profile-model', provider: 'openai', unsupported: [], adapted: false };
const messages = [{ id: 'question', role: /** @type {const} */ ('user'), state: /** @type {const} */ ('complete'), at: '2026-10-18T00:00:00.000Z', text: 'Review the request.' }];

test('selection gives authored values precedence over compatible profile and connection defaults', () => {
  assert.deepEqual(modelSelection(connection), { provider: 'openai-api', model: 'configured-model', effort: 'medium' });
  assert.deepEqual(modelSelection(connection, {}, profile), { provider: 'openai-api', model: 'profile-model', effort: 'medium' });
  assert.deepEqual(modelSelection(connection, { model: 'explicit-model', effort: 'high' }, profile), { provider: 'openai-api', model: 'explicit-model', effort: 'high' });
  assert.equal(modelSelection(connection, { model: '', effort: '' }, profile).model, 'profile-model');
  assert.throws(() => modelSelection(connection, { model: 'explicit-model' }, { ...profile, provider: 'anthropic' }), /matching worker provider/);
  assert.equal(providerSupportsDefinition('cursor-cli', 'anthropic'), true);
  assert.equal(providerSupportsDefinition('cursor-cli', 'openai'), true);
});

test('accepted defaults stay fixed with rotated credentials and changed settings or profile models', () => {
  const accepted = modelSelection({ ...connection, effort: undefined }, {}, profile);
  const current = selectedConnection({ ...connection, apiKey: 'private-rotated', model: 'new-default', effort: 'max' }, accepted, { ...profile, model: 'new-profile-model' });
  assert.equal(current.apiKey, 'private-rotated'); assert.equal(current.model, 'profile-model');
  assert.equal(current.effort, 'default'); assert.equal(current.instruction, profile.instruction);
  assert.equal(JSON.stringify(accepted).includes('private'), false);
  assert.throws(() => selectedConnection({ ...connection, id: 'anthropic-api' }, accepted), /different provider/);
  const detached = validateModelSelection(accepted); detached.model = 'mutated'; assert.equal(accepted.model, 'profile-model');
});

test('provider effort capabilities reject unsupported levels and permit native defaults without inventing a model', () => {
  for (const id of providerIds) for (const effort of /** @type {const} */ (['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])) {
    if (providerEfforts[id].includes(effort)) assert.equal(validateModelEffort(effort, id), effort);
    else assert.throws(() => validateModelEffort(effort, id), /supported effort/);
  }
  const cursor = modelSelection({ ...connection, id: 'cursor-cli', model: '', effort: undefined });
  assert.deepEqual(cursor, { provider: 'cursor-cli', model: '', effort: 'default' });
  assert.throws(() => modelSelection({ ...connection, model: '' }), /Choose a model/);
  for (const patch of [{ provider: 'unknown' }, { effort: null }, { effort: undefined }, { model: ' padded' }, { model: '--force' }, { model: 'bad\nmodel' }, { model: 'x'.repeat(201) }, { privateKey: 'unexpected' }])
    assert.throws(() => validateModelSelection({ ...modelSelection(connection), ...patch }));
});

test('prepared request and reviewer journal retain effort and reject a changed reviewed selection', async t => {
  const { journal } = await gateFixture(t);
  const accepted = { id: 'openai-api', model: 'model-one', effort: /** @type {const} */ ('high'), instruction: 'Review instruction' };
  const request = journal.ensure({ owner: { sessionId: 'selection-session', rootTurnId: 'root' }, provider: accepted, input: { kind: 'chat', title: 'Clarify behavior', message: '' } });
  journal.evaluate(request.id, 'ready');
  const intent = journal.queuedReviews()[0]; assert.equal(intent.provider.effort, 'high');
  const model = { configuration: accepted, async reply() { throw Error('No model calls'); } };
  const dispatch = prepareModelRequest(model, messages); assert.equal(dispatch.provider.effort, 'high');
  assert.throws(() => journal.startReview(request.id, intent.id, 'review-run', { ...dispatch, provider: { ...dispatch.provider, effort: 'medium' } }), { code: 'conflict', message: 'Reviewer dispatch changed its frozen provider, model, effort or authentication mode.' });
  assert.equal(journal.queuedReviews().length, 1, 'rejected selection does not consume a queued review');
  journal.startReview(request.id, intent.id, 'review-run', dispatch);
  assert.equal(journal.get(request.id).reviews[0].dispatch?.provider.effort, 'high');
  const legacy = journal.ensure({ owner: { sessionId: 'legacy-session', rootTurnId: 'root' }, provider: { id: 'codex-cli', model: '', instruction: '' }, input: { kind: 'chat', title: 'Legacy request', message: '' } });
  journal.evaluate(legacy.id, 'ready'); const queued = journal.queuedReviews()[0];
  const legacyModel = { configuration: { ...queued.provider, effort: /** @type {const} */ ('default') }, async reply() { return ''; } };
  const native = prepareModelRequest(legacyModel, messages);
  assert.equal(journal.startReview(legacy.id, queued.id, 'legacy-run', native).status, 'running', 'legacy absent effort means native default');
});
