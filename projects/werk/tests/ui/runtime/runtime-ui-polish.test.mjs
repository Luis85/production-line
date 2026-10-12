import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { statusHtml } from '../../../src/worker/dist/worker/status/server.js';

const html=await readFile(new URL('../../../src/orchestrator/public/index.html',import.meta.url),'utf8');
const source=html.split('<script>')[1].split('</script>')[0];
function harness(fetch,script=source){
  const nodes=new Map();
  class Element {
    constructor(){this.value='';this.children=[];this.dataset={};this.textContent='';this.attributes={};this.hidden=false}
    append(...children){this.children.push(...children)}
    replaceChildren(...children){this.children=children}
    setAttribute(k,v){this.attributes[k]=v}
    removeAttribute(k){delete this.attributes[k]}
    focus(){document.activeElement=this}
    get firstElementChild(){return this.children[0]}
    closest(){return this}
    querySelectorAll(){return []}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};
  const document={getElementById:id=>get('#'+id),querySelector:get,querySelectorAll:()=>[],createElement:()=>new Element(),createElementNS:()=>new Element(),hidden:false,title:'',activeElement:null};
  const context=vm.createContext({document,fetch,crypto:{randomUUID},AbortSignal,AbortController,Date,console,setInterval:()=>{},URLSearchParams});
  vm.runInContext(script,context);
  return {get,context,run:code=>vm.runInContext(code,context)};
}
const response=body=>({ok:true,status:200,json:async()=>body&&['tasks','workers','events'].some(key=>Array.isArray(body[key]))?{hasMore:false,nextCursor:null,...body}:body});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};

test('runtime navigation ignores an older response even when transport ignores cancellation',async()=>{
  const first=deferred(),second=deferred();let call=0;
  const h=harness(()=>++call===1?first.promise:second.promise);
  const pending=h.run("token='admin';tab='tasks';refresh()");
  h.run("navigate('workers')");second.resolve(response({workers:[{id:'worker-b',project:'demo',online:true,profiles:[],config:{maxParallel:2}}]}));
  await new Promise(resolve=>setImmediate(resolve));
  first.resolve(response({tasks:[{id:'old',title:'Stale task',project:'demo',status:'queued',provider:'auto',attempt:0}]}));await pending;
  assert.equal(h.get('#task-rows').children.length,1);assert.match(h.get('#task-rows').children[0].children[0].textContent,/Seite wird geladen/);assert.doesNotMatch(h.get('#task-rows').children[0].children[0].textContent,/Stale task/);
  assert.equal(h.get('#worker-rows').children[0].children[0].children[0].textContent,'worker-b');
  assert.equal(h.run('tab'),'workers');
});

test('retry preserves task idempotency after ambiguous network failure and clears only on success',async()=>{
  const keys=[];let failed=true;
  const h=harness(async(_url,options)=>{if(options.method==='POST'){keys.push(options.headers['Idempotency-Key']);if(failed){failed=false;throw Error('network timeout')}return response({id:'task-created'})}return response({tasks:[]})});
  h.run("token='admin'");
  for(const [id,value] of Object.entries({'#intake-mode':'manual','#project':'demo','#title':'Feature','#criteria':'Criterion','#wikilinks':'','#provider':'auto','#priority':'1'}))h.get(id).value=value;
  await h.get('#task-form').onsubmit({preventDefault(){}});assert.equal(h.get('#title').value,'Feature');
  await h.get('#task-form').onsubmit({preventDefault(){}});assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(h.get('#title').value,'');
});

test('disconnect clears rendered task, snapshot and credentials state',()=>{
  const h=harness(async()=>response({tasks:[]}));h.run("token='secret';tasksCache=[{id:'task'}];metricRecords=[{}]");h.get('#task-events').textContent='private detail';h.get('#snapshot-detail').textContent='private metrics';
  h.get('#disconnect').onclick();assert.equal(h.run('token'),'');assert.equal(h.run('tasksCache.length'),0);assert.equal(h.get('#task-events').textContent,'');assert.equal(h.get('#snapshot-detail').textContent,'');
});

test('metrics reads newest first with advancing cursors, retains all records for summaries',async()=>{
  const paths=[];const h=harness(async path=>{paths.push(path);return response(paths.length===1?{snapshots:[{seq:2}],nextCursor:2,hasMore:true}:{snapshots:[{seq:1}],nextCursor:1,hasMore:false})});
  const result=await h.run('loadMetrics(new AbortController().signal)');assert.match(paths[0],/order=desc/);assert.match(paths[1],/before=2/);assert.deepEqual(Array.from(result.records,r=>r.seq),[1,2]);assert.equal(result.truncated,false);
});

