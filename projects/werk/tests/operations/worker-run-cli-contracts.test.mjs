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
test('wait observes failure as terminal and timeout has a stable code without cancelling work',async t=>{
  for (const status of ['failed','needs_rework','interrupted','done']) { const stopped={session:{status}};assert.equal(await waitForWorker(async()=>stopped,'task','10'),stopped); }
  const held={execution:{status:'needs_rework',request:{phase:'needs_rework'}}};assert.equal(await waitForWorker(async()=>held,'feature','10'),held);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let calls=0;const waiting=assert.rejects(waitForWorker(async()=>{calls++;return{session:{status:'queued'}};},'task','1'),error=>testErrorCode(error)==='wait_timeout'&&/without cancelling/.test(testErrorMessage(error)));
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1);await waiting;assert.equal(calls,1);
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
  assert.ok(timeouts.every(ms => ms > 0 && ms <= 5000), 'each poll is bounded by the remaining wait');
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
test('a slow poll uses the remaining wait without a minimum grace interval', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const budgets = [];
  const waiting = assert.rejects(waitForWorker(async budget => {
    budgets.push(budget); await new Promise(resolve => setTimeout(resolve, budget)); throw slowPoll();
  }, 'feature', '30', 10000), error => testErrorCode(error) === 'wait_timeout' && /state could not be read/.test(testErrorMessage(error)) && /1 status poll timed out/.test(testErrorMessage(error)) && /--timeout-ms/.test(testErrorMessage(error)));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30); await waiting;
  assert.deepEqual(budgets, [30]); assert.equal(Date.now(), 1030);
});
test('a wait never starts another status read at its deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const budgets = [];
  const waiting = assert.rejects(waitForWorker(async budget => { budgets.push(budget); return { session: { status: 'running' } }; }, 'task', '30'), error => testErrorCode(error) === 'wait_timeout' && /without cancelling/.test(testErrorMessage(error)) && !/status poll/.test(testErrorMessage(error)));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30); await waiting;
  assert.deepEqual(budgets, [30]);
});
test('a shorter request timeout still applies to every retry within the wait deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const budgets = [], settled = { status: 'done' };
  const waiting = waitForWorker(async budget => { budgets.push(budget); if (budgets.length === 1) throw slowPoll(); return settled; }, 'file-task', '2400', 200);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  assert.equal(await waiting, settled); assert.deepEqual(budgets, [200, 200]);
});
test('connection losses name the last error', async () => {
  await assert.rejects(waitForWorker(async () => { throw Object.assign(Error('fetch failed'), { cause: Object.assign(Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); }, 'task', '30'), error => /lost the connection \(last: read ECONNRESET\)/.test(testErrorMessage(error)));
});
test('connection losses fall back to the cause code when Node reports an empty message', async () => {
  const refused = () => Object.assign(Error('fetch failed'), { cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }) });
  await assert.rejects(waitForWorker(async () => { throw refused(); }, 'task', '30'), error => /lost the connection \(last: ECONNREFUSED\)/.test(testErrorMessage(error)));
});
test('HTTP answers, input rejection and cancellation never retry even with transient-looking details', async () => {
  for (const error of [
    Object.assign(Error('socket hang up'), { status: 502 }),
    Object.assign(Error('server timeout'), { status: 503, code: 'timeout' }),
    Object.assign(Error('socket hang up'), { exitCode: 2 }),
    Object.assign(Error('request cancelled'), { name: 'AbortError', cause: { code: 'ECONNRESET' } }),
    Object.assign(Error('request cancelled'), { code: 'ABORT_ERR', cause: { code: 'ECONNRESET' } }),
  ]) {
    let calls = 0;
    await assert.rejects(waitForWorker(async () => { calls++; throw error; }, 'task', '5000'), failure => failure === error);
    assert.equal(calls, 1);
  }
});
test('a stale successful read followed by connection loss cannot claim the task continues', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let calls = 0;
  const waiting = assert.rejects(waitForWorker(async () => {
    if (++calls === 1) return { session: { status: 'running' } };
    throw Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }, 'task', '1500'), error => testErrorCode(error) === 'wait_timeout' && /state could not be read/.test(testErrorMessage(error)) && /No cancellation was sent/.test(testErrorMessage(error)) && !/task continues/.test(testErrorMessage(error)));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(500); await waiting;
  assert.equal(calls, 2);
});
