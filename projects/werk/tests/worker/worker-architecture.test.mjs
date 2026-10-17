import { snapshotFixture } from './contract-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAttempt } from '../../src/worker/dist/worker/application/execute-attempt.js';
import { ReportingError } from '../../src/worker/dist/worker/application/errors.js';
import { HttpWorkerGateway } from '../../src/worker/dist/worker/infrastructure/orchestrator-client.js';
import { ApiError } from '../../src/worker/dist/shared/http/errors.js';

/** @returns {import('../../src/shared/domain.ts').Task} */
const task = () => ({ id:'task-1', project:'demo', title:'Feature', criteria:['Done'], wikilinks:[], provider:'claude', priority:1, status:'running', attempt:1, workerId:'worker-1', lease:'lease-1', expiresAt:11000, profile:'claude-1', createdAt:0 });
const identity = { id:'worker-1', project:'demo', token:'private-token', url:'http://example.invalid', configHash:'default' };

/** @param {Partial<import('../../src/worker/application/ports.ts').AttemptDependencies>} [overrides] */
function fixture(overrides = {}) {
  const events = [], entries = new Map(), delivered = new Set();
  const state = { lastContact:null, heartbeatErrors:0, lastError:null, lastSnapshot:null, completedSimulations:0 };
  /** @type {import('../../src/worker/application/ports.ts').AttemptJournal} */
  const journal = {
    async read(pair, phase) { return entries.get(`${pair}-${phase}`) ?? null; },
    capture(task, workerId, profile, state, phase, before, outcome = 'pending', error = null) {
      const snapshot = snapshotFixture();
      return snapshotFixture({ id:`${task.lease}-${phase}`, pairId:task.lease, phase, workerId, taskId:task.id, project:task.project, attempt:task.attempt, profileId:profile.id, provider:profile.provider, execution:{...snapshot.execution,outcome,error} });
    },
    async persist(snapshot) { events.push(`persist:${snapshot.phase}`); entries.set(snapshot.id, snapshot); return snapshot; },
    async flush(send) { for(const [id,snapshot] of entries)if(!delivered.has(id)){await send(snapshot);delivered.add(id);} }
  };
  const client = {
    async currentAssignments() { return []; }, async claim() { return null; },
    async heartbeat(assigned) { events.push('heartbeat'); return {...assigned, expiresAt:11000}; },
    async publishSnapshot(snapshot) { events.push(`publish:${snapshot.phase}`); },
    async complete() { events.push('complete'); }, async abandon() { events.push('abandon'); }
  };
  /** @type {import('../../src/shared/domain.ts').Adapter} */
  const adapter = { mode:'mock', async run(assigned, signal) { signal.throwIfAborted();events.push('run');return {kind:'simulated',summary:assigned.title}; } };
  /** @type {import('../../src/worker/application/ports.ts').AttemptDependencies} */
  const dependencies = { client,journal,adapter,identity,profiles:[{id:'claude-1',provider:'claude',mode:'mock'}],state,async saveState(){events.push('save');},timeoutMs:1000,now:()=>1000,...overrides };
  return { dependencies,events,entries,state,client,adapter };
}

test('attempt application accepts substituted execution/client ports and publishes evidence before completion',async()=>{
  const f=fixture();await executeAttempt(task(),new AbortController().signal,f.dependencies);
  assert.deepEqual(f.events,['heartbeat','persist:before','save','publish:before','run','persist:after','publish:after','complete']);
  assert.equal(f.state.completedSimulations,1);assert.equal(f.state.lastContact,'1970-01-01T00:00:01.000Z');
});

test('terminal replay retries only reporting and preserves the original execution result',async()=>{
  const f=fixture();let completionCalls=0;
  f.client.complete=async()=>{completionCalls++;if(completionCalls<=3)throw new ReportingError('offline',true);f.events.push('complete');};
  await assert.rejects(executeAttempt(task(),new AbortController().signal,f.dependencies),/offline/);
  assert.equal(f.entries.get('lease-1-after').execution.outcome,'simulated');
  await executeAttempt(task(),new AbortController().signal,f.dependencies);
  assert.equal(completionCalls,4);assert.equal(f.events.filter(x=>x==='run').length,1);
  assert.equal(f.events.filter(x=>x==='persist:before').length,1);assert.equal(f.state.completedSimulations,1);
});

test('an injected adapter failure records failed evidence and abandons instead of completing',async()=>{
  const f=fixture();f.adapter.run=async()=>{throw Error('provider unavailable');};
  await executeAttempt(task(),new AbortController().signal,f.dependencies);
  assert.equal(f.entries.get('lease-1-after').execution.outcome,'failed');
  assert.equal(f.entries.get('lease-1-after').execution.error,'provider unavailable');
  assert.ok(f.events.includes('abandon'));assert.ok(!f.events.includes('complete'));
});

