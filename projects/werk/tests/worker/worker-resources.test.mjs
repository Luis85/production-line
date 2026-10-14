import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerResourceMonitor } from '../../src/worker/dist/worker/application/resource-monitor.js';
import { defaultResourcePolicy, validateResourcePolicy } from '../../src/worker/dist/worker/application/resources.js';
import { WorkerResourceJournal } from '../../src/worker/dist/worker/infrastructure/journal/resource-events.js';
import { resourceSampler } from '../../src/worker/dist/worker/infrastructure/resource-sampler.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { serviceEvent } from '../../src/worker/dist/shared/http/observability.js';

const baseline = () => ({ processId: 123, processStartId: 'fixture-process', monotonicMs: 0, cpuTotalMicros: 0, rssBytes: 20, heapUsedBytes: 20, heapLimitBytes: 100, effectiveMemoryLimitBytes: 100, availableMemoryBytes: 80, cpuCapacityCores: 4, diskAvailableBytes: 900, diskTotalBytes: 1000, unavailable: [] });
async function fixture(t, values = {}, overrides = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-resources-'))), journal = new WorkerResourceJournal(directory);
  let reading = { ...baseline(), ...values }, active = null, wall = 1700000000000;
  const logs = [], policy = { ...defaultResourcePolicy(), diskFreeBytes: 0, diskFreePercent: 10, ...overrides };
  const monitor = new WorkerResourceMonitor({ store: journal, read: async () => structuredClone(reading), policy: () => policy, active: () => active, now: () => wall, log: event => logs.push(event) });
  await monitor.init();
  t.after(async () => { await monitor.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, journal, monitor, logs, policy, get reading() { return reading; }, set reading(value) { reading = value; }, set active(value) { active = value; }, set wall(value) { wall = value; }, async tick(ms = 10000, cpuCores = 0) { reading.monotonicMs += ms; reading.cpuTotalMicros += ms * 1000 * cpuCores; wall += ms; await monitor.sample(); } };
}

test('resource pressure uses measured process scope, sustained CPU, hysteresis and transition-only durable warnings', async t => {
  const f = await fixture(t, { rssBytes: 90, heapUsedBytes: 95, diskAvailableBytes: 50 });
  assert.deepEqual(f.monitor.status().alerts.map(alert => alert.code).sort(), ['disk', 'heap', 'memory']);
  assert.equal(f.monitor.status().snapshot.cpuPercent, null);
  for (let n = 0; n < 4; n++) await f.tick(10000, 4);
  const high = f.monitor.status(); assert.equal(high.snapshot.cpuCores, 4); assert.equal(high.snapshot.cpuPercent, 100); assert.equal(high.snapshot.cpuCapacityBasis, 'available_parallelism');
  assert.equal(high.alerts.length, 4); const ids = high.alerts.map(alert => alert.id).sort();
  await f.tick(10000, 4); assert.deepEqual(f.monitor.status().alerts.map(alert => alert.id).sort(), ids); assert.equal(f.monitor.events().events.length, 4);
  f.reading.rssBytes = 80; f.reading.heapUsedBytes = 85; f.reading.diskAvailableBytes = 105; await f.tick(10000, 3.5);
  assert.equal(f.monitor.status().alerts.length, 4, 'Values in hysteresis band do not flap.');
  f.reading.rssBytes = 70; f.reading.heapUsedBytes = 70; f.reading.diskAvailableBytes = 120; await f.tick(10000, 1);
  assert.equal(f.monitor.status().alerts.length, 0); assert.equal(f.monitor.events().events.length, 8);
  assert.equal(f.logs.filter(value => value === 'resource_alert_opened').length, 4);
  assert.equal(f.logs.filter(value => value === 'resource_alert_resolved').length, 4);
});

test('unknown or invalid measurements never resolve a warning as healthy or invent CPU zero', async t => {
  const f = await fixture(t, { diskAvailableBytes: 10 });
  const alertId = f.monitor.status().alerts[0].id;
  f.reading.diskAvailableBytes = null; f.reading.diskTotalBytes = null; f.reading.unavailable = ['state_filesystem']; await f.tick();
  assert.equal(f.monitor.status().sampleError, true); assert.equal(f.monitor.status().alerts[0].id, alertId);
  const previousAt = f.monitor.status().snapshot.capturedAt;
  for (const value of [Infinity, NaN, -1]) { f.reading.cpuTotalMicros = value; await f.monitor.sample(); assert.equal(f.monitor.status().sampleErrorReason, 'invalid_measurement'); assert.equal(f.monitor.status().snapshot.capturedAt, previousAt); }
  f.reading = baseline(); await f.tick(); assert.equal(f.monitor.status().snapshot.cpuPercent, null); assert.equal(f.monitor.status().alerts.length, 0);
  await f.tick(10000, 2); assert.equal(f.monitor.status().snapshot.cpuPercent, 50);
  f.reading.cpuTotalMicros = 0; await f.tick(10000, 0); assert.equal(f.monitor.status().snapshot.cpuPercent, null);
  assert.doesNotMatch(JSON.stringify(f.monitor.events()), /Infinity|NaN/);
});

test('long execution warnings use monotonic elapsed time and never flood after wall-clock changes', async t => {
  const f = await fixture(t); f.active = { sessionId: 'long-session', startedAt: 1700000000000, monotonicStartedAt: 0 };
  f.wall = 1900000000000; await f.tick(); assert.equal(f.monitor.status().alerts.length, 0);
  f.wall = 1600000000000; await f.tick(3600000); const first = f.monitor.status().alerts.find(alert => alert.code === 'long_running'); assert.ok(first);
  await f.tick(); await f.tick(); assert.equal(f.monitor.events().events.filter(event => event.type === 'opened').length, 1); assert.equal(f.monitor.status().alerts[0].id, first.id);
  f.active = null; await f.tick(); assert.equal(f.monitor.status().alerts.length, 0); assert.equal(f.monitor.events().events.at(-1).reason, 'execution_finished');
});

test('restart preserves stable event history, ends old pressure episodes and starts CPU with unavailable delta', async t => {
  const f = await fixture(t, { rssBytes: 90 }); const original = f.monitor.events().events[0]; await f.monitor.close();
  const journal = new WorkerResourceJournal(f.directory), monitor = new WorkerResourceMonitor({ store: journal, read: async () => baseline(), policy: () => f.policy, active: () => null });
  await monitor.init(); t.after(() => monitor.close());
  const events = monitor.events().events; assert.deepEqual(events[0], original); assert.equal(events[1].reason, 'worker_restarted'); assert.equal(events[1].alertId, original.alertId); assert.equal(monitor.status().snapshot.cpuPercent, null);
});

test('event retention is bounded with replay-stable IDs, explicit gaps and future polling cursors', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 501; n++) { const alert = { id: 'episode-' + n, code: 'memory', severity: 'warning', openedAt: new Date().toISOString(), observed: 90, threshold: 85 }; f.journal.transition(alert, 'opened', 'threshold', alert.openedAt); f.journal.transition(alert, 'resolved', 'recovered', alert.openedAt); }
  let page = f.monitor.events(0, 100), events = [...page.events]; assert.equal(page.gap, true); assert.equal(page.oldestAvailableSequence, 3);
  while (page.hasMore) { page = f.monitor.events(page.nextAfter, 100); events.push(...page.events); }
  assert.equal(events.length, 1000); assert.equal(new Set(events.map(event => event.id)).size, 1000);
  const empty = f.monitor.events(page.nextAfter); assert.equal(empty.nextAfter, page.nextAfter); assert.equal(empty.events.length, 0);
  for (const [after, limit] of [[-1, 50], [1.5, 50], [0, 101], [0, 0]]) assert.throws(() => f.monitor.events(after, limit));
});

