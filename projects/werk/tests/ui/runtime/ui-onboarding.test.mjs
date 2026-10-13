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
  const document={querySelector:get,querySelectorAll:()=>[],createElement:()=>new Element(),createElementNS:()=>new Element(),activeElement:null,hidden:false};
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


test('first run gates operational content and shows release credential guidance without requesting data',()=>{
  let calls=0;const h=harness(async()=>{calls++;return response({})});
  assert.match(html,/\.werk\/credentials\.json/);assert.match(html,/WERK_ADMIN_TOKEN/);assert.match(html,/werk-docker\.ps1 credentials/);assert.match(html,/credential-export\/credentials\.json/);assert.match(h.get('#heading').textContent,/Willkommen/);
  for(const id of ['intake','tasks','workers','metrics','runtime-nav','runtime-sync'])assert.equal(h.get('#'+id).hidden,true);
  assert.equal(h.get('#connection-guide').hidden,false);h.tick();assert.equal(calls,0);
});

test('login learns project from authenticated overview without downloading inventory',async()=>{
  const paths=[];const h=harness(async path=>{paths.push(path);return response(path==='/v1/overview'?{project:'release-project'}:page('tasks',[]))});h.get('#project').value='demo';h.get('#token').value='admin';
  await h.get('#connect').onclick();await settle();assert.deepEqual(paths,['/v1/overview','/v1/tasks?limit=50']);assert.equal(h.get('#project').value,'release-project');assert.equal(h.get('#connection-guide').hidden,true);assert.equal(h.get('#intake').hidden,false);assert.equal(h.get('#first-task-help').hidden,false);
});

test('a project edited during login is never replaced by the arriving server default',async()=>{
  const pending=deferred();const h=harness(async path=>path==='/v1/overview'?pending.promise:response(page('tasks',[])));h.get('#project').value='demo';h.get('#token').value='admin';const connecting=h.get('#connect').onclick();
  h.get('#project').value='my-draft';h.get('#project').oninput();pending.resolve(response({project:'release-project'}));await connecting;assert.equal(h.get('#project').value,'my-draft');assert.match(h.get('#project-help').textContent,/release-project/);
});

test('invalid credentials and a unavailable server give distinct recoverable login feedback',async()=>{
  let code=401;const h=harness(async path=>code?response({error:'internal text'},code):response(path==='/v1/overview'?{project:'demo'}:page('tasks',[])));h.get('#token').value='candidate';await h.get('#connect').onclick();assert.match(h.get('#message').textContent,/Token nicht akzeptiert/);assert.equal(h.get('#token').attributes['aria-invalid'],'true');assert.equal(h.get('#connect').disabled,false);
  code=503;await h.get('#connect').onclick();assert.match(h.get('#message').textContent,/Startterminal/);assert.equal(h.get('#token').attributes['aria-invalid'],'false');assert.equal(h.run('document.activeElement'),h.get('#token'));
  code=0;await h.get('#connect').onclick();assert.equal(h.get('#token').value,'');assert.equal(h.get('#token').attributes['aria-invalid'],undefined);
});

test('first manual task shortcut preserves draft and focuses the real form without submitting',()=>{
  let calls=0;const h=harness(async()=>{calls++;return response({})});h.run("token='admin'");h.get('#title').value='Existing title';h.get('#criteria').value='Existing criterion';h.get('#first-manual-task').onclick();
  assert.equal(h.get('#intake-mode').value,'manual');assert.equal(h.get('#intake-options').open,true);assert.equal(h.get('#title').value,'Existing title');assert.equal(h.get('#criteria').value,'Existing criterion');assert.equal(h.run('document.activeElement'),h.get('#title'));assert.equal(calls,0);
});

test('first task guidance disappears for an existing task and missing-worker help only describes the empty first page',async()=>{
  const h=harness(async()=>response(page('tasks',[task('existing')])));h.run("token='admin'");await h.run('refresh()');assert.equal(h.get('#first-task-help').hidden,true);
  h.run('renderWorkers([])');assert.equal(h.get('#worker-empty-help').hidden,false);h.run("workerPage.previous=[null];renderWorkers([])");assert.equal(h.get('#worker-empty-help').hidden,true);h.run('workerPage.previous=[];renderWorkers([{id:"w",profiles:[],project:"demo"}])');assert.equal(h.get('#worker-empty-help').hidden,true);
});

