import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { startFactoryServer } from '../../../src/factory/dist/factory/server.js';
import { FactoryApplication } from '../../../src/factory/dist/factory/application/service.js';
import { SqliteFactoryRegistry } from '../../../src/factory/dist/factory/infrastructure/registry.js';
import { SnapshotJournal } from '../../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../../src/worker/dist/worker/status/server.js';
import { monitoringThresholds } from '../../../src/orchestrator/dist/shared/monitoring.js';
const admin='monitoring-admin-'.repeat(3), enrollment='monitoring-enroll-'.repeat(3), viewer='monitoring-viewer-'.repeat(3);
const access={schemaVersion:1,principals:[{id:'monitor',role:'viewer',token:viewer}]};
const profile={id:'private-profile',provider:'claude',mode:'mock',maxParallel:1};
const url=app=>'http://127.0.0.1:'+app.server.address().port;
const read=(origin,path,token=viewer)=>fetch(origin+path,{headers:token?{authorization:'Bearer '+token}:{}});
async function line(t){const app=await startServer({db:':memory:',host:'127.0.0.1',port:0,adminToken:admin,enrollmentToken:enrollment,project:'private-project',access});t.after(()=>app.close());return app;}
test('metrics expose zero gauges with viewer authorization, no labels, and no query credential leakage',async t=>{
 const app=await line(t);
 for(const token of ['',enrollment,'wrong-token'])for(const path of ['/v1/monitoring','/metrics'])assert.equal((await read(url(app),path,token)).status,401);
 const response=await read(url(app),'/v1/monitoring'),report=await response.json();assert.equal(response.status,200);assert.equal(report.schemaVersion,1);assert.equal(report.service,'orchestrator');assert.deepEqual(report.alerts,[]);assert.ok(Object.values(report.metrics).every(v=>v===0));
 const prom=await read(url(app),'/metrics');assert.match(prom.headers.get('content-type'),/text\/plain/);const text=await prom.text();assert.match(text,/# TYPE werk_tasks_queued gauge\nwerk_tasks_queued 0/);assert.ok(!text.includes('{'));
 for(const secret of [admin,enrollment,viewer,'private-project']){assert.ok(!JSON.stringify(report).includes(secret));assert.ok(!text.includes(secret));}
 assert.equal((await read(url(app),'/metrics?token=hidden')).status,400);assert.equal((await read(url(app),'/v1/monitoring?project=other')).status,400);
});
test('queue, worker and lease alerts use scoped durable state and clear after expiry',async t=>{
 const app=await line(t);let now=Date.now();app.store.clock=()=>now;
 app.store.register('foreign-project',[profile]);app.store.submit({project:'foreign-project',title:'foreign title',criteria:['private criteria']},'foreign-task');
 const task=app.store.submit({project:'private-project',title:'private title',criteria:['private criteria']},'own-task');now+=301000;
 let report=await(await read(url(app),'/v1/monitoring')).json();assert.equal(report.metrics.werk_tasks_queued,1);assert.equal(report.metrics.werk_queue_oldest_age_seconds,301);assert.equal(report.metrics.werk_workers_online,0);assert.deepEqual(report.alerts.map(a=>a.code),['queue_stalled','no_online_workers']);
 const registration=app.store.register('private-project',[profile]),worker=app.store.worker(registration.token);app.store.claim(worker,'claim');now+=61000;
 report=await(await read(url(app),'/v1/monitoring')).json();assert.equal(report.metrics.werk_leases_overdue,1);assert.equal(report.metrics.werk_workers_offline,1);
 app.store.reapExpired();report=await(await read(url(app),'/v1/monitoring')).json();assert.equal(report.metrics.werk_lease_expirations_window,1);assert.equal(report.metrics.werk_leases_overdue,0);
 now+=901000;report=await(await read(url(app),'/v1/monitoring')).json();assert.equal(report.metrics.werk_lease_expirations_window,0);
 for(const secret of [task.id,worker.id,registration.token,'private title','private criteria','foreign-project'])assert.ok(!JSON.stringify(report).includes(secret));assert.ok(report.alerts.length<=6);assert.ok(Buffer.byteLength(JSON.stringify(report))<8192);
});
async function journalFixture(t){const directory=await mkdtemp(join(tmpdir(),'werk-monitoring-')),journals=[];t.after(async()=>{for(const j of journals)j.close();await rm(directory,{recursive:true,force:true});});return async()=>{const j=new SnapshotJournal(directory,'a'.repeat(64),'b'.repeat(64));journals.push(j);await j.init();return j;};}
test('failed terminal evidence contributes to window gauge without leaking provider errors',async t=>{
 const app=await line(t),open=await journalFixture(t),journal=await open(),worker=app.store.worker(app.store.register('private-project',[profile],{maxParallel:1,order:'priority',maxAttempts:3,configHash:'a'.repeat(64)}).token);
 app.store.submit({project:'private-project',title:'task',criteria:['done']},'failed-task');const task=app.store.claim(worker,'failure');const before=journal.capture(task,worker.id,profile,{lastContact:null,heartbeatErrors:0},'before');
 app.store.snapshot(worker,before);app.store.snapshot(worker,journal.capture(task,worker.id,profile,{lastContact:null,heartbeatErrors:0},'after',before,'failed','SECRET_PROVIDER_ERROR'));
 const report=await(await read(url(app),'/v1/monitoring')).json();assert.equal(report.metrics.werk_attempt_failures_window,1);assert.ok(!JSON.stringify(report).includes('SECRET_PROVIDER_ERROR'));
});
test('Factory metrics distinguish unavailable and stale observations without invented zero totals',async t=>{
 const factory=await startFactoryServer({db:':memory:',host:'127.0.0.1',port:0,adminToken:admin,access,credentials:{}});t.after(()=>factory.close());
 for(const path of ['/metrics','/v1/monitoring']){assert.equal((await read(url(factory),path,'')).status,401);assert.equal((await read(url(factory),path)).status,200);}
 const empty=await(await read(url(factory),'/v1/monitoring')).json();assert.equal(empty.metrics.werk_lines_registered,0);assert.equal(empty.metrics.werk_tasks_queued,undefined);
 const registry=new SqliteFactoryRegistry(':memory:');t.after(()=>registry.close());let healthy=false;
 const app=new FactoryApplication(registry,{async read(line){return{line,status:healthy?'available':'unavailable',checkedAt:new Date().toISOString(),error:healthy?null:'SECRET_CONNECTION_ERROR',overview:healthy?{observedAt:new Date(Date.now()-130000).toISOString(),tasks:{total:0,queued:0,running:0,simulated:0,blocked:0},workers:{total:0,online:0,offline:0,slotsTotal:0,slotsBusy:0,slotsAvailable:0},snapshots:{total:0,before:0,after:0}}:null};}},new Set(['WERK_LINE_TEST_TOKEN']));
 app.createFactory({id:'private-factory',name:'Private'});app.createLine({id:'private-line',name:'Private',factoryId:'private-factory',orchestratorUrl:'http://127.0.0.1:9999',webviewUrl:'http://127.0.0.1:9999',tokenEnv:'WERK_LINE_TEST_TOKEN'});
 const missing=await app.monitoring();assert.equal(missing.metrics.werk_lines_unavailable,1);assert.equal(missing.metrics.werk_observation_partial,1);assert.equal(missing.metrics.werk_tasks_queued,undefined);assert.deepEqual(missing.alerts.map(a=>a.code),['lines_unavailable','partial_observation']);
 healthy=true;const stale=await app.monitoring();assert.equal(stale.metrics.werk_lines_stale,1);assert.deepEqual(stale.alerts.map(a=>a.code),['line_observation_stale']);
 for(const secret of ['private-factory','private-line','Private','SECRET_CONNECTION_ERROR','WERK_LINE_TEST_TOKEN'])assert.ok(!JSON.stringify([missing,stale]).includes(secret));
});
test('durable outbox age survives restart, failed delivery retains backlog, and acknowledgement clears alerts',async t=>{
 const open=await journalFixture(t);let journal=await open();assert.deepEqual(journal.metrics(),{pending:0,oldestAgeSeconds:0});
 const snapshot=journal.capture({id:'secret-task',project:'secret-project',attempt:1,lease:'secret-lease',profile:profile.id},'secret-worker',profile,{lastContact:null,heartbeatErrors:0},'before');snapshot.capturedAt=new Date(Date.now()-130000).toISOString();await journal.persist(snapshot);
 journal=await open();assert.equal(journal.metrics().pending,1);assert.ok(journal.metrics().oldestAgeSeconds>=130);await assert.rejects(journal.flush(async()=>{throw Error('delivery failed');}));assert.equal(journal.metrics().pending,1);
 let state='disconnected';const server=await statusServer(()=>({workerId:'secret-worker',project:'secret-project',mode:'mock',state,taskId:null,attempt:null,profile:null,completedSimulations:0,lastContact:null,lastError:'secret-error',updatedAt:new Date().toISOString(),profiles:[profile],heartbeatErrors:1,maxParallel:1,activeTasks:[],configurationHash:'secret-config',lastSnapshot:null,outbox:journal.metrics()}),'127.0.0.1',0);t.after(()=>new Promise(resolve=>server.close(resolve)));const origin='http://127.0.0.1:'+server.address().port;
 let report=await(await fetch(origin+'/monitoring')).json();assert.deepEqual(report.alerts.map(a=>a.code),['worker_disconnected','outbox_backlog']);assert.ok(!JSON.stringify(report).includes('secret'));assert.equal((await fetch(origin+'/healthz')).status,503);
 await journal.flush(async()=>{});state='idle';report=await(await fetch(origin+'/monitoring')).json();assert.equal(report.metrics.werk_outbox_pending,0);assert.equal(report.metrics.werk_outbox_oldest_age_seconds,0);assert.deepEqual(report.alerts,[]);assert.equal((await fetch(origin+'/healthz')).status,200);assert.match(await(await fetch(origin+'/metrics')).text(),/werk_outbox_pending 0/);
});
test('threshold configuration accepts bounded integers and does not echo malformed values',()=>{
 assert.equal(monitoringThresholds({WERK_ALERT_QUEUE_AGE_SECONDS:'42'}).queueAgeSeconds,42);
 for(const value of ['0','-1','1.5','SECRET_CONFIG','999999999','01'])assert.throws(()=>monitoringThresholds({WERK_ALERT_QUEUE_AGE_SECONDS:value}),error=>error.code==='invalid_input'&&!error.message.includes('SECRET_CONFIG'));
});

test('headless monitoring commands use viewer credentials and return the same bounded contract', async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const execute = promisify(execFile);
  const orchestrator = await line(t), factory = await startFactoryServer({ db: ':memory:', host: '127.0.0.1', port: 0, adminToken: admin, access, credentials: {} }); t.after(() => factory.close());
  for (const [service, app, credential] of [['orchestrator', orchestrator, 'WERK_ADMIN_TOKEN'], ['factory', factory, 'WERK_FACTORY_ADMIN_TOKEN']]) {
    const { stdout } = await execute(process.execPath, ['src/' + service + '/dist/' + service + '/cli.js', 'monitoring', '--url', url(app)], { env: { ...process.env, [credential]: viewer }, timeout: 5000 });
    const report = JSON.parse(stdout); assert.equal(report.service, service); assert.equal(report.schemaVersion, 1); assert.ok(!stdout.includes(viewer));
  }
});
