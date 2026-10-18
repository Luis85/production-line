import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markdownParts, readyAnswer } from './shared-markdown-fixture.mjs';
import { sharedRunnerFixture } from './shared-runner-fixture.mjs';

// The production runner, its real timers and contained CLI/MCP adapter execute this journey.
// The model is an explicitly labelled POSIX executable fixture; no live inference is claimed.
test('an unattended worker drains a pushed evening batch and resumes one morning Markdown answer exactly once', {
  skip: process.platform === 'win32' && 'POSIX shebang model fixture; native Windows process contracts have separate coverage',
  timeout: 180000,
}, async t => {
  const f = await sharedRunnerFixture(t);
  await f.observePolls();
  assert.equal((await f.events()).length, 0, 'Draft and locally committed/unpushed ready notes never invoke the model.');
  assert.equal((await f.view()).requests.find(row => row.id === f.draft.id)?.status, 'draft');
  assert.ok(!(await f.view()).requests.some(row => row.id === f.local.id), 'A ready local worker note is not a second intake route.');
  assert.deepEqual(await f.checkoutEvidence(), f.originalCheckout);

  // Remove the author-only ready note before publishing the evening tip; keep its worker copy untracked.
  await f.git(f.author, 'rm', f.local.path);
  const batch = [];
  for (const identity of ['00', '10', '20']) batch.push(await f.createRequest(identity + '-batch.md', identity));
  const sourceCommit = await f.push(batch.map(row => row.path), 'Publish the evening Feature Request batch');
  t.diagnostic('Published three ready requests with one local admission place; only production timers dispatch them.');
  const first = batch[0];
  const overnight = await f.until(async () => {
    const view = await f.view();
    const question = view.requests.find(row => row.id === first.id);
    const independent = batch.slice(1).map(request => view.requests.find(row => row.id === request.id));
    return question?.status === 'waiting_input' && question.taskNote && question.publication === 'synced'
      && independent.every(row => row?.status === 'ready_for_review' && row.publication === 'synced') && view;
  }, 'Independent requests must finish while the first waits for a teammate');
  const waiting = overnight.requests.find(row => row.id === first.id);
  assert.ok(waiting.taskId); assert.ok(waiting.taskNote?.startsWith('team/tasks/'));
  const question = await f.published(waiting.taskNote), identity = markdownParts(question).data;
  assert.equal(identity.type, 'Task'); assert.equal(identity.status, 'open'); assert.ok(identity.sessionId); assert.ok(identity.pendingId);
  assert.match(question, /Which retry policy/); assert.match(question, /## Answer/);
  assert.match(await f.published(first.path), /## Worker progress/);
  const beforeAnswer = await f.events();
  const eveningCalls = beforeAnswer.filter(row => row.phase === 'started').map(row => row.identity);
  assert.equal(eveningCalls[0], '00'); assert.deepEqual(eveningCalls.slice(1).sort(), ['10', '20']);
  assert.equal(beforeAnswer.filter(row => row.phase === 'verified').length, 2);
  assert.ok(beforeAnswer.every(row => row.phase !== 'overlap'));
  assert.deepEqual(await f.checkoutEvidence(), f.originalCheckout);

  await f.git(f.author, 'pull', '--ff-only', 'origin', 'main');
  await writeFile(join(f.author, waiting.taskNote), readyAnswer(question, 'confirm_retry_once'));
  await f.push([waiting.taskNote], 'Morning answer: retry once');
  const completed = await f.until(async () => {
    const view = await f.view(), row = view.requests.find(row => row.id === first.id);
    return row?.status === 'ready_for_review' && row.publication === 'synced' && view;
  }, 'The pushed Task answer must resume its original Feature Request');
  const resumed = completed.requests.find(row => row.id === first.id);
  assert.equal(resumed.taskId, waiting.taskId, 'The continuation keeps the accepted Feature Request task identity.');
  const processed = markdownParts(await f.published(waiting.taskNote));
  assert.equal(processed.data.status, 'processed'); assert.equal(processed.data.sessionId, identity.sessionId);

  for (const request of batch) {
    const row = completed.requests.find(row => row.id === request.id);
    assert.equal(row.done?.passed, true, JSON.stringify(row)); assert.ok(row.featureBranch); assert.ok(row.reviewNote?.startsWith('team/reviews/'));
    const review = await f.published(row.reviewNote);
    assert.equal(markdownParts(review).data.type, 'PullRequest');
    assert.match(review, /Required checks passed for this candidate/);
    assert.match(review, /Verify candidate source \(verify-source\).*passed.*0/);
    assert.match(review, new RegExp(row.sourceCommit)); assert.match(review, /human review/i);
    await f.git(f.remote, 'merge-base', '--is-ancestor', sourceCommit, row.sourceCommit);
    assert.equal(await f.git(f.remote, 'show', row.sourceCommit + ':approved.txt'), 'committed source');
    assert.equal(await f.git(f.remote, 'show', row.featureBranch + ':approved.txt'), 'Implemented batch-' + request.identity);
    assert.equal(await f.git(f.remote, 'diff', '--name-only', row.sourceCommit, row.featureBranch), 'approved.txt');
    assert.equal(await f.git(f.remote, 'rev-parse', row.featureBranch + '^'), row.sourceCommit);
    assert.match(await f.published(request.path), /status: ready_for_review/);
  }
  assert.equal(await f.git(f.remote, 'show', 'main:approved.txt'), 'committed source', 'Human merge remains separate.');
  await f.observePolls();
  const events = await f.events(), started = events.filter(row => row.phase === 'started');
  assert.deepEqual(started.map(row => row.identity), [...eveningCalls, '00'], 'Repeated automatic reconciliation never duplicates model work.');
  assert.ok(events.every(row => row.phase !== 'overlap'), 'Model invocations remain serial across the morning continuation.');
  assert.equal(events.filter(row => row.phase === 'finished').length, 4);
  assert.equal(events.filter(row => row.phase === 'verified').length, 3);
  assert.ok(events.filter(row => row.phase === 'verified').every(row => /^[a-f0-9]{64}$/.test(row.candidateDigest)));
  assert.match(started.at(-1).input, /confirm_retry_once/);
  assert.equal(new Set(started.slice(0, 3).map(row => row.sessionId)).size, 3, 'Independent Feature Requests have independent native handles.');
  assert.equal(started.at(-1).sessionId, started[0].sessionId, 'The morning answer resumes the same native model session.');
  assert.deepEqual(started.map(row => row.resumed), [false, false, false, true]);
  for (const call of started) assert.doesNotMatch(call.input, /developer unstaged change/);
  const board = await f.api('/api/taskboard'); assert.equal(board.tasks.length, 3);
  assert.deepEqual(await f.checkoutEvidence(), f.originalCheckout);
  await f.finish();
});
