import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConsumptionPolicy, validateConsumptionPolicy, workerAllowance, measuredConsumption, completeConsumption, observeConsumption, consumptionStatus, consumptionWindow } from '../../../.mutation-build/worker/application/consumption.js';

/** @param {Partial<import('../../../src/worker/application/run-evidence.js').ProviderUsage>} [changes]
 * @returns {import('../../../src/worker/application/run-evidence.js').ProviderUsage} */
const usage = (changes = {}) => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, source: 'unavailable', reason: 'Unknown', ...changes });

/** @returns {import('../../../src/worker/application/consumption.js').ConsumptionSummary} */
const summary = () => ({ trackingStartedAt: '2026-10-01T00:00:00.000Z', measuredTokens: 0, reservedTokens: 0, chargedTokens: 0, activeInvocations: 0, uncertainInvocations: 0 });

test('allowances retain exact whole-token shares and validation rejects malformed configuration', () => {
  assert.deepEqual(defaultConsumptionPolicy(), { enabled: false, period: 'daily', allowance: 1000000, workerPercent: 50, perRunReservation: 10000 });
  for (const allowance of [1, 99, 100, 101, 199, Number.MAX_SAFE_INTEGER]) for (const workerPercent of [1, 33, 50, 99, 100]) {
    const expected = Number(BigInt(allowance) * BigInt(workerPercent) / 100n);
    assert.equal(workerAllowance({ ...defaultConsumptionPolicy(), allowance, workerPercent }), expected);
    if (expected > 0) {
      const policy = { ...defaultConsumptionPolicy(), allowance, workerPercent, perRunReservation: expected };
      const result = validateConsumptionPolicy(policy);
      assert.deepEqual(result, policy); assert.notEqual(result, policy);
    }
  }
  assert.throws(() => validateConsumptionPolicy(null), /Use the documented consumption policy fields/);
  assert.throws(() => validateConsumptionPolicy(Object.assign(() => {}, defaultConsumptionPolicy())), /Use the documented consumption policy fields/);
  assert.throws(() => validateConsumptionPolicy({}), /Set a positive whole-token allowance/);
  for (const value of [null, [], false, 1, 'policy', {}]) assert.throws(() => validateConsumptionPolicy(value), { code: 'invalid_input' });
  for (const key of ['allowance', 'workerPercent', 'perRunReservation']) for (const value of [-1, 0, 0.5, NaN, Infinity, '1', null]) assert.throws(() => validateConsumptionPolicy({ ...defaultConsumptionPolicy(), [key]: value }), { code: 'invalid_input' });
});

test('accounting accepts only bounded whole-token evidence and does not add cache counts twice', () => {
  for (const value of [0, 1, 1e12]) {
    const observed = usage({ inputTokens: value, outputTokens: value, cacheReadTokens: 999, cacheWriteTokens: 999 });
    assert.equal(measuredConsumption(observed), value * 2); assert.equal(completeConsumption(observed), true);
  }
  for (const value of [-1, 0.5, NaN, Infinity, 1e12 + 1, null]) {
    assert.equal(measuredConsumption(usage({ inputTokens: value, outputTokens: 3 })), 3);
    assert.equal(completeConsumption(usage({ inputTokens: value, outputTokens: 0 })), false);
    assert.equal(completeConsumption(usage({ inputTokens: 0, outputTokens: value })), false);
  }
});

test('cumulative token and cost evidence never regresses and preserves missing-value semantics', () => {
  const empty = observeConsumption(usage(), usage());
  assert.deepEqual(empty, { ...usage(), costBasis: 'unavailable', reason: 'The provider did not report complete token usage.' });
  for (const key of /** @type {const} */ (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])) {
    const previous = usage({ [key]: 7 });
    assert.equal(observeConsumption(usage(), previous)[key], 7);
    for (const value of [null, -1, 0.5, NaN, Infinity, 1e12 + 1, 3, 7, 8]) assert.equal(observeConsumption(previous, usage({ [key]: value }))[key], value === 8 ? 8 : 7);
    assert.equal(observeConsumption(usage(), usage({ [key]: 0 })).source, 'provider_reported');
    assert.equal(observeConsumption(usage(), usage({ [key]: null }))[key], null);
    assert.equal(observeConsumption(usage({ [key]: null }), usage({ [key]: null }))[key], null);
  }
  const billed = usage({ providerReportedCostUsd: 3, costBasis: 'reported_billed' });
  for (const value of [-1, NaN, Infinity, 1e9 + 1, null, 0, 2, 3, 4, 1e9]) {
    const result = observeConsumption(billed, usage({ providerReportedCostUsd: value }));
    assert.equal(result.providerReportedCostUsd, value === 4 || value === 1e9 ? value : 3);
    assert.equal(result.costBasis, 'reported_billed'); assert.equal(result.source, 'provider_reported'); assert.equal(result.reason, null);
  }
  assert.equal(observeConsumption(usage(), usage({ providerReportedCostUsd: -1 })).providerReportedCostUsd, null);
  assert.equal(observeConsumption(usage(), usage({ providerReportedCostUsd: 0 })).providerReportedCostUsd, 0);
  assert.equal(observeConsumption(usage(), usage({ providerReportedCostUsd: 0 })).costBasis, 'unknown');
  assert.equal(observeConsumption(billed, usage({ providerReportedCostUsd: 4, costBasis: 'reported_estimate' })).costBasis, 'reported_estimate');
});

test('status reports all budget evidence, exact reservation boundaries and safe blocking precedence', () => {
  const policy = { ...defaultConsumptionPolicy(), enabled: true, allowance: 200, perRunReservation: 10 };
  const window = consumptionWindow('daily', new Date('2026-10-17T00:00:00.000Z'));
  /** @type {[number, import('../../../src/worker/application/consumption.js').ConsumptionBlockReason, boolean][]} */
  const cases = [[0, 'available', false], [90, 'available', false], [91, 'insufficient_reservation', true], [100, 'exhausted', true], [101, 'exhausted', true]];
  for (const [chargedTokens, reason, blocked] of cases) {
    const evidence = { ...summary(), measuredTokens: 5, reservedTokens: 4, activeInvocations: 1, chargedTokens };
    const result = consumptionStatus(policy, window, evidence);
    assert.deepEqual(result, { schemaVersion: 1, policy, ...window, ...evidence, workerAllowance: 100, remainingTokens: Math.max(0, 100 - chargedTokens), reason, blocked, accountingAvailable: true });
    assert.notEqual(result.policy, policy);
  }
  const uncertain = { ...summary(), chargedTokens: 100, uncertainInvocations: 1 };
  assert.equal(consumptionStatus(policy, window, uncertain).reason, 'unmeasured_usage');
  assert.equal(consumptionStatus({ ...policy, enabled: false }, window, uncertain).reason, 'disabled');
  assert.equal(consumptionStatus({ ...policy, enabled: false }, window, uncertain).blocked, false);
});
