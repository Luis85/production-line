import { testErrorCode, testErrorMessage, testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { importIteration } from '../../../src/orchestrator/dist/orchestrator/intake/importer.js';
const ps=[{id:'claude',provider:'claude',mode:'mock'}];
const task={project:'demo',title:'Feature',criteria:['Accepted'],wikilinks:[],provider:'auto',priority:1};
const configHash=createHash('sha256').update('configuration').digest('hex');
const serverConfig={db:':memory:',host:'127.0.0.1',port:0,project:'demo',adminToken:'a'.repeat(32),enrollmentToken:'e'.repeat(32)};

test('v1 migration adds policy and attempt limits atomically and remains reopenable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-migration-')),file=join(dir,'db.sqlite');let s;
  try{
    const legacy=new DatabaseSync(file);
    legacy.exec('CREATE TABLE workers(id TEXT PRIMARY KEY,project TEXT NOT NULL,profiles TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,seen INTEGER NOT NULL); PRAGMA user_version=1;');
    const workerToken = 'migration-worker-token';
    legacy.prepare('INSERT INTO workers VALUES(?,?,?,?,?)').run('old-worker','demo',JSON.stringify(ps),createHash('sha256').update(workerToken).digest('hex'),1);legacy.close();
    s=new Store(file);assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,7);
    const summary=s.workers()[0];assert.equal(summary.config.maxParallel,1);assert.equal(summary.config.order,'priority');
    const worker=s.worker(workerToken);assert.equal(worker.id,summary.id);
    s.submit(task,'migration-task');const assigned=s.claim(worker);assert.equal(assigned.attempt,1);
    assert.equal(s.db.prepare('SELECT max_attempts FROM attempts').get().max_attempts,3);
    s.close();s=new Store(file);assert.equal(s.list().length,1);
  }finally{s?.close();await rm(dir,{recursive:true,force:true});}
});

test('failed migration rolls back newly created tables and leaves version unchanged',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-migration-fail-')),file=join(dir,'db.sqlite');
  try{
    const legacy=new DatabaseSync(file);legacy.exec('CREATE TABLE snapshots(id TEXT PRIMARY KEY); PRAGMA user_version=1;');legacy.close();
    assert.throws(()=>new Store(file));
    const check=new DatabaseSync(file);
    try{assert.equal(check.prepare('PRAGMA user_version').get().user_version,1);assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get(),undefined);}finally{check.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('reading task state reaps abandoned leases once using assignment-time retry limits',()=>{
  let now=1000;const s=new Store(':memory:',100,()=>now);
  try{
    const w=s.worker(s.register('demo',ps,{maxParallel:1,order:'priority',maxAttempts:1,configHash}).token);
    const id=s.submit(task,'expiry').id,assigned=s.claim(w,'request-1');
    s.db.prepare('UPDATE workers SET config=? WHERE id=?').run(JSON.stringify({...w.config,maxAttempts:5}),w.id);
    now=1101;assert.equal(s.get(id).status,'blocked');assert.deepEqual(s.current(w),[]);
    assert.equal(s.events(id).filter(x=>x.kind==='lease_expired').length,1);
    assert.throws(()=>s.heartbeat(w,id,assigned.lease,assigned.attempt),e=>testErrorCode(e)==='conflict');
    assert.equal(s.reapExpired(),0);
  }finally{s.close();}
});

test('server reaps leases while the fleet is idle and closes idempotently',async()=>{
  const app=await startServer({...serverConfig,leaseMs:30});
  try{
    const w=app.store.worker(app.store.register('demo',ps).token);const id=app.store.submit(task,'timer').id;app.store.claim(w);
    const deadline=Date.now()+1500;
    while(app.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status==='running'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,15));
    assert.equal(app.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'queued');
  }finally{await Promise.all([app.close(),app.close()]);}
});

test('snapshot cursor reads latest pages without gaps, with explicit hasMore',async()=>{
  const app=await startServer(serverConfig);
  try{
    for(let n=1;n<=5;n++)app.store.db.prepare('INSERT INTO snapshots(id,task,attempt,phase,worker,project,captured,received,digest,payload) VALUES(?,?,?,?,?,?,?,?,?,?)').run('s'+n,'t'+n,1,'after','w','demo',new Date(n).toISOString(),n,'hash',JSON.stringify({n}));
    const url='http://127.0.0.1:'+testListeningAddress(app.server).port,headers={Authorization:'Bearer '+serverConfig.adminToken};
    const page=await(await fetch(url+'/v1/snapshots?order=desc&limit=2',{headers})).json();assert.deepEqual(page.snapshots.map(x=>x.seq),[5,4]);assert.equal(page.hasMore,true);
    const next=await(await fetch(url+'/v1/snapshots?order=desc&before='+page.nextCursor+'&limit=2',{headers})).json();assert.deepEqual(next.snapshots.map(x=>x.seq),[3,2]);
    const last=await(await fetch(url+'/v1/snapshots?order=desc&before='+next.nextCursor+'&limit=2',{headers})).json();assert.deepEqual(last.snapshots.map(x=>x.seq),[1]);assert.equal(last.hasMore,false);
    assert.equal((await fetch(url+'/v1/snapshots?order=desc&after=1',{headers})).status,400);
    assert.equal((await fetch(url+'/v1/snapshots?before=4',{headers})).status,400);
    assert.deepEqual(app.store.snapshots({after:3}).map(x=>x.seq),[4,5]);
  }finally{await app.close();}
});

test('API rejects unknown registration and lease fields rather than silently ignoring them',async()=>{
  const app=await startServer(serverConfig);
  try{
    const url='http://127.0.0.1:'+testListeningAddress(app.server).port;
    const post=(path,token,body)=>fetch(url+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post('/v1/workers/register',serverConfig.enrollmentToken,{profiles:ps,parallel:8})).status,400);
    const auth=app.store.register('demo',ps);
    assert.equal((await post('/v1/worker/assignments/next',auth.token,{requestId:'request',unexpected:true})).status,400);
    assert.equal((await post('/v1/worker/tasks/no-task/heartbeat',auth.token,{lease:'lease',attempt:'1'})).status,400);
    assert.equal((await(await fetch(url+'/healthz')).json()).schema,7);
  }finally{await app.close();}
});

