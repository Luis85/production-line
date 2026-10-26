import type { ManagedSetupPlan, ManagedSetupResult } from '../src/worker/application/managed-project-setup';
import { installWorkboardFixture } from './worker-workboard-fixtures';
import { state } from '../src/worker/webview/store';
export type ProjectGoalScenario = 'directory' | 'registration' | 'approval' | 'workflow' | 'intake' | 'enable' | 'publication';
/** In-memory journeys only. Never clones, commits, publishes, or grants actual policy authority. */
export function installProjectGoalsFixture(scenario: ProjectGoalScenario) {
  const base = installWorkboardFixture('setup'), seed = structuredClone(base.projects.projects[0]!);
  const commands: Record<string, unknown>[] = [];
  state.environment!.homeLayout = 'central';
  if (scenario === 'registration') base.projects.projects = [];
  if (scenario === 'workflow' || scenario === 'publication') base.projects.projects[0]!.workflow.configured = false;
  if (scenario === 'intake') state.environment!.sharedIntake!.canEdit = true;
  if (scenario === 'enable') { base.projects.projects[0]!.policyApproved = true; base.policy.approved = true; }
  const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  const plan: ManagedSetupPlan = { schemaVersion:1, projectId:'web', branch:'main', baseCommit:'a'.repeat(40), checkoutCommit:'a'.repeat(40), provider:'claude-cli', planDigest:'b'.repeat(64), requiresPolicyApproval:true, files:[{path:'.werk/delivery-policy.json',status:'create',sha256:'c'.repeat(64),content:'{"localMerge":true}'}] };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href), body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (url.pathname === '/api/managed-projects') {
      if (init.method !== 'POST') return Response.json(base.projects);
      commands.push(structuredClone(body));
      if (body.action === 'register') {
        if (!base.projects.projects.some(item => item.id === body.id)) base.projects.projects.push({ ...structuredClone(seed), id:body.id, name:body.name || body.id, repository:body.repository, path:'C:\\Werk Home\\projects\\'+body.id, branch:body.branch, featuresDirectory:body.featuresDirectory, pollMs:body.pollMs, detail:'Registration saved. Review this project’s policy before enabling requests.' });
        if (commands.filter(item => item.action === 'register').length === 1) return Response.json({ error:'The registration acknowledgement was interrupted.' }, {status:503});
      }
      if (body.action === 'setup_plan') return Response.json(plan);
      if (body.action === 'setup_apply' || body.action === 'setup_reconcile') {
        const project = base.projects.projects.find(item => item.id === body.id)!;
        const result: ManagedSetupResult = { schemaVersion:1, projectId:body.id, operationId:body.operationId, branch:'main', status:body.action === 'setup_apply' && scenario !== 'publication' ? 'unknown' : 'published', commit:'e'.repeat(40), requiresPolicyApproval:true, detail:body.action === 'setup_apply' && scenario !== 'publication' ? 'Publication acknowledgement was interrupted. Confirm the saved setup operation.' : 'Project workflow publication confirmed.' };
        if (result.status === 'unknown') project.setup = result;
        else { project.workflow.configured = true; delete project.setup; }
        state.refreshRevision++; return Response.json(result);
      }
      if (body.action === 'reconcile') {
        const project = base.projects.projects.find(item => item.id === body.id)!;
        if (project.policyApproved === true) { project.intakeEnabled = true; project.intakeBlockedReason = null; project.detail='Approved intake is enabled for this worker-owned checkout.'; }
      }
      state.refreshRevision++; return Response.json(base.projects);
    }
    if (url.pathname === '/api/shared-intake' && body.action === 'configure') { commands.push(structuredClone(body)); state.environment!.sharedIntake!.config = body.config; state.environment!.sharedIntake!.revision++; return Response.json(state.environment!.sharedIntake); }
    const result = await original(input, init);
    if (url.pathname === '/api/requests' && body.action === 'approve_delivery_policy') { commands.push(structuredClone(body)); const project = base.projects.projects.find(item => item.id === body.repositoryId); if (project) project.policyApproved = base.policy.approved; state.refreshRevision++; }
    return result;
  };
  return { ...base, commands, plan };
}
