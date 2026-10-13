const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(process.env.WERK_CONCEPT_HTML||path.join(__dirname,'../../../src/orchestrator/public/concept.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/render\(\);\s*$/,'');
function scenario(code){
 const nodes=new Map();
 const context={assert,document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,{classList:{add(){},remove(){}},getAttribute(){return null},focus(){},scrollLeft:0});return nodes.get(s)},querySelectorAll:()=>[],addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}}),window:{addEventListener(){}},setTimeout,clearTimeout,setInterval,clearInterval,console};
 vm.createContext(context);vm.runInContext(source,context);vm.runInContext(code,context);
}
test('Intake keeps the weekly import primary and individual entry available without losing draft',()=>scenario(String.raw`
 data=seed();manualIntakeOpen=false;assert.ok(intakeView().indexOf('iteration-intake')<intakeView().indexOf('manualIntake'));
 assert.doesNotMatch(intakeView(),/id="manualIntake" open/);
 intakeDraft.title='Preserve unfinished feature';newFeature();
 assert.equal(view,'intake');assert.equal(manualIntakeOpen,true);assert.match(intakeView(),/id="manualIntake" open/);assert.equal(intakeDraft.title,'Preserve unfinished feature');
`));
test('import receipt leads to its project board and clears stale filters',()=>scenario(String.raw`
 data=seed();intakeDraft.project='portal';filter='field';query='Old search';statusFilter='done';
 assert.doesNotMatch(iterationIntake(),/Import übernommen/);importIterationFeatures('portal');assert.match(iterationIntake(),/Import übernommen/);assert.match(iterationIntake(),/data-project-board="portal"/);
 openProjectBoard('portal');assert.equal(view,'board');assert.equal(filter,'portal');assert.equal(query,'');assert.equal(statusFilter,'all');
 assert.equal(data.tasks.filter(t=>t.sourceFeatureId).length,2);
`));
test('review journey opens the chosen project review queue without changing domain state',()=>scenario(String.raw`
 data=seed();const before=JSON.stringify(data);query='Supplier';
 openProjectBoard('portal','review');assert.equal(filter,'portal');assert.equal(statusFilter,'review');assert.equal(query,'');assert.equal(JSON.stringify(data),before);
 assert.match(board(),/Kunden können Rechnungen herunterladen/);assert.doesNotMatch(board(),/Bestellfreigabe mit Vier-Augen/);
 assert.throws(()=>openProjectBoard('missing','review'));assert.equal(filter,'portal');
`));
