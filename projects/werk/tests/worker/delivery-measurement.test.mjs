import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, provider } from './request-gate-fixtures.mjs';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { defaultDeliveryProjectPolicy, deliveryPolicySnapshot } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { deliveryEventMeasurement } from '../../src/worker/dist/worker/application/delivery-event-measurement.js';
import { deliveryMetrics } from '../../src/worker/dist/worker/status/workspace-delivery-metrics.js';

function request(journal, id, projectId = 'project-one', prepared = true) {
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  const value = journal.ensure({ owner: { sessionId: 'session-' + id, rootTurnId: 'turn-' + id, taskId: 'task-' + id }, provider, policy,
    input: { kind: 'patch', title: 'Private request ' + id, message: 'Private project requirements must not appear in aggregate reports.', criteria: ['Accepted result is observable.'], files: [{ path: 'source.txt', bytes: 1 }],
      context: { repositoryId: projectId, implementation: { mode: 'development' }, deliveryPolicy: deliveryPolicySnapshot(defaultDeliveryProjectPolicy(), 'a'.repeat(40)) } } });
  if (!prepared) return value;
  journal.evaluate(value.id, 'ready'); journal.bindTurn(value.id, 'turn-' + id);
  return journal.prepareExecution(value.id, 'turn-' + id, 'invocation-' + id);
}

test('canonical events freeze lifecycle, project, selected profile and blockers at each transition', async t => {
  const { journal } = await fixture(t), current = request(journal, 'measure');
  const held = journal.deliveryUpdate(current.id, { action: 'hold', code: 'dependency', reason: 'A private predecessor needs integration.' });
  const saved = journal.events(current.id).events.at(-1);
  assert.equal(saved.measurement.projectId, 'project-one'); assert.equal(saved.measurement.profileId, 'feature');
  assert.ok(saved.measurement.blockers.some(item => item.code === 'dependency' && item.category === 'dependency'));
  assert.equal(JSON.stringify(saved.measurement).includes('private predecessor'), false);
  const cleared = journal.deliveryUpdate(current.id, { action: 'clear_hold', code: 'dependency' });
  assert.equal(journal.events(current.id).events.at(-1).measurement.blockers.some(item => item.code === 'dependency'), false);
  assert.ok(saved.measurement.blockers.some(item => item.code === 'dependency'));
  const observations = [{ kind: /** @type {const} */ ('review_effort'), durationMs: 90000, source: /** @type {const} */ ('user_reported') }];
  const snapshot = deliveryEventMeasurement(cleared, observations);
  observations[0].durationMs = 1;
  assert.ok(snapshot.observations[0].kind === 'review_effort');
  assert.equal(snapshot.observations[0].durationMs, 90000);
  assert.equal(held.delivery.holds.length, 1);
});

test('delivery metrics reads every request and event page before claiming complete denominators', async t => {
  const { journal } = await fixture(t), first = request(journal, 'first');
  for (let index = 0; index < 105; index++) request(journal, 'historical-' + index, 'project-one', false);
  const last = request(journal, 'last', 'project-two');
  for (let index = 0; index < 110; index++) {
    journal.deliveryUpdate(first.id, { action: 'hold', code: 'dependency', reason: 'Private dependency detail.' });
    journal.deliveryUpdate(first.id, { action: 'clear_hold', code: 'dependency' });
  }
  let invocationPages = 0;
  const workspace = /** @type {Parameters<typeof deliveryMetrics>[0]} */ (/** @type {unknown} */ ({ sessions: { requests: journal,
    runs: { list(query) { invocationPages++; return { rows: [], nextCursor: query.cursor ? null : 'second-page' }; } },
  } }));
  const report = deliveryMetrics(workspace, { action: 'metrics' });
  assert.equal(report.cohort.requests, 107); assert.equal(report.cohort.completeHistories, 107); assert.equal(invocationPages, 2);
  assert.equal(report.blockers.find(item => item.category === 'dependency').waits, 110);
  assert.deepEqual(report.projects, ['project-one', 'project-two']);
  assert.equal(JSON.stringify(report).includes('Private'), false);
  const filtered = deliveryMetrics(workspace, { action: 'metrics', projectId: 'project-two' });
  assert.equal(filtered.cohort.requests, 1); assert.equal(filtered.cohort.completeHistories, 1);
  assert.equal(filtered.blockers.some(item => item.category === 'dependency'), false);
  assert.notEqual(first.id, last.id);
  for (const query of [{ action: 'metrics', since: 'yesterday' }, { action: 'metrics', until: '2026-10-20' }, { action: 'metrics', includePrompts: true }, { action: 'metrics', since: '2030-01-01T00:00:00Z' }]) assert.throws(() => deliveryMetrics(workspace, query));
});


test('production metrics include submitted readiness waits before a delivery run exists and exclude ordinary chat', async t => {
  const { journal } = await fixture(t);
  const pending = request(journal, 'awaiting-assessment', 'project-waiting', false);
  const ready = request(journal, 'awaiting-slot', 'project-waiting', false);
  assert.equal(journal.evaluate(ready.id, 'ready').passed, true);
  journal.deliveryUpdate(pending.id, { action: 'hold', code: 'readiness', reason: 'Awaiting the required readiness assessment.' });
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  journal.ensure({ owner: { sessionId: 'ordinary-chat', rootTurnId: 'ordinary-turn' }, provider, policy,
    input: { kind: 'chat', title: 'Ordinary chat', message: 'Unrelated conversation is outside the software delivery cohort.' } });
  const workspace = /** @type {Parameters<typeof deliveryMetrics>[0]} */ (/** @type {unknown} */ ({ sessions: { requests: journal, runs: { list() { return { rows: [], nextCursor: null }; } } } }));
  const report = deliveryMetrics(workspace, { action: 'metrics', projectId: 'project-waiting' });
  assert.equal(journal.get(pending.id).delivery, undefined); assert.equal(journal.get(ready.id).delivery, undefined);
  assert.equal(report.cohort.requests, 2); assert.equal(report.cohort.completeHistories, 2);
  assert.equal(report.autonomousReview.denominator, 0); assert.equal(report.autonomousReview.unknown, 2);
  assert.equal(report.firstFeedback.samples, 1); assert.equal(report.firstFeedback.unknown, 1);
  assert.equal(report.verification.firstPass.denominator, 0); assert.equal(report.verification.firstPass.unknown, 2);
  assert.equal(report.blockers.find(item => item.category === 'requirements').active, 1);
  assert.equal(report.blockerCoverage.measuredRequests, 2);
  assert.equal(deliveryMetrics(workspace, { action: 'metrics' }).cohort.requests, 2);
  assert.ok(report.notes.some(note => /Drafts and malformed files/.test(note)));
});
