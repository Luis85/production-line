import test from 'node:test';
import assert from 'node:assert/strict';
import { testErrorCode } from '../../../tests/helpers/typed-boundaries.mjs';
import { deliveryDependencies } from '../../../.mutation-build/worker/application/delivery-dependencies.js';

const baseline = 'a'.repeat(40);
const accepted = id => ({ id, requestId: 'request-' + id, inputRevision: 2, candidateCommit: 'b'.repeat(40), includesCode: true });
const noCalls = { accepted: () => { throw Error('Graph validation must finish before acceptance inspection.'); }, incorporated: async () => { throw Error('Graph validation must finish before Git inspection.'); } };

test('dependency resolution rejects duplicate, missing and cyclic identities before checking authority', async () => {
  const cases = [
    { graph: [], message: /Unknown Feature Request dependency: child/ },
    { graph: [{ id: 'child', dependsOn: ['missing'] }], message: /Unknown Feature Request dependency: missing/ },
    { graph: [{ id: 'child', dependsOn: [] }, { id: 'child', dependsOn: [] }], message: /Duplicate Feature Request identity.*child/ },
    { graph: [{ id: 'child', dependsOn: ['child'] }], message: /cycle includes child/ },
    { graph: [{ id: 'child', dependsOn: ['parent'] }, { id: 'parent', dependsOn: ['child'] }], message: /cycle includes child/ },
  ];
  for (const { graph, message } of cases) await assert.rejects(deliveryDependencies('child', graph, baseline, noCalls), error => testErrorCode(error) === 'conflict' && error instanceof Error && message.test(error.message));
});

test('each reachable prerequisite is checked once in dependency order and exact baseline is retained', async () => {
  const graph = [{ id: 'child', dependsOn: ['left', 'right'] }, { id: 'left', dependsOn: ['base'] }, { id: 'right', dependsOn: ['base'] }, { id: 'base', dependsOn: [] }, { id: 'unrelated', dependsOn: ['unrelated'] }];
  const visited = [], commits = [];
  const result = await deliveryDependencies('child', graph, baseline, {
    accepted: id => { visited.push(id); return accepted(id); },
    incorporated: async (commit, base) => { commits.push([commit, base]); return true; },
  });
  assert.deepEqual(visited, ['base', 'left', 'right']);
  assert.deepEqual(commits, Array.from({ length: 3 }, () => ['b'.repeat(40), baseline]));
  assert.deepEqual(result, visited.map(id => ({ ...accepted(id), baseline })));
  assert.deepEqual(await deliveryDependencies('child', [{ id: 'child', dependsOn: [] }], baseline, noCalls), []);
});

test('human acceptance and incorporated code are independent mandatory conditions', async () => {
  const graph = [{ id: 'child', dependsOn: ['parent'] }, { id: 'parent', dependsOn: [] }];
  await assert.rejects(deliveryDependencies('child', graph, baseline, { accepted: () => undefined, incorporated: noCalls.incorporated }), error => testErrorCode(error) === 'conflict' && error instanceof Error && /needs human acceptance/.test(error.message));
  await assert.rejects(deliveryDependencies('child', graph, baseline, { accepted: id => ({ ...accepted(id), candidateCommit: undefined }), incorporated: noCalls.incorporated }), error => testErrorCode(error) === 'conflict' && error instanceof Error && /not confirmed in the selected baseline/.test(error.message));
  await assert.rejects(deliveryDependencies('child', graph, baseline, { accepted, incorporated: async () => false }), error => testErrorCode(error) === 'conflict' && error instanceof Error && /not confirmed in the selected baseline/.test(error.message));
  const failure = Error('Local Git unavailable');
  await assert.rejects(deliveryDependencies('child', graph, baseline, { accepted, incorporated: async () => { throw failure; } }), failure);
  const source = { ...accepted('parent'), includesCode: false, candidateCommit: undefined };
  const result = await deliveryDependencies('child', graph, baseline, { accepted: () => source, incorporated: noCalls.incorporated });
  assert.deepEqual(result, [{ ...source, baseline }]); assert.notEqual(result[0], source);
  source.requestId = 'modified'; assert.equal(result[0].requestId, 'request-parent');
});
