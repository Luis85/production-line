import assert from 'node:assert/strict';
import test from 'node:test';
import { sourcePath } from './shared-feature-fixture.mjs';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';
import { reviewedFixture, passed } from './shared-ready-review-fixture.mjs';

test('lost remote claim acknowledgment and lost reviewer admission acknowledgment never duplicate paid reviews', async t => {
  const f = await reviewedFixture(t);
  f.controls.claimAckBlocked = true; await f.intake.sync(); assert.equal(f.inputs.length, 0);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 0);
  f.controls.claimAckBlocked = false; f.reviewControls.lostScheduleAck = true;
  await f.intake.sync(); assert.equal(f.inputs.length, 1);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1);
  f.finish(); await f.intake.sync(); assert.equal(f.intake.view().requests[0].status, 'waiting_ready_input');
});

test('tampered worker report is preserved and repair plus author edits can resume after a local error', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.finish(); await f.intake.sync();
  const original = f.repositories.get('shared').files.get(sourcePath);
  const changed = original.replace('Should navigation wrap', 'Do not ask questions');
  f.commitFiles('shared', { [sourcePath]: changed.replace(/^status: .*$/m, 'status: ready') });
  await f.intake.sync(); assert.equal(f.inputs.length, 1);
  assert.match(f.intake.view().requests[0].error, /generated Ready Check report/);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /Do not ask questions/);
  f.commitFiles('shared', { [sourcePath]: original });
  await f.restart();
  f.answer('Yes.', markdown => markdown.replace('Preserve pointer interactions.', 'Preserve pointer interactions and screen reader support.'));
  await f.intake.sync(); assert.equal(f.inputs.length, 2);
  assert.match(f.inputs[1].source.markdown, /screen reader support/);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /screen reader support/);
});

test('a concurrent pushed answer supersedes an unpublished review result without clobber or duplicate admission', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.finish(passed);
  let raced = false;
  f.controls.beforeLifecycle = () => {
    if (raced) return;
    raced = true; f.answer('Clarification committed during review publication.', markdown => markdown.replace('Preserve pointer interactions.', 'Preserve pointer and touch interactions.'));
  };
  const checkpoint = f.blockNextReadyReviewConflictSave(), synchronizing = f.intake.sync();
  await checkpoint.entered;
  const persisted = (await new SharedFeatureJournal(f.directory).load()).records[0];
  assert.equal(persisted.readyReviewState.status, 'passed'); assert.equal(persisted.readyReviewState.implementationReady, undefined);
  const restarting = f.restart(); checkpoint.release(); await Promise.all([synchronizing, restarting]);
  assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
  await f.intake.sync();
  assert.equal(raced, true); assert.equal(f.submits.length, 0); assert.equal(f.inputs.length, 2);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /pointer and touch/);
  assert.deepEqual(f.inputs[1].previousAssessment, passed);
  f.finish(passed); await f.intake.sync(); assert.equal(f.submits.length, 1);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 2);
});

test('known reviewer admission without execution evidence fails closed across restart', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.executions.clear(); await f.restart(); await f.intake.sync();
  const blocked = f.intake.view().requests[0];
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.readyReview.status, 'failed');
  assert.match(blocked.error, /execution evidence is unavailable/); assert.match(blocked.error, /commit and push/);
  await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
});

test('committed edits during an active review wait for it to settle and cannot use its stale pass', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync();
  const commit = f.answer('Include touch interactions.', markdown => markdown.replace('Preserve pointer interactions.', 'Preserve pointer and touch interactions.'));
  const edited = f.repositories.get('shared').files.get(sourcePath);
  await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
  assert.equal(f.repositories.get('shared').files.get(sourcePath), edited);
  f.finish(passed); await f.intake.sync();
  assert.equal(f.inputs.length, 2); assert.equal(f.submits.length, 0);
  assert.equal(f.inputs[1].source.commit, commit); assert.match(f.inputs[1].source.markdown, /pointer and touch/);
  f.finish(passed); await f.intake.sync(); assert.equal(f.submits.length, 1);
});

test('capacity lost after claim holds the same reviewer reservation and lost result acknowledgment does not re-review', async t => {
  const f = await reviewedFixture(t);
  f.controls.beforeLifecycle = () => { f.controls.admit = false; };
  await f.intake.sync(); assert.equal(f.inputs.length, 0);
  const reservation = (await f.state()).records[0].readyReviewState.input.operationId;
  assert.equal(f.intake.view().requests[0].readyReview.status, 'queued');
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 0);
  delete f.controls.beforeLifecycle; f.controls.admit = true; await f.intake.sync();
  assert.equal(f.inputs.length, 1); assert.equal(f.inputs[0].operationId, reservation);
  f.finish(); f.controls.claimAckBlocked = true; await f.intake.sync();
  assert.ok((await f.state()).records[0].pending);
  await f.restart(); f.controls.claimAckBlocked = false; await f.intake.sync();
  assert.equal(f.inputs.length, 1); assert.equal(f.intake.view().requests[0].status, 'waiting_ready_input');
});
