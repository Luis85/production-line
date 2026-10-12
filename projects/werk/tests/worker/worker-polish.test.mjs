import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { runWorker, reportWithRetry } from '../../src/worker/dist/worker/runner.js';
import { ApiError } from '../../src/worker/dist/shared/http/errors.js';
const digest='a'.repeat(64);
const profile={id:'claude-1',provider:'claude',mode:'mock',maxParallel:1};
const task={id:'task-1',project:'demo',title:'Test',criteria:['Done'],wikilinks:[],provider:'claude',priority:1,status:'running',attempt:1,workerId:'worker-1',lease:'lease-1',expiresAt:Date.now()+60000,profile:profile.id,createdAt:Date.now()};
const status={lastContact:null,heartbeatErrors:0};

test('worker configuration rejects null and array sections without crashing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-config-'));
  try{for(const section of ['scheduler','execution'])for(const value of [null,[],true]){
    const path=join(dir,'config.json');await writeFile(path,JSON.stringify({[section]:value}));
    await assert.rejects(configuration({config:path}),e=>e.code==='invalid_input');
  }}finally{await rm(dir,{recursive:true,force:true});}
});

test('snapshot journal serializes flush, preserves failed deliveries and rejects unsafe paths',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-journal-'));
  const journal=new SnapshotJournal(dir,digest,digest);
  try{
    await journal.init();const before=await journal.persist(journal.capture(task,'worker-1',profile,status,'before'));
    await journal.persist(journal.capture(task,'worker-1',profile,status,'after',before,'simulated'));
    await assert.rejects(journal.flush(async()=>{throw Error('offline');}),/offline/);
    let active=0,max=0;const sent=[];
    const send=async s=>{active++;max=Math.max(max,active);await delay(20);sent.push(s.phase);active--;};
    await Promise.all([journal.flush(send),journal.flush(send),journal.flush(send)]);
    assert.equal(max,1);assert.deepEqual(sent,['before','after']);assert.deepEqual(await readdir(join(dir,'outbox')),[]);
    await assert.rejects(journal.read('../escape','before'),/path/);
    await assert.rejects(journal.read('valid','../../escape'),/path/);
    assert.equal(journal.started.size,0);
    assert.throws(()=>journal.persist({...before,pairId:'../bad',id:'../bad-before'}));
  }finally{journal.close();await rm(dir,{recursive:true,force:true});}
});

test('project snapshot publishing refuses symlinked artifact directories',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-path-'));
  const repo=join(dir,'repo'),outside=join(dir,'outside');
  const journal=new SnapshotJournal(join(dir,'state'),digest,digest,repo);
  try{
    await mkdir(join(repo,'.git'),{recursive:true});await mkdir(outside);await symlink(outside,join(repo,'.factory'),'dir');await journal.init();
    await assert.rejects(journal.persist(journal.capture(task,'worker-1',profile,status,'before')),/symlink/);
    assert.deepEqual(await readdir(outside),[]);
  }finally{journal.close();await rm(dir,{recursive:true,force:true});}
});

test('report retry is bounded and never retries permanent lease errors',async()=>{
  let calls=0;await assert.rejects(reportWithRetry(async()=>{calls++;throw new ApiError(409,'expired');},new AbortController().signal),/expired/);assert.equal(calls,1);
  calls=0;await assert.rejects(reportWithRetry(async()=>{calls++;throw new ApiError(503,'offline');},new AbortController().signal),/offline/);assert.equal(calls,3);
  const stopped=new AbortController();stopped.abort();calls=0;
  await assert.rejects(reportWithRetry(async()=>{calls++;throw new ApiError(503,'offline at shutdown');},stopped.signal),/offline at shutdown/);assert.equal(calls,1);
});

