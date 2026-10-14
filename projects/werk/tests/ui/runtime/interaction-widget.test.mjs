import test from 'node:test';import assert from 'node:assert/strict';
import {frontend,deferred} from '../helpers/frontend-loader.mjs';
const {createLineInteraction}=await frontend('src/shared/webview/line-interaction.ts');
const snapshot=(id,messages=[],phase='completed')=>({sessions:{selected:id,records:[{id,title:messages[0]?.text||'New task'}]},chat:{messages,phase,busy:['queued','running'].includes(phase),available:true}});
test('first message queues worker session, followup keeps it, and new task adopts its returned session',async()=>{
 const calls=[];const i=createLineInteraction(async body=>{calls.push(body);return snapshot(body.action==='new'?'second':'first',body.action==='send'?[{role:'user',text:body.message}]:[]);},async()=>({}),()=>true);
 await i.connect();i.state.draft='First';await i.perform('send');i.state.draft='Continue';await i.perform('send');await i.perform('new');
 assert.equal(calls[1].sessionId,'first');assert.equal(calls[2].sessionId,'first');assert.equal(i.state.sessionId,'second');assert.equal(i.state.draft,'');assert.equal(i.title.value,'New task');
});
test('sending during polling fences a late read from replacing accepted conversation',async()=>{
 const pending=deferred();let reads=0;const i=createLineInteraction(async body=>body.action==='read'?(++reads===1?snapshot('one'):pending.promise):snapshot('one',[{role:'user',text:'Accepted'}]),async()=>({}),()=>true);
 await i.connect();const read=i.perform('read',true);i.state.draft='Accepted';await i.perform('send');pending.resolve(snapshot('one',[]));await read;assert.equal(i.state.chat.messages[0].text,'Accepted');assert.equal(i.state.reading,false);
});
test('failed new task preserves draft and later reconnect restores prior task draft',async()=>{
 let selected='one',fail=true;const i=createLineInteraction(async body=>{if(body.action==='new'){if(fail)throw Error('Unavailable');selected='two';}return snapshot(selected);},async()=>({}),()=>true);
 i.state.workerUrl='http://localhost:4100';await i.connect();i.state.draft='Unsent';await i.perform('new');assert.equal(i.state.draft,'Unsent');fail=false;await i.perform('new');i.reset();selected='one';await i.connect();assert.equal(i.state.draft,'Unsent');
});
test('routed submissions suppress duplicates and requirement success resets manual requirements',async()=>{
 const pending=deferred(),calls=[];const i=createLineInteraction(async()=>snapshot('one'),async(task,key)=>{calls.push({task,key});return pending.promise;},()=>true,'demo');i.state.input.reference='[[requirements/task]]';const submit=i.submitTask();await i.submitTask();assert.equal(calls.length,1);assert.equal(calls[0].task.requirementRef,'[[requirements/task]]');assert.equal(calls[0].task.title,undefined);pending.resolve({id:'task-one'});await submit;assert.equal(i.state.input.reference,'');assert.match(i.state.taskMessage,/Task saved to this line/);
});
test('composer has no prompt permission before connecting and close clears its credentials and drafts',async()=>{
 let calls=0;const i=createLineInteraction(async()=>{calls++;return snapshot('one');},async()=>({}),()=>true);i.state.draft='Work';await i.perform('send');assert.equal(calls,0);assert.equal(i.canSend.value,false);i.state.credential='private';i.reset(true);assert.equal(i.state.credential,'');assert.equal(i.state.draft,'');
});
