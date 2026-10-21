import test from 'node:test';
import assert from 'node:assert/strict';
import { planDeliveryDependencies } from '../../../.mutation-build/worker/application/delivery-dependency-plan.js';
const baseline = 'a'.repeat(40);
const accepted = id => ({ id, requestId: 'request-' + id, inputRevision: 2, candidateCommit: 'b'.repeat(40), includesCode: true });
const noCalls = { accepted: () => { throw Error('Graph validation must finish before acceptance inspection.'); }, incorporated: async () => { throw Error('Graph validation must finish before Git inspection.'); } };
const receipts = plan => plan.nodes.flatMap(node => node.receipt ? [node.receipt] : []);

test('dependency resolution reports duplicate, missing and cyclic identities before checking authority', async () => {
  const cases = [
    { graph: [], code: 'unknown' },
    { graph: [{ id: 'child', dependsOn: ['missing'] }], code: 'unknown' },
    { graph: [{ id: 'child', dependsOn: [] }, { id: 'child', dependsOn: [] }], code: 'duplicate' },
    { graph: [{ id: 'child', dependsOn: ['child'] }], code: 'cycle' },
    { graph: [{ id: 'child', dependsOn: ['parent'] }, { id: 'parent', dependsOn: ['child'] }], code: 'cycle' },
  ];
  for (const { graph, code } of cases) { const plan = await planDeliveryDependencies('child', graph, baseline, noCalls); assert.equal(plan.ready, false); assert.equal(plan.blockers[0].code, code); assert.deepEqual(plan.waves, []); assert.equal(receipts(plan).length, 0); }
});

test('each reachable prerequisite is checked once in dependency order and exact baseline is retained', async () => {
  const graph = [{ id: 'child', dependsOn: ['left', 'right'] }, { id: 'left', dependsOn: ['base'] }, { id: 'right', dependsOn: ['base'] }, { id: 'base', dependsOn: [] }, { id: 'unrelated', dependsOn: ['unrelated'] }];
  const visited = [], commits = [];
  const result = await planDeliveryDependencies('child', graph, baseline, {
    accepted: id => { visited.push(id); return accepted(id); },
    incorporated: async (commit, base) => { commits.push([commit, base]); return true; },
  });
  assert.equal(result.ready, true); assert.equal(result.schemaVersion, 1); assert.equal(result.target, 'child'); assert.equal(result.baseline, baseline);
  assert.deepEqual(visited, ['base', 'left', 'right']); assert.deepEqual(result.waves, [['base'], ['left', 'right'], ['child']]);
  assert.deepEqual(commits, Array.from({ length: 3 }, () => ['b'.repeat(40), baseline]));
  assert.deepEqual(receipts(result), visited.map(id => ({ ...accepted(id), baseline })));
  assert.deepEqual(result.nodes.map(node => node.state), ['ready', 'ready', 'ready', 'ready']);
  const empty = await planDeliveryDependencies('child', [{ id: 'child', dependsOn: [] }], baseline, noCalls);
  assert.equal(empty.ready, true); assert.deepEqual(receipts(empty), []);
});

test('human acceptance and incorporated code are separate mandatory observations, with unavailable inspection retained as blocker', async () => {
  const graph = [{ id: 'child', dependsOn: ['parent'] }, { id: 'parent', dependsOn: [] }];
  /** @type {Array<[import('../../../src/worker/application/delivery-dependencies.js').DeliveryDependencyPorts, string, string]>} */
  const cases = [
    [{ accepted: () => undefined, incorporated: noCalls.incorporated }, 'unaccepted', 'waiting_acceptance'],
    [{ accepted: () => ({ ...accepted('wrong') }), incorporated: noCalls.incorporated }, 'unaccepted', 'waiting_acceptance'],
    [{ accepted: id => ({ ...accepted(id), candidateCommit: undefined }), incorporated: noCalls.incorporated }, 'not_integrated', 'waiting_integration'],
    [{ accepted, incorporated: async () => false }, 'not_integrated', 'waiting_integration'],
    [{ accepted, incorporated: async () => { throw Error('Local Git unavailable'); } }, 'inspection_unavailable', 'waiting_integration'],
  ];
  for (const [ports, code, state] of cases) { const plan = await planDeliveryDependencies('child', graph, baseline, ports); assert.equal(plan.ready, false); assert.equal(plan.blockers[0].code, code); assert.equal(plan.nodes[0].state, state); assert.equal(plan.nodes[1].state, 'blocked'); assert.deepEqual(receipts(plan), []); }
  const source = { ...accepted('parent'), includesCode: false, candidateCommit: undefined };
  const result = await planDeliveryDependencies('child', graph, baseline, { accepted: () => source, incorporated: noCalls.incorporated });
  assert.equal(result.ready, true); assert.deepEqual(receipts(result), [{ ...source, baseline }]); assert.notEqual(result.nodes[0].receipt, source);
  source.requestId = 'modified'; assert.equal(result.nodes[0].receipt.requestId, 'request-parent');
});


