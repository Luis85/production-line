import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteFactoryRegistry } from '../../src/factory/dist/factory/infrastructure/registry.js';
import { FactoryApplication } from '../../src/factory/dist/factory/application/service.js';
import { HttpLineReader } from '../../src/factory/dist/factory/infrastructure/poller.js';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';
import { startServer } from '../../src/orchestrator/dist/orchestrator/server.js';
const admin='factory-admin-'.repeat(3),lineToken='orchestrator-admin-'.repeat(3),ref='WERK_LINE_ALPHA_TOKEN';
const line=(extra={})=>({id:'alpha',name:'Alpha',factoryId:'root',orchestratorUrl:'http://127.0.0.1:3000',webviewUrl:'http://127.0.0.1:3000/',tokenEnv:ref,...extra});
const summary=()=>({schemaVersion:1,observedAt:new Date().toISOString(),mode:'mock',project:'demo',tasks:{total:2,queued:1,running:0,simulated:1,blocked:0},workers:{total:1,online:1,offline:0,slotsTotal:1,slotsBusy:0,slotsAvailable:1},snapshots:{total:2,before:1,after:1},cost:{amountUsd:null,reason:'unavailable_mock'}});
const forbidden=()=>{throw Error('Registry CRUD must not poll or control an orchestrator');};
function appFor(registry,reader={read:forbidden}){return new FactoryApplication(registry,reader,new Set([ref]));}

test('Factory hierarchy CRUD prevents cycles, nonempty deletion and duplicate orchestrator origins',()=>{
  const registry=new SqliteFactoryRegistry(':memory:'),app=appFor(registry);
  try{
    app.createFactory({id:'root',name:'Root'});app.createFactory({id:'child',name:'Child',parentId:'root'});app.createFactory({id:'other',name:'Other'});
    assert.throws(()=>app.updateFactory('root',{parentId:'child'}),e=>e.code==='conflict');
    assert.throws(()=>app.deleteFactory('root'),e=>e.code==='conflict');
    app.createLine(line());
    assert.throws(()=>app.createLine(line({id:'duplicate',factoryId:'other',orchestratorUrl:'http://127.0.0.1:3000/'})),e=>e.code==='conflict');
    assert.throws(()=>app.createLine(line({id:'secret',orchestratorUrl:'http://127.0.0.1:3002',tokenEnv:'PATH'})),e=>e.code==='invalid_input');
    assert.throws(()=>app.createLine(line({id:'missing',orchestratorUrl:'http://127.0.0.1:3002',tokenEnv:'WERK_LINE_UNCONFIGURED_TOKEN'})),e=>e.code==='invalid_input');
    app.updateLine('alpha',{factoryId:'child'});assert.equal(app.line('alpha').factoryId,'child');
    app.updateFactory('child',{parentId:'other',name:'Moved'});app.deleteFactory('root');
    assert.throws(()=>app.deleteFactory('child'),e=>e.code==='conflict');
    app.deleteLine('alpha');app.deleteFactory('child');assert.equal(app.factories().factories.length,1);
  }finally{registry.close();}
});

test('Registry survives restart and contains only credential references',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'werk-factory-registry-'));let registry;
  try{const path=join(directory,'registry.sqlite');registry=new SqliteFactoryRegistry(path);const app=appFor(registry);app.createFactory({id:'root',name:'Root'});app.createLine(line());registry.close();registry=new SqliteFactoryRegistry(path);assert.equal(registry.line('alpha').tokenEnv,ref);assert.equal(registry.factory('root').name,'Root');assert.ok(!JSON.stringify(registry.lines()).includes(lineToken));}
  finally{registry?.close();await rm(directory,{recursive:true,force:true});}
});

test('Descendant rollup counts each registered line once and preserves missing data as partial/unknown',async()=>{
  const registry=new SqliteFactoryRegistry(':memory:'),seen=[];
  const reader={read:async item=>{seen.push(item.id);return {line:item,status:item.id==='lost'?'unavailable':'available',checkedAt:new Date().toISOString(),error:item.id==='lost'?'offline':null,overview:item.id==='lost'?null:summary()};}};
  const app=appFor(registry,reader);
  try{
    app.createFactory({id:'root',name:'Root'});app.createFactory({id:'child',name:'Child',parentId:'root'});app.createFactory({id:'other',name:'Other'});
    app.createLine(line());app.createLine(line({id:'lost',factoryId:'child',orchestratorUrl:'http://127.0.0.1:3001'}));app.createLine(line({id:'outside',factoryId:'other',orchestratorUrl:'http://127.0.0.1:3002'}));
    const view=await app.overview('root');assert.deepEqual(seen.sort(),['alpha','lost']);assert.equal(view.totals.lines,2);assert.equal(view.totals.partial,true);assert.equal(view.totals.tasks.total,2);assert.equal(view.totals.cost.amountUsd,null);
    const missing=await app.overview('child');assert.equal(missing.totals.tasks,null);assert.equal(missing.totals.workers,null);assert.equal(missing.totals.snapshots,null);
    await assert.rejects(app.overview('missing'),e=>e.code==='not_found');
  }finally{registry.close();}
});

