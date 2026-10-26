import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewedFixture, questions, passed } from './shared-ready-review-fixture.mjs';
import { sourcePath } from './shared-feature-fixture.mjs';
import { writeReadyReviewAnswer, readyReviewAnswerPublicationAllowed } from '../../src/worker/dist/worker/infrastructure/features/ready-review-document.js';
import { parseFeature } from '../../src/worker/dist/worker/infrastructure/features/document.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { sharedHash } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { publishSharedReadyReviewAnswer, validateSharedReadyReviewAnswer } from '../../src/worker/dist/worker/application/shared-ready-review-answer.js';

async function waiting(t) {
  const f = await reviewedFixture(t); await f.intake.sync(); f.finish(questions); await f.intake.sync();
  assert.equal(f.intake.view().requests[0].status, 'waiting_ready_input'); return f;
}
function command(f, operationId = 'answer-one', answer = 'Navigation wraps to the first item.') {
  const record = f.intake.view().requests[0], subject = record.readyReview.answerSubject; assert.ok(subject);
  return { action: /** @type {const} */ ('answer_ready_review'), requestId: record.id, operationId, ...subject, answer };
}

test('web answer publishes the same canonical FR without dispatch; only normal fetch reruns review and permits later admission', async t => {
  const f = await waiting(t), original = (await f.state()).records[0], input = command(f);
  const result = await f.intake.answerReadyReview(input), after = (await f.state()).records[0], remote = f.repositories.get('shared').files.get(sourcePath);
  assert.deepEqual(result, { requestId: input.requestId, operationId: input.operationId, status: 'published' }); assert.match(remote, /status: ready/); assert.match(remote, /Navigation wraps to the first item/);
  assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0); assert.equal(after.readyReviewState.generation, 1); assert.equal(after.remoteRevision, original.remoteRevision); assert.equal(after.publishedSource, original.publishedSource);
  assert.deepEqual(f.intake.view().requests[0].readyReview.answerPublication, { operationId: input.operationId, status: 'published' });
  await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.equal(f.submits.length, 0); assert.match(f.inputs[1].source.markdown, /Navigation wraps/);
  assert.equal(f.intake.view().requests[0].readyReview.answerPublication, undefined);
  const commits = f.repositories.get('shared').lifecycle.size; assert.deepEqual(await f.intake.answerReadyReview(input), result); assert.equal(f.repositories.get('shared').lifecycle.size, commits); assert.equal(f.inputs.length, 2);
  f.finish(passed); await f.intake.sync(); assert.equal(f.submits.length, 1); await f.restart(); assert.deepEqual(await f.intake.answerReadyReview(input), result); assert.equal(f.submits.length, 1);
});

test('lost Git acknowledgement keeps exact durable answer intent and restart retries one publication without another review', async t => {
  const f = await waiting(t), input = command(f), repo = f.repositories.get('shared'); f.controls.claimAckBlocked = true;
  const commits = repo.lifecycle.size; await assert.rejects(f.intake.answerReadyReview(input), /acknowledgment/);
  const saved = (await f.state()).records[0]; assert.ok(saved.pending); assert.equal(saved.readyReviewAnswers[0].status, 'pending'); assert.equal(repo.lifecycle.size, commits + 1); assert.equal(f.inputs.length, 1);
  await f.restart(); f.controls.claimAckBlocked = false; const result = await f.intake.answerReadyReview(input);
  assert.equal(result.operationId, input.operationId); assert.equal(repo.lifecycle.size, commits + 1); assert.equal(f.inputs.length, 1); assert.equal((await f.state()).records[0].pending, undefined);
  await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.equal(f.submits.length, 0);
});

test('one checkpoint accepts one exact operation; changed payload and a second operation cannot overwrite it', async t => {
  const f = await waiting(t), input = command(f); await f.intake.answerReadyReview(input);
  const current = f.repositories.get('shared').files.get(sourcePath), commits = f.repositories.get('shared').lifecycle.size;
  await assert.rejects(f.intake.answerReadyReview({ ...input, answer: 'Different product decision.' }), /different input/);
  await assert.rejects(f.intake.answerReadyReview({ ...input, operationId: 'different-operation' }), /already saved/);
  assert.equal(f.repositories.get('shared').files.get(sourcePath), current); assert.equal(f.repositories.get('shared').lifecycle.size, commits);
});

