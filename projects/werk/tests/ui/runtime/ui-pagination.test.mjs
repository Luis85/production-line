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

for(const [kind,prefix,item]of [['tasks','task',task],['workers','worker',worker]]){
  test(`${kind}: each navigation and poll reads one bounded page; refresh restarts from newest`,async()=>{
    const paths=[];const h=harness(async path=>{paths.push(path);return response(page(kind,[item(path.includes('cursor=')?'older':'newest')],path.includes('cursor=')?null:'next-cursor'))});
    h.run(`token='admin';tab='${kind}'`);await h.run('refresh()');assert.equal(paths.length,1);assert.equal(paths[0],`/v1/${kind}?limit=50`);
    await h.get('#'+prefix+'-next').onclick();assert.equal(paths.length,2);assert.equal(paths[1],`/v1/${kind}?limit=50&cursor=next-cursor`);
    assert.equal(h.get('#'+prefix+'-next').disabled,true);assert.equal(h.get('#'+prefix+'-previous').disabled,false);
    assert.match(h.get('#'+prefix+'-page-state').textContent,/Seite 2.*1 Einträge/);
    h.tick();await settle();assert.equal(paths.length,3);assert.equal(paths[2],paths[1]);
    await h.get('#'+prefix+'-previous').onclick();assert.equal(paths[3],paths[0]);
    await h.get('#'+prefix+'-next').onclick();await h.get('#refresh-'+kind).onclick();assert.equal(paths.at(-1),paths[0]);
    assert.match(h.get('#'+prefix+'-page-state').textContent,/Seite 1/);
  });
}

test('failed or malformed next pages preserve the current rows and cursor for a single-click retry',async()=>{
  const pending=deferred();let result=page('tasks',[task('good')],'next'),calls=0,block=false;
  const h=harness(async()=>{calls++;return block?pending.promise:response(result)});h.run("token='admin';tab='tasks'");await h.run('refresh()');
  const rows=h.get('#task-rows').children;block=true;const inFlight=h.get('#task-next').onclick();await h.get('#task-next').onclick();assert.equal(calls,2);assert.equal(h.get('#task-next').disabled,true);
  pending.resolve(response({error:'offline'},503));await inFlight;block=false;
  assert.equal(h.get('#task-rows').children,rows);assert.equal(h.run('taskPage.cursor'),null);assert.equal(h.get('#task-next').disabled,false);
  for(const invalid of [{tasks:[task('bad')]},page('tasks',[null]),page('tasks',Array.from({length:51},(_,i)=>task(String(i)))),page('tasks',[task('loop')],'next')]){
    result=invalid;await h.get('#task-next').onclick();assert.equal(h.get('#task-rows').children,rows);assert.equal(h.run('taskPage.cursor'),null);assert.equal(h.get('#message').dataset.kind,'error');
  }
  result=page('tasks',[task('recovered')]);await h.get('#task-next').onclick();assert.equal(h.run('tasksCache[0].id'),'recovered');assert.equal(h.run('taskPage.cursor'),'next');
});

test('page-local filters do not claim complete results or trigger inventory downloads',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return response(page('tasks',[task('visible')],'more'))});h.run("token='admin';tab='tasks'");await h.run('refresh()');
  h.get('#task-search').value='not on this page';h.get('#task-search').oninput();assert.equal(calls,1);
  assert.match(h.get('#task-count').textContent,/0 von 1.*dieser Seite/);assert.match(h.get('#task-rows').children[0].children[0].textContent,/Seite/);assert.equal(h.get('#task-next').disabled,false);
});

test('intake and authentication use bounded requests and label imported-feature counts as a sample',async()=>{
  const paths=[];const h=harness(async path=>{paths.push(path);return response(page('tasks',[{...task('imported'),source:{branch:'iteration/demo'}}],'more'))});h.get('#token').value='admin';await h.get('#connect').onclick();await settle();
  assert.equal(paths[0],'/v1/overview');assert.equal(paths[1],'/v1/tasks?limit=50');assert.equal(paths.length,2);
  assert.match(h.get('#import-state').textContent,/1 importierte Features.*keine Gesamtzahl/);
});

test('event pages retain evidence on failure and reject late responses after selecting another task',async()=>{
  const paths=[];let fail=false,late=null;
  const h=harness(async path=>{paths.push(path);if(late)return late.promise;if(fail)return response({error:'offline'},503);return response(page('events',[event(path.includes('cursor=')?2:1)],path.includes('cursor=')?null:'events-next'))});
  h.run("token='admin';tab='tasks'");await h.run(`showTask(${JSON.stringify(task('one'))})`);assert.equal(paths[0],'/v1/tasks/one/events?limit=50');
  const original=h.get('#task-events').textContent;fail=true;await h.get('#event-next').onclick();assert.equal(h.get('#task-events').textContent,original);assert.equal(h.run('eventPage.cursor'),null);assert.equal(h.get('#event-next').disabled,false);
  fail=false;await h.get('#event-next').onclick();assert.equal(JSON.parse(h.get('#task-events').textContent).events[0].seq,2);assert.match(h.get('#task-event-state').textContent,/Seite 2/);
  late=deferred();const slow=h.get('#refresh-task-events').onclick();const old=late;late=null;
  await h.run(`showTask(${JSON.stringify(task('two'))})`);old.resolve(response(page('events',[event(999)])));await slow;
  assert.equal(h.run('selectedTaskId'),'two');assert.deepEqual(JSON.parse(h.get('#task-events').textContent).events.map(item=>item.seq),[1]);
});

