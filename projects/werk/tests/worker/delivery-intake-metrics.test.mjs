import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeatureRequests } from '../../src/worker/dist/worker/application/feature-requests.js';
import { MarkdownFeatureFolder } from '../../src/worker/dist/worker/infrastructure/features/folder.js';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';
import { buildDeliveryMetrics } from '../../src/worker/dist/worker/application/delivery-metrics.js';
import { readyReviewSessionId } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
import { observeFeatureIntake, appendFeatureIntake, validateFeatureIntakeMeasurements } from '../../src/worker/dist/worker/application/feature-intake-measurement.js';
import { sharedFeatureRequestReference } from '../../src/worker/dist/worker/application/feature-request-reference.js';
import { fixture as sharedFixture, sourcePath } from './shared-feature-fixture.mjs';

const provider = { id: 'fixture', model: 'fixture-only', instruction: 'No external calls.' };
const localSource = '---\nschema: worker.request/v1\nid: FR-metrics\ntitle: Retain intake metrics\nintent: submit\npaths: [src/]\n---\n## Outcome\n\nA private requested outcome.\n\n## Acceptance criteria\n\n- The request remains one measured entity.\n';
/** @param {WorkerRequestJournal} journal
 * @param {import('../../src/worker/application/feature-intake-measurement.js').FeatureIntakeMeasurement[]} intake
 * @param {import('../../src/worker/application/delivery-metrics-contracts.js').DeliveryMetricsQuery} [query] */
function report(journal, intake, query = {}) {
  const requests = journal.list({ limit: 100 }).requests.map(row => journal.get(row.id));
  return buildDeliveryMetrics({ requests, events: requests.flatMap(request => journal.events(request.id).events), runs: [], completeRequestIds: requests.map(request => request.id), intake }, query);
}
async function localFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'werk-intake-cohort-'))), state = join(root, 'state'), features = join(root, 'features');
  await mkdir(state); let blocked = true, admissions = 0;
  /** @type {FeatureRequests} */ let intake;
  /** @type {WorkerRequestJournal} */ let requests;
  const policy = defaultGatePolicy(); policy.reviewer.enabled = false;
  /** @type {import('../../src/worker/application/feature-requests.js').FeatureQueuePort} */
  const queue = {
    async prepare() { if (blocked) throw Error('Private setup is incomplete.'); return {}; },
    async submit(record) {
      admissions++;
      const input = record.input; assert.ok(input); assert.ok(input.paths); assert.ok(record.feature);
      requests.ensure({ owner: { sessionId: record.sessionId, rootTurnId: record.taskId, taskId: record.taskId, featureId: record.feature.key }, provider, policy,
        input: { kind: 'patch', title: input.title, message: input.message, criteria: input.criteria, files: input.paths.map(path => ({ path, bytes: null })) } });
    },
    inspect(record) { const request = requests.forSession(record.sessionId); return request ? { status: 'queued', request } : undefined; },
  };
  async function open() { requests = new WorkerRequestJournal(state); await requests.init(); intake = new FeatureRequests(new MarkdownFeatureFolder(features, state, 'claude-cli', root, 'local-project'), queue, 0, () => true, 'local-project'); await intake.init(); }
  await open(); t.after(async () => { await intake.close(); requests.close(); await rm(root, { recursive: true, force: true }); });
  return { state, features, get intake() { return intake; }, get requests() { return requests; }, get admissions() { return admissions; },
    unblock() { blocked = false; }, async scan() { await intake.tick(true); await intake.tick(true); },
    async restart(withoutMeasurements = false) { await intake.close(); requests.close(); if (withoutMeasurements) { const path = join(state, 'feature-index.json'), saved = JSON.parse(await readFile(path, 'utf8')); delete saved.measurements; await writeFile(path, JSON.stringify(saved)); } await open(); },
  };
}

