import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkerConsumption, defaultConsumptionPolicy, validateConsumptionPolicy, consumptionWindow, workerAllowance } from '../../src/worker/dist/worker/application/consumption.js';
import { WorkerConsumptionJournal } from '../../src/worker/dist/worker/infrastructure/journal/consumption.js';
import { unknownUsage } from '../../src/worker/dist/worker/application/run-evidence.js';

const usage = (inputTokens = 30, outputTokens = 20, extra = {}) => ({ ...unknownUsage(), source: 'provider_reported', inputTokens, outputTokens, ...extra });
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-consumption-'));
  let policy = validateConsumptionPolicy({ ...defaultConsumptionPolicy(), enabled: true, allowance: 1000, perRunReservation: 100, ...overrides });
  let now = new Date('2026-10-16T12:00:00.000Z');
  const journals = [];
  const create = async () => {
    const ledger = new WorkerConsumptionJournal(directory); journals.push(ledger);
    const service = new WorkerConsumption(ledger, () => policy, () => now); await service.init();
    return { ledger, service };
  };
  t.after(async () => { for (const journal of journals) journal.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, ...await create(), create, policy: value => { policy = validateConsumptionPolicy({ ...policy, ...value }); }, time: value => { now = new Date(value); } };
}

test('policy validates the configured share and rounds whole tokens without integer overflow', () => {
  assert.equal(workerAllowance(validateConsumptionPolicy({ ...defaultConsumptionPolicy(), allowance: 101, workerPercent: 50, perRunReservation: 50 })), 50);
  assert.equal(workerAllowance({ ...defaultConsumptionPolicy(), allowance: Number.MAX_SAFE_INTEGER, workerPercent: 100 }), Number.MAX_SAFE_INTEGER);
  assert.equal(workerAllowance({ ...defaultConsumptionPolicy(), allowance: Number.MAX_SAFE_INTEGER, workerPercent: 50 }), Math.floor(Number.MAX_SAFE_INTEGER / 2));
  for (const change of [{ enabled: 'true' }, { period: 'weekly' }, { allowance: 0 }, { allowance: 1.5 }, { allowance: Number.MAX_SAFE_INTEGER + 1 }, { workerPercent: 0 }, { workerPercent: 101 }, { workerPercent: 50.5 }, { perRunReservation: 0 }, { perRunReservation: 500001 }, { anotherField: true }]) {
    assert.throws(() => validateConsumptionPolicy({ ...defaultConsumptionPolicy(), ...change }), { code: 'invalid_input' });
  }
});

test('daily and monthly windows use UTC calendar boundaries including leap days and year rollover', () => {
  assert.deepEqual(consumptionWindow('daily', new Date('2024-02-29T23:59:59.999Z')), { periodStart: '2024-02-29T00:00:00.000Z', periodEnd: '2024-03-01T00:00:00.000Z' });
  assert.deepEqual(consumptionWindow('monthly', new Date('2026-12-31T23:00:00.000Z')), { periodStart: '2026-12-01T00:00:00.000Z', periodEnd: '2027-01-01T00:00:00.000Z' });
});

test('50 percent allocation reserves before dispatch and releases unused known consumption exactly once', async t => {
  const { service } = await fixture(t);
  assert.equal(service.status().workerAllowance, 500);
  const attempt = service.begin('codex-cli');
  assert.equal(service.status().reservedTokens, 100);
  assert.equal(service.status().remainingTokens, 400);
  service.observe(attempt.id, usage(30, 20, { cacheReadTokens: 25, cacheWriteTokens: 5 }));
  assert.equal(service.status().measuredTokens, 50, 'cache counts are already included in input tokens');
  assert.equal(service.status().reservedTokens, 50);
  service.finish(attempt.id, usage()); service.finish(attempt.id, usage(100, 100));
  assert.equal(service.status().chargedTokens, 50);
  assert.equal(service.status().remainingTokens, 450);
  assert.equal(service.status().activeInvocations, 0);
});

test('atomic reservations prevent separate callers from spending the same remaining allowance', async t => {
  const f = await fixture(t, { allowance: 200, perRunReservation: 100 });
  const other = await f.create();
  const attempt = f.service.begin('claude-cli');
  assert.throws(() => other.service.begin('openai-api'), { code: 'conflict' });
  f.service.finish(attempt.id, usage(10, 0));
  assert.equal(other.service.status().reason, 'insufficient_reservation');
  assert.equal(other.service.status().remainingTokens, 90);
  f.policy({ perRunReservation: 90 });
  const second = other.service.begin('openai-api');
  assert.equal(f.service.status().remainingTokens, 0);
  other.service.finish(second.id, usage(50, 40));
  assert.equal(f.service.status().reason, 'exhausted');
});

