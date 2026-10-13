import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { taskInput } from '../../../src/orchestrator/dist/shared/validation.js';
import { parseRequirementRef } from '../../../src/orchestrator/dist/shared/wiki.js';
import { Store } from '../../../src/orchestrator/dist/orchestrator/persistence/store.js';

const minimal={project:'demo',requirementRef:'[[Features/Customer portal]]'};
const invalid=fn=>assert.throws(fn,error=>error.code==='invalid_input');
test('minimal vault intake derives display metadata without inventing acceptance criteria',()=>{
  const task=taskInput(minimal);
  assert.equal(task.title,'Customer portal');assert.equal(task.requirementRef,minimal.requirementRef);
  assert.deepEqual(task.criteria,[]);assert.deepEqual(task.wikilinks,[minimal.requirementRef]);
  assert.equal(task.provider,'auto');assert.equal(task.priority,1);assert.equal(task.source,undefined);
  assert.deepEqual(taskInput({...minimal,provider:'codex',priority:2}).criteria,[]);
  assert.deepEqual(taskInput(task),task);
});
test('vault links preserve heading, block and alias while normalizing path syntax',()=>{
  assert.equal(parseRequirementRef(' [[ Features/Customer portal.md # Sign in | Portal ]] ').wikilink,'[[Features/Customer portal#Sign in|Portal]]');
  assert.equal(parseRequirementRef('[[Features/Customer portal#^acceptance-1]]').anchor,'^acceptance-1');
  assert.equal(parseRequirementRef('[[Features/Customer portal#Flows#Login]]').anchor,'Flows#Login');
  const task=taskInput({...minimal,requirementRef:'[[Features/Customer portal.md|Portal]]',wikilinks:['[[Features/Customer portal|Portal]]','[[Quality/DoD.md]]']});
  assert.equal(task.title,'Portal');assert.deepEqual(task.wikilinks,['[[Features/Customer portal|Portal]]','[[Quality/DoD]]']);
});
test('vault refs reject missing, absolute, traversal, URI, multiple and malformed links',()=>{
  for(const requirementRef of [null,42,'','Features/Portal','[[/Features/Portal]]','[[C:/vault/Portal]]','[[../Portal]]','[[Features/../Portal]]','[[Features/ .. /Portal]]','[[https://example.org/Portal]]','[[obsidian://open?vault=work]]','[[Features\\Portal]]','[[~/Portal]]','[[Portal]] [[Other]]','[[Portal|]]','[[Portal|Alias|Other]]','[[Portal#]]','[[Portal#^]]','[[Portal#^bad block]]','[[#Local heading]]','[[Portal\nname]]','[[Portal\u0000name]]','[[Portal\u0085name]]','[[Portal\u2028name]]','[[Features//Portal]]'])invalid(()=>taskInput({...minimal,requirementRef}));
  invalid(()=>taskInput({...minimal,criteria:null}));
});
test('legacy manual intake still requires title and explicit acceptance criteria',()=>{
  for(const task of [{project:'demo'},{project:'demo',title:'Manual'}, {project:'demo',title:'Manual',criteria:[]},{project:'demo',criteria:['Accepted']},{project:'demo',title:'',criteria:['Accepted']}])invalid(()=>taskInput(task));
  const manual=taskInput({project:'demo',title:'Manual',criteria:['Accepted'],wikilinks:['[[DoD]]']});
  assert.equal(manual.title,'Manual');assert.equal(manual.requirementRef,undefined);assert.deepEqual(manual.criteria,['Accepted']);
});
test('vault reference survives SQLite reopen and equivalent syntax reuses idempotency',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'werk-vault-task-'));const path=join(dir,'factory.sqlite');let store;
  try {
    store=new Store(path);const task=store.submit(minimal,'vault-ref-1');
    assert.equal(store.submit({...minimal,requirementRef:' [[Features/Customer portal.md]] '},'vault-ref-1').id,task.id);
    store.close();store=new Store(path);
    const restored=store.get(task.id);assert.equal(restored.requirementRef,minimal.requirementRef);assert.deepEqual(restored.criteria,[]);
    assert.throws(()=>store.submit({...minimal,requirementRef:'[[Features/Other]]'},'vault-ref-1'),error=>error.code==='conflict');
  } finally {store?.close();await rm(dir,{recursive:true,force:true});}
});

