import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { WorkerSessions } from './application-fixtures.mjs';
import { LocalTaskboard } from './application-fixtures.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for(let n=0;n<400;n++){if(await fn())return;await delay(10);}throw Error('Timed out'); }
async function fixture(t, model) {
  const directory=await mkdtemp(join(tmpdir(),'werk-serial-')); const settings=new WorkerSettings(directory); await settings.init();
  const sessions=WorkerSessions(directory,settings,model);await sessions.init();
  cleanup(t, async()=>{await sessions.close();await rm(directory,{recursive:true,force:true});});return {directory,settings,sessions};
}
test('chat and file tasks share one slot, keep separate durable sessions, and reject premature follow-ups',async t=>{
  let active=0,maximum=0;const calls=[];
  const model=()=>({async reply(messages,signal){active++;maximum=Math.max(maximum,active);calls.push(messages.map(item=>item.text));try{await delay(50);signal.throwIfAborted();return messages[0].text.startsWith('Implement')?JSON.stringify({summary:'Proposed fixture',files:[{path:'hello.txt',content:'hello'}]}):'Fixture response';}finally{active--;}}});
  const {directory,settings,sessions}=await fixture(t,model);const repository=join(directory,'repo');await mkdir(repository);
  const board=LocalTaskboard(directory,settings,sessions,model);await board.init();cleanup(t, ()=>board.close());
  await settings.update({board:{paused:true}});
  await sessions.start('First task');const first=sessions.current.id;
  await sessions.action({action:'create',title:'New task',provider:'codex-cli'});await sessions.start('Second task');const second=sessions.current.id;
  await board.create({title:'File task',instruction:'Create hello',repository,paths:['hello.txt']});const local=board.view().tasks[0];
  assert.equal(new Set([first,second,local.sessionId]).size,3);
  await sessions.action({action:'select',id:local.sessionId});await assert.rejects(sessions.start('Too early'),/finish/);
  await board.tick();assert.equal(calls.length,0);assert.equal(sessions.view().execution.queued,2);
  await settings.update({board:{paused:false}});
  await until(async()=>{await board.tick();return board.view().tasks[0].status==='review'&&!sessions.busy;});assert.equal(maximum,1);assert.equal(calls.length,3);
  await sessions.action({action:'select',id:first});await sessions.start('Follow-up');await until(()=>!sessions.busy);
  assert.equal(calls[3][0],'First task');assert.ok(calls[3].includes('Follow-up'));assert.equal(sessions.current.id,first);
  await assert.rejects(sessions.action({action:'delete',id:local.sessionId}),/linked local task/);
  const recovered=WorkerSessions(directory,settings,model);await recovered.init();cleanup(t, ()=>recovered.close());
  assert.equal(recovered.view().records.length,3);assert.equal(recovered.view().records.find(item=>item.id===first).messages,4);
  assert.equal(recovered.view().records.find(item=>item.id===local.sessionId).messages,2);
});
test('cancelling a queued chat never prompts the model and does not block later tasks',async t=>{
  let calls=0;const {settings,sessions}=await fixture(t,()=>({async reply(){calls++;return 'Done';}}));
  await settings.update({board:{paused:true}});await sessions.start('Cancelled task');await sessions.chat.cancel();
  assert.equal(sessions.view().records[0].status,'cancelled');assert.equal(sessions.executor.waiting,0);
  await sessions.action({action:'create',title:'New task',provider:'codex-cli'});await sessions.start('Next task');
  await settings.update({board:{paused:false}});sessions.executor.wake();await until(()=>!sessions.busy);assert.equal(calls,1);
  await assert.rejects(settings.update({board:{maxParallel:2}}),/one task/);
});

test('failed taskboard writes and restart reconciliation leave no locked orphan task sessions',async t=>{
  const {directory,settings,sessions}=await fixture(t,()=>({async reply(){return 'Unused';}}));
  const repository=join(directory,'repo');await mkdir(repository);await mkdir(join(directory,'taskboard.json'));
  const board=LocalTaskboard(directory,settings,sessions,()=>({async reply(){return 'Unused';}}));
  await assert.rejects(board.create({title:'Failed save',instruction:'Create hello',repository,paths:['hello.txt']}));
  const orphan=sessions.view().records.find(item=>item.kind==='local');assert.equal(orphan.status,'failed');assert.equal(sessions.busy,false);assert.equal(board.view().tasks.length,0);
  await sessions.action({action:'delete',id:orphan.id});
  await sessions.ensureTask('local-interrupted','local','Interrupted save','codex-cli');
  await rm(join(directory,'taskboard.json'),{recursive:true});
  const recovered=LocalTaskboard(directory,settings,sessions);await recovered.init();cleanup(t, ()=>recovered.close());
  assert.equal(sessions.view().records.find(item=>item.id==='local-interrupted').status,'failed');assert.equal(sessions.busy,false);
});
test('cancelled and failed file tasks retain original context, and followup outcome updates the session',async t=>{
  /** @type {import('../../src/worker/application/conversation.js').ChatMessage[]} */
  let followup;
  const {directory,settings,sessions}=await fixture(t,()=>({async reply(messages){followup=messages;return 'Follow-up answered';}}));
  const repository=join(directory,'repo');await mkdir(repository);const board=LocalTaskboard(directory,settings,sessions,()=>({async reply(){throw Error('Provider failed');}}));await board.init();cleanup(t, ()=>board.close());
  await board.create({title:'Cancelled',instruction:'Original cancelled instruction',repository,paths:['a.txt']});let task=board.view().tasks[0];await board.action({id:task.id,action:'cancel'});
  await sessions.action({action:'select',id:task.sessionId});assert.match(sessions.chat.snapshot().messages[0].text,/Original cancelled/);assert.match(sessions.chat.snapshot().messages[1].text,/cancelled/);
  await sessions.start('Explain cancellation');await until(()=>!sessions.busy);assert.ok(followup);assert.match(followup[0].text,/Original cancelled/);assert.equal(sessions.view().records.find(item=>item.id===task.sessionId).status,'completed');
  await board.create({title:'Failed',instruction:'Original failed instruction',repository,paths:['b.txt']});task=board.view().tasks[1];await until(async()=>{await board.tick();return board.detail(task.id).status==='failed';});
  await sessions.action({action:'select',id:task.sessionId});assert.match(sessions.chat.snapshot().messages[0].text,/Original failed/);assert.equal(sessions.chat.snapshot().messages.at(-1).state,'error');
  const recovered=WorkerSessions(directory,settings,()=>({async reply(){return 'Unused';}}));await recovered.init();cleanup(t, ()=>recovered.close());const recoveredBoard=LocalTaskboard(directory,settings,recovered);await recoveredBoard.init();cleanup(t, ()=>recoveredBoard.close());
  const firstSession=board.view().tasks[0].sessionId;assert.equal(recovered.view().records.find(item=>item.id===firstSession).status,'completed');
});
