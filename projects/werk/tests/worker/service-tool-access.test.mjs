import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultServicePolicy, validateServicePolicy } from '../../src/worker/dist/worker/application/service-access-policy.js';
import { defaultToolPolicy, updateToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { ProcessSupervisor } from '../../src/worker/dist/worker/application/process-supervisor.js';
import { serviceToolOperations } from '../../src/worker/dist/worker/infrastructure/service-tools.js';
import { workspaceProcessTools } from '../../src/worker/dist/worker/infrastructure/workspace-process-tools.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { createProcessObservation } from '../../src/worker/dist/worker/infrastructure/process-observation.js';
import { interactionFeatureRequest } from '../../src/worker/dist/worker/application/feature-request-reference.js';

/** @typedef {import('../../src/worker/application/process-supervision.ts').ServiceHostPort} Host */
/** @typedef {import('../../src/worker/application/process-supervision.ts').ServiceExit} Exit */
const preset = { id: 'dev', name: 'Preview', executable: process.execPath, args: ['server.js'], enabled: true, ttlMs: 10000, startupTimeoutMs: 1000, restart: { maxAttempts: 1, backoffMs: 100 } };
const grant = () => ({ ...defaultServicePolicy(), enabled: true, presets: [structuredClone(preset)] });
const feature = interactionFeatureRequest('feature-a');
const scope = () => ({ featureRequestKey: feature.key, sessionId: 'local-feature-a', taskId: 'feature-a', runId: 'run-a', worktree: '/project/tree', worktreeIdentity: { dev: '1', ino: '2', birthtimeMs: 0 } });
const signal = () => new AbortController().signal;
async function fixture(t) {
  let policy = { ...defaultToolPolicy(), services: grant() };
  /** @type {Array<{ input:Parameters<Host['start']>[0]; stops:string[]; finish:(exit:Exit)=>void }>} */ const launched = [];
  /** @type {Host} */ const host = { async start(input) {
    const closed = Promise.withResolvers(); const stops = [];
    launched.push({ input, stops, finish: closed.resolve });
    return { closed: closed.promise, async stop(reason) { stops.push(reason); closed.resolve({ code: null, reason }); } };
  } };
  const supervisor = await ProcessSupervisor.open({ host, journal: { async load() { return []; }, async save() {} }, presets: () => policy.services.enabled ? policy.services.presets : [], async validateScope() {} });
  t.after(() => supervisor.close());
  const operations = serviceToolOperations(policy.services, supervisor, scope);
  const call = async (name, args) => { const operation = operations.find(item => item.definition.name === 'werk_service_' + name); assert.ok(operation); const result = await operation.call(args, signal()); assert.equal(result.content[0].type, 'text'); return JSON.parse(result.content[0].text); };
  return { supervisor, launched, operations, call, get policy() { return policy; }, revoke() { policy = { ...policy, revision: policy.revision + 1, services: defaultServicePolicy() }; } };
}

test('service grants are off by default, additive and preserved when older editors omit them', () => {
  const previous = defaultToolPolicy(); assert.equal(previous.services, undefined); assert.equal(defaultServicePolicy().enabled, false);
  const accepted = updateToolPolicy(previous, { expectedRevision: 0, builtins: previous.builtins, mcp: [], services: grant() });
  const next = updateToolPolicy(accepted, { expectedRevision: accepted.revision, builtins: previous.builtins, mcp: [] });
  assert.deepEqual(next.services, accepted.services);
  assert.equal(updateToolPolicy(next, { expectedRevision: next.revision, builtins: previous.builtins, mcp: [], services: defaultServicePolicy() }).services.enabled, false);
  for (const bad of [null, { ...grant(), maxActive: 0 }, { ...grant(), maxActive: 17 }, { ...grant(), maxActive: 1.5 }, { ...grant(), presets: [preset, preset] }, { ...grant(), cwd: '/other' }, { ...grant(), presets: [{ ...preset, executable: 'node' }] }]) assert.throws(() => validateServicePolicy(bad));
  const definitions = Array.from({ length: 60 }, (_, i) => ({ name: 'read_' + i, description: '', inputSchema: { type: 'object' } }));
  assert.throws(() => validateToolPolicy({ ...previous, services: grant(), mcp: [{ id: 'catalog', name: 'Catalog', transport: 'http', enabled: true, command: '', args: [], url: 'https://example.test/mcp', secretEnv: '', secret: '', allowedTools: definitions.map(row => row.name), discoveredTools: definitions }] }), /at most 64/);
});

test('service tools require an enabled named grant and pinned scope; model argv and other FR IDs are rejected', async t => {
  const f = await fixture(t);
  assert.equal(serviceToolOperations(undefined, f.supervisor, scope).length, 0);
  assert.equal(serviceToolOperations(grant(), f.supervisor, () => undefined).length, 0);
  assert.equal(f.operations.length, 5);
  await assert.rejects(f.call('start', { preset: 'dev', operationId: 'bad', args: ['anything'] }), /documented/);
  await assert.rejects(f.call('start', { preset: '/bin/sh', operationId: 'bad' }), /preset/);
  const row = await f.call('start', { preset: 'dev', operationId: 'start-one' });
  assert.equal(f.launched.length, 1); assert.deepEqual(f.launched[0].input.scope, scope());
  assert.equal((await f.call('start', { preset: 'dev', operationId: 'start-one' })).id, row.id);
  const other = await f.supervisor.start({ presetId: 'dev', operationId: 'other', scope: { ...scope(), featureRequestKey: interactionFeatureRequest('other').key } });
  for (const action of ['status', 'logs', 'stop', 'restart']) await assert.rejects(f.call(action, { id: other.id, ...(action === 'stop' || action === 'restart' ? { operationId: 'foreign', expectedRevision: other.revision } : {}) }), /current Feature Request/);
  const status = await f.call('status', {}); assert.deepEqual(status.services.map(item => item.id), [row.id]);
  assert.doesNotMatch(JSON.stringify(status), /worktree|executable|server\.js/);
});

test('service restart/stop replay exact receipts and reject invalid logs without side effects', async t => {
  const f = await fixture(t); const row = await f.call('start', { preset: 'dev', operationId: 'start' });
  const command = { id: row.id, expectedRevision: row.revision, operationId: 'restart' };
  const restarted = await f.call('restart', command); assert.equal(restarted.generation, 2);
  assert.deepEqual(await f.call('restart', command), restarted); assert.equal(f.launched.length, 2);
  await assert.rejects(f.call('stop', command), /different command/);
  await assert.rejects(f.call('logs', { id: row.id, after: -1 }), /cursor/);
  await assert.rejects(f.call('logs', { id: row.id, limit: 129 }), /cursor/);
  const stopped = await f.call('stop', { id: row.id, expectedRevision: restarted.revision, operationId: 'stop' });
  assert.equal(stopped.state, 'stopped'); assert.deepEqual(f.launched[1].stops, ['operator']);
});

test('the parent runtime rejects service calls after grant revision changes and consumes its shared call allowance', async t => {
  const f = await fixture(t); const directory = await mkdtemp(join(tmpdir(), 'werk-services-tools-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = createToolRuntime({ policy: f.policy, currentRevision: () => f.policy.revision, directory, additionalOperations: f.operations, maxCalls: 2 });
  t.after(() => runtime.close());
  await runtime.call('werk_service_status', {}, signal()); await runtime.call('werk_service_status', {}, signal());
  const refused = await runtime.call('werk_service_start', { preset: 'dev', operationId: 'over-budget' }, signal());
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /budget|calls|limit/i);
  assert.equal(f.launched.length, 0);
  const current = createToolRuntime({ policy: f.policy, currentRevision: () => f.policy.revision, directory, additionalOperations: f.operations }); t.after(() => current.close());
  f.revoke(); await assert.rejects(current.call('werk_service_start', { preset: 'dev', operationId: 'revoked' }, signal()), /changed|revoked/i); assert.equal(f.launched.length, 0);
});

test('cancellation racing a service start drains the lease before the tool rejects', async t => {
  const f = await fixture(t), controller = new AbortController();
  const operation = f.operations.find(item => item.definition.name === 'werk_service_start'); assert.ok(operation);
  const pending = operation.call({ preset: 'dev', operationId: 'cancel-start' }, controller.signal); controller.abort();
  await assert.rejects(pending); assert.equal(f.supervisor.status().capacity.active, 0);
  assert.deepEqual(f.launched[0].stops, ['feature_ended']);
});

test('model failure stops same-FR services while successful turns retain their TTL', async t => {
  const f = await fixture(t); await f.call('start', { preset: 'dev', operationId: 'retain' });
  const helper = workspaceProcessTools({ supervisor: () => f.supervisor, observations: createProcessObservation() }, { sessionId: scope().sessionId, feature, worktree: scope().worktree, worktreeIdentity: scope().worktreeIdentity });
  assert.equal(await helper.execute(async () => 'done', signal()), 'done'); assert.equal(f.supervisor.status().capacity.active, 1);
  await assert.rejects(helper.execute(async () => { throw Error('model failed'); }, signal()), /model failed/);
  assert.equal(f.supervisor.status().capacity.active, 0); assert.deepEqual(f.launched[0].stops, ['feature_ended']);
});
