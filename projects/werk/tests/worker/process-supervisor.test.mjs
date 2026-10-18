import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessSupervisor } from '../../src/worker/dist/worker/application/process-supervisor.js';
import { serviceLimits, validateServicePreset } from '../../src/worker/dist/worker/application/service-policy.js';

/** @typedef {import('../../src/worker/application/process-supervision.ts').StoredService} StoredService */
/** @typedef {import('../../src/worker/application/process-supervision.ts').ServiceHostPort} Host */
/** @typedef {import('../../src/worker/application/process-supervision.ts').ServiceExit} Exit */
const preset = (patch = {}) => ({ id: 'dev', name: 'Development server', enabled: true, executable: process.execPath, args: ['server.js'], ttlMs: 10000, startupTimeoutMs: 1000, restart: { maxAttempts: 2, backoffMs: 100 }, ...patch });
const scope = (char = 'a') => ({ featureRequestKey: 'fr-' + char.repeat(64), sessionId: 'session-a', worktree: '/project/worktree', worktreeIdentity: { dev: '1', ino: '2', birthtimeMs: 0 } });
const command = (row, operationId = 'command-1') => ({ id: row.id, expectedRevision: row.revision, operationId });
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } assert.fail('The expected supervisor transition did not arrive.'); };
async function fixture(t, changes = {}) {
  /** @type {StoredService[]} */ let saved = [];
  /** @type {Array<{input:Parameters<Host['start']>[0],finish:(exit:Exit)=>void,stops:string[]}>} */ const launched = [];
  let presets = [preset(changes.preset)], failSave = false, scopeValid = true, validations = 0, maximum = 4;
  const journal = { async load() { return structuredClone(saved); }, async save(rows) { if (failSave) throw Error('disk unavailable'); saved = structuredClone(rows); } };
  /** @type {Host} */ const host = { start(input) {
    const closed = Promise.withResolvers(); const stops = [];
    launched.push({ input, finish: closed.resolve, stops });
    return { started: Promise.resolve(), closed: closed.promise, async stop(reason) { stops.push(reason); closed.resolve({ code: null, reason }); } };
  } };
  const owner = await ProcessSupervisor.open({ journal, host, presets: () => presets, maxActive: () => maximum, async validateScope() { validations++; if (!scopeValid) throw Error('changed worktree'); } });
  t.after(() => owner.close().catch(() => {}));
  return { owner, launched, journal, get saved() { return saved; }, get validations() { return validations; }, setPresets(value) { presets = value; }, setValid(value) { scopeValid = value; }, setMaximum(value) { maximum = value; }, failSave() { failSave = true; }, start(operationId = 'start-1', char = 'a') { return owner.start({ operationId, presetId: 'dev', scope: scope(char) }); } };
}

test('service presets are explicit bounded grants and browser-portable data', () => {
  assert.deepEqual(validateServicePreset(preset()), preset());
  for (const patch of [{ executable: 'node' }, { ttlMs: serviceLimits.maxTtlMs + 1 }, { restart: { maxAttempts: 6, backoffMs: 100 } }, { args: ['x\nsecret'] }, { readyText: '' }, { startupTimeoutMs: 11000 }, { cwd: '/elsewhere' }]) assert.throws(() => validateServicePreset(preset(patch)));
});

test('start is durable, same-FR scoped, idempotent and capacity bounded', async t => {
  const f = await fixture(t); f.setMaximum(1);
  const row = await f.start(); assert.equal(row.state, 'running'); assert.equal(row.readiness, 'not_configured'); assert.equal(row.restartLimit, 2);
  assert.equal(f.launched.length, 1); assert.equal(f.saved[0].record.id, row.id); assert.equal(f.launched[0].input.scope.featureRequestKey, scope().featureRequestKey);
  assert.deepEqual(await f.start(), row); await assert.rejects(f.start('start-1', 'b'), /different request/);
  await assert.rejects(f.start('other', 'b'), /slots/); assert.equal(f.launched.length, 1);
  assert.equal(JSON.stringify(f.owner.status()).includes('/project/worktree'), false);
  assert.equal(JSON.stringify(f.owner.status()).includes(process.execPath), false);
});

test('disabled presets, missing canonical scope and validation failures never launch', async t => {
  const f = await fixture(t); f.setPresets([]);
  await assert.rejects(f.start(), /not currently granted/);
  f.setPresets([preset()]); await assert.rejects(f.owner.start({ operationId: 'start', presetId: 'dev', scope: { ...scope(), featureRequestKey: 'freeform' } }), /canonical Feature Request/);
  f.setValid(false); await assert.rejects(f.start(), /changed worktree/); assert.equal(f.launched.length, 0);
});