for (const [name, final, complete] of [
  ['unreported result', unknownUsage(), true], ['partial result', usage(20, null), true],
  ['failed invocation after partial observation', usage(), false], ['invalid counter', usage(-1, 20), true],
]) test(name + ' blocks subsequent enabled invocations until the UTC window changes', async t => {
  const f = await fixture(t), attempt = f.service.begin('codex-cli');
  f.service.observe(attempt.id, usage()); f.service.finish(attempt.id, final, complete);
  assert.equal(f.service.status().uncertainInvocations, 1);
  assert.equal(f.service.status().reason, 'unmeasured_usage');
  assert.equal(f.service.status().chargedTokens, 100);
  assert.throws(() => f.service.begin('claude-cli'), /incomplete usage/);
  f.policy({ allowance: 1000000 });
  assert.equal(f.service.status().reason, 'unmeasured_usage', 'raising the budget does not erase missing evidence');
  f.time('2026-10-17T00:00:00.000Z');
  assert.equal(f.service.status().reason, 'available');
  assert.equal(f.service.status().chargedTokens, 0);
  f.service.release(f.service.begin('claude-cli').id);
});

test('interrupted reservations survive restart, even when an intermediate observation had complete counters', async t => {
  const f = await fixture(t), attempt = f.service.begin('codex-cli');
  f.service.observe(attempt.id, usage(120, 20)); f.service.close();
  const recovered = await f.create();
  assert.equal(recovered.service.status().activeInvocations, 0);
  assert.equal(recovered.service.status().uncertainInvocations, 1);
  assert.equal(recovered.service.status().measuredTokens, 140);
  assert.equal(recovered.service.status().chargedTokens, 140);
  assert.equal(recovered.service.status().reason, 'unmeasured_usage');
});

test('known consumption persists across restart and disabling, enabling or changing the share never resets it', async t => {
  const f = await fixture(t);
  f.service.finish(f.service.begin('claude-cli').id, usage(200, 100));
  const started = f.service.status().trackingStartedAt; f.service.close();
  const restarted = await f.create();
  assert.equal(restarted.service.status().trackingStartedAt, started);
  assert.equal(restarted.service.status().chargedTokens, 300);
  f.policy({ enabled: false });
  const unlimited = restarted.service.begin('openai-api');
  assert.equal(unlimited.reservedTokens, 0);
  restarted.service.finish(unlimited.id, usage(120, 80));
  assert.equal(restarted.service.status().reason, 'disabled');
  f.policy({ enabled: true });
  assert.equal(restarted.service.status().reason, 'exhausted');
  f.policy({ workerPercent: 100 });
  assert.equal(restarted.service.status().chargedTokens, 500);
  assert.equal(restarted.service.status().remainingTokens, 500);
});

test('unknown usage while disabled is retained and blocks later enabled accounting', async t => {
  const f = await fixture(t, { enabled: false });
  f.service.finish(f.service.begin('codex-cli').id);
  assert.equal(f.service.status().reason, 'disabled');
  f.policy({ enabled: true });
  assert.equal(f.service.status().reason, 'unmeasured_usage');
});

test('changing daily to monthly includes earlier days without deleting the previous window', async t => {
  const f = await fixture(t);
  f.time('2026-10-15T23:59:00.000Z');
  const first = f.service.begin('codex-cli');
  f.time('2026-10-16T00:01:00.000Z');
  f.service.finish(first.id, usage(200, 100));
  assert.equal(f.service.status().chargedTokens, 0, 'usage stays in its admission window across midnight');
  f.service.finish(f.service.begin('codex-cli').id, usage(100, 50));
  f.policy({ period: 'monthly' });
  assert.equal(f.service.status().chargedTokens, 450);
  assert.equal(f.service.status().reason, 'insufficient_reservation');
  f.policy({ period: 'daily' });
  assert.equal(f.service.status().chargedTokens, 150);
  f.time('2026-10-15T23:59:30.000Z');
  assert.equal(f.service.status().chargedTokens, 300);
});

test('cumulative observations cannot regress, double count, or erase consumed tokens on cancellation', async t => {
  const { service } = await fixture(t), attempt = service.begin('anthropic-api');
  service.observe(attempt.id, usage(100, 10)); service.observe(attempt.id, usage(100, 20));
  service.observe(attempt.id, usage(50, 5)); service.observe(attempt.id, unknownUsage());
  assert.equal(service.status().measuredTokens, 120);
  service.finish(attempt.id, usage(0, 0), false);
  assert.equal(service.status().chargedTokens, 120);
  assert.equal(service.status().reason, 'unmeasured_usage');
});

