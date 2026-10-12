import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validateDefinition, planDefinition } from '../../scripts/system/definition.mjs';
import { formatPlan } from '../../scripts/system/plan-view.mjs';
const definition = {schemaVersion:1,id:'demo',environment:'native',factory:{id:'factory',name:'Demo Factory',port:3100,subFactories:[{id:'team',name:'Team',parentId:'factory'}]},productionLines:[{id:'line',name:'Delivery',factoryId:'team',project:'app',orchestrator:{port:3001},workers:{count:2,statusPort:4201}}]};
test('human plan exposes ownership, every worker port and separate credential locations without claiming readiness',()=>{
  const plan=planDefinition(validateDefinition(definition));const text=formatPlan(plan,{stateDir:'/private/state'});
  for(const expected of ['2 factories, 1 production lines, 2 workers','Subfactory Team (team) → factory','Line Delivery (line) → team','4201, 4202','http://127.0.0.1:3001',join('/private/state','factory','credentials.json'),join('lines','<line-id>','credentials.json'),'Availability has not been checked','no state, credentials or services created']) assert.ok(text.includes(expected),expected);
  assert.equal(plan.environment,'native');
});
test('Docker plan gives host-Node-free launchers and terminal control characters are not rendered',()=>{
  const plan=planDefinition(validateDefinition({...definition,environment:'docker'}));plan.factory.name='Unsafe\u001b[31m name';
  const text=formatPlan(plan,{stateDir:'/tmp/state\nnew'});assert.match(text,/bash werk-docker.sh/);assert.match(text,/werk-docker.ps1/);assert.doesNotMatch(text,/\u001b/);assert.match(text,/state new/);
});