test('readiness is literal and independent of liveness; bounded logs report cursor gaps', async t => {
  const f = await fixture(t, { preset: { readyText: 'Listening.*:3000' } }); const row = await f.start(); const send = f.launched[0].input.onEvent;
  send({ type: 'output', stream: 'stdout', text: 'Listening' }); assert.equal(f.owner.status().services[0].readiness, 'waiting');
  send({ type: 'output', stream: 'stdout', text: '.*:3000' }); assert.equal(f.owner.status().services[0].readiness, 'reported');
  for (let i = 0; i < 200; i++) send({ type: 'output', stream: 'stderr', text: '🙂'.repeat(100) });
  const logs = f.owner.logs(row.id, { after: 0, limit: 128 }); assert.equal(logs.gap, true); assert.ok(logs.entries.length <= 128); assert.ok(logs.entries.reduce((n, entry) => n + Buffer.byteLength(entry.text), 0) <= 16384);
});

test('restart drains the old handle, preserves TTL and replays an acknowledged command once', async t => {
  const f = await fixture(t); const row = await f.start(); const input = command(row, 'restart-1');
  const next = await f.owner.restart(input); assert.equal(next.generation, 2); assert.equal(next.restartCount, 1); assert.equal(next.expiresAt, row.expiresAt); assert.deepEqual(f.launched[0].stops, ['operator']);
  assert.deepEqual(await f.owner.restart(input), next); assert.equal(f.launched.length, 2);
  await assert.rejects(f.owner.stop(input), /different command/); await assert.rejects(f.owner.stop(command(row, 'stale')), /changed/);
  const stop = command(next, 'stop-1'); const ended = await f.owner.stop(stop); assert.equal(ended.state, 'stopped'); assert.deepEqual(await f.owner.stop(stop), ended); assert.deepEqual(f.launched[1].stops, ['operator']);
});

test('automatic failures consume a bounded restart budget; revoked grants stop backoff', async t => {
  const f = await fixture(t, { preset: { restart: { maxAttempts: 1, backoffMs: 100 } } }); await f.start();
  f.launched[0].finish({ code: 1, reason: 'exit' }); await until(() => f.launched.length === 2);
  f.launched[1].finish({ code: 1, reason: 'exit' }); await until(() => f.owner.status().services[0].state === 'failed'); assert.equal(f.owner.status().services[0].restartCount, 1);
  const other = await fixture(t); await other.start(); other.launched[0].finish({ code: 1, reason: 'exit' }); await until(() => other.owner.status().services[0].state === 'restarting');
  other.setPresets([]); await other.owner.reconcileGrants(); await delay(120); assert.equal(other.launched.length, 1); assert.equal(other.owner.status().services[0].lastExit.reason, 'revoked');
});

test('changed worktree or preset prevents restart without expanding its original grant', async t => {
  const f = await fixture(t); const row = await f.start(); f.setValid(false);
  const stopped = await f.owner.restart(command(row)); assert.equal(stopped.state, 'failed'); assert.equal(f.launched.length, 1); assert.deepEqual(f.launched[0].stops, ['operator']);
  const other = await fixture(t); const original = await other.start(); other.setPresets([preset({ args: ['different.js'] })]);
  const denied = await other.owner.restart(command(original)); assert.equal(denied.state, 'failed'); assert.equal(other.launched.length, 1);
});

test('startup timeout, feature end and shutdown wait for actual host closure', async t => {
  const f = await fixture(t, { preset: { readyText: 'ready', startupTimeoutMs: 100 } }); await f.start();
  await until(() => f.owner.status().services[0].state === 'stopped'); assert.equal(f.owner.status().services[0].readiness, 'timed_out'); assert.deepEqual(f.launched[0].stops, ['startup_timeout']);
  const other = await fixture(t); await other.start(); await other.start('second', 'b'); await other.owner.stopFeature(scope().featureRequestKey); assert.deepEqual(other.launched[0].stops, ['feature_ended']); assert.deepEqual(other.launched[1].stops, []);
  await other.owner.close(); assert.deepEqual(other.launched[1].stops, ['shutdown']); await assert.rejects(other.start('late', 'c'), /stopping/);
});

test('known zero measurements remain zero; missing and stale groups retain explicit coverage', async t => {
  const f = await fixture(t); await f.start(); await f.start('second', 'b');
  f.launched[0].input.onEvent({ type: 'measurement', value: { scope: 'owned_service_process_group', platform: 'linux', capturedAt: new Date().toISOString(), cpuTotalMicros: 0, rssBytes: 0, processCount: 1, coverage: 'complete_group', unavailableReason: null } });
  const status = f.owner.status(); assert.equal(status.summary.rssBytes, 0); assert.equal(status.summary.cpuTotalMicros, 0); assert.equal(status.summary.coverage, 'partial'); assert.equal(status.summary.measuredGroups, 1);
  f.launched[0].input.onEvent({ type: 'measurement', value: { ...status.services[0].measurement, capturedAt: new Date(Date.now() - 20000).toISOString() } }); assert.equal(f.owner.status().summary.coverage, 'unavailable'); assert.equal(f.owner.status().summary.rssBytes, null);
});