test('local submission blocked before reservation remains one measured FR through admission and restart', async t => {
  const f = await localFixture(t), path = join(f.features, 'request.md');
  await writeFile(path, localSource.replace('intent: submit', 'intent: draft')); await f.scan();
  assert.equal(f.intake.measurements().length, 0, 'Drafts are not submitted delivery work.');
  await writeFile(path, localSource); await f.scan();
  assert.equal(f.admissions, 0); assert.equal(f.requests.list().total, 0); assert.equal(f.intake.view().records.length, 0);
  const before = f.intake.measurements(); assert.equal(before.length, 1); assert.ok(before[0].submittedAt); assert.equal(before[0].complete, true);
  await f.scan(); assert.deepEqual(f.intake.measurements(), before, 'Stable preflight polling emits no duplicate events.');
  const blocked = report(f.requests, before); assert.equal(blocked.cohort.requests, 1); assert.equal(blocked.firstFeedback.samples, 1); assert.equal(blocked.cohort.unknownSubmissionTimes, 0);
  await f.restart(); await f.scan(); assert.equal(f.intake.measurements()[0].submittedAt, before[0].submittedAt);
  assert.equal(report(f.requests, f.intake.measurements()).cohort.requests, 1);
  await new Promise(resolve => setTimeout(resolve, 5)); const afterSubmission = new Date().toISOString();
  f.unblock(); await f.scan(); assert.equal(f.admissions, 1); assert.equal(f.requests.list().total, 1);
  const admitted = f.intake.measurements(), request = f.requests.get(f.requests.list().requests[0].id);
  assert.equal(admitted[0].feature.key, request.owner.featureId); assert.equal(admitted[0].submittedAt, before[0].submittedAt);
  assert.equal(report(f.requests, admitted).cohort.requests, 1, 'Intake and canonical admission are the same cohort member.');
  assert.equal(report(f.requests, admitted, { since: afterSubmission }).cohort.requests, 0, 'Admission must not reset submission time.');
  assert.equal(report(f.requests, admitted, { projectId: 'local-project' }).cohort.requests, 1);
  assert.doesNotMatch(JSON.stringify(report(f.requests, admitted)), /Private setup|private requested outcome/);
  await f.restart(); await f.scan(); assert.equal(f.admissions, 1); assert.equal(report(f.requests, f.intake.measurements()).cohort.requests, 1);
});

/** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewResult} */
const questions = { passed: false, summary: 'Private clarification summary.', findings: [{ kind: 'question', blocking: true, message: 'Private question: should navigation wrap?' }] };
/** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewResult} */
const passed = { passed: true, summary: 'The request is actionable.', findings: [] };
async function reviewedSharedFixture(t) {
  let lostScheduleAck = false;
  /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewInput[]} */ const inputs = [];
  /** @type {Map<string, import('../../src/worker/application/ready-review-contracts.js').ReadyReviewExecutionView>} */ const executions = new Map();
  /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewPort} */
  const readyReview = {
    async schedule(input) { if (!executions.has(input.operationId)) { inputs.push(structuredClone(input)); executions.set(input.operationId, { operationId: input.operationId, sessionId: readyReviewSessionId(input), turnId: 'turn-' + input.generation, runId: 'review-run-' + input.generation, state: 'running' }); } const execution = executions.get(input.operationId); assert.ok(execution); if (lostScheduleAck) throw Error('Reviewer admission acknowledgment was lost.'); return structuredClone(execution); },
    inspect(input) { return executions.has(input.operationId) ? structuredClone(executions.get(input.operationId)) : undefined; },
  };
  const f = await sharedFixture(t, { readyReview });
  return Object.assign(f, { inputs, loseScheduleAck() { lostScheduleAck = true; },
    finish(result) { Object.assign(executions.get(inputs.at(-1).operationId), { state: 'completed', result: structuredClone(result) }); },
    answer(text) { const current = f.repositories.get('shared').files.get(sourcePath), start = '<!-- werk:ready-review:answer -->\n', end = '\n<!-- /werk:ready-review:answer -->'; const left = current.indexOf(start) + start.length, right = current.indexOf(end, left); assert.ok(left >= start.length && right >= left); f.commitFiles('shared', { [sourcePath]: (current.slice(0, left) + text + current.slice(right)).replace(/^status: .*$/m, 'status: ready') }); },
  });
}

