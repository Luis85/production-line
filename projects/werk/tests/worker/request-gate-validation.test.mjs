import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultGatePolicy, evaluateGate, validateGateInput, validateGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';

test('gate operators reject coercible values before they can change the comparison', () => {
  const policy = defaultGatePolicy();
  for (const op of [['eq'], ['neq'], ['gte'], ['lte'], [['eq']], { toString: () => 'eq' }, null, true, 1]) {
    const malformed = { ...policy, ready: { ...policy.ready, chat: [{ id: 'minimum', fact: 'input.messageLength', op, value: 20 }] } };
    assert.throws(() => validateGatePolicy(malformed), { code: 'invalid_input' });
  }
});

test('validated numeric comparisons preserve exact equality and inequality semantics', () => {
  /** @type {Array<[import('../../src/worker/application/request-gate-contracts.ts').GateRule['op'], number, boolean]>} */
  const cases = [['eq', 19, false], ['eq', 20, true], ['neq', 20, false], ['neq', 21, true], ['gte', 19, false], ['gte', 20, true], ['lte', 20, true], ['lte', 21, false]];
  for (const [op, observed, passed] of cases) {
    const original = defaultGatePolicy();
    const policy = validateGatePolicy({ ...original, ready: { ...original.ready, chat: [{ id: 'minimum', fact: 'input.messageLength', op, value: 20 }] } });
    assert.equal(evaluateGate(policy, 'ready', 'chat', { 'input.messageLength': observed }).passed, passed);
    assert.equal(evaluateGate(policy, 'ready', 'chat', {}).rules[0].result, 'unknown');
  }
});

test('request kinds require exact strings and preserve detached input snapshots', () => {
  const input = { title: 'Bounded request', message: 'Implement the accepted change.', criteria: ['The behavior is verified.'] };
  for (const kind of [['chat'], ['patch'], [['patch']], { toString: () => 'patch' }, null, true, 1])
    assert.throws(() => validateGateInput({ ...input, kind }), { code: 'invalid_input' });
  for (const kind of ['chat', 'patch']) {
    const accepted = validateGateInput({ ...input, kind });
    assert.equal(accepted.kind, kind);
    assert.deepEqual(accepted.criteria, input.criteria);
    assert.notEqual(accepted.criteria, input.criteria);
  }
});