test('journal recovery never reattaches historical processes and storage failure stops live leases', async t => {
  const f = await fixture(t); await f.start(); let calls = 0;
  const restored = await ProcessSupervisor.open({ journal: f.journal, host: { start() { calls++; throw Error('never'); } }, presets: () => [preset()], async validateScope() {} });
  t.after(() => restored.close().catch(() => {})); assert.equal(restored.status().services[0].state, 'interrupted'); assert.equal(calls, 0);
  f.failSave(); await assert.rejects(f.owner.stop(command(f.owner.status().services[0])), /journal/); assert.deepEqual(f.launched[0].stops, ['storage_failed']); assert.equal(f.owner.status().persistenceError, true); await assert.rejects(f.start('later', 'b'), /journal/);
});

test('lost host ownership is interrupted and never automatically re-adopted or restarted', async t => {
  const f = await fixture(t); await f.start(); f.launched[0].finish({ code: null, reason: 'host_lost' });
  await until(() => f.owner.status().services[0].state === 'interrupted'); await delay(120); assert.equal(f.launched.length, 1); assert.match(f.owner.status().services[0].error, /could not be confirmed/);
});

test('control availability explains current grant, scope, capacity and lifetime restrictions', async t => {
  const f = await fixture(t); const row = await f.start(); assert.deepEqual(await f.owner.controls(row.id), { stop: true, restart: true, restartUnavailableReason: null });
  f.setValid(false); assert.match((await f.owner.controls(row.id)).restartUnavailableReason, /pinned worktree/);
  f.setValid(true); f.setPresets([]); const revoked = await f.owner.controls(row.id); assert.equal(revoked.stop, true); assert.equal(revoked.restart, false); assert.match(revoked.restartUnavailableReason, /not currently granted/);
  const other = await fixture(t, { preset: { restart: { maxAttempts: 0, backoffMs: 100 } } }); const limited = await other.start(); assert.match((await other.owner.controls(limited.id)).restartUnavailableReason, /budget/);
  await assert.rejects(other.owner.restart(command(limited)), /budget/); assert.equal(other.saved[0].commands.length, 0, 'A rejected command must not poison operation replay.');
});

test('stop and feature cleanup never acknowledge completion before the host closes', async t => {
  const closed = Promise.withResolvers(); let requested = false;
  const owner = await ProcessSupervisor.open({ journal: { async load() { return []; }, async save() {} }, host: { start() { return { started: Promise.resolve(), closed: closed.promise, async stop() { requested = true; } }; } }, presets: () => [preset()], async validateScope() {} });
  t.after(() => { closed.resolve({ code: null, reason: 'shutdown' }); return owner.close(); });
  const row = await owner.start({ operationId: 'start', presetId: 'dev', scope: scope() }); let completed = false;
  const stopping = owner.stop(command(row)).then(value => { completed = true; return value; });
  await until(() => requested); assert.equal(completed, false); assert.equal(owner.status().services[0].state, 'stopping');
  closed.resolve({ code: null, reason: 'operator' }); assert.equal((await stopping).state, 'stopped');
});

test('feature stop waits for an in-flight launch and cannot miss its new process', async t => {
  const launching = Promise.withResolvers(), launch = Promise.withResolvers(), closed = Promise.withResolvers(); const stops = [];
  const owner = await ProcessSupervisor.open({ journal: { async load() { return []; }, async save() {} }, host: { start() { launching.resolve(); return { started: launch.promise, closed: closed.promise, async stop(reason) { stops.push(reason); closed.resolve({ code: null, reason }); } }; } }, presets: () => [preset()], async validateScope() {} });
  t.after(() => { launch.resolve(); return owner.close(); });
  const started = owner.start({ operationId: 'start', presetId: 'dev', scope: scope() }); await launching.promise;
  const stopped = owner.stopFeature(scope().featureRequestKey); launch.resolve(); await started; await stopped;
  assert.deepEqual(stops, ['feature_ended']); assert.equal(owner.status().services[0].state, 'stopped');
});


test('revoking a preset during the persisted launch intent prevents actual process creation', async t => {
  const blocked = Promise.withResolvers(), saved = Promise.withResolvers(); let presets = [preset()], calls = 0;
  const owner = await ProcessSupervisor.open({ journal: { async load() { return []; }, async save(rows) { if (rows[0]?.record.generation === 1 && rows[0].record.state === 'starting') { blocked.resolve(); await saved.promise; } } }, host: { start() { calls++; throw Error('must not launch'); } }, presets: () => presets, async validateScope() {} });
  t.after(() => { saved.resolve(); return owner.close(); });
  const running = owner.start({ operationId: 'start', presetId: 'dev', scope: scope() }); await blocked.promise; presets = []; saved.resolve();
  assert.equal((await running).state, 'failed'); assert.equal(calls, 0);
});


