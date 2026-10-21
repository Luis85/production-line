import assert from 'node:assert/strict';
import test from 'node:test';
import { source, sourcePath } from './shared-feature-fixture.mjs';
import { readyReviewSessionId } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
import { reviewedFixture, questions, passed } from './shared-ready-review-fixture.mjs';

test('Ready Check precedes semantic DoR, stays on the FR and displays real review execution identity', async t => {
  const incomplete = source.replace('Support keyboard navigation.', '').replace('- Arrow keys move the active selection.', '');
  const f = await reviewedFixture(t, { source: incomplete });
  await f.intake.sync();
  assert.equal(f.inputs.length, 1); assert.equal(f.gateCalls(), 0); assert.equal(f.submits.length, 0);
  const running = f.intake.view().requests[0];
  assert.equal(running.status, 'reviewing_ready'); assert.equal(running.taskId, null);
  assert.equal(running.readyReview.status, 'running'); assert.equal(running.readyReview.runId, 'run-1');
  assert.deepEqual(f.intake.readyReviewSessionIds(), [f.inputs[0] && readyReviewSessionId(f.inputs[0])]);
  assert.equal(JSON.stringify(running).includes('Challenge ambiguous goals'), false);
  f.finish(); await f.intake.sync();
  const waiting = f.intake.view().requests[0];
  assert.equal(waiting.status, 'waiting_ready_input'); assert.equal(waiting.taskNote ?? null, null);
  const markdown = f.repositories.get('shared').files.get(sourcePath);
  assert.match(markdown, /Should navigation wrap/); assert.match(markdown, /### Answers/);
  assert.equal([...f.repositories.get('shared').files.keys()].some(path => path.includes('/task-')), false);
  const publications = f.lifecycleAttempts.length;
  await f.restart(); await f.intake.sync(); await f.intake.sync();
  assert.equal(f.inputs.length, 1); assert.equal(f.lifecycleAttempts.length, publications); assert.equal(f.gateCalls(), 0);
});

test('unchanged ready status never redispatches; substantive answer re-reviews with prior questions then submits once', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.finish(); await f.intake.sync();
  f.answer(''); await f.intake.sync(); assert.equal(f.inputs.length, 1);
  const commit = f.answer('Yes, wrap to the first item.'); await f.intake.sync();
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1].source.commit, commit);
  assert.deepEqual(f.inputs[1].previousAssessment, questions);
  assert.match(f.inputs[1].source.markdown, /Yes, wrap/);
  assert.equal(f.inputs[1].source.markdown.includes('Feature Request Ready Check'), false);
  f.finish(passed); await f.intake.sync();
  assert.equal(f.gateCalls(), 1); assert.equal(f.submits.length, 1);
  const record = (await f.state()).records[0];
  assert.equal(record.readyReviewState.implementationReady, true); assert.equal(record.sourceCommit, commit);
  assert.notEqual(record.sourceCommit, record.workflow.commit);
  assert.equal(record.accepted.message.includes('Should navigation wrap'), false, 'Reviewer advice never becomes implementation authority.');
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.equal(f.submits.length, 1);
});

test('a passing reviewer cannot bypass DoR and the same owned request remains editable', async t => {
  const f = await reviewedFixture(t, { source: source.replace('Support keyboard navigation.', '') });
  await f.intake.sync(); f.finish(passed); await f.intake.sync();
  assert.equal(f.gateCalls(), 1); assert.equal(f.submits.length, 0);
  assert.equal(f.intake.view().requests[0].ready.passed, false);
  await f.restart();
  f.answer('The goal is now explicit.', markdown => markdown.replace('# Goal\n', '# Goal\nSupport keyboard navigation.\n'));
  await f.intake.sync(); assert.equal(f.inputs.length, 2);
  f.finish(passed); await f.intake.sync(); assert.equal(f.submits.length, 1);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /Support keyboard navigation/);
});

test('interrupted review holds across restart until a changed committed recovery answer', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.interrupt(); await f.intake.sync();
  assert.equal(f.intake.view().requests[0].readyReview.status, 'failed');
  await f.restart(); await f.intake.sync(); f.answer(''); await f.intake.sync();
  assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
  f.answer('Connection repaired. Please review this unchanged scope again.'); await f.intake.sync();
  assert.equal(f.inputs.length, 2);
});

test('review findings mentioning reserved Markdown markers remain answerable', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.finish({ ...questions, findings: [{ kind: 'question', blocking: true, message: 'Explain the <!-- werk:ready-review:answer --> marker.' }] });
  await f.intake.sync();
  assert.match(f.repositories.get('shared').files.get(sourcePath), /&lt;!-- werk:ready-review:answer/);
  f.answer('It marks the answer area.'); await f.intake.sync(); assert.equal(f.inputs.length, 2);
});

test('large Unicode input and expanded findings keep the public note bounded and recoverable', async t => {
  const largeSource = source.replace('Preserve pointer interactions.', '界'.repeat(6000));
  const f = await reviewedFixture(t, { source: largeSource });
  await f.intake.sync();
  /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewResult['findings']} */
  const findings = Array.from({ length: 5 }, () => ({ kind: 'question', blocking: true, message: '<!--'.repeat(900) }));
  f.finish({ passed: false, summary: 'Clarify the reserved comment examples.', findings }); await f.intake.sync();
  const markdown = f.repositories.get('shared').files.get(sourcePath);
  assert.ok(Buffer.byteLength(markdown) < 65536); assert.match(markdown, /report was shortened/);
  assert.equal(f.intake.view().requests[0].readyReview.findings.length, findings.length);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1);
});

test('oversized custom-template readiness diagnostics remain publishable and restartable', async t => {
  const f = await reviewedFixture(t);
  const files = f.repositories.get('shared').files, configuration = JSON.parse(files.get('.werk/feature-workflow.json'));
  f.commitFiles('shared', { [configuration.template]: files.get(configuration.template) + '\n## ' + '界'.repeat(3000) + '\n' });
  await f.intake.sync(); f.finish(passed); await f.intake.sync();
  const record = (await f.state()).records[0];
  assert.equal(record.status, 'waiting_ready_input'); assert.equal(record.ready.passed, false);
  assert.ok(record.readyReviewState.gateIssues.every(issue => Buffer.byteLength(issue) <= 259));
  assert.ok(Buffer.byteLength(f.repositories.get('shared').files.get(sourcePath)) < 65536);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
});