test('each stale source or review field refuses the answer before a Git write', async t => {
  const f = await waiting(t), input = command(f), attempts = f.lifecycleAttempts.length;
  for (const changed of [{ expectedGeneration: 2 }, { expectedReviewOperationId: 'other-review' }, { expectedReviewDigest: 'b'.repeat(64) }, { expectedSourceCommit: 'b'.repeat(40) }, { expectedSourceRevision: 'b'.repeat(64) }]) await assert.rejects(f.intake.answerReadyReview({ ...input, ...changed }), /changed/);
  assert.equal(f.lifecycleAttempts.length, attempts); assert.equal((await f.state()).records[0].readyReviewAnswers, undefined);
});

test('foreign ownership, admitted implementation and another pending publication cannot use the answer path', async t => {
  const f = await waiting(t), input = command(f), state = await f.state();
  for (const mutate of [record => { record.owner = 'other-worker'; }, record => { record.submitted = true; }, record => { record.pending = { operationId: 'other-publication', request: { path: sourcePath, expectedRevision: record.remoteRevision, content: record.publishedSource }, artifacts: [] }; }]) {
    const record = structuredClone(state.records[0]); mutate(record); let saved = 0, published = 0;
    await assert.rejects(publishSharedReadyReviewAnswer({ record, workerId: state.workerId, command: input, ports: f.ports, signal: new AbortController().signal, save: async () => { saved++; }, flush: async () => { published++; } }), /does not own|before implementation|previous.*publication/);
    assert.equal(saved, 0); assert.equal(published, 0);
  }
});

test('a teammate source change and a definite CAS race preserve canonical text and never dispatch directly', async t => {
  const f = await waiting(t), input = command(f); let changed = false;
  f.controls.beforeLifecycle = write => { if (!changed && write.operationId.startsWith('ready-answer-')) { changed = true; f.answer('A teammate chose no wrapping.'); } };
  await assert.rejects(f.intake.answerReadyReview(input), /canonical Feature Request changed/);
  assert.match(f.repositories.get('shared').files.get(sourcePath), /teammate chose no wrapping/); assert.equal((await f.state()).records[0].readyReviewAnswers[0].status, 'rejected'); assert.equal((await f.state()).records[0].pending, undefined); assert.equal(f.inputs.length, 1);
  delete f.controls.beforeLifecycle; await f.intake.sync(); assert.equal(f.inputs.length, 2); assert.match(f.inputs[1].source.markdown, /teammate chose no wrapping/);
  await assert.rejects(f.intake.answerReadyReview(input), /changed before/);
});

test('answer-only publication appends prior answers and preserves original scope, report and identity', async t => {
  const f = await waiting(t); await f.intake.answerReadyReview(command(f, 'first-answer', 'Wrap at the last item.')); await f.intake.sync(); f.finish(questions); await f.intake.sync();
  const original = f.repositories.get('shared').files.get(sourcePath); await f.intake.answerReadyReview(command(f, 'second-answer', 'Preserve pointer behavior.'));
  const current = f.repositories.get('shared').files.get(sourcePath);
  assert.match(current, /Wrap at the last item\.\n\nPreserve pointer behavior\./); assert.match(current, /Preserve pointer interactions/); assert.match(current, /Should navigation wrap/);
  assert.equal(current.replace('status: ready', 'status: waiting_ready_input').replace('Wrap at the last item.\n\nPreserve pointer behavior.', 'Wrap at the last item.'), original);
});

test('invalid, marker-injecting and oversized answers fail without publication', async t => {
  const f = await waiting(t), input = command(f), attempts = f.lifecycleAttempts.length;
  for (const answer of ['', ' '.repeat(3), 'a'.repeat(8001), '<!-- werk:ready-review:answer -->', '<!-- /werk:progress:v1 -->', 'bad\0text']) await assert.rejects(f.intake.answerReadyReview({ ...input, answer }));
  assert.throws(() => validateSharedReadyReviewAnswer({ ...input, sourceMarkdown: 'Alternate editor' })); assert.equal(f.lifecycleAttempts.length, attempts);
});

