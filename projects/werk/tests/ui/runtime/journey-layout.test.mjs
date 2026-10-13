import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const page=await readFile(new URL('../../../src/orchestrator/public/index.html',import.meta.url),'utf8');
const script=page.split('<script>')[1].split('</script>')[0];
function surface(fetch=async()=>({ok:true,json:async()=>({tasks:[],snapshots:[],hasMore:false,nextCursor:null})})){
  const nodes=new Map();
  class Element {
    value=''; children=[]; dataset={}; attributes={}; textContent=''; hidden=false;
    append(...children){this.children.push(...children)}
    replaceChildren(...children){this.children=children}
    setAttribute(key,value){this.attributes[key]=value}
    removeAttribute(key){delete this.attributes[key]}
    querySelectorAll(){return []}
    focus(){document.activeElement=this}
    closest(){return this}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id)};
  const document={querySelector:get,querySelectorAll:()=>[],createElement:()=>new Element(),createElementNS:()=>new Element(),activeElement:null,hidden:false};
  const context=vm.createContext({document,fetch,crypto:{randomUUID},AbortSignal,AbortController,Date,setInterval(){}});
  vm.runInContext(script,context);
  return {get,run:source=>vm.runInContext(source,context)};
}

test('journey follows connection and route state without hiding drafted form inputs',async()=>{
  const ui=surface();ui.get('#title').value='Preserve my draft';ui.run('updateJourney()');
  assert.equal(ui.get('#journey-connect').attributes['aria-current'],'step');
  ui.get('#token').value='test-token';await ui.get('#connect').onclick();
  assert.equal(ui.get('#auth-panel').hidden,true);assert.equal(ui.get('#journey-intake').attributes['aria-current'],'step');
  ui.run("navigate('workers')");assert.equal(ui.get('#journey-tasks').attributes['aria-current'],'step');
  ui.get('#disconnect').onclick();assert.equal(ui.get('#auth-panel').hidden,false);assert.equal(ui.get('#pause-updates').disabled,true);
  assert.equal(ui.get('#journey-connect').attributes['aria-current'],'step');assert.equal(ui.get('#title').value,'Preserve my draft');
});

test('task-to-snapshot journey replaces conflicting filters and immediately scopes cached metrics',()=>{
  const ui=surface(()=>new Promise(()=>{}));
  const row=(taskId,seq)=>({seq,receivedAt:new Date().toISOString(),snapshot:{taskId,id:'snapshot-'+seq,pairId:'pair-'+seq,phase:'before',project:'demo',workerId:'worker',profileId:'mock',attempt:1,provenance:{iterationId:'iteration'},execution:{outcome:'pending',durationMs:null},resources:{rssBytes:100},health:{eventLoopDelayP95Ms:null}}});
  ui.run(`token='admin';selectedTaskId='task-selected';metricRecords=${JSON.stringify([row('task-selected',1),row('unrelated-task',2)])}`);
  for(const id of ['metric-project','metric-worker','metric-iteration','metric-window','metric-outcome'])ui.get('#'+id).value='conflicting';
  ui.get('#inspect-task-snapshots').onclick();
  assert.equal(ui.run('tab'),'metrics');assert.equal(ui.get('#task-snapshot-filter').hidden,false);assert.match(ui.get('#task-snapshot-label').textContent,/task-selected/);
  assert.equal(ui.get('#snapshot-rows').children.length,1);assert.equal(ui.get('#metric-outcome').value,'');
  assert.equal(ui.get('#journey-metrics').attributes['aria-current'],'step');
  ui.get('#clear-task-filter').onclick();assert.equal(ui.get('#snapshot-rows').children.length,2);assert.equal(ui.get('#task-snapshot-filter').hidden,true);
});

test('extracted worker renderer retains standalone export and shared responsive spacing contract',async()=>{
  const viewSource=await readFile(new URL('../../../src/worker/status/view.ts',import.meta.url),'utf8');
  const javascript=stripTypeScriptTypes(viewSource,{mode:'strip'});
  const {statusHtml}=await import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
  const html=statusHtml();
  for(const source of [page,html]){
    assert.match(source,/--space-page:\s*var\(--space-8\)/);assert.match(source,/--space-panel:\s*var\(--space-6\)/);
    assert.match(source,/@media\s*\(max-width:\s*760px\)/);assert.doesNotMatch(source,/\sstyle="/);
  }
  assert.match(html,/Current process assignments/);assert.match(html,/Static export/);
  const serverSource=await readFile(new URL('../../../src/worker/status/server.ts',import.meta.url),'utf8');
  assert.match(serverSource,/export \{ statusHtml \} from '\.\/view\.js'/);assert.doesNotMatch(serverSource,/<style>/);
});
