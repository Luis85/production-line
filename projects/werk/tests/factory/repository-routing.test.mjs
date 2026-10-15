import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryIntake } from '../../src/factory/dist/factory/application/intake.js';
import { SqliteIntakeStore } from '../../src/factory/dist/factory/infrastructure/intake-store.js';
import { SqliteFactoryRegistry } from '../../src/factory/dist/factory/infrastructure/registry.js';
const input = { project: 'demo', title: 'Preserve repository choice', criteria: ['Keep approved assignment'], provider: 'codex', executionMode: 'cli', repository: 'backend', requirementRef: '[[Feature]]' };
const row = (repositoryId, slotsAvailable = 1, extra = {}) => ({ repositoryId, provider: 'codex', mode: 'cli', slotsAvailable, ...extra });
function observation(line, rows, context = 'unbound', extra = {}) {
  return { line, status: 'available', checkedAt: new Date().toISOString(), error: null, overview: { project: 'demo', observedAt: new Date().toISOString(), tasks: { queued: 0 }, workers: { slotsAvailable: 10 }, capabilities: { context, profiles: [{ id: 'codex', provider: 'codex', mode: 'cli' }, { id: 'claude', provider: 'claude', mode: 'mock' }], intake: context === 'pinned' ? ['requirement_ref', 'pinned_iteration'] : ['structured_task', 'requirement_ref'], eligibleCapacity: [{ provider: 'codex', mode: 'cli', slotsAvailable: 10 }], repositoryCapacity: rows, repositoryCapacityTruncated: false, ...extra } } };
}
function setup(t, observe, send) {
  const registry = new SqliteFactoryRegistry(':memory:'), repository = new SqliteIntakeStore(':memory:');
  registry.createFactory({ id: 'root', name: 'Factory', parentId: null });
  for (const [index, id] of ['alpha', 'beta'].entries()) registry.createLine({ id, name: id, factoryId: 'root', orchestratorUrl: `http://127.0.0.1:${3000 + index}`, webviewUrl: `http://127.0.0.1:${3000 + index}`, tokenEnv: `WERK_LINE_${id.toUpperCase()}_TOKEN` });
  const sent = [], intake = new FactoryIntake(registry, { async read(line) { return observe(line); } }, repository, { async send(line, item) { sent.push({ line: line.id, payload: structuredClone(item.deliveryTask), key: item.id }); return send ? send(line, item) : 'remote-task'; }, close() {} });
  t.after(async () => { await intake.close(); repository.close(); registry.close(); });
  return { registry, repository, intake, sent };
}

test('pinned Factory delivery and acknowledgement retries preserve explicit repository selection', async t => {
  let calls = 0;
  const f = setup(t, line => observation(line, [row('backend')], 'pinned'), () => { if (++calls === 1) throw Error('Lost acknowledgement'); return 'remote-task'; });
  const task = f.intake.create({ factoryId: 'root', lineId: 'alpha', task: input }, 'pinned');
  await f.intake.tick(); assert.equal(f.repository.get(task.id).status, 'delivering');
  assert.equal(f.sent[0].payload.repository, 'backend'); assert.equal(f.sent[0].payload.project, 'demo'); assert.equal(f.sent[0].payload.requirementRef, '[[Feature]]');
  assert.equal(Object.hasOwn(f.sent[0].payload, 'title'), false);
  await f.intake.tick(); assert.equal(f.repository.get(task.id).status, 'delivered'); assert.deepEqual(f.sent[1], f.sent[0]);
});

test('Factory automatic routing uses matching repository capacity rather than unrelated free workers', async t => {
  const f = setup(t, line => observation(line, line.id === 'alpha' ? [row('frontend', 10)] : [row('backend', 1)]));
  const task = f.intake.create({ factoryId: 'root', task: input }, 'scoped'); await f.intake.tick();
  assert.equal(f.sent[0].line, 'beta'); assert.equal(f.repository.get(task.id).status, 'delivered');
});

test('manual incompatible destinations and truncated missing repository rows remain queued', async t => {
  const rows = Array.from({ length: 260 }, (_, i) => row('other-' + i));
  const f = setup(t, line => observation(line, rows, 'unbound', { repositoryCapacityTruncated: true }));
  const task = f.intake.create({ factoryId: 'root', lineId: 'alpha', task: input }, 'manual');
  await f.intake.tick(); assert.equal(f.sent.length, 0); assert.equal(f.repository.get(task.id).status, 'queued'); assert.equal(f.repository.get(task.id).destination, null);
});

test('legacy checkout rows serve only implicit CLI tasks and do not advertise explicit repository access', async t => {
  const f = setup(t, line => observation(line, [row('demo', 1, { implicitOnly: true })]));
  const explicit = f.intake.create({ factoryId: 'root', task: { ...input, repository: 'demo' } }, 'explicit');
  const { repository, ...legacy } = input;
  const implicit = f.intake.create({ factoryId: 'root', task: legacy }, 'implicit');
  await f.intake.tick(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].key, implicit.id); assert.equal(f.repository.get(explicit.id).status, 'queued');
});

test('automatic provider capacity does not count one dual-provider worker twice', async t => {
  const f = setup(t, line => observation(line, line.id === 'alpha' ? [row('backend', 1, { mode: 'mock' }), row('backend', 1, { mode: 'mock', provider: 'claude' })] : [row('backend', 2, { mode: 'mock' })], 'unbound', { profiles: [{ id: 'codex', provider: 'codex', mode: 'mock' }, { id: 'claude', provider: 'claude', mode: 'mock' }] }));
  f.intake.create({ factoryId: 'root', task: { ...input, provider: 'auto', executionMode: 'mock' } }, 'dual'); await f.intake.tick();
  assert.equal(f.sent[0].line, 'beta');
});

test('older lines without repository announcements retain compatibility', async t => {
  const f = setup(t, line => { const value = observation(line, []); delete value.overview.capabilities.repositoryCapacity; delete value.overview.capabilities.repositoryCapacityTruncated; return value; });
  f.intake.create({ factoryId: 'root', task: input }, 'old-line'); await f.intake.tick(); assert.equal(f.sent.length, 1);
});