test('journal write failure is observable and retried without flooding or affecting execution', async t => {
  const f = await fixture(t); const transition = f.journal.transition.bind(f.journal);
  f.journal.transition = () => { throw Error('Fixture persistence unavailable'); }; f.reading.rssBytes = 90; await f.tick();
  assert.equal(f.monitor.status().persistenceError, true); assert.equal(f.monitor.status().alerts.length, 0);
  f.journal.transition = transition; await f.tick(); assert.equal(f.monitor.status().persistenceError, false); assert.equal(f.monitor.status().alerts.length, 1);
  await f.tick(); assert.equal(f.monitor.events().events.length, 1);
});

test('monitor timer is unreferenced and shutdown drains a pending sample before disposing its journal', async t => {
  const f = await fixture(t); f.monitor.start(); assert.equal(f.monitor.timer.hasRef(), false);
  let release, entered; const waiting = new Promise(resolve => { entered = resolve; }); let reads = 0;
  f.monitor.dependencies.read = async () => { if (++reads === 1) { entered(); await new Promise(resolve => { release = resolve; }); } return baseline(); };
  const sample = f.monitor.sample(); await waiting; let closed = false; const shutdown = f.monitor.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); release(); await sample; await shutdown;
  assert.equal(f.monitor.timer, undefined); assert.throws(() => f.journal.events(), /not open/); const before = reads; await f.monitor.sample(); assert.equal(reads, before);
});

test('native measurements stay scoped to configured state and missing filesystems remain unavailable', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-native-resources-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const read = resourceSampler(directory), reading = await read(); assert.equal(reading.processId, process.pid); assert.ok(reading.heapLimitBytes > 0); assert.ok(reading.cpuCapacityCores >= 1); assert.ok(reading.diskTotalBytes > 0);
  const absent = await resourceSampler(join(directory, 'missing'))(); assert.equal(absent.diskAvailableBytes, null); assert.ok(absent.unavailable.includes('state_filesystem'));
  const foreign = join(directory, 'foreign'); await writeFile(foreign, 'unchanged'); await symlink(foreign, join(directory, 'worker-resources.sqlite'));
  const journal = new WorkerResourceJournal(directory); await assert.rejects(journal.init(), /regular file/); assert.equal(await readFile(foreign, 'utf8'), 'unchanged');
});