test('HTTP summary polling bounds concurrency, deduplicates simultaneous reads and classifies timeout/unauthorized',async()=>{
  let active=0,peak=0,requests=0;
  const server=createServer((req,res)=>{requests++;active++;peak=Math.max(peak,active);setTimeout(()=>{active--;res.writeHead(req.headers.authorization==='Bearer bad'?401:200,{'Content-Type':'application/json'});res.end(JSON.stringify(summary()));},req.headers.authorization==='Bearer slow'?400:70);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port,credentials={};for(let n=0;n<5;n++)credentials['WERK_LINE_'+n+'_TOKEN']='good';credentials.WERK_LINE_BAD_TOKEN='bad';for(let n=0;n<3;n++)credentials['WERK_LINE_SLOW_'+n+'_TOKEN']='slow';
  const reader=new HttpLineReader(credentials,1000,2),short=new HttpLineReader(credentials,50,1),queued=new HttpLineReader(credentials,100,1);
  try{
    const lines=Array.from({length:5},(_,n)=>line({id:'line'+n,orchestratorUrl:url,tokenEnv:'WERK_LINE_'+n+'_TOKEN'}));
    const result=await Promise.all([...lines,lines[0]].map(item=>reader.read(item)));
    assert.ok(result.every(item=>item.status==='available'));assert.equal(requests,5);assert.equal(peak,2);
    assert.equal((await reader.read(line({orchestratorUrl:url,tokenEnv:'WERK_LINE_BAD_TOKEN'}))).status,'unauthorized');
    assert.equal((await reader.read(line({orchestratorUrl:url,tokenEnv:'WERK_LINE_MISSING_TOKEN'}))).status,'unconfigured');
    assert.equal((await short.read(lines[0])).status,'unavailable');
    const started=Date.now();const timedOut=await Promise.all(Array.from({length:3},(_,n)=>queued.read(line({orchestratorUrl:url,tokenEnv:'WERK_LINE_SLOW_'+n+'_TOKEN'}))));
    assert.ok(timedOut.every(item=>item.status==='unavailable'));assert.ok(Date.now()-started<250,'Queue wait must count toward each line timeout');
  }finally{reader.close();short.close();queued.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});

function cli(args,env,stdin){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['src/factory/dist/factory/cli.js',...args],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(stdin??'');});}

test('Authenticated Factory API and stdin CLI observe a real orchestrator without leaking credentials',async()=>{
  let orchestrator,factory;
  try{
    orchestrator=await startServer({db:':memory:',host:'127.0.0.1',port:0,project:'demo',adminToken:lineToken,enrollmentToken:'enrollment-'.repeat(4)});
    const orchUrl='http://127.0.0.1:'+orchestrator.server.address().port;
    orchestrator.store.submit({project:'demo',title:'Feature',criteria:['Accepted']},'feature');
    factory=await startFactoryServer({db:':memory:',host:'127.0.0.1',port:0,adminToken:admin,credentials:{[ref]:lineToken}});
    const url='http://127.0.0.1:'+factory.server.address().port;
    assert.equal((await fetch(url+'/v1/factories')).status,401);assert.equal((await fetch(orchUrl+'/v1/overview')).status,401);
    const env={WERK_FACTORY_URL:url,WERK_FACTORY_ADMIN_TOKEN:admin};
    const created=await cli(['factory','create','--file','-'],env,JSON.stringify({id:'root',name:'Root'}));assert.equal(created.code,0,created.stderr);
    const registered=await cli(['line','create','--file','-'],env,JSON.stringify(line({orchestratorUrl:orchUrl,webviewUrl:orchUrl})));assert.equal(registered.code,0,registered.stderr);
    const overview=await cli(['overview','--factory','root'],env);assert.equal(overview.code,0,overview.stderr);
    const result=JSON.parse(overview.stdout);assert.equal(result.totals.tasks.queued,1);assert.equal(result.lines[0].status,'available');assert.equal(result.totals.cost.amountUsd,null);assert.ok(!overview.stdout.includes(lineToken));
    const removed=await cli(['line','delete','--id','alpha'],env);assert.equal(removed.code,0,removed.stderr);assert.equal((await fetch(orchUrl+'/healthz')).status,200);
  }finally{await factory?.close();await orchestrator?.close();}
});
