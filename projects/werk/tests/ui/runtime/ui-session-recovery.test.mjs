import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { statusHtml } from '../../../src/worker/status/view.ts';

const sources=Object.fromEntries(await Promise.all(['factory','orchestrator'].map(async name=>[name,(await readFile(new URL('../../../src/'+name+'/public/index.html',import.meta.url),'utf8')).split('<script>')[1].split('</script>')[0]])));
function harness(source,fetch){
  const nodes=new Map(),timers=[];
  class Element {
    value='';textContent='';children=[];dataset={};attributes={};hidden=false;disabled=false;
    constructor(tag='div'){this.tagName=tag.toUpperCase()}
    append(...children){this.children.push(...children)}
    replaceChildren(...children){this.children=children}
    setAttribute(key,value){this.attributes[key]=value}
    removeAttribute(key){delete this.attributes[key]}
    get firstElementChild(){return this.children[0]}
    focus(){document.activeElement=this}
    closest(){return this}
    querySelectorAll(selector){const tags=selector.toUpperCase().split(',');return this.children.filter(node=>tags.includes(node.tagName))}
    reset(){for(const node of this.querySelectorAll('input,select'))node.value=''}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};
  const document={querySelector:get,getElementById:id=>get('#'+id),querySelectorAll:()=>[],createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag),activeElement:null,hidden:false};
  const location={pathname:'/'};
  const context=vm.createContext({document,fetch,crypto:{randomUUID},AbortSignal,AbortController,Date,URL,URLSearchParams,location,history:{pushState(){},replaceState(){}},window:{addEventListener(){}},setInterval:fn=>timers.push(fn)});
  vm.runInContext(source,context);
  return {get,run:script=>vm.runInContext(script,context),tick:()=>Promise.all(timers.map(fn=>fn()))};
}
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body&&['tasks','workers','events'].some(key=>Array.isArray(body[key]))?{hasMore:false,nextCursor:null,...body}:body});
const rejected=()=>({ok:false,status:401,json:async()=>{throw Error('Proxy returned HTML')}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const overview=()=>({observedAt:new Date().toISOString(),factories:[],lines:[],totals:{lines:0,availableLines:0,unavailableLines:0,partial:false,tasks:null,workers:null,snapshots:null}});
const factoryResponse=path=>response(path==='/v1/factories'?{factories:[]}:path==='/v1/lines'?{lines:[]}:overview());

for(const surface of ['factory','orchestrator']){
  const token=surface==='factory'?'state.token':'token';
  const seed=surface==='factory'?"state.token='expired';state.editor={type:'factory',id:null,newId:'draft'}":"token='expired';tab='tasks'";
  const refresh=surface==='factory'?'refresh({registry:false})':'refresh()';
  test(`${surface}: rejected credentials stop polling, preserve input, and allow reconnecting`,async()=>{
    let calls=0,expired=true;
    const h=harness(sources[surface],async path=>{calls++;return expired?rejected():surface==='factory'?factoryResponse(path):response({tasks:[]})});
    h.run(seed);h.get(surface==='factory'?'#factory-name':'#requirement-ref').value='Unsent draft';
    await h.run(refresh);
    assert.equal(h.run(token),'');assert.equal(h.get('#token').value,'');assert.equal(h.run('document.activeElement'),h.get('#token'));
    assert.match(h.get('#message').textContent,/Automatische Abfragen wurden gestoppt/);
    assert.equal(h.get(surface==='factory'?'#factory-name':'#requirement-ref').value,'Unsent draft');
    if(surface==='factory')assert.equal(h.run('state.editor.newId'),'draft');
    const stopped=calls;await h.tick();await settle();assert.equal(calls,stopped);
    expired=false;h.get('#token').value='replacement';
    if(surface==='factory')await h.get('#login-form').onsubmit({preventDefault(){}});else await h.get('#connect').onclick();
    await settle();assert.equal(h.run(token),'replacement');assert.equal(h.get('#disconnect').hidden,false);
  });
  test(`${surface}: a late 401 from an earlier session cannot disconnect a replacement token`,async()=>{
    const pending=deferred();let first=true;
    const h=harness(sources[surface],async path=>{if(first){first=false;return pending.promise}return surface==='factory'?factoryResponse(path):response({tasks:[]})});
    h.run(seed);const old=h.run(refresh);h.get('#disconnect').onclick();h.get('#token').value='replacement';
    if(surface==='factory')await h.get('#login-form').onsubmit({preventDefault(){}});else await h.get('#connect').onclick();
    pending.resolve(rejected());await old;await settle();assert.equal(h.run(token),'replacement');assert.equal(h.get('#disconnect').hidden,false);
  });
  test(`${surface}: a rejected response with a null JSON body still ends the session`,async()=>{
    const h=harness(sources[surface],async()=>response(null,401));h.run(seed);await h.run(refresh);
    assert.equal(h.run(token),'');assert.match(h.get('#message').textContent,/erneut verbinden/);
  });
  test(`${surface}: a transient server failure keeps the session available for retry`,async()=>{
    const h=harness(sources[surface],async()=>response({error:'Temporarily unavailable'},503));h.run(seed);await h.run(refresh);
    assert.equal(h.run(token),'expired');assert.equal(h.get('#message').dataset.kind,'error');
  });
}

test('orchestrator logout clears hidden task identities and metric filter options',()=>{
  const h=harness(sources.orchestrator,async()=>response({tasks:[]}));h.run("token='secret';options('#metric-project',['private-project'],'Alle Projekte');options('#metric-worker',['private-worker'],'Alle Worker');options('#metric-iteration',['private-iteration'],'Alle Iterationen')");
  for(const id of ['task-detail-heading','snapshot-heading','task-snapshot-label'])h.get('#'+id).textContent='private identity';
  h.get('#task-search').value='private query';h.get('#disconnect').onclick();
  for(const id of ['task-detail-heading','snapshot-heading','task-snapshot-label'])assert.equal(h.get('#'+id).textContent,'');
  for(const id of ['metric-project','metric-worker','metric-iteration'])assert.equal(h.get('#'+id).children.length,1);
  assert.equal(h.get('#task-search').value,'');
});

test('orchestrator task-event rejection ends the session, while a late detail rejection cannot end a newer session',async()=>{
  const pending=deferred();let first=true;
  const h=harness(sources.orchestrator,async()=>first?(first=false,pending.promise):response({tasks:[]}));h.run("token='old';tab='tasks'");
  const old=h.run("showTask({id:'task-old',title:'Old task'})");h.get('#disconnect').onclick();h.get('#token').value='new';await h.get('#connect').onclick();
  pending.resolve(rejected());await old;assert.equal(h.run('token'),'new');
  const expired=harness(sources.orchestrator,async()=>rejected());expired.run("token='old';tab='tasks'");await expired.run("showTask({id:'task',title:'Task'})");
  assert.equal(expired.run('token'),'');assert.equal(expired.get('#task-detail').hidden,true);
});

test('worker pause and resume preserve failure until a successful refresh, with paused freshness explicit',async()=>{
  const good={state:'idle',activeTasks:[],profiles:[],maxParallel:1,lastContact:new Date().toISOString()};let failing=false;
  const h=harness(statusHtml().split('<script>')[1].split('</script>')[0],async()=>response(failing?{}:good,failing?503:200));await settle();
  h.get('#pause').onclick();assert.match(h.get('#freshness').textContent,/Updates paused · last response/);
  failing=true;await h.get('#refresh').onclick();assert.equal(h.get('#error').dataset.kind,'error');
  h.get('#pause').onclick();assert.equal(h.get('#error').dataset.kind,'error');await settle();h.get('#pause').onclick();
  assert.equal(h.get('#error').dataset.kind,'error');assert.match(h.get('#error').textContent,/Use Refresh now to retry/);
  failing=false;await h.get('#refresh').onclick();assert.equal(h.get('#error').dataset.kind,'info');assert.match(h.get('#freshness').textContent,/Updates paused/);
});


test('worker CLI view separates acknowledged change sets from simulations and rejects unknown modes',async()=>{
  const good={mode:'cli',state:'executing',completedSimulations:0,completedReviews:2,activeTasks:[],profiles:[{id:'live',provider:'codex',mode:'cli'}],maxParallel:1};let next=good;
  const h=harness(statusHtml().split('<script>')[1].split('</script>')[0],async()=>response(next));await settle();
  assert.equal(h.get('#state-label').textContent,'Executing Codex CLI');assert.match(h.get('#execution-note').textContent,/real changes/);assert.match(h.get('#measurement-note').textContent,/not verified/);
  const nodes=h.get('#values').children;const index=nodes.findIndex(node=>node.textContent==='Acknowledged change sets (this process)');assert.ok(index>=0);assert.equal(nodes[index+1].textContent,2);
  next={...good,mode:'unexpected'};await h.get('#refresh').onclick();assert.equal(h.get('#values').children,nodes);assert.match(h.get('#freshness').textContent,/stale/);
  next={...good,mode:'mock',completedReviews:0};await h.get('#refresh').onclick();assert.equal(h.get('#state-label').textContent,'Executing simulations');assert.match(h.get('#execution-note').textContent,/mock execution/);assert.match(h.get('#measurement-note').textContent,/not an implemented feature/);
});
