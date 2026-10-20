import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessSupervisor } from '../../src/worker/dist/worker/application/process-supervisor.js';
import { defaultDeliveryRetention, validateDeliveryRetention } from '../../src/worker/dist/worker/application/delivery-retention.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot, validateDeliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';

/** @typedef {import('../../src/worker/application/process-supervision.ts').StoredService} StoredService */
/** @typedef {import('../../src/worker/application/process-supervision.ts').ServiceHostPort} Host */
/** @typedef {import('../../src/worker/application/process-supervision.ts').ServiceExit} Exit */
async function fixture(t, hours) {
  let now = Date.parse('2026-10-20T10:00:00Z');
  /** @type {StoredService[]} */ let saved = [];
  /** @type {Parameters<Host['start']>[0]|undefined} */ let launched;
  /** @type {PromiseWithResolvers<Exit>} */ const closed = Promise.withResolvers();
  const owner = await ProcessSupervisor.open({
    journal: { async load() { return []; }, async save(rows) { saved = structuredClone(rows); } },
    host: { start(input) { launched = input; return { started: Promise.resolve(), closed: closed.promise, async stop(reason) { closed.resolve({ code: null, reason }); } }; } },
    presets: () => [{ id: 'dev', name: 'Development', enabled: true, executable: process.execPath, args: ['server.js'], ttlMs: 10000, startupTimeoutMs: 1000, restart: { maxAttempts: 0, backoffMs: 100 } }],
    async validateScope() {}, now: () => now, temporaryLogHours: () => hours,
  });
  t.after(() => owner.close());
  const service = await owner.start({ operationId: 'start-test', presetId: 'dev', scope: { featureRequestKey: 'fr-' + 'a'.repeat(64), sessionId: 'session', worktree: '/owned/worktree', worktreeIdentity: { dev: '1', ino: '2', birthtimeMs: 1 } } });
  return { owner, service, advance: milliseconds => { now += milliseconds; },
    async output(text) { launched.onEvent({ type: 'output', stream: 'stdout', text }); await owner.reconcileGrants(); },
    saved: () => structuredClone(saved),
  };
}

test('retention distinguishes temporary logs from preserved accepted evidence and unaccepted work', () => {
  assert.deepEqual(defaultDeliveryRetention(), { temporaryLogHours: 168, acceptedEvidence: 'preserve', unacceptedWork: 'preserve' });
  for (const value of [-1, 721, 1.5, '24']) assert.throws(() => validateDeliveryRetention({ ...defaultDeliveryRetention(), temporaryLogHours: value }));
  for (const field of ['acceptedEvidence', 'unacceptedWork']) assert.throws(() => validateDeliveryRetention({ ...defaultDeliveryRetention(), [field]: 'expire' }));
  const policy = { ...defaultDeliveryProjectPolicy(), retention: { ...defaultDeliveryRetention(), temporaryLogHours: 0 } };
  const pinned = deliveryPolicySnapshot(policy, 'a'.repeat(40));
  assert.deepEqual(validateDeliveryPolicySnapshot(pinned), pinned);
  assert.equal(Object.hasOwn(deliveryPolicySnapshot(defaultDeliveryProjectPolicy(), 'a'.repeat(40)).configuration, 'retention'), false);
});

test('expired temporary logs are removed durably while service ownership and operation receipts remain', async t => {
  const f = await fixture(t, 1);
  await f.output('temporary diagnostic line\n');
  assert.equal(f.owner.logs(f.service.id).entries.length, 1);
  f.advance(3600001);
  await f.owner.reconcileGrants();
  const logs = f.owner.logs(f.service.id);
  assert.deepEqual(logs.entries, []); assert.equal(logs.gap, true); assert.equal(logs.nextAfter, 1); assert.equal(logs.temporaryLogHours, 1);
  const saved = f.saved();
  assert.equal(saved[0].logs.length, 0); assert.equal(saved[0].record.id, f.service.id);
  assert.equal(saved[0].operationId, 'start-test'); assert.equal(saved[0].scope.sessionId, 'session');
  assert.equal(saved[0].temporaryLogHours, 1);
});

test('zero temporary-log retention discards output without losing service status', async t => {
  const f = await fixture(t, 0);
  await f.output('do not retain this temporary line\n');
  assert.deepEqual(f.owner.logs(f.service.id).entries, []);
  assert.equal(f.saved()[0].logs.length, 0);
  assert.equal(f.owner.status().services[0].id, f.service.id);
});
