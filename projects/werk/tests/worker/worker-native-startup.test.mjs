import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { SerialExecutor } from '../../src/worker/dist/worker/application/serial-executor.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
import { runWorker } from '../../src/worker/dist/worker/runner.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';

test('native startup holds local work and continuations without changing pause, capacity or cancellation rules', async () => {
  let paused = true;
  const executor = new SerialExecutor(() => paused), releaseStartup = executor.suspendNativeWork(), signal = new AbortController();
  let localStarted = false, continued = false, simulated = false;
  const local = executor.acquire('local', signal.signal).then(release => { localStarted = true; return release; });
  const continuation = executor.acquire('continuation', signal.signal, {continuation:true}).then(release => { continued = true; return release; });
  const simulation = executor.acquire('simulation', signal.signal, {startupIndependent:true}).then(release => { simulated = true; return release; });
  await turn(); assert.equal(simulated, false); assert.equal(continued, false); assert.equal(localStarted, false);
  paused = false; executor.wake();
  const releaseSimulation = await simulation;
  assert.equal(executor.current, 'simulation'); assert.equal(executor.executions.length, 1);
  assert.equal(continued, false); assert.equal(localStarted, false);
  assert.equal(executor.canStart('other', {continuation:true}), false);
  releaseSimulation(); releaseStartup(); releaseStartup();
  const releaseLocal = await local; assert.equal(executor.current, 'local'); releaseLocal();
  const releaseContinuation = await continuation; assert.equal(executor.current, 'continuation'); releaseContinuation();
  const hold = executor.suspendNativeWork(), cancel = new AbortController();
  const waiting = executor.acquire('cancelled', cancel.signal, {continuation:true});
  cancel.abort(); await assert.rejects(waiting, {name:'AbortError'}); hold();
  assert.equal(executor.current, null); assert.equal(executor.waiting, 0);
});

for (const taskMode of ['mock', 'cli', undefined]) test(`only normalized simulation work with a mock adapter bypasses native startup: ${taskMode}`, {timeout:15000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-native-startup-')), stop = new AbortController();
  const setup = Promise.withResolvers(), ready = Promise.withResolvers(), attempted = Promise.withResolvers(), finished = Promise.withResolvers();
  const config = await configuration({profiles:'codex','poll-ms':'100'});
  let claimed = false, completed = false, calls = 0, running = Promise.resolve();
  /** @type {WorkerWorkspace | undefined} */ let workspace;
  const original = WorkerWorkspace.prototype.init;
  WorkerWorkspace.prototype.init = async function (...args) { await original.apply(this, args); workspace = this; };
  t.after(async () => { stop.abort(); setup.resolve(); await running; WorkerWorkspace.prototype.init = original; await rm(directory, {recursive:true,force:true}); });
  /** @type {import('../../src/shared/domain.ts').Task} */
  const task = {id:'startup-task',project:'alpha',title:'Retain the shared execution slot',criteria:['Dispatch safely'],wikilinks:[],provider:'codex',priority:1,status:'running',attempt:1,workerId:'worker-one',lease:'startup-lease',expiresAt:Date.now()+60000,createdAt:Date.now(),profile:config.profiles[0].id,...(taskMode ? {executionMode:/** @type {'mock'|'cli'} */(taskMode)} : {})};
  const client = {
    async currentAssignments(){return claimed&&!completed?[task]:[];},
    async claim(){if(claimed)return null;claimed=true;return task;},
    async heartbeat(){return task;},async publishSnapshot(){},
    async complete(){completed=true;finished.resolve();},async abandon(){completed=true;finished.resolve();},
  };
  const gateway = {async register(){return {id:'worker-one',token:'fixture-token',project:'alpha'};},connect(){return client;}};
  running = runWorker({...config,stateDir:directory,url:'http://orchestrator.invalid',enrollmentToken:'fixture',statusHost:'127.0.0.1',statusPort:0},stop.signal,{
    gateway,prepareProcessRuntime:async()=>setup.promise,ready:async()=>ready.resolve(),
    adapter:{mode:'mock',async run(){calls++;assert.equal(workspace.executor.current,'remote-startup-task');return {kind:'simulated',summary:'Startup simulation'};}},
  });
  await ready.promise; assert.ok(workspace); assert.equal(workspace.repositoryStatus().nativeWork.state,'preparing');
  const acquire=workspace.executor.acquire.bind(workspace.executor);
  workspace.executor.acquire=(id,signal,options)=>{if(id==='remote-startup-task'){assert.equal(options.startupIndependent,taskMode!=='cli');attempted.resolve();}return acquire(id,signal,options);};
  await attempted.promise;
  if(taskMode!=='cli'){await finished.promise;assert.equal(calls,1);assert.equal(workspace.repositoryStatus().nativeWork.state,'preparing');}
  else {await turn();assert.equal(calls,0);assert.equal(workspace.executor.current,null);assert.equal(workspace.executor.waiting,1);}
  stop.abort();setup.resolve();await running;
});

test('a real remote adapter cannot bypass owned setup even for advertised simulation work', {timeout:15000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'werk-native-adapter-')),stop=new AbortController(),setup=Promise.withResolvers(),ready=Promise.withResolvers();
  const config=await configuration({'poll-ms':'100'});
  config.profiles=[{id:'codex-live',provider:'codex',mode:'cli',maxParallel:1}];
  config.policy={...config.policy,maxAttempts:1,configHash:'b'.repeat(64)};
  let calls=0,registrations=0,running=Promise.resolve();
  t.after(async()=>{stop.abort();setup.resolve();await running;await rm(directory,{recursive:true,force:true});});
  running=runWorker({...config,stateDir:directory,url:'http://orchestrator.invalid',enrollmentToken:'fixture',statusHost:'127.0.0.1',statusPort:0},stop.signal,{
    prepareProcessRuntime:async()=>setup.promise,ready:async()=>ready.resolve(),
    gateway:{async register(){registrations++;throw Error('Must not connect before real runtime readiness');},connect(){throw Error('Must not connect');}},
    adapter:{mode:'cli',async run(){calls++;throw Error('Must not execute');}},
  });
  await ready.promise;await turn();assert.equal(registrations,0);assert.equal(calls,0);
  stop.abort();setup.resolve();await running;assert.equal(registrations,0);assert.equal(calls,0);
});
