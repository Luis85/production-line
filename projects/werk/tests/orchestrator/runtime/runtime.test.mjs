import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { SnapshotJournal } from '../../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusHtml } from '../../../src/worker/dist/worker/status/server.js';
import { configuration } from '../../../src/worker/dist/worker/config.js';
import { importIteration } from '../../../src/orchestrator/dist/orchestrator/intake/importer.js';
const task = (extra={}) => ({project:'demo',title:'Feature',criteria:['Acceptance'],wikilinks:['[[DoD]]'],provider:'auto',priority:1,...extra});
const ps = [{id:'claude-1',provider:'claude',mode:'mock'},{id:'codex-2',provider:'codex',mode:'mock'}];
function addPair(store,w,t){const j=new SnapshotJournal('/tmp',w.config.configHash??'default','test');const status={lastContact:null,heartbeatErrors:0};const p=w.profiles.find(p=>p.id===t.profile);try{const b=j.capture(t,w.id,p,status,'before');store.snapshot(w,b);const a=j.capture(t,w.id,p,status,'after',b,'simulated');store.snapshot(w,a);return [b,a];}finally{j.close();}}
test('submission is validated and idempotent; changed payload cannot reuse a key',()=>{
  const s=new Store(':memory:');try{
    const a=s.submit(task(),'a');assert.equal(s.submit(task(),'a').id,a.id);assert.equal(s.list().length,1);
    assert.throws(()=>s.submit(task({title:'Other'}),'a'),e=>e.code==='conflict');
    assert.throws(()=>s.submit(task({provider:'cursor'}),'b'),e=>e.code==='invalid_input');
    assert.throws(()=>s.submit(task({criteria:[]}),'c'),e=>e.code==='invalid_input');
    assert.throws(()=>s.submit(task({wikilinks:['bad link']}),'d'),e=>e.code==='invalid_input');
  }finally{s.close();}
});
test('project/profile routing, priority and one slot across multiple profiles',()=>{
  const s=new Store(':memory:');try{
    const w=s.worker(s.register('demo',ps).token),other=s.worker(s.register('other',ps).token);
    const low=s.submit(task(),'low'),high=s.submit(task({provider:'codex',priority:2}),'high');
    assert.equal(s.claim(other),null);
    const a=s.claim(w,'same-request');assert.equal(a.id,high.id);assert.equal(a.profile,'codex-2');assert.equal(a.attempt,1);
    assert.equal(s.claim(w,'same-request').lease,a.lease);assert.equal(s.claim(w),null);assert.equal(s.get(low.id).status,'queued');
    addPair(s,w,a);s.finish(w,a.id,a.lease,a.attempt);assert.equal(s.claim(w).id,low.id);
  }finally{s.close();}
});
test('expired lease is reassigned and cannot heartbeat or finish; completion replay is safe',()=>{
  let now=1000;const s=new Store(':memory:',100,()=>now);try{
    const w1=s.worker(s.register('demo',ps).token),w2=s.worker(s.register('demo',ps).token);
    s.submit(task(),'a');const a=s.claim(w1);now=1200;const b=s.claim(w2);
    assert.equal(b.attempt,2);assert.notEqual(a.lease,b.lease);
    assert.throws(()=>s.heartbeat(w1,a.id,a.lease,a.attempt),e=>e.code==='conflict');
    assert.throws(()=>s.finish(w1,a.id,a.lease,a.attempt),e=>e.code==='conflict');
    assert.throws(()=>s.finish(w2,b.id,b.lease,b.attempt),e=>e.code==='conflict');const pair=addPair(s,w2,b);s.snapshot(w2,pair[0]);assert.throws(()=>s.snapshot(w2,{...pair[0],capturedAt:'2000-01-01T00:00:00.000Z'}),e=>e.code==='conflict');const finished=s.finish(w2,b.id,b.lease,b.attempt);assert.equal(finished.status,'simulated');
    s.finish(w2,b.id,b.lease,b.attempt);
    assert.equal(s.events(b.id).filter(e=>e.kind==='simulation_finished').length,1);
  }finally{s.close();}
});
test('SQLite state and worker identity survive reopen',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-store-'));const file=join(dir,'db.sqlite');let s;
  try{s=new Store(file);const auth=s.register('demo',ps),id=s.submit(task(),'persist').id;s.close();s=new Store(file);assert.equal(s.get(id).wikilinks[0],'[[DoD]]');assert.equal(s.worker(auth.token).id,auth.id);assert.equal(s.events(id).length,1);}finally{s?.close();await rm(dir,{recursive:true,force:true});}
});
test('HTML status snapshot escapes hostile values and is independent of the worker endpoint',()=>{
  const output=statusHtml({workerId:'</script><img src=x>',project:'demo'});
  assert.ok(!output.includes('</script><img'));assert.ok(output.includes('Exported snapshot'));assert.ok(!output.includes('setInterval(refresh,3000)'));
});
test('serial worker configuration is hashed; server retains machine and profile capacity enforcement',async()=>{
  const c=await configuration({});assert.equal(c.policy.maxParallel,1);assert.ok(c.profiles.every(profile=>profile.maxParallel===1));assert.equal(c.policy.configHash.length,64);
  const changed=await configuration({'poll-ms':'2000'});assert.notEqual(changed.policy.configHash,c.policy.configHash);
  await assert.rejects(configuration({parallel:'3'}),/parallel must be 1/);
  // Legacy or synthetic registrations still exercise the server's general capacity contract.
  const s=new Store(':memory:');try{
    const w=s.worker(s.register('demo',c.profiles,{...c.policy,maxParallel:3}).token);
    s.submit(task({provider:'claude'}),'a');s.submit(task({provider:'claude'}),'b');s.submit(task({provider:'codex'}),'c');
    const a=s.claim(w,'r1'),b=s.claim(w,'r2');assert.notEqual(a.profile,b.profile);assert.equal(s.claim(w,'r1').id,a.id);assert.equal(s.claim(w,'r3'),null);assert.equal(s.current(w).length,2);
    const serial=s.worker(s.register('demo',c.profiles,c.policy).token);s.submit(task({provider:'codex'}),'d');
    assert.ok(s.claim(serial,'s1'));assert.equal(s.claim(serial,'s2'),null);assert.equal(s.current(serial).length,1);
  }finally{s.close();}
});
test('journal recovers an incomplete attempt and preserves unknown timing; late telemetry cannot finish it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-recovery-'));let now=1000;const s=new Store(':memory:',100,()=>now);let j;
  try{
    const w=s.worker(s.register('demo',ps).token);s.submit(task(),'crash');const t=s.claim(w);
    const checkout=join(dir,'checkout');await mkdir(join(checkout,'.git'),{recursive:true});j=new SnapshotJournal(dir,'default','prompt',checkout);await j.init();const status={lastContact:null,heartbeatErrors:0};
    const before=await j.persist(j.capture(t,w.id,w.profiles[0],status,'before'));assert.equal(JSON.parse(await readFile(join(checkout,before.provenance.artifactPath),'utf8')).id,before.id);j.close();
    j=new SnapshotJournal(dir,'default','prompt');await j.init();await j.recover(w.id,w.profiles,status);
    now=1200;const other=s.worker(s.register('demo',ps).token);s.claim(other);
    await j.flush(snapshot=>Promise.resolve(s.snapshot(w,snapshot)));
    const after=await j.read(t.lease,'after');assert.equal(after.execution.outcome,'interrupted');assert.equal(after.execution.durationMs,null);assert.equal(after.health.recoveredAfterCrash,true);
    assert.throws(()=>s.finish(w,t.id,t.lease,t.attempt),e=>e.code==='conflict');assert.equal(s.snapshots().length,2);
  }finally{j?.close();s.close();await rm(dir,{recursive:true,force:true});}
});
test('iteration importer reads committed ready notes, deduplicates, and flags changed specifications',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-import-'));let app;const admin='a'.repeat(48),enroll='e'.repeat(48),exec=promisify(execFile);
  const git=(...args)=>exec('git',['-C',dir,...args]);
  try{
    await git('init','-b','iteration/2026-W42');await git('config','user.name','Factory Test');await git('config','user.email','factory-test@example.invalid');
    await mkdir(join(dir,'docs/features'),{recursive:true});const file=join(dir,'docs/features/order.md');await writeFile(file,await readFile('examples/feature.md'));
    await writeFile(join(dir,'docs/features/planned.md'),'---\ntitle: Later\nfactory_status: planning\n---\nNot ready');await git('add','.');await git('commit','-m','Plan iteration');
    app=await startServer({db:join(dir,'store.sqlite'),host:'127.0.0.1',port:0,adminToken:admin,enrollmentToken:enroll,project:'demo'});
    const o={repo:dir,branch:'iteration/2026-W42',project:'demo',iteration:'2026-W42','iteration-pr':'https://git.example/project/pull/10',url:'http://127.0.0.1:'+app.server.address().port};
    const preview=await importIteration({...o,'dry-run':'true'},admin);assert.equal(preview.ready.length,1);assert.equal(app.store.list().length,0);
    const first=await importIteration(o,admin);assert.equal(first.results[0].status,'created');const again=await importIteration(o,admin);assert.equal(again.results[0].status,'unchanged');assert.equal(app.store.list().length,1);
    await writeFile(file,(await readFile(file,'utf8'))+'\nNew specification.\n');await git('add','docs');await git('commit','-m','Revise specification');
    const revised=await importIteration(o,admin);assert.equal(revised.requiresDecision,true);assert.equal(app.store.list().length,1);
  }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
const waitFor=async(fn,timeout=10000)=>{const end=Date.now()+timeout;while(Date.now()<end){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,60));}throw Error('Timed out');};
function cli(path,args,env,stdin){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path,...args],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.once('error',reject);p.once('close',code=>resolve({code,stdout,stderr}));p.stdin.end(stdin??'');});}
test('HTTP intake, stdin CLI and three real worker processes complete a mock fleet', {timeout:process.platform==='win32'?45000:20000}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-api-'));const children=[];let app;
  const admin='a'.repeat(48),enroll='e'.repeat(48);
  try{
    app=await startServer({db:join(dir,'db.sqlite'),host:'127.0.0.1',port:0,adminToken:admin,enrollmentToken:enroll,project:'demo'});
    const url='http://127.0.0.1:'+app.server.address().port;
    const page=await (await fetch(url)).text();assert.match(page,/<div id="app"/);const modulePath=page.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)[1];const asset=await fetch(new URL(modulePath,url));assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);assert.equal(await(await fetch(url+'/intake')).text(),page);
    assert.equal((await fetch(url+'/v1/tasks')).status,401);
    assert.equal((await fetch(url+'/v1/tasks',{method:'POST',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json','Idempotency-Key':'null'},body:'null'})).status,400);
    const oc='src/orchestrator/dist/orchestrator/cli.js',wc='src/worker/dist/worker/cli.js';
    const env={WERK_ADMIN_TOKEN:admin,WERK_URL:url};
    const made=await cli(oc,['task','create','--file','-','--key','stdin-task'],env,JSON.stringify(task()));
    assert.equal(made.code,0,made.stderr);const id=JSON.parse(made.stdout).id;
    const replay=await cli(oc,['task','create','--file','-','--key','stdin-task'],env,JSON.stringify(task()));assert.equal(JSON.parse(replay.stdout).id,id);
    const bad=await cli(oc,['task','create'],env);assert.equal(bad.code,2);assert.equal(bad.stdout,'');
    for(let n=0;n<8;n++)app.store.submit(task({title:'Task '+n,provider:n%2?'claude':'codex'}),'t'+n);
    for(let n=0;n<3;n++){
      const p=spawn(process.execPath,[wc,'run','--url',url,'--state-dir',join(dir,'worker'+n),'--status-port','0','--poll-ms','100','--mock-ms','180'],{env:{...process.env,WERK_ENROLLMENT_TOKEN:enroll},stdio:['ignore','ignore','pipe']});
      let log='';p.stderr.on('data',x=>log+=x);children.push({p,getLog:()=>log});
    }
    // Cold Windows workers are still publishing successful snapshots at the old 10s boundary.
    try { await waitFor(()=>app.store.list().every(t=>t.status==='simulated'),process.platform==='win32'?30000:10000); }
    catch (cause) {
      const progress={tasks:app.store.list().map(task=>({status:task.status,attempt:task.attempt,assigned:Boolean(task.workerId)})),workers:app.store.workers().length,snapshots:app.store.snapshots().length,children:children.map(({p})=>({exitCode:p.exitCode,signal:p.signalCode}))};
      throw new Error('Mock fleet did not complete: '+JSON.stringify(progress),{cause});
    }
    const workers=app.store.workers();assert.equal(workers.length,3);assert.equal(app.store.snapshots().length,18);assert.ok(!JSON.stringify(workers).includes('token'));
    assert.ok(app.store.list().every(t=>workers.some(w=>w.id===t.workerId))); // Routing/capacity, not a timing-dependent fairness guarantee.
    assert.ok(app.store.list().every(t=>t.attempt===1));
    const line=children[0].getLog().split('\n').find(l=>l.includes('status_listening'));const port=JSON.parse(line).address.port;
    const statusUrl='http://127.0.0.1:'+port;
    assert.match(await (await fetch(statusUrl)).text(), /id="app"/);
    const snapshot=await cli(wc,['status','--url',statusUrl,'--format','html'],{});assert.equal(snapshot.code,0,snapshot.stderr);const exported=JSON.parse(snapshot.stdout.match(/<script id="werk-status-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);const current=await(await fetch(statusUrl+'/status')).json();assert.equal(exported.workerId,current.workerId);assert.equal(exported.mode,current.mode);assert.ok(Array.isArray(exported.activeTasks));
    const list=await cli(oc,['task','list'],env);assert.equal(JSON.parse(list.stdout).tasks.length,9);
    const events=await cli(oc,['task','events','--id',id],env);assert.equal(JSON.parse(events.stdout).events.at(-1).kind,'simulation_finished');
    const identity=JSON.parse(await readFile(join(dir,'worker0/identity.json'),'utf8'));
    assert.equal((await fetch(url+'/v1/tasks',{headers:{Authorization:'Bearer '+identity.token}})).status,401);
  } finally {
    await Promise.all(children.map(async({p})=>{if(p.exitCode!==null)return;const exited=once(p,'exit');p.kill('SIGTERM');const fallback=setTimeout(()=>p.kill('SIGKILL'),5000);fallback.unref();try{await exited;}finally{clearTimeout(fallback);}}));
    await app?.close();await rm(dir,{recursive:true,force:true});
  }
});
