import { state } from '../src/worker/webview/store';
import type { DevelopmentScopeView, DevelopmentEvidence } from '../src/worker/application/development';
import { installWorkerFixture, fixtureTime } from './worker-fixtures';
export type DevelopmentFixture = 'passed' | 'failed' | 'stale' | 'proposal' | 'setup' | 'budget' | 'budget-environment';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** In-memory UI fixtures only: no command, model call, Git write or runtime save occurs. */
export function installDevelopmentFixture(variant: DevelopmentFixture = 'passed') {
  const base = installWorkerFixture('populated');
  const scope: DevelopmentScopeView = { schemaVersion: 1, mode: 'worktree', baseCommit: '1'.repeat(40), approvedPaths: ['src/requests.ts', 'test/requests.test.ts'], checks: [{ id: 'tests', name: 'Request acceptance tests', fingerprint: '2'.repeat(64) }, { id: 'types', name: 'Check project types', fingerprint: '3'.repeat(64) }] };
  const evidence: DevelopmentEvidence = { schemaVersion: 1, candidateDigest: 'a'.repeat(64), changedPaths: [...scope.approvedPaths], updatedAt: fixtureTime, checks: scope.checks.map(check => ({ presetId: check.id, presetFingerprint: check.fingerprint, candidateDigest: 'a'.repeat(64), status: 'passed', exitCode: 0, stdout: check.id === 'tests' ? 'Illustrative test result\n7 passed, 0 failed\nNo command was run by this fixture.' : 'Illustrative type check passed. No command was run.', stderr: '', startedAt: '2026-10-15T10:29:00.000Z', finishedAt: fixtureTime })) };
  if (variant === 'failed') Object.assign(evidence.checks[0], { status: 'failed', exitCode: 1, stdout: 'Illustrative test result: 6 passed, 1 failed.', stderr: 'Expected oldest request first; received newest first.\n<fixture-output> is plain text, never interpreted HTML.' });
  if (variant === 'stale') evidence.candidateDigest = 'b'.repeat(64);
  const task = { ...base.file, title: 'Add stable request ordering', instruction: 'Sort requests by creation time, preserving input order when dates are equal. Add acceptance tests.', repository: '/example/projects/web', worktree: '/example/.werk/worker/worktrees/request-ordering', status: variant === 'failed' || variant === 'stale' ? 'needs_rework' : 'review', error: variant === 'failed' ? 'Required feature check failed. Repair the candidate and rerun its checks before review.' : null, files: scope.approvedPaths.map(path => ({ path, content: '// Illustrative approved file', existed: true })), summary: 'Illustrative candidate and verification receipts. No model or command was run.', patch: 'diff --git a/src/requests.ts b/src/requests.ts\n--- a/src/requests.ts\n+++ b/src/requests.ts\n@@ -1 +1 @@\n-export const order = requests => requests;\n+export const order = requests => requests.toSorted((a, b) => a.createdAt - b.createdAt);\n', ...(variant === 'proposal' ? {} : { implementation: scope, developmentEvidence: evidence }) };
  state.settings!.board.paused = true;
  state.settings!.execution = { maxRuntimeMs: 14400000, maxToolCalls: 128, commandTimeoutMs: 300000, candidateSourceMaxBytes: 67108864, candidateSourceMaxFiles: 20000, candidateFileMaxBytes: 8388608 };
  state.settings!.executionSource = variant === 'budget-environment' ? 'environment' : 'saved_settings';
  state.settings!.repositories.items = state.settings!.repositories.items.slice(0, 1);
  state.toolAccess = { schemaVersion: 1, revision: 1, workerNode: '/example/bin/node', canEdit: true, saveBlockedReason: null, builtins: { files: true, commands: scope.checks.map(check => ({ id: check.id, name: check.name, executable: '/example/bin/node', args: check.id === 'tests' ? ['--test', 'test/requests.test.ts'] : ['node_modules/typescript/bin/tsc', '--noEmit'], enabled: true, verification: variant !== 'setup' })), cliTools: [], webOrigins: [] }, mcp: [] };
  state.board!.tasks = [{ ...task, hasPatch: true, files: task.files.map(file => ({ path: file.path, sha256: '4'.repeat(64) })) }] as NonNullable<typeof state.board>['tasks'];
  state.sessions!.selected = 'file';
  const session = state.sessions!.records.find(item => item.id === 'file')!;
  Object.assign(session, { title: task.title, status: task.status });
  state.chat = { ...state.chat!, messages: [{ id: 'development-user', role: 'user', state: 'complete', at: fixtureTime, text: task.instruction }, { id: 'development-model', role: 'assistant', state: 'complete', at: fixtureTime, text: '**Illustrative fixture.** No live model or verification command was run. Inspect the sample candidate evidence below.' }] };
  let savedSettings = clone(state.settings!), savedTools = clone(state.toolAccess!);
  const submissions: Array<{ path: string; body: any }> = [];
  let reads = 0;
  const fetchFixture: typeof fetch = async (input, init = {}) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/settings') {
      if (init.method === 'POST') {
        submissions.push({ path, body: clone(body) });
        if (body.expectedToolBudget && (body.expectedToolBudget.maxToolCalls !== savedSettings.execution.maxToolCalls || body.expectedToolBudget.commandTimeoutMs !== savedSettings.execution.commandTimeoutMs)) return Response.json({ error: 'Reload current tool budget settings before saving.' }, { status: 409 });
        if (body.expectedCandidateInspection && ['candidateSourceMaxBytes', 'candidateSourceMaxFiles', 'candidateFileMaxBytes'].some(key => body.expectedCandidateInspection[key] !== savedSettings.execution[key as keyof typeof savedSettings.execution])) return Response.json({ error: 'Reload current repository inspection limits before saving.' }, { status: 409 });
        savedSettings = { ...savedSettings, resources: { ...savedSettings.resources, ...body.resources }, execution: { ...savedSettings.execution, ...body.execution } };
      }
      return Response.json(savedSettings);
    }
    if (path === '/api/tool-access') {
      if (init.method === 'POST') {
        submissions.push({ path, body: clone(body) });
        if (body.expectedRevision !== savedTools.revision) return Response.json({ error: 'Saved access changed. Reload it before saving.' }, { status: 409 });
        savedTools = { ...savedTools, revision: savedTools.revision + 1, builtins: clone(body.builtins), mcp: clone(body.mcp) };
      }
      return Response.json(savedTools);
    }
    if (path === '/api/taskboard/detail') return Response.json(task);
    if (path === '/api/taskboard') { reads++; return Response.json(state.board); }
    if (path === '/api/sessions') return Response.json(state.sessions);
    if (path === '/api/chat/session') return Response.json({ sessions: state.sessions, chat: state.chat });
    if (path === '/api/chat') return Response.json(state.chat);
    return base.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return { task, state, fetchFixture, submissions, reads: () => reads,
    changeSavedInspection(candidateSourceMaxBytes: number) { savedSettings.execution.candidateSourceMaxBytes = candidateSourceMaxBytes; state.settings = clone(savedSettings); },
    changeSavedBudget(maxToolCalls: number) { savedSettings.execution.maxToolCalls = maxToolCalls; state.settings = clone(savedSettings); },
    setCandidate(next: 'passed' | 'failed' | 'stale') {
      task.status = next === 'passed' ? 'review' : 'needs_rework'; evidence.candidateDigest = (next === 'stale' ? 'b' : 'a').repeat(64);
      Object.assign(evidence.checks[0], { status: next === 'failed' ? 'failed' : 'passed', exitCode: next === 'failed' ? 1 : 0 });
      state.board!.tasks = [{ ...clone(task), hasPatch: true, files: task.files.map(file => ({ path: file.path, sha256: '4'.repeat(64) })) }] as NonNullable<typeof state.board>['tasks'];
    },
  };
}
