const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(process.env.WERK_CONCEPT_HTML||path.join(__dirname,'../../../src/orchestrator/public/concept.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/render\(\);\s*$/,'');
function scenario(code){const nodes=new Map(),context={assert,document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,{classList:{add(){},remove(){}},getAttribute(){return null},focus(){},scrollLeft:0});return nodes.get(s)},querySelectorAll:()=>[],addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}}),window:{addEventListener(){}},setTimeout,clearTimeout,setInterval,clearInterval,console};vm.createContext(context);vm.runInContext(source,context);vm.runInContext(code,context)}
test('Factory diagram nests every line inside its owning Factory and includes an empty child',()=>scenario(String.raw`
 data=seed();const empty=createFactory('New capability','factory-products'),layout=factoryMapLayout('factory-werk');assert.equal(layout.boxes.length,4);assert.equal(layout.lanes.length,3);
 for(const lane of layout.lanes){const box=layout.boxes.find(b=>b.factory.id===lane.line.factoryId);assert.ok(lane.x>box.x);assert.ok(lane.y>box.y);assert.ok(lane.x+lane.width<box.x+box.width);assert.ok(lane.y+lane.height<box.y+box.height)}
 const child=layout.boxes.find(b=>b.factory.id===empty.id),parent=layout.boxes.find(b=>b.factory.id==='factory-products');assert.ok(child.x>parent.x);assert.ok(child.y+child.height<parent.y+parent.height);assert.match(factoryMap('factory-werk'),/Noch keine Linien oder Unterfactories/);
`));
test('Map selection is read-only and drill-down retains the selected same-project line',()=>scenario(String.raw`
 data=seed();chooseLine('line-atlas');const other=createLine('factory-products','Second Atlas','atlas'),before=JSON.stringify(data);selectFactoryMapLine(other.id);assert.equal(JSON.stringify(data),before);assert.equal(currentLineId,'line-atlas');
 const detail=factoryMapDetail(other);assert.match(detail,/Noch keine Worker zugewiesen/);assert.match(detail,new RegExp('data-line-open="'+other.id+'"'));assert.match(detail,new RegExp('data-line-architecture="'+other.id+'"'));
 chooseLine(other.id);openProjectBoard('atlas','review');assert.equal(currentLineId,other.id);assert.equal(statusFilter,'review');assert.equal(topology().nodes.filter(n=>n.kind==='orchestrator').length,1);assert.equal(topology().nodes.filter(n=>n.kind==='worker').length,0);
`));
test('Map metrics follow machine and profile capacities without treating profiles as slots',()=>scenario(String.raw`
 data=seed();const line=data.lines.find(l=>l.id==='line-atlas'),first=factoryLineSummary(line);assert.equal(first.workers.length,2);assert.equal(first.slots,2);assert.equal(first.profiles,4);assert.equal(first.active,1);
 data.workers.find(w=>w.id==='W-02').maxParallel=3;const next=factoryLineSummary(line);assert.equal(next.slots,4);assert.equal(next.free,2);assert.equal(next.profiles,4);
 const moved=createLine('factory-products','Independent Atlas','atlas');assignWorkerToLine('W-02',moved.id);assert.equal(factoryLineSummary(line).workers.length,1);assert.equal(factoryLineSummary(moved).workers.length,1);assert.equal(factoryLineSummary(moved).active,0);
`));
test('Topology exposes keyboard-equivalent native line controls and escapes custom names',()=>scenario(String.raw`
 data=seed();const factory=createFactory('<script>unsafe</script>','factory-werk'),line=createLine(factory.id,'<img src=x>','atlas'),markup=factoryMap('factory-werk');
 for(const l of data.lines)assert.ok(markup.includes('<button data-map-line="'+l.id+'"'));
 assert.ok(markup.includes('role="button" tabindex="0" data-map-line="'+line.id+'"'));assert.match(markup,/&lt;script&gt;unsafe&lt;\/script&gt;/);assert.doesNotMatch(markup,/<script>unsafe/);assert.match(markup,/PR-Status und Review-Feedback/);assert.match(markup,/Simulation/);
`));
