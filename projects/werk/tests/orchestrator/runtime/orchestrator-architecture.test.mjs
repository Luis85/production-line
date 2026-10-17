import { testErrorCode, testErrorMessage, testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OrchestratorApplication } from '../../../src/orchestrator/dist/orchestrator/application.js';
import { createHttpHandler, tokenAuthorization } from '../../../src/orchestrator/dist/orchestrator/http.js';
import { DomainError } from '../../../src/orchestrator/dist/shared/errors.js';
import { collectIteration, submitIteration } from '../../../src/orchestrator/dist/orchestrator/intake/iteration.js';

import { taskInput } from '../../../src/orchestrator/dist/shared/contracts.js';
import { SnapshotJournal } from '../../../src/worker/dist/worker/infrastructure/journal/snapshots.js';

/** @type {import('../../../src/orchestrator/dist/shared/protocol.js').WorkerRecord} */
const worker={id:'worker-1',project:'demo',profiles:[{id:'claude',provider:'claude',mode:'mock'}],seen:0,config:{maxParallel:1,order:'priority',maxAttempts:3,configHash:'default'}};
/**
 * Missing port operations throw before producing a value; supplied operations keep their full contracts.
 * @param {Partial<import('../../../src/orchestrator/dist/orchestrator/application.js').OrchestratorRepository>} operations
 * @returns {import('../../../src/orchestrator/dist/orchestrator/application.js').OrchestratorRepository}
 */
function port(operations={}) {
  return /** @type {import('../../../src/orchestrator/dist/orchestrator/application.js').OrchestratorRepository} */ (new Proxy(operations,{get(target,key){return key in target?target[key]:()=>{throw Error('Unexpected repository operation: '+String(key));};}}));
}

/** @returns {import('../../../src/orchestrator/dist/shared/contracts.js').Task} */
function storedTask(id, input = {}) {
  return { ...taskInput({ project: 'demo', title: 'Fixture', criteria: ['Observable behavior'], ...input }), id,
    status: 'queued', createdAt: 1, attempt: 0, workerId: null, lease: null, expiresAt: null, profile: null };
}
function snapshotRecord(seq) {
  const journal = new SnapshotJournal('/tmp', 'default', 'fixture');
  try {
    const snapshot = journal.capture(storedTask('task'), worker.id, worker.profiles[0], { lastContact: null, heartbeatErrors: 0 }, 'before');
    return { seq, snapshot, sha256: 'a'.repeat(64), receivedAt: '2026-10-17T00:00:00.000Z' };
  } finally { journal.close(); }
}

test('application binds worker commands to authenticated identity and rejects identity overrides',()=>{
  const calls=[];
  const app=new OrchestratorApplication(port({
    worker:token=>{assert.equal(token,'worker-token');return worker;},
    claim:(identity,requestId)=>{calls.push({identity,requestId});return null;},
    heartbeat:(identity,taskId,lease,attempt)=>{calls.push({identity,taskId,lease,attempt});return storedTask(taskId);},
  }),'demo');
  const session=app.worker('worker-token');
  assert.throws(()=>session.claim({requestId:'request-1',workerId:'other'}),e=>testErrorCode(e)==='invalid_input');
  assert.throws(()=>session.execute('heartbeat','task-1',{lease:'lease',attempt:1,workerId:'other'}),e=>testErrorCode(e)==='invalid_input');
  assert.equal(calls.length,0);
  assert.deepEqual(session.claim({requestId:'request-1'}),{task:null});
  session.execute('heartbeat','task-1',{lease:'lease',attempt:1});
  assert.ok(calls.every(call=>call.identity===worker));
});

test('application registration preserves server project affinity',()=>{
  /** @type {{project: string, profiles: unknown, policy: unknown}} */
  let registered;
  const app=new OrchestratorApplication(port({register:(project,profiles,policy)=>{registered={project,profiles,policy};return {id:'new-worker',token:'issued'};}}),'owned-project');
  assert.throws(()=>app.register({profiles:worker.profiles,project:'other'}),e=>testErrorCode(e)==='invalid_input');
  assert.equal(registered,undefined);
  const response=app.register({profiles:worker.profiles});
  assert.equal(registered.project,'owned-project');assert.equal(response.project,'owned-project');
});