test('expired or foreign assignments cannot invoke execution ports',async()=>{
  const f=fixture();await assert.rejects(executeAttempt({...task(),expiresAt:999},new AbortController().signal,f.dependencies),/expired/);
  await assert.rejects(executeAttempt({...task(),project:'other'},new AbortController().signal,f.dependencies),/Invalid task/);
  assert.equal(f.entries.size,0);assert.ok(!f.events.includes('run'));assert.equal(f.state.heartbeatErrors,1);
});

test('HTTP adapter maps the protocol and translates transport errors to application retry decisions',async()=>{
  const calls=[];let fail=false;
  const gateway=new HttpWorkerGateway(identity.url,'enrollment-secret',async(base,path,token,method,body)=>{
    calls.push({base,path,token,method,body});
    if(fail)throw new ApiError(409,'lease superseded');
    if(path.endsWith('/register'))return identity;
    if(path.endsWith('/current'))return {tasks:[task()]};
    if(path.endsWith('/next'))return {task:task()};
    if(path.endsWith('/heartbeat'))return task();
    if(path.endsWith('/complete'))return {...task(),status:'simulated',expiresAt:null};
    return {ok:true};
  });
  await gateway.register([],{maxParallel:1,order:'fifo',maxAttempts:1,configHash:'default'});
  const client=gateway.connect(identity);await client.currentAssignments();await client.claim('claim-1');await client.heartbeat(task());await client.complete(task());
  assert.equal(calls[0].token,'enrollment-secret');assert.ok(calls.slice(1).every(call=>call.token==='private-token'));
  assert.equal(calls[1].method,'GET');assert.deepEqual(calls[2].body,{requestId:'claim-1'});assert.deepEqual(calls[4].body,{lease:'lease-1',attempt:1});
  fail=true;await assert.rejects(client.complete(task()),error=>error instanceof ReportingError&&!error.retryable&&error.message==='Orchestrator request failed (HTTP 409)'&&error.cause===undefined);
});

test('HTTP adapter rejects malformed assignment envelopes and mismatched lease renewal',async()=>{
  const malformed=new HttpWorkerGateway(identity.url,'',async()=>({tasks:[{id:'../../escape'}]})).connect(identity);
  await assert.rejects(malformed.currentAssignments(),/Invalid orchestrator assignment/);
  const mismatched=new HttpWorkerGateway(identity.url,'',async()=>({...task(),lease:'another-lease'})).connect(identity);
  await assert.rejects(mismatched.heartbeat(task()),/different assignment/);
});


test('HTTP lease renewal preserves the exact optional repository selector',async()=>{
  let response;
  const client=new HttpWorkerGateway(identity.url,'',async()=>response).connect(identity);
  const assigned={...task(),repository:'backend'};
  response={...assigned,expiresAt:assigned.expiresAt+1000};
  assert.equal((await client.heartbeat(assigned)).repository,'backend');
  for(const repository of ['frontend',undefined]) {
    response={...assigned,repository};
    await assert.rejects(client.heartbeat(assigned),/different assignment/);
  }
  response={...task(),repository:'backend'};
  await assert.rejects(client.heartbeat(task()),/different assignment/);
  response={...task(),expiresAt:12000};
  assert.equal((await client.heartbeat(task())).repository,undefined);
});

test('HTTP worker acknowledgements validate snapshot identity/digest and terminal lease ownership',async()=>{
  /** @type {unknown} */
  let response={ok:true};
  const client=new HttpWorkerGateway(identity.url,'',async()=>response).connect(identity);
  const snapshot=snapshotFixture();
  await assert.rejects(client.publishSnapshot(snapshot),/snapshot acknowledgement/);
  response={id:snapshot.id,sha256:'0'.repeat(64)};
  await assert.rejects(client.publishSnapshot(snapshot),/digest mismatch/);
  response={...task(),status:'simulated',expiresAt:null,lease:'wrong-lease'};
  await assert.rejects(client.complete(task()),/completion acknowledgement/);
  response={...task(),status:'simulated',expiresAt:null};await client.complete(task());
  response=task();await assert.rejects(client.abandon(task()),/did not release/);
  response={...task(),attempt:2,lease:'new-lease'};await client.abandon(task());
});


test('initial heartbeat rejection is counted and prevents adapter execution',async()=>{
  const f=fixture();f.client.heartbeat=async()=>{throw new ReportingError('Lease rejected',false);};
  await assert.rejects(executeAttempt(task(),new AbortController().signal,f.dependencies),/Lease rejected/);
  assert.equal(f.state.heartbeatErrors,1);assert.equal(f.state.lastError,'Lease rejected');assert.ok(!f.events.includes('run'));
});
