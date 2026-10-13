import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { startServer } from '../../src/orchestrator/dist/orchestrator/server.js';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';
import { FactoryIntake } from '../../src/factory/dist/factory/application/intake.js';
import { SqliteIntakeStore } from '../../src/factory/dist/factory/infrastructure/intake-store.js';
import { SqliteFactoryRegistry } from '../../src/factory/dist/factory/infrastructure/registry.js';
import { HttpLineDelivery } from '../../src/factory/dist/factory/infrastructure/delivery.js';
const input={project:'demo',title:'Keep the complete task',criteria:['Preserve intent'],wikilinks:['[[extra]]'],provider:'codex',priority:1};
const register=(store,provider='codex',parallel=1)=>store.register('demo',[{id:provider,provider,mode:'mock',maxParallel:parallel}],{maxParallel:parallel,order:'fifo',maxAttempts:3,configHash:'test'});
const address=server=>'http://127.0.0.1:'+server.address().port;
const factory={id:'root',name:'Factory',parentId:null};
function line(id='alpha',url='http://127.0.0.1:3000'){return{id,name:id,factoryId:'root',orchestratorUrl:url,webviewUrl:url,tokenEnv:'WERK_LINE_ALPHA_TOKEN'};}
function observe(record,capacity=1){return{line:record,status:'available',checkedAt:new Date().toISOString(),error:null,overview:{project:'demo',observedAt:new Date().toISOString(),tasks:{queued:0},workers:{slotsAvailable:capacity},capabilities:{context:'unbound',profiles:[{id:'codex',provider:'codex',mode:'mock'}],intake:['structured_task','requirement_ref'],eligibleCapacity:[{provider:'codex',mode:'mock',slotsAvailable:capacity}]}}};}
function fixture(t,reader,delivery){const registry=new SqliteFactoryRegistry(':memory:'),repository=new SqliteIntakeStore(':memory:');registry.createFactory(factory);registry.createLine(line());registry.createLine(line('beta','http://127.0.0.1:3001'));const intake=new FactoryIntake(registry,reader,repository,delivery);t.after(async()=>{await intake.close();repository.close();registry.close();});return{registry,repository,intake};}
test('automatic routing prefers matching free workers; manual destinations wait and persist',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'werk-routing-'));t.after(()=>rm(dir,{recursive:true,force:true}));let store=new Store(join(dir,'line.sqlite'));const a=register(store,'codex',2),b=register(store,'codex',2),claude=register(store,'claude',2);
 store.submit(input,'a');assert.ok(store.claim(store.worker(a.token),'first'));store.submit({...input,title:'Second'},'b');assert.equal(store.claim(store.worker(a.token),'busy'),null);assert.ok(store.claim(store.worker(b.token),'free'));
 store.configureRouting('demo',{mode:'manual',workerId:a.id,order:'priority'});const task=store.submit({...input,title:'Manual'},'manual');assert.equal(store.claim(store.worker(b.token),'wrong-destination'),null);assert.equal(store.claim(store.worker(claude.token),'wrong-provider'),null);assert.equal(store.claim(store.worker(a.token),'right-destination').id,task.id);
 assert.throws(()=>store.configureRouting('demo',{mode:['manual'],workerId:null,order:'fifo'}),/mode/);store.close();store=new Store(join(dir,'line.sqlite'));t.after(()=>store.close());assert.equal(store.routing('demo').workerId,a.id);
});
test('provider-specific capacity excludes offline workers and clamps reserved slots',()=>{
 let now=100000;const store=new Store(':memory:',1000,()=>now);try{register(store,'codex',1);now+=1100;const worker=register(store,'claude',2);const capacity=store.registeredCapabilities('demo').eligibleCapacity;assert.equal(capacity.find(row=>row.provider==='codex'),undefined);assert.equal(capacity.find(row=>row.provider==='claude').slotsAvailable,2);
 for(let i=0;i<4;i++){store.submit({...input,provider:'claude',title:'Queued '+i},'t'+i);store.claim(store.worker(worker.token),'claim'+i,2);}const overview=store.overview('demo');assert.equal(overview.tasks.running,4);assert.ok(overview.workers.slotsBusy<=overview.workers.slotsTotal);
 }finally{store.close();}
});
for(const mutation of ['pause','destination','move'])test('in-flight Factory observation respects a newer '+mutation+' decision',async t=>{
 let release;const sent=[];const {intake,repository,registry}=fixture(t,{read:record=>new Promise(resolve=>{release=()=>resolve(observe(record));})},{async send(record){sent.push(record.id);return'remote';},close(){}});
 const task=intake.create({factoryId:'root',lineId:'alpha',task:input},'key');const pending=intake.tick();
 if(mutation==='pause')intake.configure('root',{mode:'auto',lineId:null,paused:true});else if(mutation==='destination')intake.route(task.id,{lineId:'beta'});else{registry.createFactory({id:'elsewhere',name:'Elsewhere',parentId:null});registry.updateLine('alpha',{...line(),factoryId:'elsewhere'});}
 release();await pending;assert.deepEqual(sent,[]);assert.equal(repository.get(task.id).destination,null);
});
test('Factory intake holds unrouteable work and preserves idempotent input',async t=>{
 const {intake,repository}=fixture(t,{read:async record=>observe(record,0)},{async send(){throw Error('Must not send');},close(){}});
 const first=intake.create({factoryId:'root',task:input},'same');assert.equal(intake.create({factoryId:'root',task:input},'same').id,first.id);assert.throws(()=>intake.create({factoryId:'root',task:{...input,title:'Different'}},'same'),/Idempotency/);await intake.tick();assert.equal(repository.get(first.id).status,'queued');assert.match(repository.get(first.id).reason,/capacity/);assert.throws(()=>intake.assertRemoval('factory','root'),/intake history/);
});
test('lost delivery acknowledgement retries the pinned destination without duplicate line tasks',async t=>{
 const server=await startServer({db:':memory:',host:'127.0.0.1',port:0,project:'demo',adminToken:'a'.repeat(32),enrollmentToken:'e'.repeat(32)});t.after(()=>server.close());register(server.store);
 const sender=new HttpLineDelivery({WERK_LINE_ALPHA_TOKEN:'a'.repeat(32)});let calls=0;
 const {intake,registry,repository}=fixture(t,{read:async record=>observe(record)},{async send(record,item){const id=await sender.send(record,item);if(++calls===1)throw Error('Lost acknowledgement');return id;},close:()=>sender.close()});
 registry.updateLine('alpha',line('alpha',address(server.server)));const task=intake.create({factoryId:'root',lineId:'alpha',task:{...input,requirementRef:'[[requirements/example]]'}},'retry');await intake.tick();assert.equal(repository.get(task.id).status,'delivering');assert.throws(()=>intake.route(task.id,{lineId:'beta'}),/fixed/);await intake.tick();assert.equal(repository.get(task.id).status,'delivered');assert.equal(server.store.list().length,1);assert.deepEqual(server.store.list()[0].criteria,input.criteria);assert.ok(server.store.list()[0].wikilinks.includes('[[extra]]'));assert.equal(server.store.list()[0].title,input.title);
});
test('Factory HTTP protects intake ownership, routing writes and worker interaction credentials',async t=>{
 const factoryServer=await startFactoryServer({db:':memory:',host:'127.0.0.1',port:0,adminToken:'f'.repeat(32)});t.after(()=>factoryServer.close());factoryServer.application.createFactory(factory);
 const call=(path,method='GET',body,token='f'.repeat(32))=>fetch(address(factoryServer.server)+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'http-task'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await call('/v1/intake','POST',{factoryId:'root',task:input})).status,201);assert.equal((await call('/v1/factories/root','DELETE')).status,409);assert.equal((await call('/v1/factories/root/routing','PUT',{mode:'manual',lineId:null,paused:false})).status,200);assert.equal((await call('/v1/intake','GET',undefined,'wrong')).status,401);assert.equal((await(await call('/v1/intake')).json()).total,1);
});
test('orchestrator interaction uses a registered worker and keeps its token out of responses',async t=>{
 const lineServer=await startServer({db:':memory:',host:'127.0.0.1',port:0,project:'demo',adminToken:'a'.repeat(32),enrollmentToken:'e'.repeat(32)});t.after(()=>lineServer.close());const worker=register(lineServer.store);let receivedToken;
 const fake=createServer((req,res)=>{receivedToken=req.headers.authorization;res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/status'?{workerId:worker.id}:{sessions:{selected:'default',records:[{id:'default',title:'Fixture session'}]},chat:{available:true,busy:false,messages:[]}}));});await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>fake.close(resolve)));
 const response=await fetch(address(lineServer.server)+'/v1/interaction',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(32),'content-type':'application/json'},body:JSON.stringify({workerUrl:address(fake),workerToken:'worker-secret',action:'read'})});assert.equal(response.status,200);const body=await response.text();assert.doesNotMatch(body,/worker-secret/);assert.equal(receivedToken,'Bearer worker-secret');assert.match(body,/Fixture session/);
});
