import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { line, task } from '../../ui/helpers/runtime-harness.mjs';
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


test('runtime defaults to one vault link and sends no manufactured manual fields',async()=>{
 const ui=line((_path,init)=>init.method==='POST'?task('created',{requirementRef:minimal.requirementRef}):undefined);ui.state.intake.requirementRef=minimal.requirementRef;assert.equal(ui.state.intake.mode,'vault');await ui.submitTask();assert.deepEqual(ui.calls.find(c=>c.method==='POST').body,minimal);assert.equal(ui.state.intake.requirementRef,'');assert.equal(ui.state.selectedTask.requirementRef,minimal.requirementRef);
});
test('runtime preserves reference drafts across modes and reuses failed request keys',async()=>{
 let failed=true;const ui=line((_path,init)=>{if(init.method==='POST'){if(failed){failed=false;throw Error('Lost reply');}return task('created');}});ui.state.intake.requirementRef=minimal.requirementRef;Object.assign(ui.state.intake,{mode:'manual',title:'Manual draft',criteria:'Accepted'});ui.state.intake.mode='vault';await ui.submitTask();assert.equal(ui.state.intake.requirementRef,minimal.requirementRef);assert.equal(ui.state.intake.title,'Manual draft');await ui.submitTask();const requests=ui.calls.filter(c=>c.method==='POST');assert.equal(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);assert.deepEqual(requests[0].body,minimal);
});
test('runtime manual intake stays explicit and body edits rotate failed request key',async()=>{
 const ui=line((_path,init)=>{if(init.method==='POST')throw Error('Offline');});Object.assign(ui.state.intake,{mode:'manual',title:'Manual',criteria:'Accepted'});await ui.submitTask();Object.assign(ui.state.intake,{mode:'vault',requirementRef:minimal.requirementRef});await ui.submitTask();const requests=ui.calls.filter(c=>c.method==='POST');assert.equal(requests[0].body.requirementRef,undefined);assert.deepEqual(requests[0].body.criteria,['Accepted']);assert.notEqual(requests[0].headers['Idempotency-Key'],requests[1].headers['Idempotency-Key']);assert.deepEqual(requests[1].body,minimal);
});
