import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WorkerConversation } from '../../src/worker/dist/worker/application/conversation.js';
import { FileConversationStore, CodexConversationModel } from '../../src/worker/dist/worker/infrastructure/conversation.js';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
import { configuration } from '../../src/worker/dist/worker/config.js';
const memoryStore = () => ({ value: { messages: [] }, async read() { return structuredClone(this.value); }, async write(value) { this.value = structuredClone(value); } });
async function waitFor(predicate) { for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out'); }
/** @returns {import("../../src/worker/status/monitoring.js").Status} */
const status = () => ({workerId:'worker-one',project:'alpha',mode:'mock',state:'idle',taskId:null,attempt:null,profile:null,completedSimulations:1,lastContact:new Date().toISOString(),lastError:null,updatedAt:new Date().toISOString(),profiles:[{id:'codex-1',provider:'codex',mode:'mock'}],heartbeatErrors:0,maxParallel:1,activeTasks:[],configurationHash:'a'.repeat(64),lastSnapshot:null,outbox:{pending:0,oldestAgeSeconds:0}});

test('conversation passes prior successful turns to the model and persists across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-chat-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const inputs=[]; const model={async reply(messages){inputs.push(messages);return 'A real adapter result';}};
  const store=new FileConversationStore(directory), chat=new WorkerConversation(store,model);await chat.init();
  await chat.start('First question');await waitFor(()=>!chat.snapshot().busy);await chat.start('Follow up');await waitFor(()=>!chat.snapshot().busy);
  assert.deepEqual(inputs[1].map(x=>x.role),['user','assistant','user']);
  const recovered=new WorkerConversation(store,model);await recovered.init();assert.equal(recovered.snapshot().messages.length,4);
  if(process.platform!=='win32')assert.equal((await stat(join(directory,'conversation.json'))).mode&0o777,0o600);
  await recovered.clear();assert.deepEqual((await store.read()).messages,[]);
});
test('conversation rejects unavailable, empty, oversized and overlapping requests; cancellation ends a running model', async () => {
  const store=memoryStore(), disabled=new WorkerConversation(store);await disabled.init();await assert.rejects(disabled.start('Hello'),/No model/);
  let aborted=false;
  const chat=new WorkerConversation(store,{reply:async(messages,signal)=>{try{await once(signal,'abort');}finally{aborted=true;}throw Error('cancelled');}});await chat.init();
  await assert.rejects(chat.start(' '),/1–8,000/);await assert.rejects(chat.start('a'.repeat(8001)),/1–8,000/);
  await chat.start('Hello');await assert.rejects(chat.start('duplicate'),/already running/);await assert.rejects(chat.clear(),/Stop/);
  await chat.cancel();assert.ok(aborted);assert.equal(chat.snapshot().messages.at(-1).state,'cancelled');assert.equal(chat.snapshot().busy,false);
  await chat.close();await assert.rejects(chat.start('after shutdown'),/stopping/);
});
test('interrupted replies recover honestly; provider errors and timeouts never expose diagnostics', async () => {
  const store=memoryStore();store.value.messages=[{id:'old',role:'assistant',text:'',state:'pending',at:new Date().toISOString()}];
  const chat=new WorkerConversation(store,{async reply(){throw Error('secret-provider-credential');}});await chat.init();assert.equal(chat.snapshot().messages[0].state,'error');
  await chat.start('Retry');await waitFor(()=>!chat.snapshot().busy);assert.doesNotMatch(JSON.stringify(chat.snapshot()),/secret-provider/);
  const timeoutStore=memoryStore();let attempts=0;
  const timed=new WorkerConversation(timeoutStore,{async reply(_,signal){attempts++;await once(signal,'abort');throw Error('timed out');}},20);
  await timed.init();await timed.start('Slow');await waitFor(()=>!timed.snapshot().busy);
  const failed=timed.snapshot().messages.at(-1);assert.equal(failed.state,'error');
  assert.match(failed.text,/configured execution time limit/);assert.match(failed.text,/saved context is retained; resume explicitly/);
  assert.deepEqual((await timeoutStore.read()).messages,timed.snapshot().messages);
  assert.equal(timeoutStore.value.messages[0].text,'Slow');assert.equal(attempts,1);
  await timed.close();
});
test('failed acceptance never invokes a model; shutdown during acceptance cannot start a model', async()=>{
  let calls=0;const failing=memoryStore();failing.write=async()=>{throw Error('disk full');};const chat=new WorkerConversation(failing,{async reply(){calls++;return 'reply';}});await chat.init();await assert.rejects(chat.start('Hello'),/disk full/);assert.equal(calls,0);assert.equal(chat.snapshot().messages.length,0);
  const { promise: held, resolve: release } = Promise.withResolvers();const blocked=memoryStore();const write=blocked.write.bind(blocked);let first=true;blocked.write=async value=>{if(first){first=false;await held;}await write(value);};
  const closing=new WorkerConversation(blocked,{async reply(_,signal){signal.throwIfAborted();calls++;return 'reply';}});await closing.init();const accepted=closing.start('Hello'),stop=closing.close();release(undefined);await accepted;await stop;assert.equal(calls,0);assert.equal(closing.snapshot().busy,false);
});
test('history and private environment use worker-scoped auth, preserve snapshots, and serve built Vue routes', async t => {
  const directory=await mkdtemp(join(tmpdir(),'werk-webview-'));
  let journal, workspace, restarted, server;
  t.after(async () => {
    const errors = [];
    // Stop traffic and every workspace sampler before closing journals and deleting files.
    for (const cleanup of [
      async () => { if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } },
      () => restarted?.close(),
      () => workspace?.close(),
      () => journal?.close(),
      () => rm(directory, { recursive: true, force: true }),
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Webview fixture cleanup failed');
  });
  const current=status();journal=new SnapshotJournal(directory,'a'.repeat(64),'b'.repeat(64));await journal.init();
  /** @type {import('../../src/shared/domain.js').Task} */
  const task = {
    id: 'task-one', project: 'alpha', title: 'Improve worker navigation',
    criteria: ['Retain task evidence'], wikilinks: [], provider: 'codex', priority: 1,
    status: 'running', workerId: current.workerId, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    attempt: 1, lease: 'lease-one', profile: 'codex-1',
  };
  /** @type {import('../../src/shared/domain.js').Profile} */
  const profile = { id: 'codex-1', provider: 'codex', mode: 'mock' };
  const before=journal.capture(task,current.workerId,profile,current,'before');await journal.persist(before);await journal.persist(journal.capture(task,current.workerId,profile,current,'after',before,'simulated'));
  const cfg={stateDir:directory,url:'http://localhost:3000',pollMs:1000,timeoutMs:60000};
  workspace=new WorkerWorkspace(cfg,journal,()=>current);await workspace.init();await workspace.updateSettings({provider:{id:'codex-cli',executable:''}});await workspace.rememberTask({...task,title:'Improve worker navigation'});
  const token=(await readFile(join(directory,'webview-token'),'utf8')).trim();restarted=new WorkerWorkspace(cfg,journal,()=>current);await restarted.init();assert.equal((await readFile(join(directory,'webview-token'),'utf8')).trim(),token);
  server=await statusServer(()=>current,'127.0.0.1',0,undefined,workspace);
  const base=`http://127.0.0.1:${testListeningAddress(server).port}`,headers={Authorization:`Bearer ${token}`};
  assert.equal((await fetch(base+'/api/history')).status,401);assert.equal((await fetch(base+'/api/environment',{headers:{Authorization:'Bearer wrong'}})).status,401);
  const environment=await(await fetch(base+'/api/environment',{headers})).json();assert.equal(environment.stateDirectory,await realpath(directory));assert.doesNotMatch(JSON.stringify(environment),/secret|hidden|webview-token/);assert.equal(environment.chat.configured,false);
  const history=await(await fetch(base+'/api/history',{headers})).json();assert.equal(history.rows.length,1);assert.equal(history.rows[0].outcome,'simulated');assert.equal(history.rows[0].title,'Improve worker navigation');assert.equal(history.rows[0].completePair,true);assert.equal((await restarted.history()).rows[0].taskId,'task-one');assert.equal((await restarted.history()).rows[0].title,'Improve worker navigation');
  const post={method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({message:'Hello'})};
  assert.equal((await fetch(base+'/api/chat',{...post,headers:{...post.headers,Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/chat',post)).status,503);
  assert.equal((await fetch(base+'/api/chat',{...post,body:'x'.repeat(70000)})).status,413);
  const workflow = { ...post, body: JSON.stringify({ action: 'workflow_metrics' }) };
  assert.equal((await fetch(base+'/api/requests', { ...workflow, headers: { 'Content-Type': 'application/json' } })).status,401);
  assert.equal((await fetch(base+'/api/requests', { ...workflow, headers: { ...workflow.headers, Origin: 'https://evil.invalid' } })).status,403);
  const workflowResponse = await fetch(base+'/api/requests',workflow); assert.equal(workflowResponse.status,200);
  const workflowReport = await workflowResponse.json(); assert.equal(workflowReport.scope,'retained_worker_workflow'); assert.equal(workflowReport.throughput.completed,0);
  assert.equal((await fetch(base+'/api/requests',{...workflow,body:JSON.stringify({action:'workflow_metrics',since:'not-a-date'})})).status,400);

  for(const path of ['/','/taskboard','/taskboard?session=saved','/chat','/history','/workflow','/workflow?project=alpha&window=4w','/workboard','/workboard?session=saved','/projects','/projects?project=alpha','/projects/new','/project','/requests/new','/request/maintenance','/request','/workflow/evidence','/review?request=saved','/dashboard','/settings','/settings?section=queue','/monitoring-status','/history?taskState=failed','/history?taskState=queued&kind=local','/chat?task=saved']) {const response=await fetch(base+path);assert.equal(response.status,200);const html=await response.text();assert.match(html,/id="app"/);assert.match(html,/assets\/.*\.js/);assert.doesNotMatch(html,new RegExp(token));}
  const html=await(await fetch(base+'/taskboard')).text();const asset=/src="([^"]+\.js)"/.exec(html)[1];const js=await fetch(base+asset);assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);assert.ok((await js.text()).length>1000);
  assert.equal((await fetch(base+'/unknown?taskState=failed')).status,404);
  assert.equal((await fetch(base+'/api/history?taskState=failed',{headers})).status,404);
  assert.equal((await fetch(base+'/api/history?taskState=failed')).status,401);
  assert.equal((await fetch(base+'/history?taskState=failed',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/assets/missing.js')).status,404);assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/status',{method:'POST'})).status,405);
});
test('Codex chat configuration is explicit and does not change task execution mode',async()=>{
  const defaultConfig=await configuration({});assert.equal(defaultConfig.chatExecutable,undefined);
  if(process.platform==='linux'){const config=await configuration({}, {chat:{codexExecutable:'/usr/local/bin/codex'}});assert.equal(config.chatExecutable,'/usr/local/bin/codex');assert.ok(config.profiles.every(profile=>profile.mode==='mock'));assert.equal(config.policy.configHash,defaultConfig.policy.configHash);}
  await assert.rejects(configuration({}, {chat:{codexExecutable:'relative'}}),/absolute/);await assert.rejects(configuration({}, {chat:{codexExecutable:'/codex',extra:true}}),/absolute/);
});
test('Codex chat uses bounded stdin conversation and read-only noninteractive CLI settings', {skip:process.platform!=='linux'}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'werk-chat-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,'model-fixture');
  const fixture=`#!/usr/bin/env node\nlet input='';for await(const chunk of process.stdin)input+=chunk;const args=process.argv.slice(2);if(!args.includes('--ignore-user-config')||!args.includes('read-only')||!args.includes('shell_tool')||!args.includes('--ephemeral')||!input.includes('A question'))process.exit(2);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture reply, not a live model'}}));`;
  await writeFile(executable,fixture,{mode:0o700});const model=new CodexConversationModel(executable,directory);const output=await model.reply([{id:'question-one',role:'user',text:'A question',at:new Date().toISOString(),state:'complete'}],AbortSignal.timeout(5000));assert.equal(output,'Fixture reply, not a live model');
});

test('system chat configuration reaches the worker without enabling task execution or allowing Docker chat', async () => {
  const { validateDefinition, planDefinition } = await import('../../scripts/system/definition.mjs');
  const { validateConfig } = await import('../../scripts/runtime/config.mjs');
  const { workerDocument } = await import('../../scripts/runtime/execution.mjs');
  const chat={codexExecutable:'/opt/codex/bin/codex'};
  const definition={schemaVersion:1,id:'chat-demo',environment:'native',factory:{id:'factory',name:'Factory',port:3100},productionLines:[{id:'alpha',name:'Alpha',project:'alpha',orchestrator:{port:3001},workers:{count:1,statusPort:4201,chat}}]};
  assert.deepEqual(validateDefinition(definition).productionLines[0].workers.chat,chat);assert.equal(planDefinition(definition).mode,'mock');
  const config=validateConfig({schemaVersion:1,project:'alpha',orchestratorPort:3001,workerPort:4201,workers:1,runtime:'native',mode:'mock',chat});assert.deepEqual(workerDocument(config.execution,config.chat),{chat});
  assert.throws(()=>validateDefinition({...definition,environment:'docker'}),/native Linux/);assert.throws(()=>validateConfig({...config,runtime:'docker'}),/native Linux/);
  assert.throws(()=>validateDefinition({...definition,productionLines:[{...definition.productionLines[0],workers:{count:1,statusPort:4201,chat:{codexExecutable:'/codex',token:'not-allowed'}}}]}),/absolute Linux/);
});