test('importer rejects a dry-run typo before reading Git or sending tasks',async()=>{
  const options={repo:'/does-not-exist',branch:'iteration/test',project:'demo',iteration:'test','iteration-pr':'https://git.example/pull/1','dry-run':'TRUE'};
  await assert.rejects(importIteration(options,''),e=>testErrorCode(e)==='invalid_input'&&testErrorMessage(e).includes('--dry-run'));
  await assert.rejects(importIteration({...options,'dry-run':'true',branch:'@{-1}'},''),e=>testErrorCode(e)==='invalid_input'&&testErrorMessage(e).includes('local branch'));
});

test('headless commands reject unrelated options with machine-readable input errors',async()=>{
  try{await promisify(execFile)(process.execPath,['src/orchestrator/dist/orchestrator/cli.js','health','--key','ignored']);assert.fail('Expected CLI input rejection');}
  catch(e){assert.equal(e.code,2);assert.equal(e.stdout,'');assert.match(JSON.parse(e.stderr.trim()).error,/Unknown option --key/);}
});

test('abandon replay cannot mutate a subsequent assignment or duplicate events',()=>{
  const s=new Store(':memory:');
  try{
    const w=s.worker(s.register('demo',ps).token),nextWorker=s.worker(s.register('demo',ps).token);
    const id=s.submit(task,'abandon').id,first=s.claim(w,'first');
    s.abandon(w,id,first.lease,first.attempt);
    assert.equal(s.abandon(w,id,first.lease,first.attempt).status,'queued');
    const next=s.claim(nextWorker,'second');
    assert.equal(s.abandon(w,id,first.lease,first.attempt).lease,next.lease);
    assert.equal(s.events(id).filter(e=>e.kind==='abandoned').length,1);
    assert.equal(s.get(id).status,'running');
    assert.throws(()=>s.abandon(w,id,'not-the-lease',first.attempt),e=>testErrorCode(e)==='conflict');
  }finally{s.close();}
});
