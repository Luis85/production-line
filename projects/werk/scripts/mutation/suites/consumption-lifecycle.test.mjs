import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkerConsumption, defaultConsumptionPolicy, consumptionWindow } from '../../../.mutation-build/worker/application/consumption.js';
import { WorkerConsumptionJournal } from '../../../.mutation-build/worker/infrastructure/journal/consumption.js';

/** @param {number | null} [inputTokens] @param {number | null} [outputTokens]
 * @returns {import('../../../src/worker/application/run-evidence.js').ProviderUsage} */
const usage = (inputTokens = 10, outputTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, source: 'provider_reported', reason: null });
const window = () => consumptionWindow('daily', new Date());
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-mutation-accounting-'));
  const ledger = new WorkerConsumptionJournal(directory);
  const policy = { ...defaultConsumptionPolicy(), enabled: true, allowance: 200, perRunReservation: 10 };
  const service = new WorkerConsumption(ledger, () => policy);
  t.after(async () => { ledger.close(); await rm(directory, { recursive: true, force: true }); });
  await service.init();
  return { directory, ledger, service, policy };
}

test('default clock records real admission time and service close releases its owned database', async t => {
  const { service, ledger } = await fixture(t), before = Date.now();
  const attempt = service.begin('provider');
  assert.ok(Date.parse(attempt.startedAt) >= before && Date.parse(attempt.startedAt) <= Date.now());
  service.close();
  assert.throws(() => ledger.summary(window()), /not open/);
});

test('unavailable storage during initialization latches admission and exposes complete empty evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-mutation-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'worker-consumption.sqlite'));
  const ledger = new WorkerConsumptionJournal(directory);
  const policy = { ...defaultConsumptionPolicy(), enabled: true, allowance: 200, perRunReservation: 10 };
  const service = new WorkerConsumption(ledger, () => policy);
  await assert.rejects(service.init(), /Consumption storage must be a regular file, not a symlink/);
  assert.throws(() => service.begin('provider'), /Restart the worker after repairing its private accounting storage/, 'initialization failure must latch before any status poll');
  const status = service.status();
  assert.equal(status.trackingStartedAt, null);
  for (const key of ['measuredTokens', 'reservedTokens', 'chargedTokens', 'activeInvocations', 'uncertainInvocations']) assert.equal(status[key], 0);
  assert.equal(status.remainingTokens, 100); assert.equal(status.accountingAvailable, false); assert.equal(status.blocked, true);
  assert.throws(() => service.begin('provider'), /Restart the worker after repairing its private accounting storage/);
});

test('provider validation rejects malformed identifiers before allocating any durable reservation', async t => {
  const { service } = await fixture(t);
  for (const provider of ['', '   ', 'a'.repeat(101), 'a\u0000b', 'a\u001fb']) assert.throws(() => service.begin(provider), { code: 'invalid_input', message: 'Choose a valid consumption provider.' });
  for (const provider of [null, false, 1, {}]) {
    // @ts-expect-error Deliberately malformed provider values exercise the runtime boundary.
    assert.throws(() => service.begin(provider), { code: 'invalid_input', message: 'Choose a valid consumption provider.' });
  }
  assert.equal(service.status().activeInvocations, 0);
  const attempt = service.begin('a'.repeat(100)); assert.equal(attempt.provider.length, 100); service.release(attempt.id);
});

test('observations stop only at an enabled allowance and terminal records cannot be rewritten', async t => {
  const { service, ledger, policy } = await fixture(t), attempt = service.begin('provider');
  assert.equal(service.observe(attempt.id, usage(1)), false);
  assert.equal(service.observe(attempt.id, usage(99)), false);
  assert.equal(service.observe(attempt.id, usage(100)), true);
  policy.enabled = false;
  assert.equal(service.observe(attempt.id, usage(101)), false);
  service.finish(attempt.id, usage(101));
  const completed = ledger.get(attempt.id);
  assert.equal(service.observe(attempt.id, usage(102)), false);
  service.release(attempt.id);
  assert.deepEqual(ledger.get(attempt.id), completed);
  const zero = service.begin('provider'); service.finish(zero.id, usage(0));
  service.release(zero.id); assert.equal(ledger.get(zero.id).state, 'complete');
});

test('storage read failure retains last known totals and tracking origin for operator diagnosis', async t => {
  const { service, ledger } = await fixture(t);
  service.finish(service.begin('provider').id, usage(15));
  const before = service.status();
  t.mock.method(ledger, 'summary', () => { throw Error('unreadable'); });
  const failed = service.status();
  assert.deepEqual(failed, { ...before, accountingAvailable: false, blocked: true, reason: 'accounting_unavailable' });
  assert.throws(() => service.begin('provider'), /Consumption accounting is unavailable/);
});

test('insufficient reservation reports a useful admission error without poisoning healthy storage', async t => {
  const { service, policy } = await fixture(t);
  service.finish(service.begin('provider').id, usage(91));
  assert.throws(() => service.begin('provider'), /remaining worker allowance is smaller than the per-run reservation/);
  policy.perRunReservation = 9;
  service.release(service.begin('provider').id);
  assert.equal(service.status().accountingAvailable, true);
});

test('journal initialization is idempotent and released records carry zero durable charge', async t => {
  const { service, ledger, directory } = await fixture(t);
  const attempt = service.begin('provider');
  await ledger.init();
  assert.equal(ledger.get(attempt.id).state, 'active');
  service.release(attempt.id);
  const database = new DatabaseSync(join(directory, 'worker-consumption.sqlite'));
  try { assert.equal(database.prepare('SELECT charged_tokens FROM consumption_invocations WHERE id=?').get(attempt.id)?.charged_tokens, 0); }
  finally { database.close(); }
  assert.throws(() => ledger.get('missing'), { code: 'not_found', message: 'Consumption invocation not found.' });
});

test('corrupt durable totals and missing metadata fail closed with actionable errors', async t => {
  const { service, ledger, directory } = await fixture(t), attempt = service.begin('provider');
  const database = new DatabaseSync(join(directory, 'worker-consumption.sqlite'));
  try {
    for (const charged of [-1, 0.5]) {
      database.prepare('UPDATE consumption_invocations SET charged_tokens=? WHERE id=?').run(charged, attempt.id);
      assert.throws(() => ledger.summary(window()), /Consumption totals exceed safe accounting bounds/);
    }
    database.prepare('UPDATE consumption_invocations SET charged_tokens=0 WHERE id=?').run(attempt.id);
    database.exec('DELETE FROM consumption_metadata');
    assert.throws(() => ledger.summary(window()), /Consumption tracking metadata is missing/);
  } finally { database.close(); }
});
