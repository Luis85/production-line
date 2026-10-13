import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { taskInput, profiles, workerPolicy } from '../../src/orchestrator/dist/shared/contracts.js';
import { validateSnapshot } from '../../src/orchestrator/dist/shared/snapshots.js';
import { httpStatus } from '../../src/orchestrator/dist/shared/http/errors.js';
import { args, integer, input, request, readJson } from '../../src/orchestrator/dist/shared/io.js';
const invalid = fn => assert.throws(fn, error => error.code === 'invalid_input');
const task = () => ({project:'demo',title:'Feature',criteria:['Acceptance'],source:{featureId:'f-1',iterationId:'iteration-1',branch:'iteration/1',commit:'a'.repeat(40),path:'docs/features/feature.md',iterationPrUrl:'https://git.example/repo/pull/1',specSha256:'b'.repeat(64)}});
function snapshot() {
  return {
    schemaVersion:1,id:'pair-before',pairId:'pair',phase:'before',capturedAt:'2026-10-12T12:00:00.000Z',workerId:'worker',project:'demo',taskId:'task',attempt:1,profileId:'claude-1',provider:'claude',mode:'mock',configuration:{maxParallel:2},
    runtime:{processInstanceId:'process-1',node:'v24.0.0',platform:'linux',arch:'x64',workerVersion:'0.1.0',adapterVersion:'mock-1'},
    execution:{outcome:'pending',durationMs:null,timingSource:'monotonic',error:null},
    resources:{scope:'worker_process',rssBytes:100,heapUsedBytes:50,peakRssBytes:120,cpuUserMicros:3,cpuSystemMicros:2,cpuDeltaMicros:null,uptimeSeconds:1.5,hostLoad1m:0.2},
    health:{serverLastContactAt:null,heartbeatErrors:0,eventLoopDelayP95Ms:null,recoveredAfterCrash:false},
    usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,providerReportedCostUsd:null,estimatedCostUsd:null,subscriptionAllocatedCostUsd:null,subscriptionRemaining:null,source:'unavailable_mock',reason:'Provider did not run'},
    quality:{build:'not_run',tests:'not_run',testsTotal:null,testsPassed:null,coveragePercent:null,lintErrors:null,securityFindings:null,gate:'not_evaluated'},
    provenance:{repoBaseCommit:null,testedCommit:null,contextManifestHash:null,skillsVersion:null,iterationId:null,featureId:null,sourceCommit:null,policyVersion:'mock-only-1',configurationHash:'default',systemPromptHash:'prompt',artifactPath:'.factory/runs/task/attempt-1/pair/before.json'}
  };
}
test('task source rejects unknown, traversing, malformed and ambiguous values',()=>{
  assert.equal(taskInput(task()).provider,'auto');
  assert.equal(taskInput({...task(),source:{...task().source,commit:'c'.repeat(64)}}).source.commit.length,64);
  for(const source of [null,[],{...task().source,extra:true},{...task().source,commit:'a'.repeat(41)},{...task().source,path:'../secrets'},{...task().source,path:'/tmp/file'},{...task().source,path:'docs\\feature.md'},{...task().source,branch:'../main'},{...task().source,branch:'refs/heads/.bad'},{...task().source,iterationPrUrl:'https://'},{...task().source,iterationPrUrl:'https://user:password@git.example/pr/1'}])invalid(()=>taskInput({...task(),source}));
  for(const value of [null,[],42])invalid(()=>taskInput(value));
  for(const [field,value] of [['wikilinks',null],['provider',null],['provider',{toString:()=> 'auto'}],['priority',null],['priority',NaN]])invalid(()=>taskInput({...task(),[field]:value}));
});
test('worker policies and profiles reject malformed nested objects and ignored options',()=>{
  assert.equal(workerPolicy().maxAttempts,3);
  for(const value of [null,[],{maxParallel:1,order:'priority',configHash:'x',typo:true},{maxParallel:1,order:'priority',configHash:'x',maxAttempts:null},{maxParallel:Infinity,order:'priority',configHash:'x'}])invalid(()=>workerPolicy(value));
  const profile={id:'p',provider:'claude',mode:'mock'};
  assert.equal(profiles([profile])[0].maxParallel,1);
  for(const value of [[null],[[]],[{...profile,maxParallel:null}],[{...profile,maxParallel:1.5}],[{...profile,password:'secret'}],[profile,profile]])invalid(()=>profiles(value));
});
test('snapshot contract validates every required group and rejects corrupt measurements',()=>{
  assert.equal(validateSnapshot(snapshot()).id,'pair-before');
  for(const field of ['configuration','runtime','execution','resources','health','usage','quality','provenance']){
    for(const value of (field==='configuration'?[null,[]]:[null,[],{}]))invalid(()=>validateSnapshot({...snapshot(),[field]:value}));
  }
  for(const number of [NaN,Infinity,-1,'100',null,undefined,0.5]){const s=snapshot();s.resources.rssBytes=number;invalid(()=>validateSnapshot(s));}
  for(const modify of [s=>s.unknown=true,s=>s.runtime.secret='token',s=>s.resources.scope='task',s=>s.execution.timingSource='wall-clock',s=>s.provider='cursor',s=>s.taskId='../escape',s=>s.workerId=' worker ',s=>s.capturedAt='2026-02-30T12:00:00.000Z',s=>s.attempt=0,s=>s.provenance.artifactPath='../before.json',s=>s.health.recoveredAfterCrash='false',s=>s.health.heartbeatErrors=0.5]){const s=snapshot();modify(s);invalid(()=>validateSnapshot(s));}
});
test('mock snapshots cannot invent cost, usage or quality and preserve interrupted timing',()=>{
  for(const [group,field,value] of [['usage','inputTokens',0],['usage','estimatedCostUsd',0],['usage','subscriptionRemaining',100],['quality','testsTotal',0],['quality','coveragePercent',100],['quality','build','passed']]){const s=snapshot();s[group][field]=value;invalid(()=>validateSnapshot(s));}
  const s=snapshot();s.phase='after';s.id='pair-after';s.provenance.artifactPath=s.provenance.artifactPath.replace('before.json','after.json');s.execution={outcome:'interrupted',durationMs:null,timingSource:'unavailable_after_restart',error:'Process restarted'};s.health.recoveredAfterCrash=true;
  assert.equal(validateSnapshot(s).execution.durationMs,null);
  s.execution.durationMs=0;invalid(()=>validateSnapshot(s));
});
test('snapshot configuration rejects non-JSON, cyclic, deep and oversized data',()=>{
  const cyclic={};cyclic.self=cyclic;
  let deep={};for(let n=0;n<10;n++)deep={nested:deep};
  for(const configuration of [{token:undefined},{nonfinite:Infinity},cyclic,deep,{large:'x'.repeat(17000)}])invalid(()=>validateSnapshot({...snapshot(),configuration}));
});
test('CLI parsing rejects duplicate options and ambiguous numeric notation',()=>{
  assert.deepEqual(args(['task','list','--url','http://localhost']).commands,['task','list']);
  for(const argv of [['--port','10','--port','11'],['--help','--help'],['--__proto__','value'],['--port=10'],['--port']])invalid(()=>args(argv));
  for(const value of ['',' ','1e2','0x10','1.0','Infinity','1.5'])invalid(()=>integer(value,'count',0,100));
  assert.equal(integer('0','port',0,65535),0);
});
test('CLI input rejects inaccessible, malformed and oversized files with input errors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-contract-'));
  try {
    await assert.rejects(input(join(dir,'missing')),e=>httpStatus(e)===400);
    await assert.rejects(input(dir),e=>httpStatus(e)===400);
    await writeFile(join(dir,'bad.json'),'{');await assert.rejects(input(join(dir,'bad.json')),e=>httpStatus(e)===400);
    await writeFile(join(dir,'big.json'),'x'.repeat(65537));await assert.rejects(input(join(dir,'big.json')),e=>httpStatus(e)===413);
    await writeFile(join(dir,'ok.json'),' {"title":"Feature"} ');assert.equal((await input(join(dir,'ok.json'))).title,'Feature');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('HTTP input requires exact JSON media type; client normalizes malformed error responses',async()=>{
  const server=createServer(async(req,res)=>{
    if(req.url==='/input'){try{const value=await readJson(req);res.setHeader('content-type','application/json');res.end(JSON.stringify(value));}catch(e){res.writeHead(httpStatus(e));res.end(JSON.stringify({error:e.message}));}return;}
    if(req.url==='/null'){res.writeHead(400);res.end('null');return;}
    if(req.url==='/redirect'){res.writeHead(302,{location:'/null'});res.end();return;}
    res.writeHead(500);res.end('<html>Error</html>');
  });server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  try {
    await assert.rejects(request('file:///tmp','/',''),e=>httpStatus(e)===400);
    await assert.rejects(request(base,'//other.example',''),e=>httpStatus(e)===400);
    await assert.rejects(request(base,'/null',''),e=>httpStatus(e)===400&&e.message==='HTTP 400');
    await assert.rejects(request(base,'/bad',''),e=>e.status===500&&e.message.includes('invalid JSON'));
    await assert.rejects(request(base,'/redirect',''));
    assert.equal((await fetch(base+'/input',{method:'POST',headers:{'content-type':'application/json-malformed'},body:'{}'})).status,415);
    assert.equal((await fetch(base+'/input',{method:'POST',headers:{'content-type':'application/json'},body:'null'})).status,400);
    assert.deepEqual(await request(base,'/input','','POST',{ok:true}),{ok:true});
  } finally {await new Promise(resolve=>server.close(resolve));}
});