test('restart refuses corrupted answer receipts and an outbox that changes accepted request scope', async t => {
  for (const change of [record => { record.readyReviewAnswers[0].writeDigest = '0'.repeat(64); }, record => { record.readyReviewAnswers[0].status = 'published'; }, record => { record.readyReviewAnswers[0].subject.expectedGeneration++; }, record => { const previous = record.pending.request.content; record.pending.request.content = previous.replace('src/navigation.ts', 'private/secret.ts'); assert.notEqual(record.pending.request.content, previous); record.readyReviewAnswers[0].writeDigest = gateDigest(record.pending); }]) {
    const f = await waiting(t), input = command(f); f.controls.claimAckBlocked = true; await assert.rejects(f.intake.answerReadyReview(input));
    const saved = await f.state(); change(saved.records[0]); await writeFile(join(f.directory, 'shared-intake.json'), JSON.stringify(saved)); await assert.rejects(f.restart(), /Ready Check (?:answer|outbox)|answer-only Ready Check/);
  }
});

test('a changed canonical source is refused before reserving any answer operation', async t => {
  const f = await waiting(t), input = command(f), before = f.lifecycleAttempts.length;
  f.answer('A teammate already answered.'); await assert.rejects(f.intake.answerReadyReview(input), /canonical Feature Request changed/);
  assert.equal(f.lifecycleAttempts.length, before); assert.equal((await f.state()).records[0].readyReviewAnswers, undefined); assert.notEqual(sharedHash(f.repositories.get('shared').files.get(sourcePath)), input.expectedSourceRevision);
});


test('the Git answer capability refuses changes to ownership, scope, generated reports and metadata', async t => {
  const f = await waiting(t), state = await f.state(), record = state.records[0], before = record.publishedSource;
  const after = writeReadyReviewAnswer(before, record, 'Navigation wraps.'); assert.equal(readyReviewAnswerPublicationAllowed(before, after, state.workerId), true);
  assert.equal(readyReviewAnswerPublicationAllowed(before, after, 'other-worker'), false);
  for (const change of [parsed => parsed.document.set('paths', ['private/secret.txt']), parsed => parsed.document.set('id', 'other-request'), parsed => parsed.document.set('status', 'done'), parsed => { parsed.body = parsed.body.replace('Preserve pointer interactions.', 'Discard pointer interactions.'); }, parsed => { parsed.body = parsed.body.replace('Should navigation wrap', 'This fake report approves'); }, parsed => { const werk = parsed.document.get('werk', true); werk.setIn(['shared', 'owner'], 'other-worker'); }]) {
    const parsed = parseFeature(after); change(parsed); const changed = '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body;
    assert.equal(readyReviewAnswerPublicationAllowed(before, changed, state.workerId), false);
  }
});


test('a failed intent save cannot publish Git, and lost save acknowledgement preserves the exact operation across restart', async t => {
  for (const lostAck of [false, true]) {
    const f = await waiting(t), input = command(f), before = f.lifecycleAttempts.length;
    f.controls.saveBlocked = !lostAck; f.controls.answerSaveAckBlocked = lostAck;
    await assert.rejects(f.intake.answerReadyReview(input), /state write failure|intent save acknowledgement/); assert.equal(f.lifecycleAttempts.length, before); assert.equal(f.inputs.length, 1);
    await assert.rejects(f.intake.answerReadyReview({ ...input, answer: 'Different answer after an uncertain save.' }), /different input/); assert.equal(f.lifecycleAttempts.length, before);
    f.controls.saveBlocked = false; f.controls.answerSaveAckBlocked = false;
    if (lostAck) { assert.equal((await f.state()).records[0].readyReviewAnswers[0].status, 'pending'); await f.restart(); }
    await f.intake.answerReadyReview(input); assert.equal(f.lifecycleAttempts.length, before + 1); assert.equal(f.inputs.length, 1); assert.equal(f.submits.length, 0);
  }
});