test('worker renews leases throughout slow terminal upload and replays completion without execution', {timeout:12000}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-renew-'));const stop=new AbortController();
  let claimed=false,finished=false,completeCalls=0,heartbeatsDuringUpload=0,uploading=false,beforeCount=0;
  let assigned={...task,expiresAt:Date.now()+450};
  const uploads=new Map();
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):{};
    const send=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(req.url==='/v1/workers/register')return send(200,{id:'worker-1',project:'demo',token:'secret'});
    if(req.url==='/v1/worker/assignments/current')return send(200,{tasks:claimed&&!finished?[assigned]:[]});
    if(req.url==='/v1/worker/assignments/next'){
      if(claimed)return send(200,{task:null});claimed=true;assigned.expiresAt=Date.now()+450;return send(200,{task:assigned});
    }
    if(req.url?.endsWith('/heartbeat')){
      if(assigned.expiresAt<=Date.now())return send(409,{error:'expired'});
      if(uploading)heartbeatsDuringUpload++;assigned.expiresAt=Date.now()+450;return send(200,assigned);
    }
    if(req.url==='/v1/worker/snapshots'){
      if(body.phase==='before')beforeCount++;
      if(body.phase==='after'){uploading=true;await delay(750);uploading=false;}
      uploads.set(body.phase,body);return send(200,{id:body.id,sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
    }
    if(req.url?.endsWith('/complete')){
      completeCalls++;if(completeCalls<=3)return send(503,{error:'temporary completion outage'});
      if(assigned.expiresAt<=Date.now())return send(409,{error:'expired'});
      finished=true;send(200,{...assigned,status:'simulated',expiresAt:null});stop.abort();return;
    }
    send(404,{error:'not found'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let running;
  try{
    const c=await configuration({'poll-ms':'100','mock-ms':'80'});
    running=runWorker({...c,url:'http://127.0.0.1:'+server.address().port,stateDir:dir,enrollmentToken:'enroll',statusHost:'127.0.0.1',statusPort:0},stop.signal);
    await running;
    assert.equal(finished,true);assert.equal(completeCalls,4);assert.ok(heartbeatsDuringUpload>=2);assert.equal(beforeCount,1);
    assert.equal(uploads.size,2);assert.equal(uploads.get('after').execution.outcome,'simulated');
    const persisted=JSON.parse(await readFile(join(dir,'status.json'),'utf8'));
    assert.equal(persisted.state,'stopped');assert.equal(persisted.activeTasks.length,0);assert.equal(persisted.completedSimulations,1);assert.equal(persisted.lastError,'Orchestrator request failed (HTTP 503)');
    await assert.rejects(readFile(join(dir,'worker.lock')),e=>e.code==='ENOENT');
  }finally{stop.abort();await running?.catch(()=>{});await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('failed worker startup removes its process lock and writes a stopped state',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-startup-'));
  try{
    const c=await configuration({});
    await assert.rejects(runWorker({...c,stateDir:dir,url:'http://127.0.0.1:1',enrollmentToken:'',statusHost:'127.0.0.1',statusPort:0,projectDir:join(dir,'missing')},new AbortController().signal),/Git checkout/);
    await assert.rejects(readFile(join(dir,'worker.lock')),e=>e.code==='ENOENT');
    assert.equal(JSON.parse(await readFile(join(dir,'status.json'),'utf8')).state,'stopped');
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('completion cannot conceal an outstanding orchestrator polling failure', {timeout:10000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-state-')),stop=new AbortController();
  let release;const execution=new Promise(resolve=>{release=resolve;});let claimed=false,completed=false;
  const assigned={...task,expiresAt:Date.now()+60000};
  const client={
    async currentAssignments(){if(claimed)throw Error('Polling unavailable');return [];},
    async claim(){if(claimed)return null;claimed=true;return assigned;},
    async heartbeat(){return assigned;},async publishSnapshot(){},async abandon(){},async complete(){completed=true;}
  };
  const gateway={async register(){return {id:task.workerId,project:task.project,token:'test-identity'};},connect(){return client;}};
  const adapter={mode:'mock',async run(){await execution;return {kind:'simulated',summary:'done'};}};
  let running;
  const readState=async()=>{try{return JSON.parse(await readFile(join(dir,'status.json'),'utf8'));}catch{return null;}};
  const wait=async predicate=>{const until=Date.now()+5000;while(Date.now()<until){if(await predicate())return;await delay(20);}throw Error('State transition timed out');};
  try{
    const c=await configuration({'poll-ms':'100'});
    running=runWorker({...c,stateDir:dir,url:'http://injected.invalid',enrollmentToken:'',statusHost:'127.0.0.1',statusPort:0},stop.signal,{gateway,adapter});
    await wait(async()=> (await readState())?.state==='disconnected');release();
    await wait(async()=>completed&&(await readState())?.activeTasks.length===0);
    assert.equal((await readState()).state,'disconnected');
  }finally{release();stop.abort();await running;await rm(dir,{recursive:true,force:true});}
});
