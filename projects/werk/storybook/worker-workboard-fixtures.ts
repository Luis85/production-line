import type { FeatureAuthoringResult } from '../src/worker/application/feature-authoring-contracts';
import { state } from '../src/worker/webview/store';
import { installManagedProjectsFixture } from './worker-release-fixtures';
/** Fictional examples only. No Git operation or provider call occurs in these stories. */
export function installWorkboardFixture(variant: 'setup' | 'ready' | 'review' = 'ready') {
  const base = installManagedProjectsFixture(), commands: Record<string, any>[] = [];
  const project = base.projects.projects[0]!;
  project.path = 'C:\\Werk Home\\projects\\web'; project.pollMs = 30000;
  project.policyApproved = variant !== 'setup'; project.intakeEnabled = variant !== 'setup';
  project.detail = variant === 'setup' ? 'Repository cloned. Exact policy approval is required before intake.' : 'Repository cloned and registered. Approved request intake is enabled.';
  project.intakeBlockedReason = variant === 'setup' ? 'Review and approve this exact committed project policy, then recheck setup.' : null;
  base.projects.homeDirectory = 'C:\\Werk Home'; base.projects.home = 'C:\\Werk Home\\projects'; base.projects.stateDirectory = 'C:\\Werk Home\\state\\worker';
  base.policy.approved = variant !== 'setup';
  state.environment!.orchestratorUrl = null;
  const binding = { repositoryId: 'web', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json' };
  state.environment!.sharedIntake = { dependencyPlans: [], selectedProjectId: 'web', projects: [{ id: 'web', label: 'Customer portal', enabled: true }], revision: 1, workerId: 'fixture-worker', config: { ...binding, enabled: true, pollMs: 30000 }, canEdit: false, blockedReason: null, state: 'idle', error: null, lastSyncedAt: null, sourceCommit: null, workflow: null, requests: [] };
  const markdown = ['---','schemaVersion: 1','id: export-orders','templateId: default','title: Export orders','status: draft','mode: patch','provider: claude-cli','paths:','  - src/orders.ts','---','# Goal','','Export orders for finance.','','## Context','','Finance needs a monthly CSV.','','## Acceptance criteria','','All selected orders appear in the export.','','## Verification plan','','Run export tests and inspect headers.'].join('\n');
  const result: FeatureAuthoringResult = { featureId: 'export-orders', name: 'export-orders.md', path: 'features/export-orders.md', markdown, revision: null, status: 'draft', readiness: { valid: true, errors: [] }, workflowDigest: 'fixture-workflow', binding };
  const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href), body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (url.pathname === '/api/requests' && body.action === 'execution_recovery') return Response.json({ schemaVersion: 1, runs: [] });
    if (url.pathname === '/api/shared-intake') return Response.json(state.environment!.sharedIntake);
    if (url.pathname === '/api/features/templates') return Response.json({ projectId: 'web', configured: true, defaultTemplateId: 'default', templates: [{ id: 'default', label: 'Feature Request', path: 'features/_templates/feature-request.md', default: true }] });
    if (url.pathname === '/api/features' && init.method === 'POST' && ['prepare', 'publish'].includes(body.action)) {
      commands.push(body);
      return Response.json({ ...result, markdown: body.markdown ?? result.markdown, ...(body.action === 'publish' ? { revision: 'published-example', status: body.status, publication: { commit: 'a'.repeat(40), branch: 'main' } } : {}) });
    }
    if (variant !== 'review' && url.pathname === '/api/features' && init.method !== 'POST') return Response.json({ enabled: false, tasks: [] });
    return original(input, init);
  };
  if (variant !== 'review') { state.sessions!.records = []; state.sessions!.selected = ''; state.sessions!.execution.currentSessionId = null; state.board!.tasks = []; state.history!.rows = []; }
  return { ...base, commands };
}