test('application validates cursor direction before persistence and trims lookahead',()=>{
  const queries=[], rows=[9,8,7].map(snapshotRecord);
  const app=new OrchestratorApplication(port({snapshots:query=>{queries.push(query);return rows;}}),'demo');
  assert.throws(()=>app.snapshots({order:'desc',after:2}),e=>testErrorCode(e)==='invalid_input');
  assert.throws(()=>app.snapshots({before:-1}),e=>testErrorCode(e)==='invalid_input');assert.equal(queries.length,0);
  const page=app.snapshots({order:'desc',before:10,limit:2});
  assert.deepEqual(page,{snapshots:rows.slice(0,2),nextCursor:8,hasMore:true});
  assert.equal(queries[0].limit,3);
});

test('HTTP boundary authenticates before side effects and hides unexpected persistence errors',async()=>{
  const calls=[],errors=[];
  const application=new OrchestratorApplication(port({
    submit:()=>{calls.push('submit');throw new DomainError('conflict','Task key conflict');},
    list:()=>{throw Error('private database path /credentials.sqlite');},
  }),'demo');
  const server=createServer(createHttpHandler({application,schemaVersion:3,authorize:tokenAuthorization('admin-token','enroll-token'),views:{intake:'Intake',concept:'Concept'},reportError:error=>errors.push(error)}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',() => resolve(undefined)));
  try{
    const base='http://127.0.0.1:'+testListeningAddress(server).port;
    const post=token=>fetch(base+'/v1/tasks',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({project:'demo',title:'Valid authenticated input',criteria:['Reaches the repository boundary']})});
    assert.equal((await post('wrong')).status,401);assert.deepEqual(calls,[]);
    const conflict=await post('admin-token');assert.equal(conflict.status,409);assert.deepEqual(await conflict.json(),{error:'Task key conflict'});
    const failure=await fetch(base+'/v1/tasks',{headers:{Authorization:'Bearer admin-token'}});
    assert.equal(failure.status,500);assert.deepEqual(await failure.json(),{error:'Internal server error'});assert.equal(errors.length,1);
    assert.equal(await(await fetch(base+'/')).text(),'Intake');
  }finally{await new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();});}
});

const request={project:'demo',iteration:'week-1',branch:'iteration/week-1',features:'docs/features',iterationPrUrl:'https://git.example/pull/1'};
const note='---\nfactory_id: feature-1\nfactory_iteration: week-1\nfactory_status: ready_for_implementation\ntitle: Planned feature\nfactory_acceptance:\n  - Accepted\n---\nSpecification';
const source={commit:'a'.repeat(40),files:async()=>['docs/features/feature.md'],read:async()=>note};

test('iteration collection is side-effect-free and records one committed source revision',async()=>{
  const plan=await collectIteration(source,request);
  assert.equal(plan.ready.length,1);assert.equal(plan.ready[0].source.commit,source.commit);
  assert.equal(plan.ready[0].source.path,'docs/features/feature.md');
  await assert.rejects(collectIteration({...source,files:async()=>['one.md','two.md']},request),e=>testErrorCode(e)==='invalid_input'&&testErrorMessage(e).includes('Duplicate feature'));
});

test('iteration use case reconciles a concurrent import without overwriting changed specifications',async()=>{
  const plan=await collectIteration(source,request),item=plan.ready[0];
  let reads=0,creates=0;
  const prior={...storedTask('existing-task', item),source:{...item.source,specSha256:'b'.repeat(64)}};
  const gateway={
    listTasks:async()=>++reads===1?[]:[prior],
    createTask:async(input,key)=>{creates++;assert.match(key,/^iteration:[a-f0-9]{64}$/);throw new DomainError('conflict','Already submitted');},
  };
  const result=await submitIteration(plan,gateway);
  assert.equal(creates,1);assert.equal(reads,2);assert.equal(result.requiresDecision,true);
  assert.deepEqual(result.results,[{featureId:'feature-1',taskId:'existing-task',status:'revision_required'}]);
});
