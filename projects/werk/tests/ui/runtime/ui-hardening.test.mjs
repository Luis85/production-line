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

test('repeated keyboard connection requests make one authentication call',async()=>{
  const pending=deferred();let calls=0;
  const h=harness(()=>{calls++;return pending.promise});h.get('#token').value='admin';
  const first=h.get('#connect').onclick();await h.get('#connect').onclick();
  assert.equal(calls,1);assert.equal(h.get('#connect').disabled,true);
  pending.reject(Error('offline'));await first;
  assert.equal(h.get('#connect').disabled,false);assert.equal(h.run('connecting'),false);
  assert.equal(h.get('#token').value,'admin');
});

test('disconnect during authentication invalidates the response and permits reconnecting',async()=>{
  const pending=deferred();const h=harness(()=>pending.promise);h.get('#token').value='admin';
  const first=h.get('#connect').onclick();h.get('#disconnect').onclick();pending.resolve(response({tasks:[]}));await first;
  assert.equal(h.run('token'),'');assert.equal(h.run('connecting'),false);
  assert.equal(h.get('#connect').disabled,false);assert.equal(h.get('#connect').textContent,'Verbinden');
});

test('worker malformed status preserves the complete last good response and recovers',async()=>{
  const good={workerId:'worker-1',project:'demo',state:'idle',updatedAt:new Date().toISOString(),activeTasks:[{id:'task-1',attempt:1,profile:'mock'}],profiles:[{id:'mock',provider:'local',mode:'mock'}],maxParallel:2};
  let next=good;const script=statusHtml().split('<script>')[1].split('</script>')[0];
  const h=harness(async()=>response(next),script);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.get('#active-rows').children[0].children[0].textContent,'task-1');
  const prior=h.get('#values').children;
  for(const invalid of [null,{}, {...good,activeTasks:[null]}, {...good,profiles:[null]}, {...good,maxParallel:'many'}]){
    next=invalid;await h.get('#refresh').onclick();
    assert.equal(h.get('#values').children,prior);assert.equal(h.get('#active-rows').children[0].children[0].textContent,'task-1');
    assert.equal(h.get('#error').dataset.kind,'error');assert.match(h.get('#freshness').textContent,/may be stale/);
    assert.equal(h.get('#refresh').disabled,false);
  }
  next={...good,state:'executing'};await h.get('#refresh').onclick();
  assert.equal(h.get('#state-label').textContent,'Executing simulations');assert.equal(h.get('#error').dataset.kind,'info');
});

test('worker status live region announces recovery rather than every polling timestamp',async()=>{
  const good={state:'idle',activeTasks:[],profiles:[],maxParallel:1};
  const h=harness(async()=>response(good),statusHtml().split('<script>')[1].split('</script>')[0]);await new Promise(resolve=>setImmediate(resolve));
  const node=h.get('#error'),message=node.textContent;let writes=0;
  Object.defineProperty(node,'textContent',{get:()=>message,set:()=>writes++});
  await h.get('#refresh').onclick();assert.equal(writes,0);
});
