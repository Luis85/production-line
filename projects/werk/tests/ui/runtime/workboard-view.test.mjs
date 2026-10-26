import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../helpers/frontend-loader.mjs';
const { workboardLane, workboardAction } = await frontend('src/worker/webview/workboard-view.ts');
const { managedProjectCommand, emptyManagedProjectDraft } = await frontend('src/worker/webview/managed-project-view.ts');
const { workerLinks } = await frontend('src/worker/webview/worker-navigation.ts');
/** @param {Partial<import('../../../src/worker/webview/task-overview.ts').TaskOverviewItem>} patch */
function item(patch = {}) { return /** @type {import('../../../src/worker/webview/task-overview.ts').TaskOverviewItem} */ ({ id:'request:one', title:'Export orders', group:'attention', status:'review', statusLabel:'Ready for review', primaryAction:{ kind:'review', href:'/review?session=one', label:'Review candidate' }, ...patch }); }

test('Workboard separates review and explicit merge from questions, failed attempts and running delivery', () => {
  assert.equal(workboardLane(item()), 'review');
  assert.equal(workboardLane(item({status:'merge_pending',statusLabel:'Awaiting main checkout merge'})), 'review');
  assert.equal(workboardLane(item({status:'release_pending',statusLabel:'Awaiting release'})), 'review');
  assert.equal(workboardLane(item({status:'waiting_input',statusLabel:'Needs an answer'})), 'attention');
  assert.equal(workboardLane(item({status:'failed',statusLabel:'Failed'})), 'attention');
  assert.equal(workboardLane(item({status:'interrupted',statusLabel:'Interrupted'})), 'attention');
  assert.equal(workboardLane(item({deliveryRunId:'delivery:one',status:'running',statusLabel:'Running'})), 'running');
  assert.equal(workboardLane(item({status:'done',statusLabel:'Done',group:'completed'})), 'completed');
});

test('clearer card labels preserve exact review identity and never invent an action for legacy conversations', () => {
  const original=item(), before=structuredClone(original), projected=workboardAction(original);
  assert.equal(projected.primaryAction.label,'Review increment');
  assert.equal(projected.primaryAction.href,'/review?session=one');
  assert.deepEqual(original,before);
  assert.equal(workboardAction(item({status:'failed',statusLabel:'Failed'})).primaryAction.label,'Open progress');
  const legacy=item({primaryAction:{kind:'session',label:'Open conversation',href:'/taskboard?session=old',sessionId:'old'}});
  assert.equal(workboardAction(legacy),legacy);
});

test('Add project freezes visible folder, branch and polling settings into the same replayable operation', () => {
  const draft={...emptyManagedProjectDraft(),id:' portal ',repository:' ssh://git@example.test/team/portal.git ',branch:' integration ',featuresDirectory:' requests ',pollSeconds:45};
  const command=managedProjectCommand(draft,'register:one');
  assert.deepEqual(command,{action:'register',operationId:'register:one',intake:'shared',id:'portal',repository:'ssh://git@example.test/team/portal.git',branch:'integration',featuresDirectory:'requests',pollMs:45000});
  draft.repository='https://example.test/other.git';draft.pollSeconds=3;
  assert.equal(command.pollMs,45000);assert.equal(command.operationId,'register:one');
  assert.equal(emptyManagedProjectDraft().pollSeconds,30);
});

test('primary navigation opens Workboard with Projects and Workflow one step away', () => {
  assert.deepEqual(workerLinks.map(link=>[link.path,link.label]),[['/workboard','Workboard'],['/projects','Projects'],['/workflow','Workflow'],['/settings','Settings']]);
});

test('pre-admission notifications keep the project and exact Feature Request instead of an installation fallback', () => {
  const request=item({projectId:'company',featureName:'export orders.md',primaryAction:{kind:'feature',label:'Inspect Ready Check',href:'/settings#shared-intake'}});
  const projected=workboardAction(request), url=new URL(projected.primaryAction.href,'http://localhost');
  assert.equal(url.pathname,'/projects');assert.equal(url.searchParams.get('project'),'company');assert.equal(url.searchParams.get('request'),'export orders.md');assert.equal(url.hash,'#shared-progress');
  assert.equal(request.primaryAction.href,'/settings#shared-intake');
});
