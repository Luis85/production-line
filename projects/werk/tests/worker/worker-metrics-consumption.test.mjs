import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../ui/helpers/frontend-loader.mjs';

const { consumptionAllocation, consumptionStateLabel, consumptionBlockedMessage } = await frontend('src/worker/webview/consumption-view.ts');

/** @returns {import('../../src/worker/application/consumption').ConsumptionStatus} */
function report() {
  return {
    schemaVersion: 1, policy: { enabled: true, period: 'daily', allowance: 1_000_000, workerPercent: 50, perRunReservation: 10_000 },
    trackingStartedAt: '2026-10-18T00:00:00Z', periodStart: '2026-10-18T00:00:00Z', periodEnd: '2026-10-19T00:00:00Z',
    workerAllowance: 500_000, measuredTokens: 125_000, reservedTokens: 10_000, chargedTokens: 135_000,
    remainingTokens: 365_000, activeInvocations: 1, uncertainInvocations: 0,
    blocked: false, reason: 'available', accountingAvailable: true,
  };
}

test('allowance chart distinguishes measured usage, reservations and remainder within the worker share', () => {
  const view = consumptionAllocation(report());
  assert.equal(view.measured, 125_000); assert.equal(view.reserved, 10_000); assert.equal(view.remaining, 365_000);
  assert.deepEqual(view.segments, { measured: 25, reserved: 2, remaining: 73 });
  assert.equal(view.aboveAllowance, 0);
});

test('accounting failure does not expose cached or fallback zeros as measured usage', () => {
  const value = report(); value.accountingAvailable = false; value.reason = 'accounting_unavailable'; value.blocked = true;
  assert.deepEqual(consumptionAllocation(value), { measured: null, reserved: null, remaining: null, aboveAllowance: null, segments: null });
  assert.equal(consumptionStateLabel(value), 'Accounting unavailable');
  assert.match(consumptionBlockedMessage(value), /New model calls are blocked/);
  assert.equal(consumptionAllocation(null).measured, null);
});

test('incomplete reports retain known usage and reservations without a verified remainder graphic', () => {
  const value = report(); value.uncertainInvocations = 1; value.reason = 'unmeasured_usage'; value.blocked = true;
  const view = consumptionAllocation(value);
  assert.equal(view.measured, 125_000); assert.equal(view.reserved, 10_000);
  assert.equal(view.remaining, null); assert.equal(view.segments, null);
  assert.match(consumptionBlockedMessage(value), /remaining allowance cannot be verified/);
});

test('disabled limits show recorded usage without a hypothetical remaining allowance or meter', () => {
  const value = report(); value.policy.enabled = false; value.reason = 'disabled';
  const view = consumptionAllocation(value);
  assert.equal(consumptionStateLabel(value), 'Limits off'); assert.equal(view.measured, 125_000);
  assert.equal(view.remaining, null); assert.equal(view.segments, null); assert.equal(view.aboveAllowance, null);
});

test('over-allocation keeps exact values instead of truncating the overrun at a full meter', () => {
  const value = report(); value.measuredTokens = 550_000; value.reservedTokens = 50_000; value.chargedTokens = 600_000;
  value.remainingTokens = 0; value.blocked = true; value.reason = 'exhausted';
  const view = consumptionAllocation(value);
  assert.equal(view.aboveAllowance, 100_000); assert.equal(view.measured, 550_000); assert.equal(view.reserved, 50_000);
  assert.equal(view.remaining, 0); assert.equal(view.segments.remaining, 0);
  assert.ok(Math.abs(view.segments.measured + view.segments.reserved - 100) < 0.00001);
  assert.equal(consumptionStateLabel(value), 'New model calls blocked');
});

test('a measured zero stays zero and insufficient reservations have actionable wording', () => {
  const value = report(); value.measuredTokens = 0; value.reservedTokens = 0; value.chargedTokens = 0;
  value.remainingTokens = value.workerAllowance;
  assert.deepEqual(consumptionAllocation(value).segments, { measured: 0, reserved: 0, remaining: 100 });
  value.reason = 'insufficient_reservation'; value.blocked = true;
  assert.match(consumptionBlockedMessage(value), /reservation for another model call/);
});
