import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, WorkerDefinitions } from '../../src/worker/dist/worker/application/definitions.js';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';

const snapshot = () => ({ definitionId: 'reviewer', name: 'Reviewer', digest: 'a'.repeat(64), agent: 'root', instruction: 'Review the feature.', model: '', provider: '', unsupported: [], adapted: false });
const savedDefinition = () => ({
  id: 'reviewer', ref: 'project-reviewer', name: 'Reviewer', digest: 'a'.repeat(64), createdAt: '2026-10-21T12:00:00.000Z',
  agents: [{ name: 'root', description: '', instruction: 'Review the feature.', model: '', provider: '', unsupported: [], requiresAdaptation: false }],
});

/** @param {unknown} value */
function catalog(value) {
  return new WorkerDefinitions({ async read() { return JSON.stringify(value); }, async write() { assert.fail('Restoring definitions must not write.'); } });
}

// These values arrive from persisted JSON, not from the typed application API.
test('saved definition snapshots reject coercible provider values and retain supported string values', () => {
  for (const provider of [['openai'], ['anthropic'], [], {}, null, false, 0]) {
    assert.throws(() => validateSnapshot({ ...snapshot(), provider }), error => testErrorCode(error) === 'invalid_input');
  }
  for (const provider of ['', 'openai', 'anthropic']) assert.doesNotThrow(() => validateSnapshot({ ...snapshot(), provider }));
});

test('malformed persisted definitions fail with a domain error before exposing a partial catalog', async () => {
  const valid = savedDefinition();
  for (const value of [null, [], 7, { ...valid, agents: [null] }, { ...valid, agents: [[]] },
    { ...valid, agents: [{ ...valid.agents[0], provider: ['openai'] }] },
    { ...valid, agents: [{ ...valid.agents[0], unsupported: null }] },
    { ...valid, createdAt: [valid.createdAt] }, { ...valid, updatedAt: [valid.createdAt] },
    { ...valid, ref: ['project-reviewer'] }]) {
    const definitions = catalog([valid, value]);
    await assert.rejects(definitions.init(), error => testErrorCode(error) === 'invalid_input');
    assert.deepEqual(definitions.view().definitions, []);
  }
});

test('definition restoration preserves immutable agent selections and rejects duplicate identities', async () => {
  const valid = savedDefinition(), definitions = catalog([valid]);
  await definitions.init();
  const selected = definitions.select({ definitionRef: 'project-reviewer' });
  assert.ok(selected);
  selected.instruction = 'Caller edit';
  assert.equal(definitions.select({ definitionRef: 'project-reviewer' })?.instruction, 'Review the feature.');
  for (const values of [[valid, valid], [valid, { ...valid, id: 'second' }], [{ ...valid, agents: [...valid.agents, ...valid.agents] }]]) {
    await assert.rejects(catalog(values).init(), error => testErrorCode(error) === 'invalid_input');
  }
});
