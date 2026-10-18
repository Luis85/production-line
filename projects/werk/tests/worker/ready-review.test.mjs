import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture, input, passed, usage, wait } from './ready-review-fixtures.mjs';
import { readyReviewSessionId, validateReadyReviewInput } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
import { parseReadyReviewResult } from '../../src/worker/dist/worker/application/ready-review-protocol.js';
import { featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';

test('review shares capacity and durable evidence without duplicate tasks; frozen dispatch and completed replay survive restart', async t => {
  const f = await fixture(t, { capacity: 1 }), accepted = input(), caller = structuredClone(accepted);
  const release = await f.sessions.executor.acquire('implementation', new AbortController().signal);
  const preparation = f.schedule(caller);
  caller.source.markdown = 'Caller mutation'; caller.prompt.content = 'Caller mutation';
  const attempt = await preparation;
  assert.equal(f.calls.length, 0); assert.equal(f.manager.active, 1);
  assert.equal(f.sessions.admissionActive, 1); assert.equal(f.sessions.busy, true);
  assert.equal(f.sessions.view().capacity.local.used, 1);
  await assert.rejects(f.schedule(input('second')), /queue is full/);
  await assert.rejects(f.sessions.updateProviders(async () => {}), /active replies/);
  assert.deepEqual(await f.schedule(accepted), attempt);
  f.selectedProfile.model = 'changed-after-dispatch';
  const turn = f.sessions.interactions.turn(attempt.sessionId, attempt.turnId);
  assert.equal(turn.dispatch.provider.model, 'original-model');
  assert.equal(turn.dispatch.session.featureRequestKey, accepted.feature.key);
  assert.equal(turn.dispatch.session.generation, 1);
  assert.equal(turn.dispatch.policy.tools, 'none'); assert.equal(turn.dispatch.policy.filesystem, 'read_only');
  assert.equal(turn.dispatch.toolManifest, undefined); assert.equal(turn.dispatch.capabilities.tools, 'none');
  assert.equal(turn.dispatch.messages.length, 1);
  assert.equal(turn.dispatch.messages[0].text.split(accepted.prompt.content).length, 2);
  assert.ok(turn.dispatch.messages[0].text.includes(JSON.stringify(accepted.source)));
  release(); await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.manager.inspect(accepted).result.passed, true);
  const run = f.sessions.runs.get(attempt.runId);
  assert.equal(run.purpose, 'gate_review'); assert.equal(run.taskId, attempt.sessionId);
  assert.equal(run.usage.inputTokens, 12); assert.ok(run.before); assert.ok(run.after);
  assert.equal(f.consumption.status().measuredTokens, 16);
  assert.equal(f.sessions.requests.list().total, 0);
  assert.equal(f.sessions.view().records.some(record => record.id === attempt.sessionId), false);
  await f.restart();
  assert.deepEqual(await f.schedule(accepted), attempt); assert.equal(f.calls.length, 1);
  assert.equal(f.manager.inspect(accepted).result.passed, true);
  await assert.rejects(f.schedule({ ...accepted, title: 'Conflicting replay' }), /accepted source/);
});

test('a started review interrupted on shutdown never repeats automatically; a new committed generation uses the same FR session', async t => {
  let calls = 0;
  const f = await fixture(t, { respond: async (_request, signal) => {
    if (++calls > 1) return { type: 'needs_input', request: { schemaVersion: 1, kind: 'question', message: 'Which user role may approve?' } };
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted(); return passed();
  } });
  const first = input(); await f.schedule(first); await wait(() => calls === 1);
  await f.restart();
  assert.equal(f.manager.inspect(first).state, 'interrupted');
  await f.schedule(first); assert.equal(calls, 1);
  const second = input('feature-one', 2); second.previousAssessment = { passed: false, summary: 'Review target role.', findings: [{ kind: 'question', message: 'Which user role may approve?', blocking: true }] }; await f.schedule(second); await f.settle();
  assert.equal(calls, 2); assert.equal(readyReviewSessionId(first), readyReviewSessionId(second));
  const result = f.manager.inspect(second).result;
  assert.equal(result.passed, false); assert.equal(result.findings[0].kind, 'question'); assert.equal(result.findings[0].blocking, true);
  assert.ok(f.calls[1].messages[0].text.includes(JSON.stringify(second.previousAssessment)));
  assert.equal(f.calls[1].session.generation, 2); assert.equal(f.calls[1].messages.length, 1);
  assert.equal(f.sessions.interactions.view(readyReviewSessionId(first)).pending, null, 'Markdown owns answers; no duplicate chat pending workflow.');
});

test('committed result and numeric finish acknowledgment loss cannot cause a second provider call', async t => {
  for (const failure of ['result', 'run']) {
    const f = await fixture(t), accepted = input(failure);
    if (failure === 'result') {
      const complete = f.sessions.interactions.complete.bind(f.sessions.interactions);
      f.sessions.interactions.complete = (...args) => { complete(...args); throw Error('Lost completion acknowledgment'); };
    } else {
      const finish = f.sessions.runs.finish.bind(f.sessions.runs);
      f.sessions.runs.finish = async (...args) => { await finish(...args); throw Error('Lost numeric acknowledgment'); };
    }
    const attempt = await f.schedule(accepted); await f.settle();
    assert.equal(f.manager.inspect(accepted).state, 'completed');
    await f.restart();
    assert.deepEqual(await f.schedule(accepted), attempt); assert.equal(f.calls.length, 1);
    assert.equal(f.manager.inspect(accepted).result.passed, true);
  }
});

