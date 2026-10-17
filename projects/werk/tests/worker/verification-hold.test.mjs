import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { defaultGatePolicy, evaluateGate } from '../../src/worker/dist/worker/application/request-gates.js';

function customPolicy() {
  const policy = defaultGatePolicy();
  policy.reviewer.enabled = false;
  policy.done.patch = [{ id: 'only-summary', fact: 'output.nonEmpty', op: 'eq', value: true }];
  return policy;
}
test('required verification cannot be removed or inverted by a custom completion rule', () => {
  const policy = customPolicy();
  for (const configured of [[], policy.done.patch, [{ id: 'expect-unverified', fact: 'output.verificationPassed', op: 'eq', value: false }]]) {
    policy.done.patch = configured;
    const result = evaluateGate(policy, 'done', 'patch', { 'output.nonEmpty': true, 'output.verificationPassed': false });
    assert.equal(result.passed, false);
    assert.deepEqual(result.rules.at(-1), { ruleId: 'worker-required-verification', fact: 'output.verificationPassed', expected: true, observed: false, result: 'fail' });
  }
  assert.equal(evaluateGate(customPolicy(), 'done', 'patch', { 'output.nonEmpty': true }).passed, true, 'Legacy proposals have no implementation verification fact.');
  assert.equal(evaluateGate(customPolicy(), 'done', 'patch', { 'output.nonEmpty': true, 'output.verificationPassed': true }).passed, true);
});

test('a cached completion verdict from before the mandatory rule cannot keep an unverified candidate done', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-verification-hold-')));
  let journal = new WorkerRequestJournal(directory);
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); });
  await journal.init();
  const request = journal.ensure({ owner: { sessionId: 'feature', rootTurnId: 'initial' }, provider: { id: 'fixture', model: 'fixture', instruction: '' },
    input: { kind: 'patch', title: 'Implement feature', message: 'Change the approved file.', files: [{ path: 'source.txt', bytes: 10 }] }, policy: customPolicy() });
  journal.evaluate(request.id, 'ready');
  journal.bindTurn(request.id, 'turn'); journal.prepareExecution(request.id, 'turn', 'run'); journal.startExecution(request.id, 'turn', 'run');
  const held = journal.recordResult(request.id, 'turn', 'run', { type: 'completed', text: 'A proposed implementation without completed checks.' }, { 'output.verificationPassed': false });
  assert.equal(held.phase, 'needs_rework');
  const outputDigest = held.execution.outputDigest;
  // Simulate the exact durable verdict produced by the previous evaluator: identical
  // facts and output digest, but no mandatory verification rule in the cached verdict.
  const old = structuredClone(held), evaluation = old.evaluations.at(-1);
  old.phase = 'done'; evaluation.passed = true;
  evaluation.rules = evaluation.rules.filter(rule => rule.ruleId !== 'worker-required-verification');
  old.findings = old.findings.filter(finding => finding.ruleId !== 'worker-required-verification');
  journal.close();
  const db = new DatabaseSync(join(directory, 'worker-requests.sqlite'));
  try { db.prepare('UPDATE worker_requests SET phase=?,payload=? WHERE id=?').run('done', JSON.stringify(old), request.id); } finally { db.close(); }
  journal = new WorkerRequestJournal(directory); await journal.init();
  const current = journal.evaluate(request.id, 'done');
  assert.equal(current.passed, false); assert.notEqual(current.id, evaluation.id);
  assert.equal(journal.get(request.id).phase, 'needs_rework');
  assert.equal(journal.get(request.id).execution.outputDigest, outputDigest);
  assert.match(journal.get(request.id).findings.at(-1).message, /Required feature checks have not all passed/);
  assert.equal(journal.evaluate(request.id, 'done').id, current.id, 'The corrected held verdict remains idempotent.');
});
