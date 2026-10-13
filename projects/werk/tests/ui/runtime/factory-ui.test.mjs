import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const page=await readFile(new URL('../../../src/factory/public/index.html',import.meta.url),'utf8');
const source=page.split('<script>')[1].split('</script>')[0];
function ui(fetch){
  const nodes=new Map();
  class Node {
    children=[];value='';textContent='';dataset={};attributes={};hidden=false;disabled=false;
    constructor(tag='div'){this.tagName=tag.toUpperCase()}
    append(...children){this.children.push(...children)}
    replaceChildren(...children){this.children=children}
    get firstElementChild(){return this.children[0]}
    setAttribute(key,value){this.attributes[key]=value}
    removeAttribute(key){delete this.attributes[key]}
    querySelectorAll(selector){const tags=selector.split(',').map(tag=>tag.toUpperCase());const all=[];const visit=node=>{for(const child of node.children){if(tags.includes(child.tagName))all.push(child);visit(child)}};visit(this);return all}
    focus(){document.activeElement=this}
    reset(){for(const child of this.querySelectorAll('input,select'))child.value=''}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)};
  const document={querySelector:get,createElement:tag=>new Node(tag),activeElement:null,hidden:false,title:''};
  const location={pathname:'/'};const history={pushState(_a,_b,path){location.pathname=path},replaceState(_a,_b,path){location.pathname=path}};
  const context=vm.createContext({document,fetch,crypto:{randomUUID},AbortSignal,AbortController,Date,URL,location,history,window:{addEventListener(){}},setInterval(){}});
  vm.runInContext(source,context);
  return {get,context,run:code=>vm.runInContext(code,context)};
}
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const factories=[{id:'parent',name:'Parent',parentId:null},{id:'child',name:'Child',parentId:'parent'},{id:'other',name:'Other',parentId:null}];
const line={id:'line',name:'Delivery',factoryId:'child',orchestratorUrl:'http://orchestrator:4000',webviewUrl:'http://localhost:4000',tokenEnv:'WERK_LINE_DEMO_TOKEN'};
const overview=(id,{available=true}={})=>({factoryId:id,observedAt:new Date().toISOString(),factories,lines:[{line,status:available?'available':'unavailable',checkedAt:new Date().toISOString(),error:available?null:'Connection refused',overview:available?{tasks:{total:3,running:1,queued:2,simulated:0,blocked:0},workers:{total:1,online:1,slotsBusy:1,slotsTotal:2}}:null}],totals:{lines:1,availableLines:available?1:0,unavailableLines:available?0:1,partial:!available,tasks:available?{total:3,running:1,queued:2}:null,workers:available?{total:1,online:1}:null,snapshots:available?{before:1,after:0}:null}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const setup=surface=>surface.run(`state.token='token';state.factories=${JSON.stringify(factories)};state.lines=${JSON.stringify([line])}`);

test('factory hierarchy includes descendants and excludes own subtree from move choices',()=>{
  const surface=ui(async()=>response({}));setup(surface);surface.run("state.scope='parent';openFactory(findFactory('parent'))");
  assert.deepEqual(Array.from(surface.run("descendants('parent')")),['parent','child']);
  assert.deepEqual(surface.get('#factory-parent').children.map(option=>option.value),['','other']);
  assert.equal(surface.get('#factory-parent').value,'');
  assert.equal(surface.run('selectedLines().length'),1);
});

test('unavailable lines show unknown counts and partial coverage, safe Intake links remain available',()=>{
  const surface=ui(async()=>response({}));setup(surface);surface.run(`renderOverview(${JSON.stringify(overview(null,{available:false}))})`);
  assert.equal(surface.get('#overview-facts').children[2].children[1].textContent,'Unbekannt');
  assert.match(surface.get('#coverage').textContent,/Teilansicht: 0 von 1/);
  const row=surface.get('#line-rows').children[0];assert.equal(row.children[2].children[0].textContent,'Unbekannt');
  const linkNode=row.children[0].children[2];assert.equal(linkNode.rel,'noopener noreferrer');assert.equal(linkNode.target,'_blank');
  assert.equal(surface.run("safeWebview('javascript:alert(1)')"),null);assert.equal(surface.run("safeWebview('https://user:secret@example.test')"),null);
});

test('late overview response cannot replace a newly selected factory scope',async()=>{
  const first=deferred(),second=deferred();let calls=0;
  const surface=ui(()=>++calls===1?first.promise:second.promise);setup(surface);surface.run("state.scope='parent'");
  const pending=surface.run('refresh({registry:false})');surface.run("navigate('other')");second.resolve(response({...overview('other'),lines:[],totals:{lines:0,availableLines:0,unavailableLines:0,partial:false,tasks:null,workers:null,snapshots:null}}));await new Promise(r=>setImmediate(r));
  first.resolve(response(overview('parent')));await pending;
  assert.equal(surface.run('state.scope'),'other');assert.equal(surface.get('#scope-title').textContent,'Other');assert.equal(surface.run("state.cache.has('parent')"),false);
});

test('failed overview preserves per-scope cache with an explicit stale warning',async()=>{
  const surface=ui(async()=>{throw Error('offline')});setup(surface);surface.run(`state.scope='parent';state.cache.set('parent',{data:${JSON.stringify(overview('parent'))}})`);
  await surface.run('refresh({registry:false})');assert.match(surface.get('#freshness').textContent,/veraltet/);assert.match(surface.get('#coverage').textContent,/Veralteter letzter Stand/);
  assert.equal(surface.get('#line-rows').children[0].children[1].children[0].textContent,'Veralteter Stand');
});

test('failed factory create preserves draft and its identity for retry',async()=>{
  const bodies=[];const surface=ui(async(_path,options)=>{bodies.push(JSON.parse(options.body));throw Error('timeout')});setup(surface);surface.run('openFactory()');surface.get('#factory-name').value='New factory';surface.get('#factory-parent').value='parent';
  await surface.get('#factory-form').onsubmit({preventDefault(){}});await surface.get('#factory-form').onsubmit({preventDefault(){}});
  assert.equal(bodies[0].id,bodies[1].id);assert.equal(surface.get('#factory-name').value,'New factory');assert.equal(surface.get('#factory-parent').value,'parent');assert.match(surface.get('#factory-error').textContent,/Eingaben bleiben erhalten/);
});

test('line editing sends an environment reference and moves registry ownership without sending a secret',async()=>{
  let posted;const surface=ui(async(path,options)=>{
    if(options.method==='PATCH'){posted={path,body:JSON.parse(options.body)};return response({...line,...posted.body})}
    if(path==='/v1/factories')return response({factories});if(path==='/v1/lines')return response({lines:[{...line,factoryId:'other'}]});return response(overview('other'));
  });setup(surface);surface.run(`openLine(${JSON.stringify(line)})`);surface.get('#line-factory').value='other';
  await surface.get('#line-form').onsubmit({preventDefault(){}});
  assert.equal(posted.path,'/v1/lines/line');assert.equal(posted.body.factoryId,'other');assert.equal(posted.body.tokenEnv,'WERK_LINE_DEMO_TOKEN');assert.equal('token' in posted.body,false);assert.equal(surface.run('state.editor'),null);
});

test('line unregister requires an explicit confirmation and explains ongoing work continues',async()=>{
  const requests=[];const surface=ui(async(path,options)=>{requests.push({path,method:options.method});if(path==='/v1/factories')return response({factories});if(path==='/v1/lines'&&options.method==='GET')return response({lines:[]});if(options.method==='DELETE')return response({deleted:true,id:'line'});return response({...overview(null),lines:[]})});setup(surface);
  surface.run(`confirmRemoval('line',${JSON.stringify(line)})`);assert.equal(requests.length,0);assert.match(surface.get('#confirmation-description').textContent,/nicht gestoppt oder gelöscht/);
  await surface.get('#confirm-delete').onclick();assert.ok(requests.some(request=>request.path==='/v1/lines/line'&&request.method==='DELETE'));
});

test('disconnect during initial overview clears cache and restores a usable login',async()=>{
  const pending=deferred();const surface=ui(async path=>path==='/v1/factories'?response({factories}):path==='/v1/lines'?response({lines:[line]}):pending.promise);
  surface.get('#token').value='login-token';const connecting=surface.get('#login-form').onsubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
  surface.get('#disconnect').onclick();pending.resolve(response(overview(null)));await connecting;
  assert.equal(surface.run('state.token'),'');assert.equal(surface.run('state.cache.size'),0);assert.equal(surface.get('#connect').disabled,false);assert.equal(surface.get('#workspace').hidden,true);assert.equal(surface.get('#login').hidden,false);
});

test('line actions retain keyboard focus through refresh and cancelled editing returns to the current row',()=>{
  const surface=ui(async()=>response({}));setup(surface);surface.run(`renderOverview(${JSON.stringify(overview(null))})`);
  const initial=surface.run("lineControl('line','edit')");initial.focus();surface.run(`renderOverview(${JSON.stringify(overview(null))})`);
  const current=surface.run("lineControl('line','edit')");assert.notEqual(current,initial);assert.equal(surface.run('document.activeElement'),current);
  current.onclick();assert.equal(surface.run('document.activeElement'),surface.get('#line-name'));
  surface.run(`renderOverview(${JSON.stringify(overview(null))})`);surface.get('#cancel-line').onclick();
  assert.equal(surface.run('document.activeElement'),surface.run("lineControl('line','edit')"));
});

test('invalid line endpoint focuses and marks the offending field without submitting or erasing draft',async()=>{
  let requests=0;const surface=ui(async()=>{requests++;return response({})});setup(surface);surface.run(`openLine(${JSON.stringify(line)})`);
  surface.get('#line-api').value='javascript:alert(1)';await surface.get('#line-form').onsubmit({preventDefault(){}});
  assert.equal(requests,0);assert.equal(surface.get('#line-api').attributes['aria-invalid'],'true');assert.equal(surface.run('document.activeElement'),surface.get('#line-api'));assert.equal(surface.get('#line-name').value,line.name);
});

test('a fresh cached overview remains healthy while refreshing and a recovered request clears its own error',async()=>{
  let failed=true;const surface=ui(async()=>{if(failed){failed=false;throw Error('offline')}return response(overview('parent'))});setup(surface);surface.run(`state.scope='parent';state.cache.set('parent',{data:${JSON.stringify(overview('parent'))}});renderCached({loading:true})`);
  assert.equal(surface.get('#line-rows').children[0].children[1].children[0].textContent,'Erreichbar');
  await surface.run('refresh({registry:false})');assert.equal(surface.get('#message').dataset.kind,'error');
  await surface.run('refresh({registry:false})');assert.equal(surface.get('#message').dataset.kind,'success');assert.match(surface.get('#message').textContent,/wiederhergestellt/);
});

function nodeText(node){return [node.textContent,...node.children.map(nodeText)].join(' ')}
test('topology derives owning factory, one orchestrator and an aggregate worker pool from observed data',()=>{
  const surface=ui(async()=>response({}));setup(surface);surface.run(`state.scope='parent';renderOverview(${JSON.stringify(overview('parent'))})`);
  const topology=surface.get('#line-topology');assert.equal(topology.hidden,false);assert.equal(surface.get('#line-table').hidden,true);
  assert.equal(topology.children.length,1);assert.equal(topology.children[0].dataset.ownerFactory,'child');
  const flow=topology.querySelectorAll('article')[0];assert.equal(flow.querySelectorAll('h5').length,2);assert.match(nodeText(flow),/1 von 1 Workern online/);assert.match(nodeText(flow),/1 \/ 2 Slots belegt/);assert.match(nodeText(flow),/Einzelne Worker sind hier nicht aufgeschlüsselt/);
  const intake=flow.querySelectorAll('a')[0];assert.equal(intake.href,'http://localhost:4000/');assert.equal(intake.rel,'noopener noreferrer');
});

test('topology keeps unavailable worker counts unknown and exposes the actual owner-scope drill-in',async()=>{
  const paths=[];const surface=ui(async path=>{paths.push(path);return response(overview('child',{available:false}))});setup(surface);surface.run(`state.scope='parent';renderOverview(${JSON.stringify(overview('parent',{available:false}))})`);
  assert.match(nodeText(surface.get('#line-topology')),/Worker-Anzahl: unbekannt/);assert.match(nodeText(surface.get('#line-topology')),/Nicht erreichbar/);
  const drill=surface.get('#line-topology').querySelectorAll('button').find(button=>button.dataset.topologyScope==='child');drill.onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(surface.run('state.scope'),'child');assert.ok(paths.includes('/v1/overview?factoryId=child'));
});

test('switching topology and table preserves scope, cached reading and an open draft without an API request',()=>{
  let requests=0;const surface=ui(async()=>{requests++;return response({})});setup(surface);surface.run(`state.scope='parent';renderOverview(${JSON.stringify(overview('parent'))});openLine()`);surface.get('#line-name').value='Unsaved production line';
  surface.get('#show-table').onclick();assert.equal(surface.get('#line-table').hidden,false);assert.equal(surface.get('#line-topology').hidden,true);assert.equal(surface.get('#show-table').attributes['aria-pressed'],'true');
  surface.get('#show-topology').onclick();assert.equal(surface.run('state.scope'),'parent');assert.equal(surface.get('#line-name').value,'Unsaved production line');assert.equal(surface.run('state.editor.type'),'line');assert.equal(requests,0);
  assert.match(nodeText(surface.get('#line-topology')),/1 von 1 Workern online/);
});


for(const type of ['factory','line'])for(const editing of [false,true]){
  test(`${type} ${editing?'update':'create'}: lost responses retain retry keys; changed drafts and new actions rotate keys`,async()=>{
    const requests=[];
    const surface=ui(async(path,options)=>{requests.push({path,key:options.headers['Idempotency-Key'],body:JSON.parse(options.body)});throw Error('Response lost after commit')});
    setup(surface);
    const open=type==='factory'?`openFactory(${editing?JSON.stringify(factories[1]):''})`:`openLine(${editing?JSON.stringify(line):''})`;
    const fill=()=>{surface.get('#'+type+'-name').value='Draft';if(type==='line'){surface.get('#line-factory').value='child';surface.get('#line-api').value=line.orchestratorUrl;surface.get('#line-web').value=line.webviewUrl;surface.get('#line-token-env').value=line.tokenEnv}};
    surface.run(open);fill();const submit=()=>surface.get('#'+type+'-form').onsubmit({preventDefault(){}});
    await submit();await submit();assert.match(requests[0].key,/^[a-f0-9-]{36}$/);assert.equal(requests[0].key,requests[1].key);assert.deepEqual(requests[0].body,requests[1].body);
    surface.get('#'+type+'-name').value='Changed draft';await submit();assert.notEqual(requests[2].key,requests[1].key);
    surface.get('#'+type+'-name').value='Draft';await submit();assert.notEqual(requests[3].key,requests[0].key);
    surface.run('closeEditors()');surface.run(open);fill();await submit();assert.notEqual(requests[4].key,requests[3].key);
  });
}
for(const type of ['factory','line']){
  test(`${type} deletion: uncertain responses retain a key until confirmation is reopened`,async()=>{
    const keys=[];const surface=ui(async(_path,options)=>{keys.push(options.headers['Idempotency-Key']);throw Error('Response lost after commit')});setup(surface);
    const confirm=`confirmRemoval('${type}',${JSON.stringify(type==='factory'?factories[1]:line)})`;
    surface.run(confirm);await surface.get('#confirm-delete').onclick();await surface.get('#confirm-delete').onclick();assert.match(keys[0],/^[a-f0-9-]{36}$/);assert.equal(keys[0],keys[1]);
    surface.run('closeEditors()');surface.run(confirm);await surface.get('#confirm-delete').onclick();assert.notEqual(keys[2],keys[0]);
  });
}


test('line capability announcements keep unknown, mock execution and partial profiles explicit',()=>{
  const surface=ui(async()=>response({}));assert.match(surface.run('capabilityDescription(null)'),/Fähigkeiten unbekannt/);assert.match(surface.run('capabilityDescription({})'),/Fähigkeiten unbekannt/);
  const capabilities={schemaVersion:1,execution:'mock',context:'pinned',intake:['requirement_ref','pinned_iteration'],profiles:[{id:'codex-custom',provider:'codex'}],profilesTruncated:true};
  const description=surface.run(`capabilityDescription(${JSON.stringify(capabilities)})`);assert.match(description,/Mock-Ausführung.*Git-Commit fixiert/);assert.match(description,/Wikilinks.*Iterationen/);assert.match(description,/codex-custom \(codex, simuliert\)/);assert.match(description,/Ankündigung begrenzt/);assert.match(description,/Verfügbarkeit steht im Linienstatus/);
});


test('viewer factory access disables topology actions and guards direct editor calls',()=>{
  const surface=ui(async()=>response({}));setup(surface);surface.run("applyAccess({principal:{id:'reader',role:'viewer'},permissions:{read:true,write:false}})");surface.run(`renderOverview(${JSON.stringify(overview(null))})`);
  surface.run('renderHierarchy()');assert.equal(surface.get('#register-line').disabled,true);assert.equal(surface.get('#create-factory').disabled,true);assert.match(surface.get('#access-summary').textContent,/nur lesen/);surface.run('openLine()');assert.equal(surface.run('state.editor'),null);
});

test('factory next steps distinguish checking, stale, missing worker and ready observations',()=>{
  const surface=ui(async()=>response({}));setup(surface);const value=overview(null);surface.run(`renderOverview(${JSON.stringify(value)})`);assert.match(surface.get('#next-step').textContent,/eigenen Zugangstoken/);
  value.lines[0].overview.workers.online=0;surface.run(`renderOverview(${JSON.stringify(value)})`);assert.match(surface.get('#next-step').textContent,/kein Online-Worker/);
  surface.run(`renderOverview(${JSON.stringify(value)},{stale:true})`);assert.match(surface.get('#next-step').textContent,/veraltet/);
  surface.run('renderOverview(undefined,{loading:true})');assert.match(surface.get('#next-step').textContent,/wird geprüft/);
});

test('system-managed registry locks named edits in both views while preserving additions and standalone edits',()=>{
  const surface=ui(async()=>response({}));setup(surface);surface.run("applyManagedRegistry({factories:['child'],lines:['line']});state.scope='child';renderHierarchy()");
  assert.equal(surface.get('#edit-factory').disabled,true);assert.equal(surface.get('#delete-factory').disabled,true);assert.equal(surface.get('#create-factory').disabled,false);assert.equal(surface.get('#register-line').disabled,false);assert.match(surface.get('#managed-registry-note').textContent,/Systemdefinition.*Migration.*stoppen.*sichern/);assert.match(surface.get('#scope-description').textContent,/Systemdefinition/);
  surface.run(`renderOverview(${JSON.stringify(overview('child'))})`);assert.equal(surface.run("lineControl('line','edit').disabled"),true);assert.equal(surface.run("lineControl('line','remove').disabled"),true);surface.run("state.lineView='table'");assert.equal(surface.run("lineControl('line','edit').disabled"),true);
  surface.run("openFactory(findFactory('child'))");assert.equal(surface.run('state.editor'),null);surface.run(`confirmRemoval('line',${JSON.stringify(line)})`);assert.equal(surface.run('state.deletion'),null);
  surface.run('openFactory()');assert.equal(surface.run('state.editor.id'),null);surface.run("closeEditors();openFactory(findFactory('other'))");assert.equal(surface.run('state.editor.id'),'other');
  surface.run('closeEditors();applyManagedRegistry();renderHierarchy()');assert.equal(surface.get('#edit-factory').disabled,false);assert.equal(surface.get('#managed-registry-note').hidden,true);
});

test('factory login and registry refresh consume managed IDs and logout clears their disclosure',async()=>{
  let managedRegistry={factories:['child'],lines:['line']};const surface=ui(async path=>response(path==='/v1/factories'?{factories,managedRegistry}:path==='/v1/lines'?{lines:[line]}:overview(null)));
  surface.get('#token').value='admin';await surface.get('#login-form').onsubmit({preventDefault(){}});assert.equal(surface.run("isManaged('line','line')"),true);
  managedRegistry={factories:[],lines:[]};await surface.run('refresh()');assert.equal(surface.run("isManaged('line','line')"),false);
  surface.get('#disconnect').onclick();assert.equal(surface.get('#managed-registry-note').textContent,'');assert.equal(surface.get('#managed-registry-note').hidden,true);
});
