import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { legacyWorkerDestination } = await frontend('src/worker/webview/worker-route-compatibility.ts');
const { settingsSectionId, visibleSettingsSections } = await frontend('src/worker/webview/settings-navigation.ts');
const location = (path,query={},hash='') => ({path,query,hash});
test('legacy request bookmarks retain the exact explicit identity, filters and fragment on the focused request page',()=>{
  for (const path of ['/workboard','/taskboard','/chat']) assert.deepEqual(legacyWorkerDestination(location(path,{session:'local-42',project:'web'},'#answer')),{path:'/request',query:{session:'local-42',project:'web'},hash:'#answer',replace:true});
  assert.equal(legacyWorkerDestination(location('/workboard',{})),undefined);
  assert.equal(legacyWorkerDestination(location('/workboard',{session:['one','two']})),undefined,'Ambiguous IDs never choose an unrelated request');
});
test('project bookmarks choose a project-scoped goal, never invent an authority subject',()=>{
  assert.deepEqual(legacyWorkerDestination(location('/projects',{project:'web'},'#delivery-policy')),{path:'/project',query:{project:'web',step:'policy'},hash:'',replace:true});
  assert.deepEqual(legacyWorkerDestination(location('/projects',{project:'web',request:'FR-42'},'#shared-progress')),{path:'/request',query:{project:'web',request:'FR-42'},hash:'',replace:true});
  assert.equal(legacyWorkerDestination(location('/projects',{},'#delivery-policy')),undefined);
});
test('capacity and duration bookmarks keep their independent save destinations and unknown settings open the directory',()=>{
  assert.equal(settingsSectionId('#queue-settings'),'queue');assert.equal(settingsSectionId('#duration-policy'),'duration-policy');
  assert.equal(settingsSectionId(''),undefined);assert.equal(settingsSectionId('#unrecognized'),undefined);
  assert.deepEqual(legacyWorkerDestination(location('/dashboard',{},'#duration-policy')),{path:'/settings',query:{},hash:'#duration-policy',replace:true});
  const central=visibleSettingsSections(true);assert.ok(!central.some(section=>section.group==='projects'));assert.ok(visibleSettingsSections(false).some(section=>section.id==='shared-intake'));
});
