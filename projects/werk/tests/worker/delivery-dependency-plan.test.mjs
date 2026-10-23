import test from 'node:test';
import assert from 'node:assert/strict';
import { planDeliveryDependencies } from '../../src/worker/dist/worker/application/delivery-dependency-plan.js';

const baseline = 'a'.repeat(40), commit = 'b'.repeat(40);
const accepted = id => ({ id, requestId: 'request-' + id, inputRevision: 1, includesCode: true, candidateCommit: commit });

test('duplicate identities outside the reachable dependency graph do not hold independent projects', async () => {
  let inspections = 0;
  const plan = await planDeliveryDependencies('project-a:target', [
    { id: 'project-a:target', dependsOn: ['project-a:base'] },
    { id: 'project-a:base', dependsOn: [] },
    { id: 'project-b:duplicate', dependsOn: [] },
    { id: 'project-b:duplicate', dependsOn: [] },
  ], baseline, { accepted, incorporated: async () => { inspections++; return true; } });
  assert.equal(plan.ready, true); assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.nodes.map(node => [node.id, node.state]), [['project-a:base', 'ready'], ['project-a:target', 'ready']]);
  assert.equal(inspections, 1); assert.equal(plan.nodes[0].receipt.candidateCommit, commit);
});

test('a reachable duplicate still blocks every dependent request before Git inspection', async () => {
  let inspections = 0;
  const plan = await planDeliveryDependencies('target', [
    { id: 'target', dependsOn: ['duplicate'] },
    { id: 'duplicate', dependsOn: [] },
    { id: 'duplicate', dependsOn: [] },
  ], baseline, { accepted, incorporated: async () => { inspections++; return true; } });
  assert.equal(plan.ready, false); assert.equal(inspections, 0); assert.deepEqual(plan.waves, []);
  assert.deepEqual(plan.blockers.map(item => [item.nodeId, item.code]), [['duplicate', 'duplicate']]);
  assert.ok(plan.nodes.every(node => node.state === 'blocked' && !node.receipt));
});

for (const unavailable of ['acceptance', 'integration', 'inspection']) test(`blocked ${unavailable} propagates through every dependent node without discarding observed receipts`, async () => {
  const graph = [
    { id: 'target', dependsOn: ['middle', 'independent'] },
    { id: 'middle', dependsOn: ['base'] },
    { id: 'base', dependsOn: [] },
    { id: 'independent', dependsOn: [] },
  ];
  const plan = await planDeliveryDependencies('target', graph, baseline, {
    accepted: id => id === 'base' && unavailable === 'acceptance' ? undefined : accepted(id),
    incorporated: async (_commit, _baseline, dependency) => {
      if (dependency.id !== 'base') return true;
      if (unavailable === 'inspection') throw Error('Repository unavailable.');
      return unavailable !== 'integration';
    },
  });
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.nodes.map(node => [node.id, node.state]), [
    ['base', unavailable === 'acceptance' ? 'waiting_acceptance' : 'waiting_integration'],
    ['middle', 'blocked'], ['independent', 'ready'], ['target', 'blocked'],
  ]);
  assert.equal(plan.nodes.find(node => node.id === 'base').receipt, undefined);
  assert.equal(plan.nodes.find(node => node.id === 'middle').receipt.candidateCommit, commit);
  assert.deepEqual(plan.waves, [['base', 'independent'], ['middle'], ['target']]);
  assert.equal(plan.blockers[0].nodeId, 'base');
});
