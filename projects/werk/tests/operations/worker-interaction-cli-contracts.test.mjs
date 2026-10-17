import { testErrorStatus } from '../helpers/process-errors.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../scripts/runtime/portable/commands.mjs';
import { workerBody, waitForWorker } from '../../scripts/runtime/portable/worker-commands.mjs';
const catalog=commands('worker');
test('interaction commands discover readonly inspection and explicit stable answer/resume targets',()=>{
  assert.equal(catalog.capabilities.path,'/api/capabilities');assert.equal(catalog.capabilities.mutating,false);
  assert.equal(catalog['interaction get'].mutating,false);assert.equal(catalog['interaction turn'].mutating,false);assert.equal(catalog['interaction events'].mutating,false);
  assert.equal(catalog['interaction answer'].mutating,true);assert.equal(catalog['interaction cancel'].mutating,true);assert.equal(catalog['interaction resume'].mutating,true);
  assert.deepEqual(catalog['task resume'].required,['id','turn-id','if-match','key']);
  assert.match(catalog['interaction answer'].input,/--message.*--file/);
});
test('interaction flags own identity and revision while message and file input map to exact frozen API',async()=>{
  assert.deepEqual(await workerBody(catalog['interaction get'],undefined,{id:'session-a'}),{action:'get',sessionId:'session-a'});
  assert.deepEqual(await workerBody(catalog['interaction turn'],undefined,{id:'session-a','turn-id':'turn-a'}),{action:'turn',sessionId:'session-a',turnId:'turn-a'});
  assert.deepEqual(await workerBody(catalog['interaction events'],undefined,{id:'session-a',after:'12',limit:'10'}),{action:'events',sessionId:'session-a',after:12,limit:10});
  const flags={id:'session-a','question-id':'pending-a','if-match':'3',key:'answer-op-a'};
  const expected={action:'answer',sessionId:'session-a',pendingId:'pending-a',expectedRevision:3,operationId:'answer-op-a',answer:'Use the existing layout.'};
  assert.deepEqual(await workerBody(catalog['interaction answer'],{answer:expected.answer},flags),expected);
  assert.deepEqual(await workerBody(catalog['interaction answer'],undefined,{...flags,message:expected.answer}),expected);
  assert.deepEqual(await workerBody(catalog['interaction cancel'],undefined,flags),{action:'cancel',sessionId:'session-a',pendingId:'pending-a',expectedRevision:3,operationId:'answer-op-a'});
  const resume={id:'session-a','turn-id':'turn-a','if-match':'4',key:'resume-op-a'};
  assert.deepEqual(await workerBody(catalog['task resume'],undefined,resume),{action:'resume',sessionId:'session-a',turnId:'turn-a',expectedRevision:4,operationId:'resume-op-a'});
  assert.equal((await workerBody(catalog['interaction resume'],{message:'Continue safely.'},resume)).message,'Continue safely.');
});
test('interaction input rejects ambiguous text, invalid revisions and caller-controlled target fields',async()=>{
  const flags={id:'session-a','question-id':'pending-a','if-match':'3',key:'answer-op-a'};
  const cases=[[undefined,flags],[{answer:' '},flags],[{answer:'a'.repeat(8001)},flags],[{answer:'One'},{...flags,message:'Two'}],[{answer:'Text',sessionId:'other'},flags],[{answer:'Text',operationId:'other'},flags],[{answer:'Text'},{...flags,'if-match':'-1'}],[{answer:'Text'},{...flags,'if-match':'1.5'}],[{answer:'Text'},{...flags,'if-match':'9007199254740992'}],[{answer:'Text'},{...flags,key:'spaces not allowed'}]];
  for(const [body,options] of cases)await assert.rejects(workerBody(catalog['interaction answer'],body,options),error=>testErrorStatus(error, 'exitCode')===2);
});
test('worker waits return immediately for pending questions/escalations and never label them completed',async()=>{
  const task={session:{status:'waiting_input'}},feature={record:{status:'escalated'},execution:{status:'escalated'}},local={status:'waiting_input'};
  assert.equal(await waitForWorker(async()=>task,'task','1'),task);assert.equal(task.session.status,'waiting_input');
  assert.equal(await waitForWorker(async()=>feature,'feature','1'),feature);assert.equal(feature.execution.status,'escalated');
  assert.equal(await waitForWorker(async()=>local,'file-task','1'),local);
});

test('normalized event polling rejects unsafe sequence/page arguments before a request',async()=>{
  for(const options of [{after:'-1'},{after:'1.5'},{after:'9007199254740992'},{limit:'0'},{limit:'101'}]) await assert.rejects(workerBody(catalog['interaction events'],undefined,{id:'session-a',...options}),error=>testErrorStatus(error, 'exitCode')===2);
});
