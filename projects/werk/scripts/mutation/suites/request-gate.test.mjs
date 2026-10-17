import { testErrorCode } from '../../../tests/helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequestGateEvidence } from '../../../.mutation-build/shared/request-gate.js';
const receipt = () => ({ schemaVersion: 1, requestId: 'request', revision: 2, inputDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), evaluationId: 'evaluation', stage: 'ready', status: 'passed', failedRules: 0, unknownRules: 0 });
const rejects = value => assert.throws(() => validateRequestGateEvidence(value), error => testErrorCode(error) === 'invalid_input');

test('gate receipts preserve validated values without exposing mutable input', () => {
  for (const stage of ['ready', 'done']) for (const revision of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const value = { ...receipt(), stage, revision }, result = validateRequestGateEvidence(value);
    assert.deepEqual(result, value); assert.notEqual(result, value);
    value.requestId = 'changed'; assert.equal(result.requestId, 'request');
  }
  for (const failedRules of [0, 1, 32, 33]) for (const unknownRules of [0, 1, 32, 33]) {
    const value = { ...receipt(), status: 'blocked', failedRules, unknownRules };
    if (failedRules + unknownRules > 0 && failedRules + unknownRules <= 33) assert.deepEqual(validateRequestGateEvidence(value), value);
    else rejects(value);
  }
});
test('gate receipts reject malformed identities, private fields, enums and inconsistent counts', () => {
  for (const value of [null, [], 1, 'receipt', { ...receipt(), schemaVersion: 2 }, { ...receipt(), findings: 'private' }]) rejects(value);
  for (const key of ['requestId', 'evaluationId']) for (const value of ['', ' padded ', 'path/request', null, ['request']]) rejects({ ...receipt(), [key]: value });
  for (const key of ['inputDigest', 'policyDigest']) for (const value of ['', 'a'.repeat(63), 'g'.repeat(64), null]) rejects({ ...receipt(), [key]: value });
  for (const key of ['stage', 'status']) for (const value of ['', null, 1, ['done'], { toString: () => 'done' }]) rejects({ ...receipt(), [key]: value });
  for (const key of ['revision', 'failedRules', 'unknownRules']) for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) rejects({ ...receipt(), [key]: value });
  for (const key of ['failedRules', 'unknownRules']) {
    rejects({ ...receipt(), status: 'blocked', [key]: 34 });
    rejects({ ...receipt(), [key]: 1 });
  }
  rejects({ ...receipt(), status: 'blocked' });
});

test('gate failures retain useful public diagnostics without exposing receipt input', () => {
  /** @type {[unknown, string][]} */
  const cases = [
    [{ ...receipt(), schemaVersion: 2 }, 'Invalid request gate receipt.'],
    [{ ...receipt(), requestId: ' padded ' }, 'Invalid gate receipt identity.'],
    [{ ...receipt(), revision: -1 }, 'Invalid gate receipt count.'],
    [{ ...receipt(), failedRules: 1 }, 'Gate receipt status must match its rule counts.'],
  ];
  for (const [value, message] of cases) assert.throws(() => validateRequestGateEvidence(value), { message });
  assert.throws(() => validateRequestGateEvidence(null), /Request gate evidence/);
});
