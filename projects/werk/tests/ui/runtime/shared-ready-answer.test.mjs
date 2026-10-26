import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { createReadyAnswerController, emptyReadyAnswerDraft } = await frontend('src/worker/webview/shared-ready-answer-controller.ts');
const subject = { expectedGeneration: 2, expectedReviewOperationId: 'review-two', expectedReviewDigest: 'a'.repeat(64), expectedSourceCommit: 'b'.repeat(40), expectedSourceRevision: 'c'.repeat(64) };
function fixture() {
  const draft=emptyReadyAnswerDraft(), sent=[];let epoch=1,active=true,receive=async command=>({config:{repositoryId:command.projectId},readyReviewAnswer:{requestId:command.requestId,operationId:command.operationId,status:'published'}});
  const controller=createReadyAnswerController({draft,epoch:()=>epoch,active:()=>active,uuid:()=> 'answer-one',send:async command=>{sent.push(structuredClone(command));return receive(command);}});
  return { draft,sent,controller,receive:fn=>{receive=fn;},lock:()=>{active=false;epoch++;Object.assign(draft,emptyReadyAnswerDraft());} };
}
test('answer-only publication retains the inspected source and checkpoint and confirms the exact operation', async()=>{
  const f=fixture();f.draft.answer='  Use UTC dates for the export.  ';
  assert.equal(await f.controller.submit('company','request-one',subject),true);
  assert.deepEqual(f.sent,[{action:'answer_ready_review',projectId:'company',requestId:'request-one',operationId:'answer-one',...subject,answer:'Use UTC dates for the export.'}]);
  assert.equal(f.draft.pending,null);assert.equal(f.draft.answer,'');assert.match(f.draft.notice,/committed and pushed/);assert.match(f.draft.notice,/implementation has not been started by this action/);
});
test('a lost acknowledgement replays the original answer even after a newer question is observed', async()=>{
  const f=fixture();f.draft.answer='Use UTC.';f.receive(async()=>{throw Error('Response lost after publication.');});
  assert.equal(await f.controller.submit('company','request-one',subject),false);
  const original=structuredClone(f.draft.pending);assert.ok(original);assert.equal(f.draft.answer,'Use UTC.');
  f.draft.answer='An unsent replacement';f.receive(async command=>({config:{repositoryId:command.projectId},readyReviewAnswer:{requestId:command.requestId,operationId:command.operationId,status:'published'}}));
  assert.equal(await f.controller.submit('another-project','another-request',{...subject,expectedGeneration:3}),true);
  assert.deepEqual(f.sent,[original,original]);
});
test('HTTP success without the matching operation or project receipt cannot discard an uncertain answer', async()=>{
  const f=fixture();f.draft.answer='Use UTC.';
  f.receive(async()=>({config:{repositoryId:'other'},readyReviewAnswer:{requestId:'request-one',operationId:'answer-one',status:'published'}}));
  assert.equal(await f.controller.submit('company','request-one',subject),false);assert.ok(f.draft.pending);assert.equal(f.draft.answer,'Use UTC.');
  assert.match(f.draft.error,/exact answer publication/);
});
test('changing a checkpoint while typing requires an explicit new answer; missing subjects and oversized answers do not publish',async()=>{
  const f=fixture();f.draft.answer='Use UTC.';f.draft.subject={...subject};
  assert.equal(await f.controller.submit('company','request-one',{...subject,expectedReviewOperationId:'new-review'}),false);
  assert.equal(await f.controller.submit('company','request-one',undefined),false);
  f.draft.answer='x'.repeat(8001);assert.equal(await f.controller.submit('company','request-one',subject),false);assert.deepEqual(f.sent,[]);
});
test('explicit lock clears the draft and ignores a late successful acknowledgement',async()=>{
  const f=fixture();
  /** @type {() => void} */
  let complete=()=>assert.fail('The answer was not dispatched.');
  f.draft.answer='Private answer.';f.receive(()=>new Promise(resolve=>{complete=()=>resolve({config:{repositoryId:'company'},readyReviewAnswer:{requestId:'request-one',operationId:'answer-one',status:'published'}});}));
  const pending=f.controller.submit('company','request-one',subject);assert.equal(f.draft.busy,true);f.lock();
  complete();
  assert.equal(await pending,false);assert.deepEqual(f.draft,emptyReadyAnswerDraft());
});
