import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
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

test('worker renews leases throughout slow terminal upload and replays completion without execution', {timeout:12000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-renew-')),stop=new AbortController();
  let clock=Date.now(),releaseExecution,releaseUpload;
  const execution=new Promise(resolve=>{releaseExecution=resolve;}),upload=new Promise(resolve=>{releaseUpload=resolve;});
  const cancel=()=>{releaseExecution();releaseUpload();stop.abort();};
  t.signal.addEventListener('abort',cancel,{once:true});
  t.after(()=>{t.signal.removeEventListener('abort',cancel);cancel();});
  // Only advance lease/retry timers after each observable boundary; filesystem latency consumes no lease time.
  t.mock.timers.enable({apis:['setTimeout']});
  let claimed=false,finished=false,completeCalls=0,heartbeats=0,heartbeatsDuringUpload=0,uploading=false,beforeCount=0,executions=0;
  const assigned={...task,expiresAt:clock+450},uploads=new Map();
  const client={
    async currentAssignments(){return claimed&&!finished?[assigned]:[];},
    async claim(){if(claimed)return null;claimed=true;return assigned;},
    async heartbeat(){
      if(assigned.expiresAt<=clock)throw new ApiError(409,'expired');
      heartbeats++;if(uploading)heartbeatsDuringUpload++;assigned.expiresAt=clock+450;return {...assigned};
    },
    async publishSnapshot(snapshot){
      if(snapshot.phase==='before')beforeCount++;
      if(snapshot.phase==='after'){uploading=true;await upload;uploading=false;}
      uploads.set(snapshot.phase,snapshot);
    },
    async complete(){
      completeCalls++;if(completeCalls<=3)throw new ApiError(503,'temporary completion outage');
      if(assigned.expiresAt<=clock)throw new ApiError(409,'expired');
      finished=true;stop.abort();
    },
    async abandon(){throw Error('Successful fixture execution must not be abandoned');}
  };
  const gateway={async register(){return {id:task.workerId,project:task.project,token:'test-identity'};},connect(){return client;}};
  const adapter={mode:'mock',async run(){executions++;await execution;return {kind:'simulated',summary:'done'};}};
  let running,runtimeError;
  const state=async()=>{try{return JSON.parse(await readFile(join(dir,'status.json'),'utf8'));}catch{return null;}};
  const wait=async(label,predicate)=>{
    const until=performance.now()+5000;
    while(performance.now()<until){
      if(runtimeError)throw runtimeError;
      if(await predicate())return;
      t.signal.throwIfAborted();await turn();
    }
    throw Error(`State transition timed out: ${label}`);
  };
  const advance=async milliseconds=>{clock+=milliseconds;t.mock.timers.tick(milliseconds);await turn();};
  try{
    const c=await configuration({'poll-ms':'100'});
    running=runWorker({...c,url:'http://injected.invalid',stateDir:dir,enrollmentToken:'',statusHost:'127.0.0.1',statusPort:0},stop.signal,{gateway,adapter,now:()=>clock});
    running.catch(error=>{runtimeError=error;});
    await wait('execution entered',()=>executions===1);releaseExecution();
    await wait('terminal upload entered',()=>uploading);
    const uploadStarted=clock,originalExpiry=assigned.expiresAt;
    for(let n=0;n<4;n++){
      const previous=heartbeats;await advance(150);
      await wait('lease renewed during terminal upload',()=>heartbeats>previous);
    }
    assert.ok(clock>originalExpiry,'upload remains blocked beyond the original lease');
    assert.equal(clock-uploadStarted,600);assert.equal(heartbeatsDuringUpload,4);assert.equal(completeCalls,0);
    releaseUpload();
    await wait('first completion failure',()=>completeCalls===1);
    await advance(100);await wait('second completion failure',()=>completeCalls===2);
    await advance(200);await wait('third completion failure',()=>completeCalls===3);
    await wait('failed completion attempt drained',async()=>{
      const persisted=await state();return persisted?.activeTasks.length===0&&persisted.lastError==='temporary completion outage';
    });
    // Retry exhaustion releases the attempt, then polling replays its durable terminal evidence.
    await advance(350);await wait('completion replay acknowledged',()=>finished);
    await running;
    assert.equal(completeCalls,4);assert.equal(executions,1);assert.equal(beforeCount,1);
    assert.equal(uploads.size,2);assert.equal(uploads.get('after').execution.outcome,'simulated');
    const persisted=await state();
    assert.equal(persisted.state,'stopped');assert.equal(persisted.activeTasks.length,0);assert.equal(persisted.completedSimulations,1);assert.equal(persisted.lastError,'temporary completion outage');
    await assert.rejects(readFile(join(dir,'worker.lock')),e=>e.code==='ENOENT');
  }finally{cancel();await running?.catch(()=>{});t.mock.timers.reset();await rm(dir,{recursive:true,force:true});}
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


test('completion cannot conceal an outstanding orchestrator polling failure', {timeout:10000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-state-')),stop=new AbortController();
  let release;const execution=new Promise(resolve=>{release=resolve;});let claimed=false,completed=false,adapterStarted=false;
  const cancel=()=>{release();stop.abort();};
  t.signal.addEventListener('abort',cancel,{once:true});
  t.after(()=>{t.signal.removeEventListener('abort',cancel);cancel();});
  const assigned={...task,expiresAt:Date.now()+60000};
  const client={
    // Fail polling only after execution actually starts, so a startup failure cannot masquerade as the outage under test.
    async currentAssignments(){if(adapterStarted)throw Error('Polling unavailable');return [];},
    async claim(){if(claimed)return null;claimed=true;return assigned;},
    async heartbeat(){return assigned;},async publishSnapshot(){},async abandon(){},async complete(){completed=true;}
  };
  const gateway={async register(){return {id:task.workerId,project:task.project,token:'test-identity'};},connect(){return client;}};
  const adapter={mode:'mock',async run(){adapterStarted=true;await execution;return {kind:'simulated',summary:'done'};}};
  let running,runtimeError;
  const readState=async()=>{try{return JSON.parse(await readFile(join(dir,'status.json'),'utf8'));}catch{return null;}};
  const wait=async(label,predicate)=>{
    const until=Date.now()+5000;
    while(Date.now()<until){
      if(runtimeError)throw runtimeError;
      const state=await readState();
      if(state?.lastError && state.lastError!=='Polling unavailable')throw Error(`${label}: ${state.lastError}`);
      if(predicate(state))return;
      t.signal.throwIfAborted();await delay(20);
    }
    throw Error(`State transition timed out: ${label}`);
  };
  try{
    const c=await configuration({'poll-ms':'100'});
    running=runWorker({...c,stateDir:dir,url:'http://injected.invalid',enrollmentToken:'',statusHost:'127.0.0.1',statusPort:0},stop.signal,{gateway,adapter});
    running.catch(error=>{runtimeError=error;});
    await wait('adapter entered',()=>adapterStarted);
    await wait('polling disconnected',state=>state?.state==='disconnected');release();
    await wait('completion acknowledged and drained',state=>completed&&state?.activeTasks.length===0);
    assert.equal((await readState()).state,'disconnected');
  }finally{cancel();try{await running;}finally{await rm(dir,{recursive:true,force:true});}}
});

test('an unwritable status snapshot is reported and retried without stopping a standalone worker',{timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-status-write-'));const stop=new AbortController();
  // A directory in place of status.json makes every snapshot replacement fail on every platform.
  await mkdir(join(dir,'status.json'));
  const adapter={mode:'mock',async run(){throw Error('No task is expected');}};
  let runtimeError,running;
  try{
    const c=await configuration({'poll-ms':'100'});
    running=runWorker({...c,stateDir:dir,url:'',enrollmentToken:'',statusHost:'127.0.0.1',statusPort:0},stop.signal,{adapter});
    running.catch(error=>{runtimeError=error;});
    // Several standalone polls (each with up to ~2.3 s of Windows retries) must not end the worker.
    await delay(process.platform==='win32'?6000:800);
    assert.equal(runtimeError,undefined);
    await rm(join(dir,'status.json'),{recursive:true,force:true});
    for(let i=0;i<100;i++){const state=await readFile(join(dir,'status.json'),'utf8').then(JSON.parse,()=>null);if(state?.state==='standalone')break;await delay(50);}
    assert.equal(JSON.parse(await readFile(join(dir,'status.json'),'utf8')).state,'standalone');
  }finally{stop.abort();try{await running;}finally{await rm(dir,{recursive:true,force:true});}}
});
