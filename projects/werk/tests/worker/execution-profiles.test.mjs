import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionProfiles } from '../../src/worker/dist/worker/application/execution-profiles.js';
import { executionProfilesStorage } from '../../src/worker/dist/worker/infrastructure/execution-profiles.js';
import { loadOrRegisterIdentity } from '../../src/worker/dist/worker/infrastructure/identity.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { Store } from '../../src/orchestrator/dist/orchestrator/persistence/store.js';
import { cleanup } from './fixture-cleanup.mjs';
const base = 'a'.repeat(64);
const initial = [{ id: 'codex-original', provider: 'codex', mode: 'mock', maxParallel: 1 }];
const replacement = [{ id: 'claude-edited', provider: 'claude', mode: 'mock', maxParallel: 1 }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 10000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(20); } throw Error('Condition timed out'); }
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'werk-profiles-')); cleanup(t, () => rm(path, {recursive:true,force:true})); return path; }
function manager(path, profiles = initial, hash = base, mode = 'mock') { return new ExecutionProfiles(hash, profiles, mode, executionProfilesStorage(path)); }

test('profile overrides persist privately, recover staged intent, guard stale writes, and restore the original configuration hash', async t => {
  const path = await directory(t), profiles = manager(path); await profiles.init();
  assert.equal(profiles.active.configurationHash, base);
  await profiles.stage({expectedConfigurationHash:base, profiles:replacement});
  assert.deepEqual(profiles.active.profiles, initial); assert.deepEqual(profiles.pending.profiles, replacement);
  await profiles.stage({expectedConfigurationHash:base, profiles:replacement});
  await assert.rejects(profiles.stage({expectedConfigurationHash:base,profiles:[{...replacement[0],id:'other'}]}), /waiting/);
  const restarted = manager(path); await restarted.init(); assert.deepEqual(restarted.pending,profiles.pending);
  await restarted.commit(); assert.deepEqual(restarted.active.profiles,replacement);
  await assert.rejects(restarted.stage({expectedConfigurationHash:base,profiles:initial}), /Reload/);
  await restarted.stage({expectedConfigurationHash:restarted.active.configurationHash,profiles:initial}); await restarted.commit(); assert.equal(restarted.active.configurationHash,base);
  if(process.platform!=='win32') assert.equal((await stat(join(path,'execution-profiles.json'))).mode & 0o777,0o600);
  await assert.rejects(manager(path,initial,'b'.repeat(64)).init(),/different startup configuration/);
  const corrupt=JSON.parse(await readFile(join(path,'execution-profiles.json'),'utf8'));corrupt.active.configurationHash='c'.repeat(64);await writeFile(join(path,'execution-profiles.json'),JSON.stringify(corrupt));
  await assert.rejects(manager(path).init(),/hash does not match/);
});

test('profile editing enforces current execution mode, unique IDs, provider support, one slot and bounded profile count', async t => {
  const profiles=manager(await directory(t));
  for(const invalid of [[],Array.from({length:9},(_,i)=>({...initial[0],id:'p'+i})),[initial[0],initial[0]],[{...initial[0],id:'../escape'}],[{...initial[0],maxParallel:2}],[{...initial[0],mode:'cli'}],[{...initial[0],provider:'unknown'}]])
    await assert.rejects(profiles.stage({expectedConfigurationHash:base,profiles:invalid}));
  const live=manager(await directory(t),[{id:'live',provider:'codex',mode:'cli',maxParallel:1}],base,'cli');
  await assert.rejects(live.stage({expectedConfigurationHash:base,profiles:[{id:'a',provider:'codex',mode:'cli'},{id:'b',provider:'codex',mode:'cli'}]}),/exactly one/);
  await assert.rejects(live.stage({expectedConfigurationHash:base,profiles:[{id:'a',provider:'claude',mode:'cli'}]}),/live Codex/);
  await live.stage({expectedConfigurationHash:base,profiles:[{id:'renamed-live',provider:'codex',mode:'cli'}]}); assert.equal(live.pending.profiles[0].maxParallel,1);
});

test('identity recovery allows only the explicitly durable pending hash after acknowledgement interrupted local commit', async t=>{
  const path=await directory(t),profiles=manager(path);await profiles.stage({expectedConfigurationHash:base,profiles:replacement});
  const desired=profiles.pending.configurationHash, identity={id:'worker',project:'alpha',token:'private-token',url:'http://localhost',configHash:desired};
  await writeFile(join(path,'identity.json'),JSON.stringify(identity));
  const gateway={async register(){assert.fail('Must retain worker identity');}};
  await assert.rejects(loadOrRegisterIdentity(path,identity.url,initial,{configHash:base},gateway,new AbortController().signal),/bound to server/);
  assert.equal((await loadOrRegisterIdentity(path,identity.url,initial,{configHash:base},gateway,new AbortController().signal,desired)).id,'worker');
  await profiles.commit(); const restarted=manager(path);await restarted.init();
  assert.equal((await loadOrRegisterIdentity(path,identity.url,restarted.active.profiles,{configHash:desired},gateway,new AbortController().signal)).configHash,desired);
});