test('selected-task snapshots return to their task even after its row leaves the current task page',async()=>{
  const paths=[];const h=harness(async path=>{paths.push(path);return response(path.includes('/events?')?page('events',[event(1)]):path.startsWith('/v1/snapshots')?{snapshots:[],hasMore:false,nextCursor:null}:page('tasks',[task('different')]))});
  h.run("token='admin';tab='tasks'");await h.run(`showTask(${JSON.stringify(task('selected'))})`);await h.run('refresh()');assert.equal(h.run('tasksCache[0].id'),'different');
  h.get('#inspect-task-snapshots').onclick();await settle();h.get('#return-to-task').onclick();await settle();
  assert.equal(h.run('selectedTaskId'),'selected');assert.equal(h.run('tasksCache[0].id'),'different');assert.match(h.get('#task-detail-heading').textContent,/selected/);
  await h.get('#refresh-task-events').onclick();assert.equal(paths.at(-1),'/v1/tasks/selected/events?limit=50');
});

test('newly submitted task opens its own evidence even when the newest page contains other tasks',async()=>{
  const created=task('created');const h=harness(async(path,options)=>response(options.method==='POST'?created:path.includes('/events?')?page('events',[event(1)]):page('tasks',[task('unrelated')])));
  h.run("token='admin'");for(const [id,value]of Object.entries({'project':'demo','intake-mode':'manual','title':'Draft','criteria':'Criterion','provider':'auto','priority':'1'}))h.get('#'+id).value=value;
  await h.get('#task-form').onsubmit({preventDefault(){}});await settle();assert.equal(h.run('selectedTaskId'),'created');assert.equal(h.run('tasksCache[0].id'),'unrelated');assert.match(h.get('#task-events').textContent,/observed/);
});

test('pinned requirement context is labeled from the server while unresolved legacy tasks remain explicit',async()=>{
  const h=harness(async()=>response(page('events',[])));h.run("token='admin';tab='tasks'");
  await h.run(`showTask(${JSON.stringify({...task('pinned'),requirementRef:'[[Features/Test]]',context:{commit:'a'.repeat(40),sha256:'b'.repeat(64)}})})`);
  assert.match(h.get('#task-reference').textContent,/Commit a{40} fixiert.*simuliert/);assert.doesNotMatch(h.get('#task-reference').textContent,/nicht aufgelöst/);
  await h.run(`showTask(${JSON.stringify({...task('legacy'),requirementRef:'[[Features/Test]]'})})`);assert.match(h.get('#task-reference').textContent,/noch nicht aufgelöst/);
});


for(const [kind,prefix,item]of [['tasks','task',task],['workers','worker',worker]]){
  test(`${kind}: bottom controls mirror bounds and focus only successful explicit page navigation`,async()=>{
    let fail=false;const h=harness(async path=>{if(fail)throw Error('offline');return response(page(kind,[item(path.includes('cursor=')?'older':'newest')],path.includes('cursor=')?null:'next'))});
    h.run(`token='admin';tab='${kind}'`);await h.run('refresh()');
    assert.equal(h.get('#'+prefix+'-previous-bottom').disabled,true);assert.equal(h.get('#'+prefix+'-next-bottom').disabled,false);
    const focus=h.get('#task-search');focus.focus();h.tick();await settle();assert.equal(h.run('document.activeElement'),focus);
    fail=true;await h.get('#'+prefix+'-next-bottom').onclick();assert.equal(h.run('document.activeElement'),focus);assert.equal(h.get('#'+prefix+'-next-bottom').disabled,false);
    fail=false;await h.get('#'+prefix+'-next-bottom').onclick();assert.equal(h.run('document.activeElement'),h.get('#'+prefix+'-page-state'));assert.equal(h.get('#'+prefix+'-next-bottom').disabled,true);assert.equal(h.get('#'+prefix+'-previous-bottom').disabled,false);
    await h.get('#'+prefix+'-previous-bottom').onclick();assert.equal(h.get('#'+prefix+'-previous-bottom').disabled,true);assert.match(h.get('#'+prefix+'-page-state').textContent,/Seite 1/);
  });
}


test('a superseded page request never moves focus after a newer refresh completes',async()=>{
  const pending=deferred();const h=harness(async path=>path.includes('cursor=')?pending.promise:response(page('tasks',[task('newest')],'next')));
  h.run("token='admin';tab='tasks'");await h.run('refresh()');const next=h.get('#task-next-bottom').onclick();
  await h.run('refresh({page:firstPage()})');const focus=h.get('#task-search');focus.focus();pending.resolve(response(page('tasks',[task('older')])));await next;
  assert.equal(h.run('document.activeElement'),focus);assert.match(h.get('#task-page-state').textContent,/Seite 1/);
});