test('worker exported status is self-contained and safely encodes hostile labels',()=>{
  const result=statusHtml({workerId:'</script><img src=x onerror=alert(1)>',project:'demo',state:'idle',updatedAt:new Date().toISOString(),activeTasks:[],profiles:[],maxParallel:2});
  assert.equal((result.match(/<script>/g)||[]).length,1);assert.equal((result.match(/<\/script>/g)||[]).length,1);
  assert.match(result,/\\u003c\/script>/);assert.match(result,/Static export/);assert.match(result,/if\(exported\)/);assert.match(result,/Acknowledged simulations \(this process\)/);
  const script=result.split('<script>')[1].split('</script>')[0];
  const h=harness(()=>{throw Error('Export must not request live status')},script);
  assert.equal(h.get('#refresh').hidden,true);assert.equal(h.get('#json-link').hidden,true);assert.match(h.get('#update-note').textContent,/do not update/);
});


test('connection moves focus into the next intake field and disconnected views explain access',async()=>{
  const h=harness(async()=>response({tasks:[]}));h.get('#token').value='admin';h.get('#intake-mode').value='vault';
  await h.get('#connect').onclick();assert.equal(h.run('document.activeElement'),h.get('#requirement-ref'));
  h.get('#disconnect').onclick();h.run("navigate('tasks')");
  assert.match(h.get('#task-rows').children[0].children[0].textContent,/Zuerst.*verbinden/);assert.equal(h.get('#refresh-tasks').disabled,true);
});

test('successful intake clears hiding filters and opens the saved task evidence',async()=>{
  const created={id:'new-task',title:'Portal',project:'demo',status:'queued',provider:'auto',attempt:0,requirementRef:'[[Features/Portal]]'};
  const h=harness(async(url,options)=>response(options.method==='POST'?created:url.split('?')[0].endsWith('/events')?{events:[{seq:1,kind:'submitted'}]}:{tasks:[created]}));
  h.run("token='admin'");for(const [id,value] of Object.entries({'#project':'demo','#intake-mode':'vault','#requirement-ref':'[[Features/Portal]]','#provider':'auto','#priority':'1','#task-search':'old filter','#task-status':'simulated'}))h.get(id).value=value;
  await h.get('#task-form').onsubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.get('#task-search').value,'');assert.equal(h.get('#task-status').value,'');assert.equal(h.run('selectedTaskId'),'new-task');assert.equal(h.get('#task-detail').hidden,false);assert.match(h.get('#task-events').textContent,/submitted/);
  h.get('#new-task').onclick();assert.equal(h.run('tab'),'intake');assert.equal(h.run('document.activeElement'),h.get('#requirement-ref'));
});

test('closing task evidence ignores late events and task-scoped metrics can return to the task',async()=>{
  const pending=deferred();let calls=0;
  const task={id:'task-1',title:'Portal',project:'demo'};
  const h=harness(async(url)=>{if(url.split('?')[0].endsWith('/events'))return ++calls===1?pending.promise:response({events:[{seq:2,kind:'reviewed'}]});return response({tasks:[task]})});
  h.run(`token='admin';tab='tasks';tasksCache=[${JSON.stringify(task)}]`);
  const first=h.run('showTask(tasksCache[0])');h.get('#close-task-detail').onclick();pending.resolve(response({events:[{seq:1,kind:'old-event'}]}));await first;
  assert.equal(h.get('#task-detail').hidden,true);assert.doesNotMatch(h.get('#task-events').textContent,/old-event/);assert.equal(h.get('#refresh-task-events').disabled,false);
  h.run("tab='metrics';metricTaskId='task-1'");h.get('#return-to-task').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.run('tab'),'tasks');assert.equal(h.run('selectedTaskId'),'task-1');assert.match(h.get('#task-events').textContent,/reviewed/);assert.match(h.get('#task-event-state').textContent,/Gelesen/);
  h.get('#refresh-task-events').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,3);
});


test('snapshot inspection never keeps unrelated evidence visible after filtering',()=>{
  const h=harness(async()=>response({snapshots:[]}));
  h.run("token='admin';selectedSnapshotId='outside-filter';metricRecords=[]");h.get('#snapshot-inspector').hidden=false;h.get('#snapshot-detail').textContent='old evidence';
  h.run('renderMetrics()');assert.equal(h.get('#snapshot-inspector').hidden,true);assert.equal(h.get('#snapshot-detail').textContent,'');assert.equal(h.run('selectedSnapshotId'),'');
});