test('a final provider report may exceed the allocation and is fully charged before later admission is denied', async t => {
  const { service } = await fixture(t), attempt = service.begin('claude-cli');
  assert.equal(service.observe(attempt.id, usage(400, 200)), true);
  service.finish(attempt.id, usage(400, 200));
  assert.equal(service.status().chargedTokens, 600);
  assert.equal(service.status().remainingTokens, 0);
  assert.equal(service.status().reason, 'exhausted');
  assert.throws(() => service.begin('claude-cli'), /used its configured token allowance/);
});

test('only a never-dispatched reservation can be released without consumption evidence', async t => {
  const { service } = await fixture(t);
  const skipped = service.begin('codex-cli'); service.release(skipped.id); service.release(skipped.id);
  assert.equal(service.status().chargedTokens, 0);
  const observed = service.begin('claude-cli'); service.observe(observed.id, usage(0, 0));
  assert.throws(() => service.release(observed.id), /observed usage/);
  service.finish(observed.id, usage(0, 0));
  assert.equal(service.status().chargedTokens, 0);
  assert.equal(service.status().reason, 'available');
});

test('storage mutation failure is latched, retains the durable reservation and fails closed until restart', async t => {
  const f = await fixture(t), attempt = f.service.begin('codex-cli');
  const mocked = t.mock.method(f.ledger, 'save', () => { throw Error('disk full'); });
  assert.throws(() => f.service.finish(attempt.id, usage()), /disk full/);
  mocked.mock.restore();
  assert.equal(f.service.status().reason, 'accounting_unavailable');
  assert.equal(f.service.status().accountingAvailable, false);
  f.policy({ enabled: false });
  assert.throws(() => f.service.begin('codex-cli'), { code: 'unavailable' });
  f.service.close(); const recovered = await f.create();
  assert.equal(recovered.service.status().accountingAvailable, true);
  assert.equal(recovered.service.status().uncertainInvocations, 1);
});

test('status read failures report unavailable instead of throwing into scheduler or HTTP polling', async t => {
  const f = await fixture(t, { enabled: false });
  t.mock.method(f.ledger, 'summary', () => { throw Error('unreadable database'); });
  assert.equal(f.service.status().blocked, true);
  assert.equal(f.service.status().accountingAvailable, false);
  assert.equal(f.service.status().reason, 'accounting_unavailable');
  assert.throws(() => f.service.begin('codex-cli'), { code: 'unavailable' });
});

test('consumption journal uses private permissions and closes failed initialization', async t => {
  const f = await fixture(t);
  if (process.platform !== 'win32') assert.equal((await lstat(join(f.directory, 'worker-consumption.sqlite'))).mode & 0o777, 0o600);
  f.service.close();
  const close = DatabaseSync.prototype.close, execute = DatabaseSync.prototype.exec;
  let closed = 0;
  const failing = new WorkerConsumptionJournal(f.directory);
  t.mock.method(DatabaseSync.prototype, 'close', function () { closed++; close.call(this); });
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) { if (sql.includes('CREATE TABLE')) throw Error('schema failure'); return execute.call(this, sql); });
  await assert.rejects(failing.init(), /schema failure/);
  assert.equal(closed, 1);
  mocked.mock.restore(); await failing.init(); failing.close();
  assert.equal(closed, 2);
});


test('continuing an invocation across midnight cannot borrow the next calendar allowance', async t => {
  const f = await fixture(t);
  f.time('2026-10-16T23:59:59.000Z');
  const attempt = f.service.begin('openai-api');
  f.time('2026-10-17T00:00:01.000Z');
  assert.equal(f.service.observe(attempt.id, usage(400, 100)), true);
  assert.equal(f.service.status().measuredTokens, 0);
  f.service.finish(attempt.id, usage(400, 100));
  assert.equal(f.service.status().reason, 'available');
  f.policy({ period: 'monthly' });
  assert.equal(f.service.status().reason, 'exhausted');
});

test('unsafe stored totals fail closed instead of rounding the available allowance', async t => {
  const f = await fixture(t);
  const attempt = f.service.begin('codex-cli');
  const database = new DatabaseSync(join(f.directory, 'worker-consumption.sqlite'));
  try { database.prepare('UPDATE consumption_invocations SET charged_tokens=? WHERE id=?').run(9007199254740992n, attempt.id); }
  finally { database.close(); }
  assert.equal(f.service.status().reason, 'accounting_unavailable');
  assert.throws(() => f.service.begin('codex-cli'), { code: 'unavailable' });
});

test('a missing durable invocation fails closed even when storage reports a domain error', async t => {
  const { service } = await fixture(t);
  assert.throws(() => service.observe('missing', usage()), { code: 'not_found' });
  assert.equal(service.status().reason, 'accounting_unavailable');
  assert.throws(() => service.begin('codex-cli'), { code: 'unavailable' });
});
