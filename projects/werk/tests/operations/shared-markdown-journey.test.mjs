import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownParts, readyAnswer, sharedMarkdownFixture } from './shared-markdown-fixture.mjs';

// No HTTP server or webview: after one-time local configuration, the team's interface is Git Markdown.
test('a teammate answers a published Task through Git and the restarted worker resumes one feature into a reviewable PullRequest', { timeout: 120000 }, async t => {
  const fixture = await sharedMarkdownFixture(t);
  const { current, sync, feature, task, sent, git, remote, published } = fixture;
  const taskId = task().id, sessionId = task().sessionId, pending = task().interaction.pending;
  assert.ok(pending);
  const taskPath = feature().taskNote;
  assert.ok(taskPath?.startsWith('team/tasks/'), JSON.stringify(feature()));
  const question = await published(taskPath);
  const note = markdownParts(question);
  assert.equal(note.data.type, 'Task'); assert.equal(note.data.status, 'open');
  assert.equal(note.data.sessionId, sessionId); assert.equal(note.data.pendingId, pending.id);
  assert.match(note.body, /Which retry policy/); assert.match(note.body, /Retry once/);
  assert.match(note.body, /Repeating the operation can duplicate work/);
  const sourceWhileWaiting = await published(fixture.requestPath);
  assert.match(sourceWhileWaiting, /## Worker progress/); assert.match(sourceWhileWaiting, /werkTask:/);
  assert.ok(sourceWhileWaiting.includes(taskPath.replace(/\.md$/, '')));
  assert.deepEqual(await fixture.checkoutEvidence(), fixture.originalCheckout);
  const waitingRefs = await git(remote, 'show-ref');
  await sync(); await sync(); await fixture.restart(); await sync();
  assert.equal(sent.length, 1); assert.equal(task().id, taskId); assert.equal(task().sessionId, sessionId);
  assert.equal(task().interaction.pending?.id, pending.id);
  assert.equal(await git(remote, 'show-ref'), waitingRefs, 'Waiting and restart do not republish an unchanged checkpoint.');
  assert.deepEqual(await fixture.checkoutEvidence(), fixture.originalCheckout);

  const reply = readyAnswer(question, 'retry_once');
  await fixture.publish(taskPath, reply, 'Team chooses a retry policy');
  await sync(); await current().board.tick(); await fixture.settle('review'); await sync();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /retry_once/); assert.match(sent[1], /Which retry policy/);
  assert.match(sent[1], /committed source/); assert.doesNotMatch(sent[1], /developer unstaged/);
  assert.equal(task().id, taskId); assert.equal(task().sessionId, sessionId);
  assert.equal(current().board.view().tasks.length, 1);
  assert.equal(task().interaction.pending, null);
  assert.equal(markdownParts(await published(taskPath)).data.status, 'processed');

  const completed = feature();
  assert.equal(completed.status, 'ready_for_review', JSON.stringify(completed));
  assert.equal(completed.publication, 'synced'); assert.equal(completed.done?.passed, true);
  assert.ok(completed.reviewNote?.startsWith('team/reviews/'));
  assert.ok(completed.featureBranch);
  const review = await published(completed.reviewNote), reviewNote = markdownParts(review);
  assert.equal(reviewNote.data.type, 'PullRequest');
  assert.match(review, /human review/i); assert.match(review, new RegExp(fixture.sourceCommit));
  assert.equal(await git(remote, 'show', `${completed.featureBranch}:approved.txt`), 'Retry once, then report the failure.');
  assert.equal(await git(remote, 'show', 'main:approved.txt'), 'committed source');
  assert.equal(await git(remote, 'diff', '--name-only', fixture.sourceCommit, completed.featureBranch), 'approved.txt');
  assert.equal(await git(remote, 'rev-parse', `${completed.featureBranch}^`), fixture.sourceCommit);
  const doneSource = await published(fixture.requestPath);
  assert.match(doneSource, /status: ready_for_review/); assert.match(doneSource, /werkPullRequest:/);
  assert.ok(doneSource.includes(completed.reviewNote.replace(/\.md$/, '')));
  assert.match(doneSource, /Document a retry policy chosen by the team/);
  assert.deepEqual(await fixture.checkoutEvidence(), fixture.originalCheckout);

  const completedRefs = await git(remote, 'show-ref');
  await sync(); await fixture.restart(); await current().board.tick(); await sync();
  assert.equal(sent.length, 2); assert.equal(current().board.view().tasks.length, 1);
  assert.equal(await git(remote, 'show-ref'), completedRefs);
  // A teammate accidentally reopens the already-consumed file; its durable operation must not execute twice.
  await fixture.publish(taskPath, reply, 'Replay an already consumed answer');
  await sync(); await fixture.restart(); await sync(); await current().board.tick();
  assert.equal(sent.length, 2); assert.equal(task().id, taskId); assert.equal(task().sessionId, sessionId);
  assert.equal(feature().status, 'ready_for_review');
  assert.deepEqual(await fixture.checkoutEvidence(), fixture.originalCheckout);
});

test('tampered checkpoint identity and stale revision cannot authorize a shared Markdown reply, including after restart', { timeout: 120000 }, async t => {
  const fixture = await sharedMarkdownFixture(t);
  const { current, sync, feature, task, sent, published } = fixture;
  const taskPath = feature().taskNote;
  assert.ok(taskPath);
  const question = await published(taskPath), identity = markdownParts(question).data;
  const sessionId = task().sessionId, pendingId = task().interaction.pending?.id;
  assert.ok(pendingId); assert.equal(typeof identity.expectedRevision, 'number');
  const invalid = [
    { name: 'another pending checkpoint', fields: { pendingId: 'pending-from-a-different-question' } },
    { name: 'a stale interaction revision', fields: { expectedRevision: Number(identity.expectedRevision) - 1 } },
  ];
  for (const attempt of invalid) {
    await fixture.publish(taskPath, readyAnswer(question, 'retry_once', attempt.fields), 'Reject ' + attempt.name);
    await sync();
    assert.equal(sent.length, 1, attempt.name);
    assert.equal(task().status, 'waiting_input'); assert.equal(task().sessionId, sessionId);
    assert.equal(task().interaction.pending?.id, pendingId);
    assert.equal(await published(taskPath), readyAnswer(question, 'retry_once', attempt.fields).trim(), 'The worker preserves the invalid teammate edit.');
    assert.match(feature().error ?? '', /identity|revision|checkpoint|changed/i);
    await fixture.restart(); await sync(); await current().board.tick();
    assert.equal(sent.length, 1, 'Restart cannot turn an invalid shared response into authority.');
    assert.equal(task().interaction.pending?.id, pendingId);
  }
  // Repair only the note. No local status/UI interaction should be necessary to recover.
  await fixture.publish(taskPath, readyAnswer(question, 'retry_once'), 'Restore identity and answer the open question');
  await sync(); await current().board.tick(); await fixture.settle('review'); await sync();
  assert.equal(sent.length, 2); assert.equal(task().sessionId, sessionId);
  assert.equal(current().board.view().tasks.length, 1);
  assert.equal(feature().status, 'ready_for_review'); assert.equal(feature().publication, 'synced');
  assert.deepEqual(await fixture.checkoutEvidence(), fixture.originalCheckout);
});
