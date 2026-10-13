const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(process.env.WERK_CONCEPT_HTML||path.join(__dirname,'../../../src/orchestrator/public/concept.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/render\(\);\s*$/,'');
function scenario(code){const nodes=new Map(),context={assert,document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,{classList:{add(){},remove(){}},getAttribute(){return null},focus(){},scrollLeft:0});return nodes.get(s)},querySelectorAll:()=>[],addEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:true,addEventListener(){},removeEventListener(){}}),window:{addEventListener(){}},setTimeout,clearTimeout,setInterval,clearInterval,console};vm.createContext(context);vm.runInContext(source,context);vm.runInContext(code,context)}
test('switching production lines keeps Vault and advanced drafts within their original line',()=>scenario(String.raw`
 data=seed();chooseLine('line-atlas');intakeDraft.title='Atlas draft';intakeDraft.criteria='Atlas criteria';vaultDraftRef='[[requirements/Bestellfreigabe]]';manualIntakeOpen=true;
 chooseLine('line-portal');assert.equal(intakeDraft.title,'');assert.equal(intakeDraft.criteria,'');assert.equal(vaultDraftRef,'');assert.equal(manualIntakeOpen,false);
 intakeDraft.title='Portal draft';vaultDraftRef='[[portal/Unfinished]]';chooseLine('line-atlas');assert.equal(intakeDraft.title,'Atlas draft');assert.equal(intakeDraft.criteria,'Atlas criteria');assert.equal(vaultDraftRef,'[[requirements/Bestellfreigabe]]');assert.equal(manualIntakeOpen,true);
 chooseLine('line-portal');assert.equal(intakeDraft.title,'Portal draft');assert.equal(vaultDraftRef,'[[portal/Unfinished]]');
`));
test('Factory overview separates portfolio management from line simulation controls',()=>scenario(String.raw`
 data=seed();chooseLine('line-atlas');navigate('factory');const main=document.querySelector('#main').innerHTML;
 assert.match(main,/Portfolioansicht/);assert.doesNotMatch(main,/id="lineSwitcher"/);assert.doesNotMatch(main,/id="step"/);assert.match(main,/Zur aktiven Linie/);
 navigate('board');assert.match(document.querySelector('#main').innerHTML,/id="step"/);assert.match(document.querySelector('#main').innerHTML,/id="lineSwitcher"/);
`));
test('correcting an unresolved reference retains task identity and line, then enables normal execution',()=>scenario(String.raw`
 data=seed();data.tasks=[];const t=addVaultTask('atlas','[[Missing]]'),id=t.id,line=t.lineId;
 assert.match(requirementRepair(t),/Requirement-Pfad korrigieren/);const updated=reviseTaskRequirement(id,'[[requirements/Bestellifreigabe]]');assert.equal(updated.status,'blocked');assert.equal(updated.intakeRevision,2);
 reviseTaskRequirement(id,'[[requirements/Bestellfreigabe#Regeln]]');assert.equal(t.id,id);assert.equal(t.lineId,line);assert.equal(t.intakeRevision,3);assert.equal(t.criteria,'');assert.equal(t.status,'queued');assert.equal(t.context.references.length,1);assert.equal(requirementRepair(t),'');advance();assert.equal(t.status,'running');assert.throws(()=>reviseTaskRequirement(id,'[[DoD]]'));
`));
test('malformed correction leaves the unresolved task unchanged and empty worker choices are explained',()=>scenario(String.raw`
 data=seed();const t=addVaultTask('portal','[[Missing]]'),before=JSON.stringify(t);assert.throws(()=>reviseTaskRequirement(t.id,'[[../Secrets]]'));assert.equal(JSON.stringify(t),before);
 const line=data.lines.find(l=>l.id==='line-portal');assert.match(workerAssignmentForm(line),/Kein freier Worker/);assert.doesNotMatch(workerAssignmentForm(line),/<select/);
`));
