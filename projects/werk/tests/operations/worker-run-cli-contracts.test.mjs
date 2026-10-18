import { testErrorStatus } from '../helpers/process-errors.mjs';
import { testErrorCode, testErrorMessage } from '../helpers/typed-boundaries.mjs';
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
  for(const options of [{limit:'101'},{limit:'0'},{offset:'-1'},{offset:'1.2'},{provider:'unknown'},{kind:'patch'},{outcome:'done'},{since:'2026-10-14'},{since:'2026-10-15T00:00:00Z',until:'2026-10-14T00:00:00Z'},{cursor:'one',offset:'0'},{cursor:'one','as-of':'100'}]) await assert.rejects(workerBody(catalog['run list'],undefined,options),error=>testErrorStatus(error, 'exitCode')===2);
  await assert.rejects(workerBody(catalog['run export'],undefined,{format:'yaml'}),error=>testErrorStatus(error, 'exitCode')===2);
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
  let calls=0;await assert.rejects(waitForWorker(async()=>{calls++;return{session:{status:'queued'}};},'task','1'),error=>testErrorCode(error)==='wait_timeout'&&/continues/.test(testErrorMessage(error)));assert.ok(calls>=1);
});

test('feature wait observes terminal execution only after its generated record settles', async () => {
  let reads = 0;
  const completed = {record:{status:'completed',result:'_results/fixture.md'},execution:{status:'completed',text:'Fixture output'}};
  const result = await waitForWorker(async () => ++reads === 1 ? {record:{status:'running'},execution:completed.execution} : completed, 'feature', '2000');
  assert.equal(reads,2); assert.equal(result,completed);
});

const slowPoll = () => Object.assign(Error('No response within 10 s. The request may still be running on the server; inspect its status before retrying.'), { code: 'timeout' });
test('wait retries a poll that timed out and returns the settled result', async () => {
  const settled = { session: { status: 'done' } }, timeouts = [];
  let calls = 0;
  const result = await waitForWorker(async pollTimeout => { timeouts.push(pollTimeout); if (++calls === 1) throw slowPoll(); return settled; }, 'task', '5000', 10000);
  assert.equal(result, settled); assert.equal(calls, 2);
  assert.ok(timeouts.every(ms => ms >= 1000 && ms <= 5000), 'each poll is bounded by the remaining wait, never below one poll interval');
});
test('wait retries dropped connections but ends on API and input errors', async () => {
  const settled = { status: 'done' };
  for (const error of [Object.assign(Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), Error('socket hang up')]) {
    let calls = 0;
    assert.equal(await waitForWorker(async () => { if (++calls === 1) throw error; return settled; }, 'file-task', '5000'), settled);
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(waitForWorker(async () => { calls++; throw Object.assign(Error('Not found'), { status: 404 }); }, 'task', '5000'), error => testErrorStatus(error, 'status') === 404);
  assert.equal(calls, 1);
});
test('repeated slow polls end in wait_timeout at the deadline and say how many timed out', async () => {
  const started = Date.now(), timeouts = [];
  await assert.rejects(waitForWorker(async pollTimeout => { timeouts.push(pollTimeout); await new Promise(resolve => setTimeout(resolve, 150)); throw slowPoll(); }, 'feature', '400', 200), error => testErrorCode(error) === 'wait_timeout' && /worker state could not be read/.test(testErrorMessage(error)) && !/continues/.test(testErrorMessage(error)) && /`status`/.test(testErrorMessage(error)) && /\d+ status polls? timed out/.test(testErrorMessage(error)) && /--request-timeout-ms/.test(testErrorMessage(error)));
  assert.ok(Date.now() - started < 1800); assert.ok(timeouts.length >= 2); assert.ok(timeouts.every(ms => ms === 200));
});
test('an expired wait with fast polls reports no slow polls and its final poll at the deadline still reads the state', async () => {
  const latency = 5, budgets = [];
  const poll = answer => async budget => { budgets.push(budget); if (budget < latency) throw slowPoll(); await new Promise(resolve => setTimeout(resolve, latency)); return answer(); };
  await assert.rejects(waitForWorker(poll(() => ({ session: { status: 'running' } })), 'task', '30', 10000), error => testErrorCode(error) === 'wait_timeout' && !/status poll|--request-timeout-ms/.test(testErrorMessage(error)));
  assert.ok(budgets.length >= 2 && budgets.every(ms => ms >= 1000), 'a poll at the deadline keeps a full interval budget');
  let reads = 0;
  const settled = { session: { status: 'done' } };
  assert.equal(await waitForWorker(poll(() => ++reads < 2 ? { session: { status: 'running' } } : settled), 'task', '30', 10000), settled);
  assert.equal(reads, 2);
});
test('connection losses name the last error', async () => {
  await assert.rejects(waitForWorker(async () => { throw Object.assign(Error('fetch failed'), { cause: Object.assign(Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); }, 'task', '30'), error => /lost the connection \(last: read ECONNRESET\)/.test(testErrorMessage(error)));
});
test('connection losses fall back to the cause code when Node reports an empty message', async () => {
  const refused = () => Object.assign(Error('fetch failed'), { cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }) });
  await assert.rejects(waitForWorker(async () => { throw refused(); }, 'task', '30'), error => /lost the connection \(last: ECONNREFUSED\)/.test(testErrorMessage(error)));
});
test('an error carrying an HTTP status ends the wait even when its message looks like a dropped socket', async () => {
  let calls = 0;
  await assert.rejects(waitForWorker(async () => { calls++; throw Object.assign(Error('socket hang up'), { status: 502 }); }, 'task', '5000'), error => testErrorStatus(error, 'status') === 502);
  assert.equal(calls, 1);
});
test('a wait that never read the worker does not claim the task continues, and one that did still does', async () => {
  await assert.rejects(waitForWorker(async () => { throw Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, 'task', '30'), error => testErrorCode(error) === 'wait_timeout' && /state could not be read/.test(testErrorMessage(error)) && /`status`/.test(testErrorMessage(error)) && !/continues/.test(testErrorMessage(error)));
  let calls = 0;
  await assert.rejects(waitForWorker(async () => { if (++calls === 1) return { session: { status: 'running' } }; throw slowPoll(); }, 'task', '30'), error => testErrorCode(error) === 'wait_timeout' && /task continues/.test(testErrorMessage(error)));
});
