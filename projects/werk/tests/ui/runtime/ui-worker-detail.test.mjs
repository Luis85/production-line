import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const html=await readFile(new URL('../../../src/orchestrator/public/index.html',import.meta.url),'utf8');
const script=html.split('<script>')[1].split('</script>')[0];
function harness(fetch){
  const nodes=new Map(),timers=[];
  class Element {
    value='';textContent='';children=[];dataset={};attributes={};hidden=false;disabled=false;
    append(...children){this.children.push(...children)}
    replaceChildren(...children){this.children=children}
    setAttribute(key,value){this.attributes[key]=value}
    removeAttribute(key){delete this.attributes[key]}
    focus(){document.activeElement=this}
    closest(){return this}
    querySelectorAll(){return []}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};
  const document={querySelector:get,querySelectorAll:selector=>selector==='[data-worker-id]'?get('#worker-rows').children.map(row=>row.children[0]?.children[0]).filter(Boolean):[],createElement:()=>new Element(),createElementNS:()=>new Element(),activeElement:null,hidden:false};
  const context=vm.createContext({document,fetch,crypto:{randomUUID},AbortSignal,AbortController,Date,setInterval:fn=>timers.push(fn)});
  vm.runInContext(script,context);return {get,run:source=>vm.runInContext(source,context),tick:()=>timers.forEach(fn=>fn())};
}
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const page=(key,items,nextCursor=null)=>({[key]:items,hasMore:nextCursor!==null,nextCursor});
const task=id=>({id,title:'Feature '+id,project:'demo',status:'queued',provider:'auto',attempt:0});
const worker=id=>({id,project:'demo',online:true,seen:Date.now(),profiles:[],config:{maxParallel:2}});
const event=seq=>({seq,kind:'observed',at:Date.now(),detail:{step:seq}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};


const detail=(id='worker-a')=>({id,project:'demo',seen:Date.now(),online:true,profiles:[{id:'codex-profile',provider:'codex',mode:'mock',maxParallel:2}],config:{maxParallel:2,order:'priority',maxAttempts:3},activeTasks:[{id:'task-active',status:'running',attempt:1,expiresAt:Date.now()+60000,profile:'codex-profile'}],activeTasksTruncated:false});
const setup=h=>h.run("token='admin';tab='workers'");

test('selecting a worker opens its own bounded detail and safely renders profiles/capacity/active tasks',async()=>{
  const paths=[];const h=harness(async path=>{paths.push(path);return response(detail())});setup(h);h.run(`renderWorkers([${JSON.stringify(worker('worker-a'))}])`);const button=h.get('#worker-rows').children[0].children[0].children[0];await button.onclick();
  assert.deepEqual(paths,['/v1/workers/worker-a']);assert.equal(h.get('#worker-list').hidden,true);assert.equal(h.get('#worker-detail').hidden,false);assert.equal(h.run('document.activeElement'),h.get('#worker-detail-heading'));
  assert.equal(h.get('#worker-profile-rows').children[0].children[2].textContent,'Simuliert');assert.equal(h.get('#worker-active-rows').children[0].children[0].textContent,'task-active');assert.match(h.get('#worker-active-count').textContent,/1 aktive.*maximal 8/);assert.equal(h.get('#worker-detail-facts').children[3].children[1].textContent,'2');
});

test('a failed refresh preserves worker data with explicit staleness and retry recovers',async()=>{
  let failed=false;const h=harness(async()=>failed?response({error:'unavailable'},503):response(detail()));setup(h);await h.run("showWorker('worker-a')");const rows=h.get('#worker-profile-rows').children;failed=true;await h.get('#refresh-worker-detail').onclick();assert.equal(h.get('#worker-profile-rows').children,rows);assert.match(h.get('#worker-detail-state').textContent,/Veralteter letzter Stand/);assert.equal(h.get('#refresh-worker-detail').disabled,false);
  failed=false;await h.get('#refresh-worker-detail').onclick();assert.match(h.get('#worker-detail-state').textContent,/Gelesen/);
});

test('late worker detail cannot replace the selection of another worker',async()=>{
  const pending=deferred();const h=harness(async path=>path.endsWith('worker-a')?pending.promise:response(detail('worker-b')));setup(h);const first=h.run("showWorker('worker-a')");await h.run("showWorker('worker-b')");pending.resolve(response(detail('worker-a')));await first;assert.equal(h.run('workerDetailData.id'),'worker-b');assert.equal(h.get('#worker-detail-heading').textContent,'Worker worker-b');
});

test('back restores worker identity focus and cancels a late response',async()=>{
  const pending=deferred();const h=harness(()=>pending.promise);setup(h);h.run(`renderWorkers([${JSON.stringify(worker('worker-a'))}])`);const button=h.get('#worker-rows').children[0].children[0].children[0];const opening=button.onclick();h.get('#close-worker-detail').onclick();assert.equal(h.run('document.activeElement'),button);assert.equal(h.get('#worker-list').hidden,false);pending.resolve(response(detail()));await opening;assert.equal(h.get('#worker-detail').hidden,true);assert.equal(h.get('#worker-detail-heading').textContent,'');
});

test('logout removes hidden worker identity/data and ignores old-session authentication errors',async()=>{
  let pending;const h=harness(async()=>pending?pending.promise:response(detail()));setup(h);await h.run("showWorker('worker-a')");pending=deferred();const late=h.get('#refresh-worker-detail').onclick();h.get('#disconnect').onclick();assert.equal(h.run('workerDetailData'),null);assert.equal(h.get('#worker-detail-facts').children.length,0);assert.equal(h.get('#worker-detail-heading').textContent,'');
  h.run("token='replacement';tab='workers'");pending.resolve(response({error:'old token'},401));await late;assert.equal(h.run('token'),'replacement');assert.equal(h.get('#worker-detail').hidden,true);
});

test('worker authentication expiry ends the current session and focuses login',async()=>{
  const h=harness(async()=>response({error:'expired'},401));setup(h);await h.run("showWorker('worker-a')");assert.equal(h.run('token'),'');assert.equal(h.run('document.activeElement'),h.get('#token'));assert.equal(h.get('#worker-detail').hidden,true);
});

test('missing workers and malformed/oversized details remain recoverable without false empty success',async()=>{
  let value=response({error:'missing'},404);const h=harness(async()=>value);setup(h);await h.run("showWorker('worker-a')");assert.match(h.get('#worker-detail-state').textContent,/nicht gefunden/);assert.equal(h.get('#worker-detail-content').hidden,true);
  for(const malformed of [{...detail(),activeTasks:Array.from({length:9},()=>detail().activeTasks[0])},{...detail(),seen:1e30},{...detail(),id:'other-line-worker'}]){value=response(malformed);await h.get('#refresh-worker-detail').onclick();assert.match(h.get('#worker-detail-state').textContent,/Keine Worker-Details geladen/);assert.equal(h.get('#worker-detail-content').hidden,true)}
  value=response({...detail(),activeTasksTruncated:true});await h.get('#refresh-worker-detail').onclick();assert.match(h.get('#worker-active-count').textContent,/unvollständig/);
});

test('worker detail polling reads only its bounded endpoint, preserves focus and honors pause',async()=>{
  const paths=[];const h=harness(async path=>{paths.push(path);return response(detail())});setup(h);await h.run("showWorker('worker-a')");const close=h.get('#close-worker-detail');close.focus();h.tick();await settle();assert.deepEqual(paths,['/v1/workers/worker-a','/v1/workers/worker-a']);assert.equal(h.run('document.activeElement'),close);
  h.get('#pause-updates').onclick();h.tick();await settle();assert.equal(paths.length,2);h.get('#pause-updates').onclick();await settle();assert.equal(paths.at(-1),'/v1/workers/worker-a');assert.equal(paths.length,3);
});

test('line operations have explicit scope and a separate safe guide link',()=>{
  assert.match(html,/Auftrag an die Linie übergeben/);assert.match(html,/Messwerte der Linie/);assert.doesNotMatch(html,/Feature an die Fabrik übergeben|Portfolio & Health/);assert.match(html,/href="\/guide" target="_blank" rel="noopener noreferrer"/);assert.doesNotMatch(html,/worker\.statusUrl|worker\.statusURL/);
});
