import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../scripts/runtime/portable/commands.mjs';
import { workerBody, workerOutput, waitForWorker } from '../../scripts/runtime/portable/worker-commands.mjs';
const catalog=commands('worker');
test('worker schema discovers template, redacted providers and read-only attempt inspection/export',()=>{
  assert.equal(catalog['feature template'].local,true);assert.equal(catalog['feature template'].outputFormat,'markdown');
  assert.ok(!catalog['run analyze'].options.includes('cursor'));assert.ok(!catalog['run analyze'].options.includes('limit'));
  assert.equal(catalog['provider list'].view,'providers');assert.equal(catalog['provider configure'].mutating,true);
  for(const action of ['list','get','analyze','export']){const command=catalog['run '+action];assert.equal(command.mutating,false);assert.equal(command.path,'/api/runs');assert.match(command.scope,/original orchestrator lease snapshots/);}
});
test('run filters produce typed bounded requests and reject mistakes before any API call',async()=>{
  const body=await workerBody(catalog['run list'],undefined,{'session-id':'session-one','task-id':'task-one',provider:'codex-cli',kind:'chat',outcome:'failed',since:'2026-10-14T02:00:00+02:00',until:'2026-10-15T00:00:00Z',limit:'10',offset:'0','as-of':'1234'});
  assert.deepEqual(body,{action:'list',sessionId:'session-one',taskId:'task-one',provider:'codex-cli',kind:'chat',outcome:'failed',since:'2026-10-14T00:00:00.000Z',until:'2026-10-15T00:00:00.000Z',limit:10,offset:0,asOf:1234});
  for(const options of [{limit:'101'},{limit:'0'},{offset:'-1'},{offset:'1.2'},{provider:'unknown'},{kind:'patch'},{outcome:'done'},{since:'2026-10-14'},{since:'2026-10-15T00:00:00Z',until:'2026-10-14T00:00:00Z'},{cursor:'one',offset:'0'},{cursor:'one','as-of':'100'}]) await assert.rejects(workerBody(catalog['run list'],undefined,options),error=>error.exitCode===2);
  await assert.rejects(workerBody(catalog['run export'],undefined,{format:'yaml'}),error=>error.exitCode===2);
  assert.deepEqual(await workerBody(catalog['run get'],undefined,{id:'attempt-one'}),{action:'get',id:'attempt-one'});
});
test('JSON export preserves nullable original evidence and CSV escapes spreadsheet formulas and full snapshots',()=>{
  const record={id:'run-one',sessionId:'session-one',taskId:'task-one',kind:'chat',purpose:'gate_review',requestId:'request-one',title:'=SUM(1,2)',provider:'codex-cli',model:'fixture',attempt:1,before:{capturedAt:'before',consumption:{inputTokens:null,costUsd:null}},after:{capturedAt:'after',consumption:{outputTokens:8,costUsd:null}}};
  const page={schemaVersion:1,rows:[record],total:1,asOf:4,nextOffset:1,nextCursor:'page-two'};
  assert.deepEqual(JSON.parse(workerOutput(page,{},catalog['run export'])),page);
  const csv=workerOutput(page,{format:'csv'},catalog['run export']);assert.match(csv,/^id,sessionId,taskId,kind,title,provider,model,attempt,sequence,outcome/);assert.match(csv,/usage,resourceDelta,before,after,schemaVersion,total,asOf,nextOffset,nextCursor,purpose,requestId\r\n/);assert.match(csv,/"page-two","gate_review","request-one"$/);assert.match(csv,/"'=SUM\(1,2\)"/);assert.match(csv,/""costUsd"":null/);assert.match(csv,/""capturedAt"":""before""/);assert.match(csv,/""capturedAt"":""after""/);
  assert.deepEqual(JSON.parse(workerOutput({providers:[{id:'codex-cli'}],connection:{url:'private-worker'}},{},catalog['provider list'])),{providers:[{id:'codex-cli'}]});
});
test('wait observes failure as terminal and timeout has a stable code without cancelling work',async()=>{
  for (const status of ['failed','needs_rework','interrupted','done']) { const stopped={session:{status}};assert.equal(await waitForWorker(async()=>stopped,'task','10'),stopped); }
  const held={execution:{status:'needs_rework',request:{phase:'needs_rework'}}};assert.equal(await waitForWorker(async()=>held,'feature','10'),held);
  let calls=0;await assert.rejects(waitForWorker(async()=>{calls++;return{session:{status:'queued'}};},'task','1'),error=>error.code==='wait_timeout'&&/continues/.test(error.message));assert.ok(calls>=1);
});

test('feature wait observes terminal execution only after its generated record settles', async () => {
  let reads = 0;
  const completed = {record:{status:'completed',result:'_results/fixture.md'},execution:{status:'completed',text:'Fixture output'}};
  const result = await waitForWorker(async () => ++reads === 1 ? {record:{status:'running'},execution:completed.execution} : completed, 'feature', '2000');
  assert.equal(reads,2); assert.equal(result,completed);
});