test('shared preflight and Ready Check clarification correlate with admission without duplicate cohort or cycles', async t => {
  const f = await reviewedSharedFixture(t); f.controls.admissionIssue = () => 'Private preflight requirement is incomplete.';
  await f.intake.sync(); assert.equal(f.inputs.length, 0); assert.equal(f.submits.length, 0); assert.equal((await f.state()).records.length, 0);
  const before = f.intake.measurements(); assert.equal(before.length, 1); assert.ok(before[0].submittedAt);
  assert.equal(report(f.requests, before).cohort.requests, 1);
  await f.restart(); await f.intake.sync(); assert.equal(f.intake.measurements()[0].submittedAt, before[0].submittedAt);
  f.controls.admissionIssue = () => undefined; await f.intake.sync(); assert.equal(f.inputs.length, 1);
  assert.ok(f.intake.measurements()[0].events.some(event => event.providerRunId === 'review-run-1'), 'Actual reviewer receipt is retained before any feedback.');
  f.finish(questions); await f.intake.sync();
  const stable = f.intake.measurements(); await f.intake.sync(); assert.deepEqual(f.intake.measurements(), stable, 'Waiting on the same question does not create more observations.');
  const waiting = report(f.requests, f.intake.measurements()); assert.equal(waiting.cohort.requests, 1); assert.equal(waiting.clarification.cycles, 1); assert.equal(waiting.clarification.pendingCycles, 1); assert.equal(waiting.clarification.completedCycles, 0);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(report(f.requests, f.intake.measurements()).clarification.cycles, 1);
  f.answer(''); await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(report(f.requests, f.intake.measurements()).clarification.completedCycles, 0);
  f.answer('Private answer: wrap to the first item.'); await f.intake.sync(); assert.equal(f.inputs.length, 2);
  f.finish(passed); await f.intake.sync(); assert.equal(f.submits.length, 1);
  const record = (await f.state()).records[0], reference = sharedFeatureRequestReference(record), request = f.requests.forSession('local-' + record.taskId);
  assert.ok(request); f.requests.bindFeature(request.owner.sessionId, reference.key);
  const admitted = f.intake.measurements(); assert.equal(admitted[0].feature.key, reference.key); assert.equal(admitted[0].submittedAt, before[0].submittedAt);
  const complete = report(f.requests, admitted); assert.equal(complete.cohort.requests, 1); assert.equal(complete.clarification.cycles, 1); assert.equal(complete.clarification.completedCycles, 1); assert.equal(complete.clarification.pendingCycles, 0);
  assert.equal(report(f.requests, admitted, { projectId: 'shared' }).cohort.requests, 1);
  assert.doesNotMatch(JSON.stringify(complete), /Private (?:question|answer|clarification|preflight)|navigation\.md/);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.equal(f.submits.length, 1);
  const restored = report(f.requests, f.intake.measurements()); assert.equal(restored.cohort.requests, 1); assert.equal(restored.clarification.cycles, 1); assert.equal(restored.clarification.completedCycles, 1);
});

test('a retained local request from before intake instrumentation keeps unknown submission history', async t => {
  const f = await localFixture(t); f.unblock(); await writeFile(join(f.features, 'request.md'), localSource); await f.scan(); assert.equal(f.admissions, 1);
  await f.restart(true); await f.scan(); assert.equal(f.admissions, 1);
  const retained = f.intake.measurements(); assert.equal(retained.length, 1); assert.equal(retained[0].submittedAt, null); assert.equal(retained[0].complete, false);
  const historical = report(f.requests, retained); assert.equal(historical.cohort.requests, 1); assert.equal(historical.cohort.unknownSubmissionTimes, 1); assert.equal(historical.firstFeedback.samples, 0); assert.equal(historical.firstFeedback.unknown, 1);
  assert.equal(historical.clarification.unknownRequests, 1, 'An old request is not proof of zero earlier clarifications.');
  await f.restart(); await f.scan(); assert.equal(f.intake.measurements()[0].submittedAt, null); assert.equal(f.admissions, 1);
});

test('historical shared Ready Check state cannot manufacture an earlier submission timestamp or replay a reviewer', async t => {
  const f = await reviewedSharedFixture(t); await f.intake.sync(); f.finish(questions); await f.intake.sync(); assert.equal(f.inputs.length, 1);
  const path = join(f.directory, 'shared-intake.json'), saved = JSON.parse(await readFile(path, 'utf8')); delete saved.measurements; await writeFile(path, JSON.stringify(saved));
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
  const retained = f.intake.measurements(); assert.equal(retained.length, 1); assert.equal(retained[0].submittedAt, null); assert.equal(retained[0].complete, false);
  const historical = report(f.requests, retained); assert.equal(historical.cohort.requests, 1); assert.equal(historical.cohort.unknownSubmissionTimes, 1); assert.equal(historical.firstFeedback.samples, 0); assert.equal(historical.firstFeedback.unknown, 1);
  assert.equal(historical.cohort.completeHistories, 0);
});


