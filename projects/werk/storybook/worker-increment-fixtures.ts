import { state } from '../src/worker/webview/store';
import type { ToolBudgetEvidence } from '../src/worker/application/tool-runtime';
import { installWorkerFixture } from './worker-fixtures';

/** In-memory examples. They never execute a tool, contact a model or change a checkout. */
export function installToolDirectoryFixture(directory: 'private' | 'live' | 'missing', savedSecret = false) {
  const base = installWorkerFixture('settings-ready');
  state.settings!.execution = { maxRuntimeMs: 21_600_000, maxToolCalls: 128, commandTimeoutMs: 300_000 };
  state.settings!.repositories.items = [{ id: 'web', path: '/example/projects/web', remote: 'origin', branch: 'main', watch: true }];
  const chatDirectory = directory === 'private' ? {} : { chatDirectory: 'repository:' + (directory === 'live' ? 'web' : 'removed-project') };
  state.toolAccess = {
    schemaVersion: 1, revision: 5, canEdit: true, saveBlockedReason: null, workerNode: '/example/bin/node',
    builtins: { files: false, cliTools: [], webOrigins: [], commands: [{ id: 'check-types', name: 'Check project types', executable: '/example/bin/npm', args: ['run', 'typecheck'], enabled: true, verification: true, timeoutMs: 300_000, ...chatDirectory }] },
    mcp: [{ id: 'project-tools', name: 'Local project tools', transport: 'stdio', enabled: true, command: '/example/bin/node', args: ['/example/tools/project-server.mjs'], url: '', secretEnv: savedSecret ? 'MCP_AUTH_TOKEN' : '', hasSecret: savedSecret, allowedTools: ['inspect_project'], discoveredTools: [{ name: 'inspect_project', description: 'Inspect the project selected by this server’s working directory.', inputSchema: { type: 'object', properties: {} } }], ...chatDirectory }],
  };
  const fetchFixture: typeof fetch = (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path === '/api/tool-access' && (!init?.method || init.method === 'GET')) return Promise.resolve(Response.json(state.toolAccess));
    return base.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return { ...base, fetchFixture };
}

export function installToolBudgetFixture(reason: ToolBudgetEvidence['reason']) {
  const base = installWorkerFixture('populated');
  state.settings!.execution = { maxRuntimeMs: 21_600_000, maxToolCalls: 128, commandTimeoutMs: 300_000 };
  const toolBudget: ToolBudgetEvidence = { reason, maxCalls: 128, windowMs: 21_600_000, callsUsed: reason === 'calls' ? 128 : 9, refusedCalls: reason === 'calls' ? 2 : 1 };
  const fetchFixture: typeof fetch = async (input, init) => {
    const response = await base.fetchFixture(input, init);
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/interactions' && body.action === 'turn') return Response.json({ ...await response.json(), toolBudget });
    return response;
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return { ...base, fetchFixture };
}
