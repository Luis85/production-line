import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../../../src/orchestrator/public/experience.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
function routingHarness(api){
  const nodes=new Map();
  class Element{
    constructor(tag='div',text=''){this.tag=tag;this.textContent=text;this.children=[];this.disabled=false;this.value='';this.events={};this.hidden=false;}
    set id(value){this._id=value;nodes.set('#'+value,this);}get id(){return this._id;}
    append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
    prepend(...children){this.children.unshift(...children);}after(){}replaceChildren(...children){this.children=[];this.append(...children);}
    setAttribute(){}reset(){}addEventListener(name,fn){this.events[name]=fn;}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const el=(tag,text)=>new Element(tag,text),button=(text,fn)=>{const n=el('button',text);n.onclick=fn;return n;};
  const context=vm.createContext({document:{querySelector:get},WerkSpatial:{el,button},api,console});
  vm.runInContext(`let token='admin',canWrite=true,sessionId=1,selectedTaskId='a',tab='tasks';const names={},leads={};const $=document.querySelector;function showTask(task){selectedTaskId=task.id;return Promise.resolve();}function clearSession(){sessionId++;token='';canWrite=false;}function expireAuthentication(){return false;}`,context);
  vm.runInContext(source.slice(source.indexOf('/* Dashboard, routing controls')),context);
  return{get,run:code=>vm.runInContext(code,context)};
}
test('task routing retains pending edits on event reload and ignores another task late errors',async()=>{
  const pending=deferred(),h=routingHarness(()=>pending.promise);
  await h.run("showTask({id:'a',status:'queued'})");
  const destination=h.get('#task-destination'),form=destination.parentElement,note=form.children.at(-1),save=form.children.at(-2);
  destination.value='worker-a';await h.run("showTask({id:'a',status:'queued'})");assert.equal(destination.value,'worker-a');
  const saving=form.onsubmit({preventDefault(){}});assert.equal(destination.disabled,true);assert.equal(save.disabled,true);
  await h.run("showTask({id:'b',status:'queued'})");destination.value='worker-b';pending.reject(Error('Old task failure'));await saving;
  assert.equal(destination.value,'worker-b');assert.equal(note.textContent,'');assert.equal(destination.disabled,false);
});
test('line routing freezes controls during loading and save, keeping selected values on failure',async()=>{
  const readPolicy=deferred(),readWorkers=deferred(),saved=deferred();let calls=0;
  const h=routingHarness(path=>++calls===1?readPolicy.promise:calls===2?readWorkers.promise:saved.promise);
  const mode=h.get('#routing-mode'),order=h.get('#routing-order'),worker=h.get('#routing-worker'),form=mode.parentElement,save=form.children.at(-2);
  const panel=h.get('#line-routing');panel.open=true;const reading=panel.events.toggle();
  assert.equal(mode.disabled,true);assert.equal(order.disabled,true);assert.equal(save.disabled,true);
  readPolicy.resolve({mode:'manual',order:'fifo',workerId:'worker-a'});readWorkers.resolve({workers:[{id:'worker-a',online:true}]});await reading;
  assert.equal(mode.disabled,false);assert.equal(worker.disabled,false);assert.equal(worker.value,'worker-a');
  order.value='priority';const saving=form.onsubmit({preventDefault(){}});assert.equal(mode.disabled,true);assert.equal(worker.disabled,true);
  await form.onsubmit({preventDefault(){}});assert.equal(calls,3);
  saved.reject(Error('Save failed'));await saving;assert.equal(order.value,'priority');assert.equal(mode.disabled,false);assert.equal(form.children.at(-1).textContent,'Save failed');
});
test('authenticated task handoff opens the requested task and ignores late fetch after navigation',async()=>{
  const pending=deferred(),nodes=new Map(),shown=[];
  const get=id=>{if(!nodes.has(id))nodes.set(id,{value:'filter'});return nodes.get(id);};
  const context=vm.createContext({URLSearchParams,location:{hash:'#tasks?task=saved-task'},window:{addEventListener(){}},api:()=>pending.promise,document:{querySelector:get},shown});
  vm.runInContext(`const names={tasks:'Tasks',system:'Dashboard'};const $=document.querySelector;let sessionId=1,detailId=0,tab='system',replaying=false,token='admin';function navigate(page){tab=page;detailId++;}function showTask(task){shown.push(task.id);}function expireAuthentication(){return false;}function message(){}`,context);
  const start=source.indexOf('  function workspaceRoute()'),end=source.indexOf('  const rawRefresh=',start);vm.runInContext(source.slice(start,end),context);
  const reading=vm.runInContext('openWorkspaceRoute()',context);assert.equal(get('#task-search').value,'');assert.equal(get('#task-status').value,'');
  pending.resolve({id:'saved-task'});await reading;assert.deepEqual(shown,['saved-task']);
  const late=deferred();context.api=()=>late.promise;const second=vm.runInContext('openWorkspaceRoute()',context);vm.runInContext("navigate('system')",context);late.resolve({id:'stale-task'});await second;assert.deepEqual(shown,['saved-task']);
  const older=deferred(),newer=deferred();let calls=0;context.api=()=>++calls===1?older.promise:newer.promise;
  context.location.hash='#tasks?task=older';const firstRoute=vm.runInContext('openWorkspaceRoute()',context);
  context.location.hash='#tasks?task=newer';const nextRoute=vm.runInContext('openWorkspaceRoute()',context);
  older.resolve({id:'older'});await firstRoute;assert.deepEqual(shown,['saved-task']);
  newer.resolve({id:'newer'});await nextRoute;assert.deepEqual(shown,['saved-task','newer']);

});