test('resource policy validates hard bounds and environment execution override retains underlying settings', async t => {
  for (const patch of [{ memoryPercent: NaN }, { cpuPercent: 101 }, { cpuSustainMs: 0 }, { diskFreeBytes: -1 }, { longRunningMs: Infinity }, { extra: 1 }]) assert.throws(() => validateResourcePolicy({ ...defaultResourcePolicy(), ...patch }));
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-policy-'))); const previous = process.env.WERK_WORKER_MAX_RUNTIME_MS;
  t.after(async () => { if (previous === undefined) delete process.env.WERK_WORKER_MAX_RUNTIME_MS; else process.env.WERK_WORKER_MAX_RUNTIME_MS = previous; await rm(directory, { recursive: true, force: true }); });
  delete process.env.WERK_WORKER_MAX_RUNTIME_MS; const settings = new WorkerSettings(directory); await settings.init(); assert.equal(settings.value.execution.maxRuntimeMs, 21600000);
  await settings.update({ execution: { maxRuntimeMs: 7200000 }, resources: { longRunningMs: 1800000 } });
  process.env.WERK_WORKER_MAX_RUNTIME_MS = '10800000'; const overridden = new WorkerSettings(directory); await overridden.init();
  assert.equal(overridden.value.execution.maxRuntimeMs, 10800000); assert.equal(overridden.publicView().executionSource, 'environment');
  await assert.rejects(overridden.update({ execution: { maxRuntimeMs: 3600000 } }), /environment override/);
  await overridden.update({ resources: { memoryPercent: 80 } });
  assert.equal(JSON.parse(await readFile(join(directory, 'workspace-settings.json'), 'utf8')).execution.maxRuntimeMs, 7200000);
  delete process.env.WERK_WORKER_MAX_RUNTIME_MS; const restored = new WorkerSettings(directory); await restored.init(); assert.equal(restored.value.execution.maxRuntimeMs, 7200000); assert.equal(restored.publicView().executionSource, 'saved_settings');
  process.env.WERK_WORKER_MAX_RUNTIME_MS = 'NaN'; await assert.rejects(new WorkerSettings(directory).init());
});

test('resource transition logs accept only fixed structured event names without arbitrary payloads', () => {
  const logs = []; serviceEvent('worker', 'resource_alert_opened', 'warn', event => logs.push(event)); serviceEvent('worker', 'resource_alert_resolved', 'info', event => logs.push(event)); serviceEvent('worker', 'resource_sample_error', 'warn', event => logs.push(event)); serviceEvent('worker', 'secret arbitrary text', 'warn', event => logs.push(event));
  assert.equal(logs.length, 3); assert.ok(logs.every(log => log.service === 'worker' && log.schemaVersion === 1)); assert.doesNotMatch(JSON.stringify(logs), /secret/);
});


test('resource endpoints require worker access, reject arbitrary paths and expose only aggregate public metrics', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-resource-api-')));
  const journal = new SnapshotJournal(directory, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const status = () => ({ activeTasks: [], state: 'standalone', heartbeatErrors: 0, lastContact: null });
  const workspace = new WorkerWorkspace({ stateDir: directory, pollMs: 1000, timeoutMs: 60000 }, journal, status); await workspace.init();
  const server = await statusServer(status, '127.0.0.1', 0, undefined, workspace);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await workspace.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port, token = (await readFile(join(directory, 'webview-token'), 'utf8')).trim();
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const post = body => fetch(base + '/api/resources', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/resources')).status, 401);
  const report = await (await fetch(base + '/api/resources', { headers })).json(); assert.equal(report.schemaVersion, 1); assert.equal(report.snapshot.scope, 'worker_node_process'); assert.equal(report.sampleIntervalMs, 10000);
  assert.equal((await post({ action: 'events', after: -1 })).status, 400);
  assert.equal((await post({ action: 'events', path: '/outside-worker-state' })).status, 400);
  const events = await (await post({ action: 'events', limit: 100 })).json(); assert.equal(events.schemaVersion, 1); assert.ok(Array.isArray(events.events));
  const update = await fetch(base + '/api/settings', { method: 'POST', headers, body: JSON.stringify({ resources: { memoryPercent: 82 } }) }); assert.equal(update.status, 200);
  assert.equal(workspace.resources.status().policy.memoryPercent, 82);
  const metrics = await (await fetch(base + '/metrics')).text(); assert.match(metrics, /werk_worker_process_rss_bytes/); assert.match(metrics, /werk_worker_resource_sample_known 1/); assert.doesNotMatch(metrics, /sessionId|processStartId|webview-token/);
});
