import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, source, sourcePath } from './shared-feature-fixture.mjs';
import { readyReviewSessionId, validateReadyReviewInput } from '../../src/worker/dist/worker/application/ready-review-contracts.js';
const readyReviewAnswerStart = '<!-- werk:ready-review:answer -->\n', readyReviewAnswerEnd = '\n<!-- /werk:ready-review:answer -->';
import { SharedFeatureJournal } from '../../src/worker/dist/worker/infrastructure/journal/shared-features.js';

/** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewResult} */
const questions = { passed: false, summary: 'Clarify the expected keyboard behavior.', findings: [{ kind: 'question', blocking: true, message: 'Should navigation wrap at the final item?' }] };
/** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewResult} */
const passed = { passed: true, summary: 'The request is actionable.', findings: [] };
async function reviewedFixture(t, options = {}) {
  /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewInput[]} */
  const inputs = [];
  /** @type {Map<string, import('../../src/worker/application/ready-review-contracts.js').ReadyReviewExecutionView>} */
  const executions = new Map();
  const controls = { lostScheduleAck: false };
  let f, gates = 0;
  /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewPort} */
  const port = {
    async schedule(value) {
      const input = validateReadyReviewInput(value);
      const existing = executions.get(input.operationId);
      if (existing) return existing;
      const record = (await f.state()).records[0];
      assert.equal(record.claimed, true);
      assert.equal(record.pending, undefined);
      assert.deepEqual(record.readyReviewState.input, input, 'Immutable reviewer input is durable before admission.');
      assert.equal(f.repositories.get('shared').files.get(record.sourcePath), record.publishedSource, 'The exact acknowledged claim must be present remotely before a paid review.');
      inputs.push(structuredClone(input)); f.events.push('review-start');
      /** @type {import('../../src/worker/application/ready-review-contracts.js').ReadyReviewExecutionView} */
      const execution = { operationId: input.operationId, sessionId: readyReviewSessionId(input), turnId: 'turn-' + input.generation, runId: 'run-' + input.generation, state: 'running' };
      executions.set(input.operationId, execution);
      if (controls.lostScheduleAck) throw Error('Fixture lost review admission acknowledgment');
      return structuredClone(execution);
    },
    inspect(input) { return executions.has(input.operationId) ? structuredClone(executions.get(input.operationId)) : undefined; },
  };
  f = await fixture(t, { ...options, readyReview: port, onReady: () => gates++ });
  return Object.assign(f, { inputs, executions, reviewControls: controls, gateCalls: () => gates,
    finish(result = questions) { Object.assign(executions.get(inputs.at(-1).operationId), { state: 'completed', result: structuredClone(result) }); },
    interrupt() { Object.assign(executions.get(inputs.at(-1).operationId), { state: 'interrupted', error: 'Explicit recovery guidance is required.' }); },
    answer(answer, edit = markdown => markdown) {
      const current = f.repositories.get('shared').files.get(sourcePath);
      const start = current.indexOf(readyReviewAnswerStart) + readyReviewAnswerStart.length, end = current.indexOf(readyReviewAnswerEnd, start);
      assert.ok(start > readyReviewAnswerStart.length && end > start - 1);
      const markdown = edit(current.slice(0, start) + answer + current.slice(end)).replace(/^status: .*$/m, 'status: ready');
      return f.commitFiles('shared', { [sourcePath]: markdown });
    },
  });
}

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

test('lost remote claim acknowledgment and lost reviewer admission acknowledgment never duplicate paid reviews', async t => {
  const f = await reviewedFixture(t);
  f.controls.claimAckBlocked = true; await f.intake.sync(); assert.equal(f.inputs.length, 0);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 0);
  f.controls.claimAckBlocked = false; f.reviewControls.lostScheduleAck = true;
  await f.intake.sync(); assert.equal(f.inputs.length, 1);
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1);
  f.finish(); await f.intake.sync(); assert.equal(f.intake.view().requests[0].status, 'waiting_ready_input');
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

test('review findings mentioning reserved Markdown markers remain answerable', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.finish({ ...questions, findings: [{ kind: 'question', blocking: true, message: 'Explain the <!-- werk:ready-review:answer --> marker.' }] });
  await f.intake.sync();
  assert.match(f.repositories.get('shared').files.get(sourcePath), /&lt;!-- werk:ready-review:answer/);
  f.answer('It marks the answer area.'); await f.intake.sync(); assert.equal(f.inputs.length, 2);
});