test('task guidance follows server status while remaining explicit about simulated evidence',()=>{
  const h=harness(async()=>response({}));h.run(`selectedTaskId='first';tasksCache=[${JSON.stringify(task('first'))}];renderTasks()`);assert.match(h.get('#task-next-step').textContent,/wartet.*Worker/);assert.equal(h.get('#inspect-workers').hidden,false);
  h.run("tasksCache[0].status='simulated';renderTasks()");assert.match(h.get('#task-next-step').textContent,/Testlauf simuliert.*keine Umsetzung/);assert.equal(h.get('#inspect-workers').hidden,true);assert.equal(h.run('selectedTask.status'),'simulated');
});

test('logout returns to welcome, removes token and hides operational panels while preserving unsent drafts',()=>{
  const h=harness(async()=>response({}));h.run("token='admin';tab='tasks'");h.get('#title').value='Unsent draft';h.get('#token').value='secret';h.get('#disconnect').onclick();assert.equal(h.get('#title').value,'Unsent draft');assert.equal(h.get('#token').value,'');assert.equal(h.run('token'),'');assert.equal(h.get('#connection-guide').hidden,false);assert.equal(h.get('#tasks').hidden,true);assert.equal(h.get('#runtime-nav').hidden,true);assert.equal(h.run('document.activeElement'),h.get('#token'));
});


test('viewer login keeps evidence available and prevents task mutation including direct submit',async()=>{
  const paths=[];const h=harness(async path=>{paths.push(path);return response(path==='/v1/overview'?{project:'demo',access:{principal:{id:'reader',role:'viewer'},permissions:{read:true,write:false}},workers:{online:0}}:page('tasks',[]))});h.get('#token').value='reader';await h.get('#connect').onclick();await settle();
  assert.equal(h.get('#task-form').hidden,true);assert.equal(h.get('#new-task').disabled,true);assert.match(h.get('#access-summary').textContent,/nur lesen/);assert.match(h.get('#line-readiness').textContent,/Kein Worker online/);
  const count=paths.length;await h.get('#task-form').onsubmit({preventDefault(){}});assert.equal(paths.length,count);assert.match(h.get('#message').textContent,/Nur Lesezugriff/);
  h.get('#disconnect').onclick();assert.equal(h.get('#access-summary').hidden,true);assert.equal(h.run('readinessObservation'),null);
});

test('readiness retry rejects an old session response and distinguishes unknown from zero workers',async()=>{
  const pending=deferred();const h=harness(()=>pending.promise);h.run("token='admin';readinessObservation={overview:{workers:{}},at:Date.now()};renderReadiness()");assert.match(h.get('#line-readiness').textContent,/unbekannt/);
  const checking=h.get('#check-readiness').onclick();h.get('#disconnect').onclick();pending.resolve(response({workers:{online:4}}));await checking;assert.equal(h.run('readinessObservation'),null);assert.doesNotMatch(h.get('#line-readiness').textContent,/4 Worker/);
});

test('explicit live mode uses Codex manual intake and review never claims accepted work',()=>{
  const h=harness(async()=>response({}));h.get('#project').value='demo';h.get('#title').value='Retained draft';h.get('#criteria').value='Criterion';h.get('#wikilinks').value='';h.get('#priority').value='1';h.get('#execution-mode').value='cli';h.get('#execution-mode').onchange();
  assert.equal(h.get('#intake-mode').value,'manual');assert.equal(h.get('#provider').value,'codex');assert.equal(h.get('#provider').disabled,true);assert.equal(h.get('#title').value,'Retained draft');assert.equal(h.run('intakePayload().executionMode'),'cli');assert.equal(h.run('intakePayload().provider'),'codex');
  h.run("taskGuidance({status:'review'})");assert.match(h.get('#task-next-step').textContent,/Basis-Commit.*SHA-256/);assert.match(h.get('#task-next-step').textContent,/nichts wurde automatisch/);
  h.get('#execution-mode').value='mock';h.get('#execution-mode').onchange();assert.equal(h.run('intakePayload().executionMode'),undefined);assert.equal(h.get('#provider').disabled,false);
});

test('malformed declared access fails closed without converting missing readiness to healthy',()=>{
  const h=harness(async()=>response({}));h.run("token='test';applyAccess({permissions:{write:true},principal:{role:'unexpected'}});renderReadiness()");assert.equal(h.get('#task-form').hidden,true);assert.match(h.get('#line-readiness').textContent,/unbekannt/);
});
