const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(process.env.WERK_CONCEPT_HTML||path.join(__dirname,'../../../src/orchestrator/public/concept.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/render\(\);\s*$/,'');
function check(code){
 const elements=new Map();
 const element=()=>({classList:{add(){},remove(){}},getAttribute(){return null},focus(){},scrollLeft:0});
 const context={assert,document:{querySelector:s=>{if(!elements.has(s))elements.set(s,element());return elements.get(s)},querySelectorAll:()=>[],addEventListener(){},hidden:false},localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}}),window:{addEventListener(){}},setTimeout,clearTimeout,setInterval,clearInterval,console};
 vm.createContext(context);vm.runInContext(source,context);vm.runInContext(code,context);
}
test('concept initializes once, with Intake and visible iteration project selection',()=>{
 assert.equal((source.match(/^render\(\);/gm)||[]).length,0);
 check(`render();assert.equal(view,'intake');assert.ok(intakeView().includes('id="iterationProject"'));`);
});
test('iteration import follows Intake project, pins context, and remains idempotent',()=>check(String.raw`
 data=seed();filter='field';intakeDraft.project='portal';
 assert.equal(importIterationFeatures(intakeDraft.project),2);
 const imported=data.tasks.filter(t=>t.sourceFeatureId);assert.equal(imported.length,2);
 for(const t of imported){assert.equal(t.project,'portal');assert.equal(t.context.projectId,'portal');assert.equal(t.context.references.length,2);assert.equal(t.context.baseRef,t.iterationBranch);assert.match(t.title,/Rechnung/)}
 assert.equal(importIterationFeatures('portal'),0);assert.equal(importIterationFeatures('atlas'),2);
 assert.match(iterationIntake(),/2 importierte Demo-Features/);
`));
test('failed checks close the same attempt with a failed after snapshot before retry',()=>check(String.raw`
 data=seed();data.tasks=data.tasks.filter(t=>t.id===104);advance();const t=data.tasks[0],pr=t.pr;
 advance();assert.equal(taskAction(t.id,'failed'),true);
 const after=t.snapshots.find(s=>s.phase==='after');assert.equal(after.execution.outcome,'checks_failed');assert.equal(after.workerId,'W-01');assert.equal(after.quality.state,'simulated_failed');assert.equal(after.execution.elapsedTicks,1);
 assert.equal(t.worker,null);advance();assert.equal(t.pr,pr);assert.equal(t.attempt,2);
 assert.equal(t.snapshots.filter(s=>s.phase==='before').length,2);assert.equal(t.snapshots.filter(s=>s.phase==='after').length,1);
`));
test('parallel machine and profile slots agree in status and all task links',()=>check(String.raw`
 data=seed();data.tasks=data.tasks.filter(t=>t.id===104);const w=data.workers[0];w.maxParallel=4;w.profiles[0].maxParallel=2;w.profiles[1].maxParallel=1;
 assert.equal(freeSlots(w),3);assert.match(statusBar(),/freie Slots/);
 addTask({project:'atlas',title:'Second job',criteria:'Checked'});advance();assert.equal(workerTasks(w).length,2);assert.equal(freeSlots(w),1);
 selected=w.id;for(const t of workerTasks(w)){assert.ok(inspect().includes('FT-'+t.id));assert.ok(deliveryDashboard().includes('data-task="'+t.id+'"'))}
 w.profiles[1].authenticated=false;assert.equal(freeSlots(w),0);
`));
test('configuration rejects invalid integers atomically and protects running attempts',()=>check(String.raw`
 data=seed();const w=data.workers[1],original=JSON.stringify(w),config={maxParallel:2,timeoutSeconds:120,systemPrompt:'Test policy',profiles:w.profiles.map(p=>({id:p.id,maxParallel:1}))};
 assert.throws(()=>applyWorkerConfiguration(w,{...config,maxParallel:1.5}));assert.equal(JSON.stringify(w),original);
 assert.throws(()=>applyWorkerConfiguration(w,{...config,profiles:[{id:w.profiles[0].id,maxParallel:0}]}));assert.equal(JSON.stringify(w),original);
 assert.throws(()=>applyWorkerConfiguration(w,{...config,systemPrompt:'   '}));
 applyWorkerConfiguration(w,config);assert.equal(w.configVersion,2);assert.equal(w.maxParallel,2);
 assert.throws(()=>applyWorkerConfiguration(data.workers[0],config));
`));
test('persisted profile overbooking and fractional concurrency are rejected',()=>check(String.raw`
 data=seed();let copy=JSON.parse(JSON.stringify(data));copy.workers[0].maxParallel=2.5;assert.throws(()=>normalize(copy));
 copy=JSON.parse(JSON.stringify(data));copy.workers[0].maxParallel=2;const second=copy.tasks.find(t=>t.id===104);Object.assign(second,{status:'running',worker:'W-01',attempt:1,execution:{provider:'claude',profileId:'W-01-claude'}});assert.throws(()=>normalize(copy),/Profilkapazität/);
 second.execution={provider:'codex',profileId:'W-01-codex'};assert.equal(normalize(copy).tasks.filter(t=>t.worker==='W-01').length,2);
`));
test('telemetry comes from task snapshots, preserves unknown costs and exposes data gaps',()=>check(String.raw`
 data=seed();data.tasks=data.tasks.filter(t=>t.id===104);assert.match(snapshotDashboard(),/Noch keine vollständigen Snapshot-Paare/);
 advance();assert.match(snapshotDashboard(),/1<\/b> laufende Versuche/);advance();advance();
 const row=snapshotSeries()[0];assert.equal(row.after.execution.elapsedTicks,2);assert.equal(row.after.execution.durationMs,null);assert.equal(row.after.resources.rssBytes,null);assert.equal(row.after.usage.providerReportedCostUsd,null);
 assert.match(snapshotDashboard(),/1<\/b> vollständige Paare/);assert.match(snapshotDashboard(),/2 Takte/);
 snapshotMetric='rss';assert.match(snapshotDashboard(),/Kein Worker-Speicher gemessen/);
 snapshotMetric='duration';filter='portal';assert.equal(snapshotSeries().length,0);assert.match(snapshotDashboard(),/0 Datenpunkte/);
 filter='all';data.tasks[0].snapshots=data.tasks[0].snapshots.filter(s=>s.phase==='after');assert.match(snapshotDashboard(),/Vorher fehlt/);assert.match(snapshotDashboard(),/1<\/b> unvollständige historische Paare/);
`));
test('rework prefers the previous available worker and configuration navigation pauses simulation',()=>check(String.raw`
 data=seed();data.tasks=data.tasks.filter(t=>t.id===104);data.workers[0].paused=true;advance();const t=data.tasks[0];assert.equal(t.worker,'W-02');advance();advance();taskAction(t.id,'changes');data.workers[0].paused=false;advance();assert.equal(t.worker,'W-02');
 playing=true;navigate('providers');assert.equal(playing,false);
`));