async function boot(path, config, gateway, now) {
  const stop = new AbortController(); let endpoint, finished;
  const ready=new Promise(resolve=>{finished=resolve;});
  const run=runWorker({...config,stateDir:path,enrollmentToken:'enroll',statusHost:'127.0.0.1',statusPort:0},stop.signal,{...(gateway?{gateway}:{}),...(now?{now}:{}),ready:async address=>{endpoint='http://127.0.0.1:'+address.port;finished();}});
  await Promise.race([ready,run.then(()=>{throw Error('Worker stopped before ready');})]);
  const token=(await readFile(join(path,'webview-token'),'utf8')).trim();
  const api=async(route,body)=>{const response=await fetch(endpoint+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};};
  return {api,endpoint,stop:async()=>{stop.abort();await run;}};
}

test('standalone HTTP editor authenticates, requires pause, rejects simultaneous stale edits, and recovers a staged edit after restart', {timeout:20000},async t=>{
  const path=await directory(t),config=await configuration({'poll-ms':'100','mock-ms':'1',profiles:'codex'});let worker=await boot(path,config);cleanup(t,()=>worker.stop());
  assert.equal((await fetch(worker.endpoint+'/api/execution-profiles')).status,401);
  const first=(await worker.api('/api/execution-profiles')).value;
  assert.equal((await worker.api('/api/execution-profiles',{expectedConfigurationHash:first.configurationHash,profiles:replacement})).status,409);
  assert.equal((await worker.api('/api/settings',{board:{paused:true}})).status,200);
  const updates=await Promise.all([replacement,[{...replacement[0],id:'another'}]].map(profiles=>worker.api('/api/execution-profiles',{expectedConfigurationHash:first.configurationHash,profiles})));
  assert.deepEqual(updates.map(x=>x.status).sort(),[200,409]);
  const active=(await worker.api('/api/execution-profiles')).value;assert.equal(active.state,'ready');assert.notEqual(active.configurationHash,first.configurationHash);
  assert.deepEqual((await worker.api('/status')).value.profiles,active.profiles);
  await worker.stop();
  // Simulate a crash after durable stage and before standalone commit.
  const saved=manager(path,config.profiles,config.policy.configHash);await saved.init();await saved.stage({expectedConfigurationHash:saved.active.configurationHash,profiles:[{...replacement[0],id:'after-crash'}]});
  worker=await boot(path,config);
  const recovered=(await worker.api('/api/execution-profiles')).value;assert.equal(recovered.state,'ready');assert.equal(recovered.profiles[0].id,'after-crash');
});