test('manual restart does not replace a host whose cleanup becomes unconfirmed while stopping', async t => {
  const closed = Promise.withResolvers(); let launches = 0;
  const owner = await ProcessSupervisor.open({ journal: { async load() { return []; }, async save() {} }, host: { start() { launches++; return { started: Promise.resolve(), closed: closed.promise, async stop() { closed.resolve({ code: null, reason: 'host_lost' }); } }; } }, presets: () => [preset()], async validateScope() {} });
  t.after(() => owner.close());
  const row = await owner.start({ operationId: 'start', presetId: 'dev', scope: scope() });
  await assert.rejects(owner.restart(command(row)), /no replacement was launched/);
  assert.equal(owner.status().services[0].state, 'interrupted'); assert.equal(launches, 1);
});

async function uncertainFixture(t, { failedStart = false, maximum = 1 } = {}) {
  const handles = []; let holdFirst = true;
  const owner = await ProcessSupervisor.open({ journal: { async load() { return []; }, async save() {} }, maxActive: maximum,
    host: { start() { const index = handles.length, closed = Promise.withResolvers(), stops = []; handles.push({ closed, stops });
      return { started: failedStart && index === 0 ? Promise.reject(Error('did not acknowledge startup')) : Promise.resolve(), closed: closed.promise,
        async stop(reason) { stops.push(reason); if (index === 0 && holdFirst) throw Error('cleanup could not be confirmed'); closed.resolve({ code: null, reason }); } };
    } }, presets: () => [preset()], async validateScope() {} });
  t.after(() => { holdFirst = false; for (const handle of handles) handle.closed.resolve({ code: null, reason: 'shutdown' }); return owner.close().catch(() => {}); });
  return { owner, handles, release() { holdFirst = false; }, start(operationId = 'start', char = 'a') { return owner.start({ operationId, presetId: 'dev', scope: scope(char) }); } };
}

test('unconfirmed startup retains its active lease, denies replacement, and leaves the command queue usable', async t => {
  const f = await uncertainFixture(t, { failedStart: true });
  await assert.rejects(f.start(), /cleanup|confirm|startup/i);
  const row = f.owner.status().services[0]; assert.equal(row.state, 'stopping'); assert.equal(f.owner.status().capacity.active, 1);
  const controls = await f.owner.controls(row.id); assert.equal(controls.stop, true); assert.equal(controls.restart, false);
  assert.equal((await f.start()).id, row.id, 'Replaying the original start keeps the original owned lease.');
  await assert.rejects(f.start('replacement'), /active|slots|cleanup|stopping/i);
  await assert.rejects(f.owner.restart(command(row, 'restart')), /cleanup|stopping|confirm/i); assert.equal(f.handles.length, 1);
  f.release(); const stopped = await f.owner.stop(command(f.owner.status().services[0], 'retry-stop')); assert.equal(stopped.state, 'stopped');
  const independent = await f.start('independent', 'b'); assert.equal(independent.state, 'running'); assert.equal(f.handles.length, 2);
});

for (const failedStart of [false, true]) test(`a late nonzero close after uncertain ${failedStart ? 'startup' : 'operator stop'} never schedules a replacement`, async t => {
  const f = await uncertainFixture(t, { failedStart });
  if (failedStart) await assert.rejects(f.start(), /cleanup|confirm|startup/i);
  else { const row = await f.start(); await assert.rejects(f.owner.stop(command(row)), /cleanup|confirm/i); }
  assert.equal(f.owner.status().services[0].state, 'stopping');
  f.handles[0].closed.resolve({ code: 1, reason: 'exit' });
  await until(() => f.owner.status().capacity.active === 0); await delay(150);
  assert.equal(f.handles.length, 1, 'Remaining automatic restart budget cannot override an outstanding stop.');
  assert.notEqual(f.owner.status().services[0].state, 'restarting');
});

test('close attempts every owned lease even when one cleanup remains unconfirmed', async t => {
  const f = await uncertainFixture(t, { maximum: 2 }); await f.start(); await f.start('second', 'b');
  await assert.rejects(f.owner.close(), /cleanup|confirm/i);
  assert.deepEqual(f.handles[0].stops, ['shutdown']); assert.deepEqual(f.handles[1].stops, ['shutdown']);
  const rows = f.owner.status().services; assert.equal(rows[0].state, 'stopping'); assert.equal(rows[1].state, 'stopped');
  assert.equal(f.owner.status().capacity.active, 1);
});