test('dependency graph budgets accept exact bounds and stop oversized graphs before repository inspection', async () => {
  const graph = Array.from({ length: 4096 }, (_, i) => ({ id: 'request-' + i, dependsOn: [] }));
  assert.equal((await planDeliveryDependencies('request-0', graph, baseline, noCalls)).ready, true);
  assert.equal((await planDeliveryDependencies('request-0', [...graph, { id: 'overflow', dependsOn: [] }], baseline, noCalls)).blockers[0].code, 'limit');
  const ports = { accepted: id => ({ ...accepted(id), includesCode: false }), incorporated: noCalls.incorporated };
  const chain = length => Array.from({ length }, (_, i) => ({ id: 'n-' + i, dependsOn: i + 1 < length ? ['n-' + (i + 1)] : [] }));
  assert.equal((await planDeliveryDependencies('n-0', chain(129), baseline, ports)).ready, true);
  assert.equal((await planDeliveryDependencies('n-0', chain(130), baseline, noCalls)).blockers[0].code, 'limit');
  const wide = length => [{ id: 'root', dependsOn: Array.from({ length }, (_, i) => 'leaf-' + i) }, ...Array.from({ length }, (_, i) => ({ id: 'leaf-' + i, dependsOn: [] }))];
  assert.equal((await planDeliveryDependencies('root', wide(64), baseline, ports)).ready, true);
  assert.equal((await planDeliveryDependencies('root', wide(65), baseline, noCalls)).blockers[0].code, 'limit');
  const reachable = leaves => {
    const groups = Array.from({ length: 4 }, (_, i) => ({ id: 'group-' + i, dependsOn: [] }));
    const nodes = Array.from({ length: leaves }, (_, i) => { groups[i % 4].dependsOn.push('leaf-' + i); return { id: 'leaf-' + i, dependsOn: [] }; });
    return [{ id: 'root', dependsOn: groups.map(group => group.id) }, ...groups, ...nodes];
  };
  assert.equal((await planDeliveryDependencies('root', reachable(251), baseline, ports)).ready, true);
  assert.equal((await planDeliveryDependencies('root', reachable(252), baseline, noCalls)).blockers[0].code, 'limit');
});

test('dependency blockers preserve distinct node and reason identities without duplicate diagnostics', async () => {
  const graph = [{ id: 'root', dependsOn: ['root'] }, { id: 'root', dependsOn: ['root'] }, { id: 'root', dependsOn: ['root'] }, { id: 'other', dependsOn: [] }, { id: 'other', dependsOn: [] }];
  const plan = await planDeliveryDependencies('root', graph, baseline, noCalls);
  assert.deepEqual(plan.blockers.map(({ nodeId, code }) => [nodeId, code]), [['root', 'duplicate'], ['root', 'cycle']]);
  const independent = await planDeliveryDependencies('independent', [...graph, { id: 'independent', dependsOn: [] }], baseline, noCalls);
  assert.equal(independent.ready, true); assert.deepEqual(independent.blockers, []);
  const missing = await planDeliveryDependencies('root', [{ id: 'root', dependsOn: ['missing', 'missing', 'another'] }], baseline, noCalls);
  assert.deepEqual(missing.nodes.map(node => node.id), ['missing', 'another', 'root']);
  assert.deepEqual(missing.nodes[0].blockers.map(item => item.nodeId), ['missing']);
  assert.deepEqual(missing.nodes[1].blockers.map(item => item.nodeId), ['another']);
  assert.deepEqual(missing.nodes[2].dependsOn, ['missing', 'missing', 'another']);
});