const html=await readFile(new URL('../../../src/orchestrator/public/index.html',import.meta.url),'utf8');
function harness(fetch) {
  const nodes=new Map();
  class Element {
    constructor(){this.value='';this.children=[];this.dataset={};this.textContent='';this.attributes={};this.hidden=false;this.disabled=false;this.required=false;}
    append(...values){this.children.push(...values)}replaceChildren(...values){this.children=values}
    setAttribute(key,value){this.attributes[key]=value}removeAttribute(key){delete this.attributes[key]}
    focus(){document.activeElement=this}querySelectorAll(){return []}get firstElementChild(){return this.children[0]}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};
  for(const [id,value] of Object.entries({'#project':'demo','#intake-mode':'vault','#provider':'auto','#priority':'1'}))get(id).value=value;
  const document={querySelector:get,querySelectorAll:()=>[],getElementById:id=>get('#'+id),createElement:()=>new Element(),createElementNS:()=>new Element(),hidden:false,activeElement:null};
  const context=vm.createContext({document,fetch,crypto:{randomUUID},AbortSignal,AbortController,Date,console,setInterval:()=>{},URLSearchParams});
  vm.runInContext(html.split('<script>')[1].split('</script>')[0],context);
  return {get,run:code=>vm.runInContext(code,context)};
}
const response=body=>({ok:true,status:200,json:async()=>body});
test('runtime defaults to one vault link and sends no manufactured manual fields',async()=>{
  const payloads=[];const ui=harness(async(_url,options)=>{if(options.method==='POST'){payloads.push(JSON.parse(options.body));return response({id:'created',requirementRef:minimal.requirementRef})}return response({tasks:[]})});
  ui.run("token='admin'");ui.get('#requirement-ref').value=minimal.requirementRef;
  assert.equal(ui.get('#manual-fields').hidden,true);assert.equal(ui.get('#title').disabled,true);assert.equal(ui.get('#requirement-ref').required,true);
  await ui.get('#task-form').onsubmit({preventDefault(){}});
  assert.deepEqual(payloads,[minimal]);assert.equal(ui.get('#requirement-ref').value,'');assert.match(ui.get('#message').textContent,/Kontext noch nicht aufgelöst/);
  assert.match(html,/id="intake-options"/);assert.match(html,/Optionen und manuelle Eingabe/);
});
test('runtime preserves ref drafts across mode changes and reuses failed request keys',async()=>{
  const requests=[];let failed=true;
  const ui=harness(async(_url,options)=>{if(options.method==='POST'){requests.push({body:JSON.parse(options.body),key:options.headers['Idempotency-Key']});if(failed){failed=false;throw Error('network timeout')}return response({id:'created'})}return response({tasks:[]})});
  ui.run("token='admin'");ui.get('#requirement-ref').value=minimal.requirementRef;
  ui.get('#intake-mode').value='manual';ui.get('#intake-mode').onchange();ui.get('#title').value='Manual draft';ui.get('#criteria').value='Accepted';
  assert.equal(ui.get('#requirement-ref').disabled,true);assert.equal(ui.get('#title').required,true);
  ui.get('#intake-mode').value='vault';ui.get('#intake-mode').onchange();assert.equal(ui.get('#requirement-ref').value,minimal.requirementRef);assert.equal(ui.get('#title').value,'Manual draft');
  await ui.get('#task-form').onsubmit({preventDefault(){}});assert.equal(ui.get('#requirement-ref').value,minimal.requirementRef);
  await ui.get('#task-form').onsubmit({preventDefault(){}});assert.equal(requests.length,2);assert.equal(requests[0].key,requests[1].key);assert.deepEqual(requests[0].body,minimal);
});
test('runtime manual mode remains explicit and edits after a failed request get a new key',async()=>{
  const requests=[];const ui=harness(async(_url,options)=>{if(options.method==='POST'){requests.push({body:JSON.parse(options.body),key:options.headers['Idempotency-Key']});throw Error('offline')}return response({tasks:[]})});
  ui.run("token='admin'");ui.get('#intake-mode').value='manual';ui.get('#intake-mode').onchange();ui.get('#title').value='Manual';ui.get('#criteria').value='Accepted';
  await ui.get('#task-form').onsubmit({preventDefault(){}});
  assert.equal(requests[0].body.requirementRef,undefined);assert.deepEqual(requests[0].body.criteria,['Accepted']);
  ui.get('#intake-mode').value='vault';ui.get('#intake-mode').onchange();ui.get('#requirement-ref').value=minimal.requirementRef;
  await ui.get('#task-form').onsubmit({preventDefault(){}});assert.notEqual(requests[0].key,requests[1].key);assert.deepEqual(requests[1].body,minimal);
});
