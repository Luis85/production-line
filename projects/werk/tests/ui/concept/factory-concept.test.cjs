const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(process.env.WERK_CONCEPT_HTML||path.join(__dirname,'../../../src/orchestrator/public/concept.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/render\(\);\s*$/,'');
function scenario(code){const nodes=new Map(),context={assert,document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,{classList:{add(){},remove(){}},getAttribute(){return null},focus(){},scrollLeft:0});return nodes.get(s)},querySelectorAll:()=>[],addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}}),window:{addEventListener(){}},setTimeout,clearTimeout,setInterval,clearInterval,console};vm.createContext(context);vm.runInContext(source,context);vm.runInContext(code,context)}
test('legacy state gains hierarchy and project lines while active assignments remain valid',()=>scenario(String.raw`
 data=seed();const legacy=JSON.parse(JSON.stringify(data));delete legacy.factories;delete legacy.lines;for(const t of legacy.tasks)delete t.lineId;for(const w of legacy.workers)delete w.lineId;
 const migrated=normalize(legacy);assert.equal(migrated.factories.length,3);assert.equal(migrated.lines.length,3);assert.equal(migrated.tasks.find(t=>t.id===101).lineId,'line-atlas');assert.equal(migrated.workers[0].lineId,'line-atlas');assert.equal(migrated.tasks.find(t=>t.id===101).worker,'W-01');
 assert.equal(new Set(migrated.lines.map(l=>l.orchestratorId)).size,migrated.lines.length);
`));
test('factory reparenting rejects cycles atomically and preserves line ownership on rename',()=>scenario(String.raw`
 data=seed();const child=createFactory('Platform','factory-products');const original=JSON.stringify(data);
 assert.throws(()=>updateFactory('factory-werk','Werk',child.id),/Zyklus/);assert.equal(JSON.stringify(data),original);
 updateFactory(child.id,'Platform Services','factory-service');assert.equal(data.factories.find(f=>f.id===child.id).parentId,'factory-service');assert.equal(data.lines.find(l=>l.id==='line-atlas').factoryId,'factory-products');
 assert.throws(()=>normalize({...data,factories:[...data.factories,{id:'factory-cycle',name:'Cycle',parentId:'factory-cycle'}]}),/Zyklus/);
`));
test('new same-project line starts empty and cannot consume another line workers',()=>scenario(String.raw`
 data=seed();data.tasks=[];const line=createLine('factory-products','Atlas Parallel','atlas');assert.equal(data.workers.filter(w=>w.lineId===line.id).length,0);
 const t=addTask({project:'atlas',lineId:line.id,title:'Isolated job',criteria:'Checked'});advance();assert.equal(t.status,'queued');assert.match(waitReason(t),/Produktionslinie/);
 assignWorkerToLine('W-02',line.id);advance();assert.equal(t.worker,'W-02');assert.equal(t.status,'running');assert.equal(t.lineId,line.id);
 assert.throws(()=>assignWorkerToLine('W-02','line-atlas'),/Aktive/);assert.throws(()=>assignWorkerToLine('W-03',line.id),/selben Projekt/);
`));
test('stored cross-line active assignment is rejected even within one project',()=>scenario(String.raw`
 data=seed();const line=createLine('factory-products','Atlas Second','atlas'),copy=JSON.parse(JSON.stringify(data));copy.tasks.find(t=>t.id===101).lineId=line.id;assert.throws(()=>normalize(copy),/Zuweisung/);
`));
test('selected line scopes board, review, import identity and 3D worker topology',()=>scenario(String.raw`
 data=seed();const line=createLine('factory-products','Atlas Second','atlas');chooseLine(line.id);assert.equal(taskList().length,0);assert.equal(workerList().length,0);assert.equal(topology().nodes.filter(n=>n.kind==='orchestrator').length,1);assert.equal(topology().nodes.filter(n=>n.kind==='worker').length,0);assert.equal(topology().nodes.filter(n=>n.kind==='repo').length,1);
 assert.equal(importIterationFeatures('atlas'),2);assert.equal(importIterationFeatures('atlas'),0);assert.equal(taskList().length,2);
 chooseLine('line-atlas');assert.equal(importIterationFeatures('atlas'),2);assert.ok(taskList().every(t=>t.lineId==='line-atlas'));
 assert.ok(factoryView().includes('Factory-Hierarchie'));assert.equal(view,'intake');
`));
test('minimal vault-note intake stores unknown references with no fabricated criteria and blocks execution',()=>scenario(String.raw`
 data=seed();const t=addVaultTask('atlas','[[Features/Customer portal]]');assert.equal(t.title,'Customer portal');assert.equal(t.criteria,'');assert.equal(t.requirementResolution,'unresolved');assert.equal(t.status,'blocked');assert.equal(taskAction(t.id,'retry'),false);advance();assert.equal(t.status,'blocked');assert.equal(t.worker,null);
 assert.equal(normalize(data).tasks.find(x=>x.id===t.id).requirementRef,'[[Features/Customer portal]]');assert.throws(()=>addVaultTask('atlas','[[../secrets]]'));assert.throws(()=>addVaultTask('atlas','[[One]] [[Two]]'));
`));
test('known demo requirement resolves its supplied note without requesting title or criteria',()=>scenario(String.raw`
 data=seed();const t=addVaultTask('atlas','[[requirements/Bestellfreigabe#Regeln]]');assert.equal(t.requirementResolution,'demo_resolved');assert.equal(t.criteria,'');assert.equal(t.context.references.length,1);assert.equal(t.context.references[0].path,'docs/requirements/Bestellfreigabe.md');assert.equal(t.status,'queued');assert.match(vaultIntake(),/Ein Wikilink genügt/);
`));
