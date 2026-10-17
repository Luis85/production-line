import { testErrorCode, testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SqliteFactoryRegistry } from '../../src/factory/dist/factory/infrastructure/registry.js';
import { FactoryApplication } from '../../src/factory/dist/factory/application/service.js';
import { HttpLineReader } from '../../src/factory/dist/factory/infrastructure/poller.js';

const reference='WERK_LINE_ALPHA_TOKEN';
const line=(id,factoryId='root')=>({id,name:id,factoryId,orchestratorUrl:`http://127.0.0.1:${id==='alpha'?3010:3020}`,webviewUrl:'http://127.0.0.1:3000/',tokenEnv:reference});
/** @returns {import('../../src/shared/factory.ts').OrchestratorOverview} */
const overview=()=>({schemaVersion:1,observedAt:new Date().toISOString(),mode:'mock',project:'demo',tasks:{total:1,queued:1,running:0,simulated:0,blocked:0},workers:{total:0,online:0,offline:0,slotsTotal:0,slotsBusy:0,slotsAvailable:0},snapshots:{total:0,before:0,after:0},cost:{amountUsd:null,reason:'unavailable_mock'}});
const noReads={read:()=>{throw Error('CRUD must not query an orchestrator');}};

test('Existing registrations remain editable after deployment credentials become unavailable',()=>{
  const registry=new SqliteFactoryRegistry(':memory:');
  try{
    const configured=new FactoryApplication(registry,noReads,new Set([reference]));
    configured.createFactory({id:'root',name:'Root'});configured.createFactory({id:'child',name:'Child',parentId:'root'});
    configured.createLine(line('alpha'));
    const restarted=new FactoryApplication(registry,noReads,new Set());
    const changed=restarted.updateLine('alpha',{name:'Renamed',factoryId:'child',webviewUrl:'http://127.0.0.1:8080/'});
    assert.equal(changed.name,'Renamed');assert.equal(changed.factoryId,'child');assert.equal(changed.tokenEnv,reference);
    assert.throws(()=>restarted.updateLine('alpha',{tokenEnv:'WERK_LINE_UNCONFIGURED_TOKEN'}),error=>testErrorCode(error)==='invalid_input');
    assert.throws(()=>restarted.createLine(line('beta')),error=>testErrorCode(error)==='invalid_input');
    assert.equal(restarted.line('alpha').name,'Renamed');
  }finally{registry.close();}
});

test('A rejected line adapter cannot erase healthy portfolio observations or reflect its diagnostic secrets',async()=>{
  const registry=new SqliteFactoryRegistry(':memory:'),secret='sensitive-adapter-diagnostic';
  /** @type {import('../../src/factory/application/ports.ts').LineReader} */
  const reader={read:async registration=>{
    if(registration.id==='beta')throw Error(secret);
    return {line:registration,status:'available',checkedAt:new Date().toISOString(),error:null,overview:overview()};
  }};
  const app=new FactoryApplication(registry,reader,new Set([reference]));
  try{
    app.createFactory({id:'root',name:'Root'});app.createFactory({id:'child',name:'Child',parentId:'root'});
    app.createLine(line('alpha'));app.createLine(line('beta','child'));
    const portfolio=await app.overview('root');
    assert.equal(portfolio.totals.lines,2);assert.equal(portfolio.totals.availableLines,1);assert.equal(portfolio.totals.partial,true);
    assert.equal(portfolio.totals.tasks.total,1);assert.equal(portfolio.lines.find(item=>item.line.id==='beta').overview,null);
    assert.ok(!JSON.stringify(portfolio).includes(secret));
    const unavailableScope=await app.overview('child');assert.equal(unavailableScope.totals.tasks,null);assert.equal(unavailableScope.totals.workers,null);
  }finally{registry.close();}
});

test('Closing a line reader cancels an active body read and every queued poll without starting queued requests', {timeout:5000},async()=>{
  let received=0,resolveFirst;
  const firstRequest=new Promise(resolve=>resolveFirst=resolve);
  const server=createServer((_request,response)=>{
    received++;response.writeHead(200,{'Content-Type':'application/json'});response.write('{');resolveFirst();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));
  const credentials={WERK_LINE_A_TOKEN:'secret-a',WERK_LINE_B_TOKEN:'secret-b',WERK_LINE_C_TOKEN:'secret-c'};
  const reader=new HttpLineReader(credentials,10000,1);
  try{
    const url='http://127.0.0.1:'+testListeningAddress(server).port;
    const polls=Object.keys(credentials).map((tokenEnv,index)=>reader.read({...line('line'+index),orchestratorUrl:url,tokenEnv}));
    await firstRequest;
    reader.close();
    const observations=await Promise.all(polls);
    assert.equal(received,1);assert.ok(observations.every(item=>item.status==='unavailable'&&item.overview===null));
    const afterClose=await reader.read({...line('later'),orchestratorUrl:url,tokenEnv:'WERK_LINE_A_TOKEN'});
    assert.equal(afterClose.status,'unavailable');assert.equal(received,1);
  }finally{reader.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});
