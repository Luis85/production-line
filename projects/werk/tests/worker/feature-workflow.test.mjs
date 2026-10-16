import { validateApprovedPaths } from '../../src/worker/dist/worker/application/approved-paths.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFeatureWorkflow, defaultFeatureCheck, validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy, featureGateInput, evaluateFeatureDone, featureContentHash } from '../../src/worker/dist/worker/application/feature-workflow.js';
import { featureRequestSections, validateFeatureReadiness, validateFeatureTemplate, loadFeatureWorkflowSnapshot } from '../../src/worker/dist/worker/infrastructure/features/workflow.js';
const commit='a'.repeat(40);
const template=`---
schemaVersion: 1
templateId: feature-request-v1
title: Describe the feature
status: draft
mode: patch
paths: []
---
# Goal
<!-- Explain the behavior. -->
## Context
<!-- Explain constraints. -->
## Acceptance criteria
- [ ] <!-- An observable outcome. -->
## Verification plan
<!-- Explain how the outcome will be checked. -->
`;
const request=`---
schemaVersion: 1
templateId: feature-request-v1
id: keyboard-navigation
title: Keyboard navigation
status: ready
mode: patch
paths:
  - src/navigation.ts
---
# Goal
Allow keyboard users to select a result.
## Context
Preserve existing pointer interactions.
## Acceptance criteria
- [ ] Arrow keys move selection.
- Enter opens the selected result.
## Verification plan
Run the keyboard interaction tests and verify focus manually.
`;
const ready=()=>defaultFeatureCheck('ready'), done=()=>defaultFeatureCheck('done');
function fixture(overrides={}) {
  const configuration=defaultFeatureWorkflow();
  const files=new Map(Object.entries({'.werk/feature-workflow.json':JSON.stringify(configuration),[configuration.readyCheck]:JSON.stringify(ready()),[configuration.doneCheck]:JSON.stringify(done()),[configuration.template]:template,[configuration.base]:'filters:\n  and:\n    - file.ext == "md"\nviews:\n  - type: table\n    name: Features\n',...overrides}));
  const reads=[];
  return {files,reads,readBlob:async (revision,path)=>{reads.push({revision,path});return files.get(path)??null;}};
}
test('workflow paths preserve portable repository boundaries and separate generated notes',()=>{
  assert.deepEqual(validateFeatureWorkflow(defaultFeatureWorkflow()),defaultFeatureWorkflow());
  for(const path of ['/tmp/requests','../requests','a/../requests','C:/requests','a\\b','a//b','.git/features','node_modules/features','CON/features','features.','features ']) assert.throws(()=>validateFeatureWorkflow({...defaultFeatureWorkflow(),requestsDirectory:path}));
  for(const directory of ['features','FEATURES','features/review','.werk/worker','bin/apps/worker','.agents/skills']) assert.throws(()=>validateFeatureWorkflow({...defaultFeatureWorkflow(),reviewDirectory:directory}));
  assert.throws(()=>validateFeatureWorkflow({...defaultFeatureWorkflow(),readyCheck:'fr-done-check.json'}),/distinct/);
  assert.throws(()=>validateFeatureWorkflow({...defaultFeatureWorkflow(),template:'features/template.md'}),/intake/);
  assert.throws(()=>validateFeatureWorkflow({...defaultFeatureWorkflow(),readyCheck:'.werk/authoring/override.json'}),/private runtime/);
});
test('stage checks reuse typed bounded facts and cannot replace mandatory workflow checks',()=>{
  assert.deepEqual(validateFeatureCheck(ready(),'ready'),ready());
  assert.throws(()=>validateFeatureCheck(done(),'ready'),/ready/);
  for(const rule of [{id:'bad',fact:'model.claimedTests',op:'eq',value:true},{id:'bad',fact:'tests.passed',op:'gte',value:true},{id:'werk-required-title',fact:'input.titleLength',op:'gte',value:0}]) assert.throws(()=>validateFeatureCheck({...ready(),rules:{chat:[],patch:[rule]}},'ready'));
  const policy=featureWorkflowPolicy(ready(),done());
  assert.equal(policy.reviewer.enabled,false);assert.equal(policy.rework.maxAttempts,0);
  assert.ok(policy.ready.patch.some(rule=>rule.fact==='input.criteriaCount'));
  assert.ok(policy.done.patch.some(rule=>rule.fact==='output.patchPresent'));
  assert.throws(()=>featureWorkflowPolicy({...ready(),rules:{chat:[],patch:Array.from({length:27},(_,i)=>({id:'r'+i,fact:'input.messageLength',op:'gte',value:1}))}},done()),/32-rule/);
});
test('same readiness parser extracts actual criteria and freezes the meaningful feature input',()=>{
  const result=validateFeatureReadiness(request,ready(),'codex-cli',template);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.deepEqual(result.input.criteria,['Arrow keys move selection.','Enter opens the selected result.']);
  assert.equal(result.input.id,'keyboard-navigation');assert.equal(result.input.mode,'patch');
  assert.equal(featureGateInput(result.input).criteria.length,2);
  assert.equal(result.evaluation.rules.find(rule=>rule.fact==='input.criteriaCount').observed,2);
  assert.match(result.inputHash,/^[a-f0-9]{64}$/);
  assert.equal(validateFeatureReadiness(request.replace('status: ready','status: draft'),ready(),'codex-cli',template).inputHash,result.inputHash);
});
test('draft placeholders, malformed sections, implicit scope and managed records never pass readiness',()=>{
  assert.equal(validateFeatureReadiness(template,ready(),'codex-cli',template).valid,false);
  for(const changed of [request.replace('id: keyboard-navigation\n',''),request.replace('mode: patch','mode: chat'),request.replace('  - src/navigation.ts','  - ../outside.ts'),request.replace('  - src/navigation.ts','  - src/navigation.ts\n  - SRC/navigation.ts'),request.replace('status: ready','status: running'),request.replace('status: ready','status: ready\nwerk: {}'),request.replace('## Context\nPreserve existing pointer interactions.','## Context\n<!-- later -->'),request.replace('- [ ] Arrow keys move selection.\n- Enter opens the selected result.','- [ ] <!-- later -->'),request.replace('## Verification plan','## Different heading')]) assert.equal(validateFeatureReadiness(changed,ready(),'codex-cli',template).valid,false,changed);
});
test('fenced examples and HTML comments cannot supply readiness headings or criteria',()=>{
  assert.throws(()=>featureRequestSections('# Goal\nText\n```markdown\n## Context\nText\n## Acceptance criteria\n- fake\n## Verification plan\nText\n```'),/heading/);
  const hidden=request.replace('- [ ] Arrow keys move selection.\n- Enter opens the selected result.','```md\n- pretend criterion\n```');
  assert.equal(validateFeatureReadiness(hidden,ready(),'codex-cli',template).valid,false);
  assert.equal(validateFeatureReadiness(request+'\n```unclosed\n',ready(),'codex-cli',template).valid,false);
  assert.equal(validateFeatureReadiness(request+'\n## Goal\nDuplicate\n',ready(),'codex-cli',template).valid,false);
});
test('custom template identity, headings and frontmatter remain authoritative',()=>{
  const customized=template.replace('templateId: feature-request-v1','templateId: frontend-v2\ncomponent: ""')+'\n## Accessibility\n<!-- Describe focus behavior. -->\n';
  assert.equal(validateFeatureTemplate(customized).templateId,'frontend-v2');
  assert.equal(validateFeatureReadiness(request,ready(),'codex-cli',customized).valid,false);
  const matching=request.replace('templateId: feature-request-v1','templateId: frontend-v2\ncomponent: search')+'\n## Accessibility\nSelection remains visible to keyboard users.\n';
  const accepted=validateFeatureReadiness(matching,ready(),'codex-cli',customized);
  assert.equal(accepted.valid,true);assert.equal(accepted.input.metadata.component,'search');assert.equal(accepted.input.templateId,'frontend-v2');
  assert.match(accepted.input.message,/Request metadata/);assert.match(accepted.input.message,/\"component\": \"search\"/);assert.match(accepted.input.message,/worker retains execution policy and verification authority/);
  assert.equal(validateFeatureReadiness(matching.replace('component: search','component: '+ 'x'.repeat(8000)),ready(),'codex-cli',customized).valid,false);
  assert.notEqual(validateFeatureReadiness(matching.replace('component: search','component: navigation'),ready(),'codex-cli',customized).inputHash,accepted.inputHash);
  assert.equal(validateFeatureReadiness(matching.replace('component: search','component: ""'),ready(),'codex-cli',customized).valid,false);
  assert.throws(()=>validateFeatureTemplate(template.replace('templateId: feature-request-v1\n','')),/templateId/);
});
test('offline validation fails closed for facts that require runtime evidence',()=>{
  const check={...ready(),rules:{chat:[],patch:[{id:'bounded-input-files',fact:'input.approvedBytes',op:'lte',value:5000}]}};
  const result=validateFeatureReadiness(request,check,'codex-cli',template);
  assert.equal(result.valid,false);assert.equal(result.errors[0].code,'ready_fact_unavailable');
  assert.equal(result.evaluation.rules.find(rule=>rule.ruleId==='bounded-input-files').observed,null);
});
test('workflow loader reads every source from one immutable commit and retains source hashes',async()=>{
  const f=fixture(), snapshot=await loadFeatureWorkflowSnapshot({commit,readBlob:f.readBlob});
  assert.equal(f.reads.length,5);assert.ok(f.reads.every(read=>read.revision===commit));
  assert.equal(snapshot.commit,commit);assert.equal(snapshot.files.template.sha256,featureContentHash(template));
  assert.equal(snapshot.configuration.requestsDirectory,'features');assert.equal(snapshot.policy.id,snapshot.configuration.id);
  f.files.set('fr-ready-check.json','invalid edited policy');assert.equal(snapshot.readyCheck.id,'fr-ready-check');
  assert.equal(validateFeatureReadiness(request,snapshot.readyCheck,'codex-cli',snapshot.template).valid,true);
});
test('missing or changed policy files fail closed instead of falling back to worker defaults',async()=>{
  await assert.rejects(loadFeatureWorkflowSnapshot({commit:'main',readBlob:fixture().readBlob}),/immutable/);
  for(const overrides of [{'fr-ready-check.json':null},{'fr-done-check.json':'{'},{'fr-ready-check.json':JSON.stringify(done())},{'features/_templates/feature-request.md':template.replace('mode: patch','mode: chat')},{'Feature Requests.base':''},{'fr-ready-check.json':' '.repeat(65537)}]) {
    const f=fixture(overrides);await assert.rejects(loadFeatureWorkflowSnapshot({commit,readBlob:f.readBlob}));
  }
});
test('done verdicts require recorded artifacts and never infer test/build evidence from prose',()=>{
  const check={...done(),rules:{chat:[],patch:[{id:'tests',fact:'tests.passed',op:'eq',value:true},{id:'build',fact:'build.passed',op:'neq',value:false}]}};
  const policy=featureWorkflowPolicy(ready(),check), facts={'execution.outcome':'completed','output.nonEmpty':true,'output.protocolValid':true,'output.patchPresent':true,'output.changedFileCount':1,'pending.count':0,'findings.blockingCount':0};
  assert.equal(evaluateFeatureDone(policy,facts).passed,false);
  assert.deepEqual(evaluateFeatureDone(policy,facts).rules.filter(rule=>['tests','build'].includes(rule.ruleId)).map(rule=>rule.result),['unknown','unknown']);
  assert.equal(evaluateFeatureDone(policy,{...facts,'tests.passed':true,'build.passed':true}).passed,true);
  assert.equal(evaluateFeatureDone(featureWorkflowPolicy(ready(),done()),{}).passed,false);
  assert.equal(evaluateFeatureDone(featureWorkflowPolicy(ready(),done()),{...facts,'output.patchPresent':false}).passed,false);
});

test('readiness shares execution static scope rules before a request can be claimed',()=>{
  const paths=['.werk/worker.json','.agents/skills/example/SKILL.md','.env','src/.cache/output.ts','credentials.txt','config/secrets.json','id_rsa','keys/id_ed25519.pub','config/client.pem','config/client.key','config/client.p12','config/client.pfx','src/with+plus.ts','-option.ts','x'.repeat(241)];
  for(const path of paths){
    assert.throws(()=>validateApprovedPaths([path]),/safe relative non-secret/);
    const result=validateFeatureReadiness(request.replace('src/navigation.ts',path),ready(),'codex-cli',template);
    assert.equal(result.valid,false,path);assert.match(result.errors[0].message,/safe relative non-secret/);
  }
  assert.throws(()=>validateApprovedPaths(['src/a.ts','src/a.ts']),/unique/);
  for(const paths of [[],Array.from({length:33},(_,i)=>'src/file'+i+'.ts')]) assert.throws(()=>validateApprovedPaths(paths));
  for(const path of ['AGENTS.md','CLAUDE.md','src/new-feature.ts','docs/new feature.md','src/secretary.ts']){
    assert.deepEqual(validateApprovedPaths([path]),[path]);
    assert.equal(validateFeatureReadiness(request.replace('src/navigation.ts',path),ready(),'codex-cli',template,{configuration:defaultFeatureWorkflow()}).valid,true,path);
  }
});
test('snapshot-aware readiness protects workflow controls and queue namespaces without broad code denial',()=>{
  const configuration={...defaultFeatureWorkflow(),requestsDirectory:'requirements',reviewDirectory:'review-notes',template:'templates/request.md',base:'Project.base',readyCheck:'checks/ready.json',doneCheck:'checks/done.json'};
  const scope={configuration,workflowPath:'workflow.json'};
  for(const path of ['requirements','requirements/new.md','requirements/nested/other.md','review-notes/result.md','templates/request.md','Project.base','checks/ready.json','checks/done.json','workflow.json','CHECKS/READY.JSON']){
    const result=validateFeatureReadiness(request.replace('src/navigation.ts',path),ready(),'codex-cli',template,scope);
    assert.equal(result.valid,false,path);assert.match(result.errors[0].message,/workflow configuration/);
  }
  for(const path of ['requirements-code/service.ts','review-notes-util.ts','templates/ordinary-document.md','checks/business-rule.ts','AGENTS.md','CLAUDE.md']) assert.equal(validateFeatureReadiness(request.replace('src/navigation.ts',path),ready(),'codex-cli',template,scope).valid,true,path);
});
test('definitionRef is a typed request field, never author metadata, and cannot be combined with definitionId',()=>{
  const withRef=request.replace('mode: patch\n','mode: patch\ndefinitionRef: team-reviewer\nagent: root\n');
  const result=validateFeatureReadiness(withRef,ready(),'codex-cli',template);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.input.definitionRef,'team-reviewer');assert.equal(result.input.agent,'root');
  assert.deepEqual(result.input.metadata,{});assert.doesNotMatch(result.input.message,/Request metadata/);
  assert.notEqual(result.inputHash,validateFeatureReadiness(request,ready(),'codex-cli',template).inputHash);
  assert.match(validateFeatureReadiness(withRef.replace('agent: root\n','agent: root\ndefinitionId: local-id\n'),ready(),'codex-cli',template).errors[0].message,/not both/);
  assert.match(validateFeatureReadiness(withRef.replace('team-reviewer','Team Reviewer'),ready(),'codex-cli',template).errors[0].message,/definitionRef/);
  const templateWithRef=template.replace('mode: patch\n','mode: patch\ndefinitionRef: team-reviewer\nagent: root\n');
  assert.deepEqual(validateFeatureTemplate(templateWithRef).fields,[],'a template may preset the shared reference without making it a required custom field');
});