test('dispatch persistence failure prevents inference and remains a durable non-retried attempt', async t => {
  const f = await fixture(t), accepted = input(), prepare = f.sessions.interactions.prepare.bind(f.sessions.interactions);
  f.sessions.interactions.prepare = (...args) => { prepare(...args); throw Error('Lost prepare acknowledgment'); };
  await assert.rejects(f.schedule(accepted), /prepare acknowledgment/); await f.settle();
  assert.equal(f.calls.length, 0); assert.equal(f.manager.inspect(accepted).state, 'failed');
  await f.restart(); await f.schedule(accepted); assert.equal(f.calls.length, 0);
});

test('usage persistence failure aborts inference, prevents passing, and drains already queued reviews without paid calls', async t => {
  /** @type {{enter?: () => void; unblock?: () => void}} */
  const deferred = {};
  const entered = new Promise(resolve => { deferred.enter = () => resolve(undefined); }), blocked = new Promise(resolve => { deferred.unblock = () => resolve(undefined); });
  const f = await fixture(t, { respond: async (_request, signal, observe) => {
    assert.ok(deferred.enter); deferred.enter(); await blocked; observe?.(usage); signal.throwIfAborted(); return passed();
  } });
  const first = input(), second = input('queued');
  await f.schedule(first); await entered; await f.schedule(second);
  f.sessions.runs.observeUsage = () => { throw Error('Evidence storage unavailable'); };
  assert.ok(deferred.unblock); deferred.unblock(); await f.settle();
  assert.equal(f.calls.length, 1);
  assert.notEqual(f.manager.inspect(first).state, 'completed'); assert.notEqual(f.manager.inspect(second).state, 'completed');
  assert.equal(f.manager.inspect(first).error, 'evidence_unavailable'); assert.equal(f.sessions.executor.busy, false);
  await assert.rejects(f.schedule(input('third')), /unavailable/);
});

test('missing numeric completion evidence blocks promotion while restart reconciles the saved result without another call', async t => {
  const f = await fixture(t), accepted = input();
  f.sessions.runs.finish = async () => { throw Error('No completion write'); };
  await f.schedule(accepted); await f.settle();
  assert.equal(f.manager.inspect(accepted).state, 'failed'); assert.equal(f.manager.inspect(accepted).error, 'evidence_unavailable');
  await f.restart(); await f.schedule(accepted);
  assert.equal(f.manager.inspect(accepted).result.passed, true); assert.equal(f.calls.length, 1);
});

test('restart detects changed retained source context even when the operation fingerprint still matches', async t => {
  const f = await fixture(t), accepted = input();
  const attempt = await f.schedule(accepted); await f.settle();
  const db = new DatabaseSync(join(f.directory, 'worker-interactions.sqlite'));
  try {
    const row = db.prepare('SELECT payload FROM interaction_turns WHERE id=?').get(attempt.turnId), saved = JSON.parse(String(row.payload));
    saved.context.input.prompt.content = 'Swapped reviewer instructions.';
    saved.context.input.prompt.sha256 = featureContentHash(saved.context.input.prompt.content);
    db.prepare('UPDATE interaction_turns SET payload=? WHERE id=?').run(JSON.stringify(saved), attempt.turnId);
  } finally { db.close(); }
  await f.restart();
  assert.throws(() => f.manager.inspect(accepted), /accepted source/);
  await assert.rejects(f.schedule(accepted), /accepted source/); assert.equal(f.calls.length, 1);
});

test('malformed, contradictory and oversized results fail once, retain usage, and cannot authorize implementation', async t => {
  const invalid = [
    { schemaVersion: 1, passed: true, summary: 'Claimed pass', findings: [{ kind: 'question', message: 'Who owns this?', blocking: false }] },
    { schemaVersion: 1, passed: true, summary: 'Claimed pass', findings: [], facts: { 'tests.passed': true } },
    { schemaVersion: 1, passed: true, summary: 'Huge response', findings: Array.from({ length: 8 }, () => ({ kind: 'issue', message: 'a'.repeat(4000), blocking: false })) },
  ];
  for (const result of invalid) {
    const f = await fixture(t, { respond: async () => ({ type: 'completed', text: JSON.stringify(result) }) }), accepted = input();
    await f.schedule(accepted); await f.settle();
    assert.equal(f.manager.inspect(accepted).error, 'protocol'); assert.equal(f.manager.inspect(accepted).result, undefined);
    assert.equal(f.sessions.runs.list().rows[0].usage.outputTokens, 4);
    await f.schedule(accepted); assert.equal(f.calls.length, 1);
  }
  assert.throws(() => validateReadyReviewInput({ ...input(), source: { ...input().source, markdown: 'Changed without digest' } }));
  assert.throws(() => parseReadyReviewResult({ schemaVersion: 1, passed: true, summary: 'Empty output', findings: [{ kind: 'issue', message: 'Blocking concern', blocking: true }] }));
});

test('Ready Check usage consumes the same configured allowance and blocks the next review without another model call', async t => {
  const f = await fixture(t), first = input();
  await f.settings.update({ consumption: { enabled: true, period: 'daily', allowance: 20, workerPercent: 100, perRunReservation: 10 } });
  await f.schedule(first); await f.settle();
  assert.equal(f.manager.inspect(first).result.passed, true);
  assert.equal(f.consumption.status().remainingTokens, 4);
  assert.equal(f.consumption.status().reason, 'insufficient_reservation');
  await assert.rejects(f.schedule(input('next-review')), /allowance/);
  assert.equal(f.calls.length, 1); assert.equal(f.manager.active, 0);
});