test('registered edits recover old incomplete evidence, survive a lost acknowledgement and restart, and route new work with the same identity', {timeout:25000},async t=>{
  const path=await directory(t),config=await configuration({'poll-ms':'100','mock-ms':'1',profiles:'codex'});config.url='http://orchestrator.invalid';
  let now=Date.now(), rejectAcknowledgement=true, registration, updateCalls=0, recoveryTaskId;
  const store=new Store(':memory:',1000,()=>now);cleanup(t,()=>store.close());
  const current=()=>store.worker(registration.token);
  const gateway={async register(profiles,policy){registration={...store.register('alpha',profiles,policy),project:'alpha'};return registration;},connect(){return {
    async currentAssignments(){
      // This manually seeded lease models orphaned journal evidence, not a runnable live assignment.
      return store.current(current()).filter(task=>task.id!==recoveryTaskId);
    },async claim(id,capacity,repos,legacy){return store.claim(current(),id,capacity,repos,legacy);},
    async heartbeat(task){return store.heartbeat(current(),task.id,task.lease,task.attempt);},async publishSnapshot(snapshot){return store.snapshot(current(),snapshot);},async complete(task){return store.finish(current(),task.id,task.lease,task.attempt);},async abandon(task){return store.abandon(current(),task.id,task.lease,task.attempt);},
    async updateProfiles(input){updateCalls++;const result=store.updateProfiles(current(),input);if(rejectAcknowledgement)throw Error('Lost response fixture');return result;}
  };}};
  let worker=await boot(path,config,gateway,()=>now);cleanup(t,()=>worker.stop());await until(()=>registration);await until(async()=> (await worker.api('/status')).value.state==='idle');
  await worker.api('/api/settings',{board:{paused:true}});
  const old=(await worker.api('/api/execution-profiles')).value;
  const repository=join(path,'local-repository');await mkdir(repository);await writeFile(join(repository,'hello.txt'),'before\n');
  assert.equal((await worker.api('/api/settings',{provider:{id:'openai-api',apiKey:'fixture-key',model:'fixture-model'}})).status,200);
  const local=await worker.api('/api/taskboard',{title:'Cancelled local task',instruction:'Edit hello',repository,paths:['hello.txt'],provider:'openai-api'});assert.equal(local.status,202);
  const localId=local.value.tasks[0].id;assert.equal((await worker.api('/api/taskboard/action',{id:localId,action:'cancel'})).status,200);
  // Model a terminal-write failure after its lease expires: no active execution remains, but a before snapshot still needs closure.
  const task=store.submit({project:'alpha',title:'Interrupted old attempt',criteria:['Done'],wikilinks:[],provider:'codex',priority:1},'old-incomplete');
  recoveryTaskId=task.id;
  const assigned=store.claim(current(),'interrupted',0,[],false);
  const journal=new SnapshotJournal(path,old.configurationHash,config.systemPromptHash);await journal.init();
  await journal.persist(journal.capture(assigned,registration.id,config.profiles[0],{lastContact:null,heartbeatErrors:0},'before'));journal.close();
  now+=2000;store.reapExpired();
  // Block automatic retry of the recovered old task to keep this fixture focused on new-profile routing.
  store.db.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(task.id);
  // A paused worker still polls existing leases. Its bounded admission guard may
  // overlap this save; retry only a rejected, unchanged, completely idle edit.
  await until(async()=>{
    const response=await worker.api('/api/execution-profiles',{expectedConfigurationHash:old.configurationHash,profiles:replacement});
    if(response.status===409){
      assert.equal(response.value.error,'Pause intake and finish or cancel queued tasks and active replies before changing execution profiles.');
      const [settings,status,profiles,board]=await Promise.all(['/api/settings','/status','/api/execution-profiles','/api/taskboard'].map(route=>worker.api(route)));
      for(const result of [settings,status,profiles,board])assert.equal(result.status,200);
      assert.equal(settings.value.board.paused,true);assert.deepEqual(status.value.activeTasks,[]);assert.deepEqual(status.value.queuedTasks??[],[]);
      assert.equal(board.value.tasks.some(task=>['queued','running'].includes(task.status)),false);
      assert.equal(profiles.value.configurationHash,old.configurationHash);assert.equal(profiles.value.state,'ready');assert.equal(profiles.value.pending,null);assert.equal(updateCalls,0);
      return false;
    }
    assert.equal(response.status,200,JSON.stringify(response.value));return true;
  });
  const recovered=JSON.parse(await readFile(join(path,'snapshots',assigned.lease,'after.json'),'utf8'));assert.equal(recovered.profileId,config.profiles[0].id);assert.equal(recovered.provenance.configurationHash,old.configurationHash);
  await until(()=>updateCalls>0);assert.deepEqual(current().profiles,replacement);
  assert.equal((await worker.api('/api/execution-profiles')).value.state,'pending');
  assert.equal((await worker.api('/api/settings',{board:{paused:false}})).status,409);
  assert.equal((await worker.api('/api/tasks',{action:'create',title:'Blocked',provider:'codex-cli',message:'Must not run'})).status,409);
  const retry=await worker.api('/api/taskboard/action',{id:localId,action:'retry'});assert.equal(retry.status,503);
  assert.equal((await worker.api('/api/taskboard')).value.tasks.find(task=>task.id===localId).status,'cancelled');
  const cancelled=await worker.api('/api/taskboard/action',{id:localId,action:'cancel'});assert.equal(cancelled.status,409);assert.match(cancelled.value.error,/no longer active/);
  await worker.stop();rejectAcknowledgement=false;worker=await boot(path,config,gateway,()=>now);
  await until(async()=> (await worker.api('/api/execution-profiles')).value.state==='ready');
  const identity=JSON.parse(await readFile(join(path,'identity.json'),'utf8'));assert.equal(identity.id,registration.id);assert.equal(identity.configHash,current().config.configHash);
  const next=store.submit({project:'alpha',title:'Edited profile task',criteria:['Done'],wikilinks:[],provider:'claude',priority:1},'new-profile-task');
  // The committed profile becomes visible before the final guarded status write finishes.
  await until(async()=>{
    const resumed=await worker.api('/api/settings',{board:{paused:false}});
    if(resumed.status===409){assert.match(resumed.value.error,/Finish the execution profile change/);return false;}
    assert.equal(resumed.status,200);return true;
  });
  try { await until(()=>store.get(next.id).status==='simulated'); }
  catch(cause){
    const task=store.get(next.id),status=(await worker.api('/status')).value;
    const progress={task:{status:task.status,attempt:task.attempt,profile:task.profile},worker:{state:status.state,lastError:status.lastError,active:status.activeTasks?.length,queued:status.queuedTasks?.length},events:store.events(next.id).map(event=>event.kind),snapshots:store.snapshots({task:next.id}).map(row=>({phase:row.snapshot.phase,outcome:row.snapshot.execution.outcome}))};
    throw new Error('Edited-profile task did not complete: '+JSON.stringify(progress),{cause});
  }
  const completed=store.get(next.id);assert.equal(completed.profile,replacement[0].id);
  const snapshots=store.snapshots({task:next.id});assert.ok(snapshots.every(row=>row.snapshot.provenance.configurationHash===identity.configHash));
  assert.equal(store.workers().length,1);assert.ok(store.snapshots({task:task.id}).some(row=>row.snapshot.phase==='after'));
});