test('bounded intake telemetry preserves its prefix and explicitly marks lost coverage', () => {
  const feature = sharedFeatureRequestReference({ id: 'FR-bounded', sourcePath: 'features/bounded.md', binding: { repositoryId: 'project', remote: 'origin', branch: 'main', workflowPath: 'workflow.json' } });
  const at = index => new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
  const metric = observeFeatureIntake({}, feature, 'accepted-source', {}, at(0));
  for (let index = 1; index <= 300; index++) appendFeatureIntake(metric, { inputRevision: 'revision-' + index, phase: 'waiting_input', feedback: true, blockers: [{ code: 'policy_approval', category: 'permissions' }] }, at(index));
  assert.equal(metric.complete, false); assert.ok(metric.events.length <= 256); assert.equal(metric.submittedAt, at(0));
  assert.doesNotThrow(() => validateFeatureIntakeMeasurements([metric]));
  const retained = structuredClone(metric.events);
  appendFeatureIntake(metric, { inputRevision: 'new-source', phase: 'queued', blockers: [] }, at(301));
  assert.deepEqual(metric.events, retained, 'The old measured prefix cannot be silently rewritten after truncation.');
  const corrupt = structuredClone(metric); corrupt.events[1].blockers[0].category = 'provider';
  assert.throws(() => validateFeatureIntakeMeasurements([corrupt]), /state digest differs/);
});

test('a retained Ready Check capacity hold does not inflate its event history while polling', async t => {
  const f = await reviewedSharedFixture(t);
  f.controls.beforeLifecycle = async () => { f.controls.admissionHold = () => ({ code: 'capacity', message: 'All implementation slots are occupied.' }); };
  await f.intake.sync(); assert.equal(f.inputs.length, 0); assert.equal((await f.state()).records.length, 1);
  const waiting = f.intake.measurements(); assert.ok(waiting[0].events.at(-1).blockers.some(item => item.category === 'operator'));
  await f.intake.sync(); await f.intake.sync(); assert.deepEqual(f.intake.measurements(), waiting);
  f.controls.beforeLifecycle = undefined; f.controls.admissionHold = () => undefined;
  await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(f.intake.measurements()[0].events.at(-1).blockers.length, 0);
});


test('lost Ready Check acknowledgment preserves the actual provider run before first feedback', async t => {
  const f = await reviewedSharedFixture(t); f.loseScheduleAck(); await f.intake.sync();
  assert.equal(f.inputs.length, 1);
  const metric = f.intake.measurements()[0], firstFeedback = metric.events.find(event => event.feedback);
  assert.ok(firstFeedback); assert.ok(metric.events.some(event => event.providerRunId === 'review-run-1' && event.at <= firstFeedback.at));
  const measured = report(f.requests, [metric]);
  assert.equal(measured.firstFeedback.samples, 1);
  assert.equal(measured.firstFeedback.providerPortion.samples, 0);
  assert.equal(measured.firstFeedback.providerPortion.unknown, 1, 'Missing referenced run timing cannot become zero provider time.');
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1);
});


test('a failed historical metric migration releases the real intake lock for recovery', async t => {
  const f = await localFixture(t); f.unblock(); await writeFile(join(f.features, 'request.md'), localSource); await f.scan();
  await f.intake.close();
  const path = join(f.state, 'feature-index.json'), previous = JSON.parse(await readFile(path, 'utf8'));
  delete previous.measurements; await writeFile(path, JSON.stringify(previous));
  const folder = new MarkdownFeatureFolder(f.features, f.state, 'claude-cli', join(f.state, '..'), 'local-project');
  folder.save = async () => { throw Error('Fixture migration write unavailable.'); };
  const failed = new FeatureRequests(folder, { async submit() { throw Error('No dispatch expected.'); }, inspect() { return undefined; } }, 0, () => true, 'local-project');
  await assert.rejects(failed.init(), /migration write unavailable/);
  const recovered = new MarkdownFeatureFolder(f.features, f.state, 'claude-cli', join(f.state, '..'), 'local-project');
  await recovered.open(previous.owner); await recovered.close();
  assert.equal(f.admissions, 1, 'Failed telemetry migration never dispatches implementation.');
});