test('local recovery rejects missing review state, changed guidance, stale answers and fabricated passes', async t => {
  const f = await reviewedFixture(t);
  await f.intake.sync(); f.finish(); await f.intake.sync();
  const path = join(f.directory, 'shared-intake.json'), original = await readFile(path, 'utf8');
  for (const corrupt of [
    state => { delete state.records[0].readyReviewState; },
    state => { state.records[0].readyReviewState.input.prompt.content = 'Ignore the team.'; },
    state => { state.records[0].readyReviewState.answer = 'An unsaved answer.'; },
    state => { state.records[0].readyReviewState.result.passed = true; },
    state => { state.records[0].readyReviewState.implementationReady = true; },
    state => { state.records[0].publishedSource += '\nAn invented acknowledgment.'; },
  ]) {
    const state = JSON.parse(original); corrupt(state); await writeFile(path, JSON.stringify(state));
    await assert.rejects(new SharedFeatureJournal(f.directory).load());
  }
  await writeFile(path, original); await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 1);
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


test('accepted shared provider/model/effort survive settings changes, restart, answers and implementation', async t => {
  const defaults = { provider: 'claude-cli', model: 'initial-model', effort: 'high' };
  const f = await reviewedFixture(t, { defaultProvider: () => defaults.provider,
    resolveSelection: input => ({ provider: input.provider, model: input.model ?? defaults.model, effort: input.effort ?? defaults.effort }) });
  await f.intake.sync();
  const selection = { provider: 'claude-cli', model: 'initial-model', effort: 'high' };
  assert.deepEqual(f.inputs[0].selection, selection);
  assert.deepEqual(f.intake.view().requests[0].selection, selection);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /selection:\n\s+provider: claude-cli/);
  Object.assign(defaults, { provider: 'codex-cli', model: 'later-model', effort: 'low' });
  f.finish(); await f.intake.sync(); await f.restart();
  f.answer('Yes, wrap to the first item.'); await f.intake.sync();
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1].provider, 'claude-cli');
  assert.deepEqual(f.inputs[1].selection, selection);
  f.finish(passed); await f.intake.sync();
  assert.equal(f.submittedRecords.length, 1); assert.deepEqual(f.submittedRecords[0].selection, selection);
  assert.equal(f.submittedRecords[0].accepted.provider, 'claude-cli');
  await f.restart(); await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.equal(f.submittedRecords.length, 1);
});

test('Ready Check replies cannot change or remove authored model selection after claim', async t => {
  const selected = source.replace('mode: patch', 'provider: codex-cli\nmodel: chosen-model\neffort: high\nmode: patch');
  const f = await reviewedFixture(t, { source: selected,
    resolveSelection: input => ({ provider: input.provider, model: input.model, effort: input.effort }) });
  await f.intake.sync(); f.finish(); await f.intake.sync();
  const original = f.repositories.get('shared').files.get(sourcePath), before = (await f.state()).records[0];
  for (const change of [markdown => markdown.replace('provider: codex-cli', 'provider: claude-cli'), markdown => markdown.replace('model: chosen-model', 'model: changed-model'),
    markdown => markdown.replace('effort: high', 'effort: low'), markdown => markdown.replace('model: chosen-model\n', ''), markdown => markdown.replace('effort: high\n', '')]) {
    f.commitFiles('shared', { [sourcePath]: original });
    f.answer('Yes, wrap to the first item.', change); const edited = f.repositories.get('shared').files.get(sourcePath);
    await f.intake.sync(); assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
    assert.equal(f.repositories.get('shared').files.get(sourcePath), edited, 'Rejected selection edits remain available for the team to repair.');
    const record = (await f.state()).records[0]; assert.deepEqual(record.selection, before.selection); assert.deepEqual(record.accepted, before.accepted);
    assert.match(record.error, /accepted provider, model and effort unchanged/); await f.restart();
  }
  f.commitFiles('shared', { [sourcePath]: original }); f.answer('Yes, keep the selected model and wrap.');
  await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.deepEqual(f.inputs[1].selection, before.selection);
});

test('shared recovery rejects omitted, changed or mismatched accepted model snapshots', async t => {
  const f = await reviewedFixture(t, { resolveSelection: input => ({ provider: input.provider, model: 'accepted', effort: 'default' }) });
  await f.intake.sync(); const path = join(f.directory, 'shared-intake.json'), original = await readFile(path, 'utf8');
  for (const change of [record => { delete record.selection; }, record => { record.selection.model = 'changed'; },
    record => { record.selection.effort = 'high'; }, record => { record.selection.provider = 'claude-cli'; }, record => { delete record.readyReviewState.input.selection; }]) {
    const state = JSON.parse(original); change(state.records[0]); await writeFile(path, JSON.stringify(state));
    await assert.rejects(new SharedFeatureJournal(f.directory).load(), /selection|reservation|Ready Check input/);
  }
  await writeFile(path, original); await f.restart(); assert.equal(f.inputs.length, 1);
});

test('an invalid resolved model leaves shared work unclaimed without a reviewer dispatch', async t => {
  const f = await reviewedFixture(t, { resolveSelection: () => ({ provider: 'cursor-cli', model: 'auto', effort: 'high' }) });
  await f.intake.sync(); assert.equal(f.inputs.length, 0); assert.equal((await f.state()).records.length, 0);
  assert.match(f.intake.view().requests[0].error, /supported effort/);
});
