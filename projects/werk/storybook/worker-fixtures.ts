import { state } from '../src/worker/webview/store';

/** Fictional, in-memory examples. These fixtures never contact a provider or a runtime. */
export const fixtureTime = '2026-10-15T10:30:00.000Z';
const startedAt = '2026-10-15T10:28:00.000Z';
const initialState = JSON.parse(JSON.stringify(state));
export type WorkerFixture = 'populated' | 'empty' | 'running' | 'checkpoint' | 'failed' | 'history-error' | 'locked';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const fixtureUsage = { inputTokens: 1260, outputTokens: 324, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, costBasis: 'unavailable', source: 'provider_reported', reason: 'Illustrative token measurements; no billable model call occurred.' };
const consumption = { runs: 1, reportedRuns: 1, ...fixtureUsage, coverage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, providerReportedCostUsd: 0 } };
const resource = { scope: 'worker_process', processInstanceId: 'storybook-process', rssBytes: 98_000_000, heapUsedBytes: 31_000_000, cpuUserMicros: 850_000, cpuSystemMicros: 140_000, uptimeSeconds: 720 };
const snapshot = (state: string) => ({ measurement: 'execution_boundary', capturedAt: state === 'running' ? startedAt : fixtureTime, state, resources: resource, consumption });
const interaction = (id: string, phase = 'completed') => {
  const pending = phase === 'waiting_input' ? { id: 'decision-package', kind: 'question', message: 'Which delivery format should the release include?', reason: 'The scope needs an explicit decision before this task continues.', choices: [{ id: 'desktop', label: 'Desktop app' }, { id: 'browser', label: 'Browser app' }], createdAt: fixtureTime, turnId: 'turn-' + id } : null;
  const turn = phase === 'idle' ? null : { id: 'turn-' + id, runId: 'run-' + id, kind: 'message', status: phase, createdAt: startedAt, finishedAt: phase === 'running' || phase === 'queued' ? null : fixtureTime, priorTurnId: null };
  return { schemaVersion: 1, sessionId: id, revision: 3, phase, pending, latestTurn: turn, turns: turn ? [turn] : [], totalTurns: turn ? 1 : 0 };
};
const session = (id: string, title: string, status: string, kind = 'chat') => ({ id, taskId: 'task-' + id, title, provider: 'codex-cli', kind, createdAt: startedAt, archived: false, status, messages: status === 'draft' ? 0 : 2, busy: ['running', 'queued'].includes(status), interaction: interaction(id, status === 'draft' ? 'idle' : status) });
export const diagnosticFixture = { workerId: 'storybook-worker', machineId: 'storybook-machine', project: 'Werk release', state: 'standalone', mode: 'mock', maxParallel: 1, activeTasks: [], queuedTasks: [], profiles: [{ id: 'simulation', provider: 'codex', mode: 'mock' }], completedSimulations: 12, completedReviews: 0, heartbeatErrors: 0, lastContact: null, lastError: null, updatedAt: fixtureTime, configurationHash: 'storybook-configuration', lastSnapshot: 'storybook-snapshot', outbox: { pending: 0 } };

export function installWorkerFixture(variant: WorkerFixture = 'populated') {
  const empty = variant === 'empty' || variant === 'locked';
  const records = empty ? [] : [session('decision', 'Confirm the release scope', 'waiting_input'), session('release', 'Prepare the release checklist', 'queued'), session('docs', 'Document interaction states', 'queued'), session('completed', 'Review the task lifecycle', 'completed'), session('draft', 'Explore retry guidance', 'draft'), session('file', 'Review the navigation patch', 'review', 'local')];
  if (variant === 'running') records.push(session('running', 'Validate worker restart behavior', 'running'));
  if (variant === 'failed') records.push(session('failed', 'Inspect the failed request', 'failed'));
  const selected = empty ? '' : variant === 'checkpoint' ? 'decision' : variant === 'running' ? 'running' : variant === 'failed' ? 'failed' : 'completed';
  const current = records.find(item => item.id === selected);
  const sessions = { selected, execution: { currentSessionId: variant === 'running' ? 'running' : null, queued: empty ? 0 : 2, maxParallel: 1 }, records };
  const providers = [
    { id: 'codex-cli', label: 'Codex CLI', executable: '/example/bin/codex', model: 'gpt-fixture', configured: true, hasApiKey: false, authentication: 'Host CLI login; not verified' },
    { id: 'claude-cli', label: 'Claude CLI', executable: '', model: '', configured: false, hasApiKey: false, authentication: 'Host CLI login; not verified' },
    { id: 'openai-api', label: 'OpenAI API', executable: '', model: '', configured: false, hasApiKey: false, authentication: 'Private API key' },
    { id: 'anthropic-api', label: 'Anthropic API', executable: '', model: '', configured: false, hasApiKey: false, authentication: 'Private API key' },
  ];
  const repositories = { pollMs: 30000, items: empty ? [] : [
    { id: 'web', path: '/example/projects/web', remote: 'origin', branch: 'main', watch: true },
    { id: 'api', path: '/example/projects/api', remote: 'origin', branch: 'main', watch: true },
  ] };
  const repositoryStatus = { pollMs: repositories.pollMs, items: repositories.items.map((item, index) => ({ ...item, state: index ? 'dirty' : 'ready', currentBranch: 'main', head: 'storybook-commit', ahead: 0, behind: index ? 1 : 0, lastCheckedAt: fixtureTime, lastPulledAt: index ? null : fixtureTime, error: index ? 'Local changes were retained. Commit or stash them before pulling.' : null })) };
  const settings = { repositories, executionSource: 'saved_settings', resources: { longRunningMs: 3_600_000 }, execution: { maxRuntimeMs: 14_400_000 }, providers, connection: { enabled: false, url: '', hasEnrollmentToken: false }, board: { paused: false, maxParallel: 1, queueCapacity: 16, orchestratorQueue: 4, order: 'fifo' } };
  const file = { id: 'file-review', title: 'Review the navigation patch', instruction: 'Clarify the task interaction guidance.', sessionId: 'file', provider: 'codex-cli', model: 'gpt-fixture', repository: '/example/project', files: [{ path: 'README.md', content: '# Worker\nOriginal task guidance.\n', existed: true }], status: 'review', priority: 1, createdAt: startedAt, finishedAt: fixtureTime, error: null, summary: 'A proposed documentation change is ready for human review. No checkout changes or tests were performed.', patch: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n # Worker\n-Original task guidance.\n+Open the taskboard to add work or follow up on a task.\n', archived: false, interaction: interaction('file'), changedFileCount: 1, runId: 'run-file' };
  const board = { settings: settings.board, tasks: empty ? [] : [{ ...file, files: file.files.map(item => ({ path: item.path, sha256: 'storybook-sha256' })), hasPatch: true }], running: 0, persistenceError: false };
  const chat = { sessionId: selected, messages: empty ? [] : [
    { id: 'message-user', role: 'user', state: 'complete', at: startedAt, text: 'Review the task lifecycle and identify the next step.' },
    { id: 'message-model', role: 'assistant', state: variant === 'running' ? 'pending' : variant === 'failed' ? 'error' : 'complete', at: fixtureTime, text: variant === 'failed' ? 'The request was interrupted before a final response was saved. Inspect this attempt before continuing.' : variant === 'checkpoint' ? 'I need one decision before preparing the release checklist.' : '**Review ready — illustrative fixture**\n\nThe saved task context is retained. Review the navigation patch and confirm the release scope.\n\n```js\nconst nextStep = "Review the saved patch";\n```' },
  ], available: true, busy: variant === 'running', phase: variant === 'running' ? 'running' : 'idle', persistenceError: false };
  const definition = { id: 'release-reviewer', name: 'Release reviewer', digest: 'storybook-definition', createdAt: fixtureTime, agents: [{ name: 'root', description: 'Inspect release acceptance criteria.', instruction: 'Review requirements before proposing work. Ask for missing decisions.', model: 'openai/gpt-fixture', provider: 'openai', unsupported: ['Filesystem tools require instructions-only adaptation.'], requiresAdaptation: true }] };
  const environment = { repositories: repositoryStatus, hostname: 'example-worker', platform: 'linux', osRelease: 'example', architecture: 'x64', nodeVersion: 'v24.0.0', pid: 1234, uptimeSeconds: 720, memory: { hostTotalBytes: 16_000_000_000, hostFreeBytes: 8_000_000_000, processRssBytes: resource.rssBytes, heapUsedBytes: resource.heapUsedBytes, heapTotalBytes: 64_000_000 }, disk: { totalBytes: 100_000_000_000, freeBytes: 72_000_000_000 }, hostLoad: [0.18, 0.22, 0.15], logicalCpus: 8, chat: { configured: true, provider: 'codex-cli' }, orchestratorUrl: null, stateDirectory: '/example/.werk/worker', projectDirectory: '/example/project', pollMs: 3000, taskTimeoutMs: 14_400_000, retainedPairs: 24 };
  const run = { schemaVersion: 1, id: variant === 'running' ? 'run-running' : 'run-completed', sequence: 1, attempt: 1, purpose: 'execution', sessionId: variant === 'running' ? 'running' : 'completed', taskId: 'task-' + selected, kind: 'chat', title: current?.title ?? 'Review the task lifecycle', provider: 'codex-cli', model: 'gpt-fixture', outcome: variant === 'running' ? 'running' : 'completed', acceptedAt: startedAt, startedAt, before: snapshot('running'), after: variant === 'running' ? null : snapshot('completed'), durationMs: variant === 'running' ? null : 120_000, queueDurationMs: 250, usage: fixtureUsage, resourceDelta: { scope: 'worker_process_between_snapshots', cpuUserMicros: 500_000, cpuSystemMicros: 80_000 } };
  const features = { enabled: true, directory: '/example/project/feature-requests', pollMs: 1000, error: null, errors: [], records: [], files: empty ? [] : [{ name: 'release-notes.md', title: 'Prepare public release notes', status: 'draft', source: 'folder', mode: 'chat', provider: 'codex-cli', revision: 'storybook-revision', archived: false }] };
  const history = { rows: empty ? [] : [{ title: 'Simulate release dispatch', pairId: 'pair-simulated', taskId: 'assigned-release', attempt: 1, project: 'Werk release', provider: 'codex', profile: 'simulation', mode: 'mock', startedAt, finishedAt: fixtureTime, outcome: 'simulated', durationMs: 2000, resources: resource, usage: { ...fixtureUsage, inputTokens: null, outputTokens: null, source: 'unavailable', reason: 'Simulated execution; no provider request or token consumption.' }, quality: { gate: 'not_evaluated' }, provenance: { featureId: null }, review: null, completePair: true, error: null }], errors: [], retainedPairs: 24, scanned: empty ? 0 : 1 };
  const status = { ...diagnosticFixture, ...(variant === 'running' ? { state: 'executing' } : {}) };
  const monitoring = { alerts: [], sampledAt: fixtureTime };
  const resourceReport = { snapshot: { capturedAt: fixtureTime, rssBytes: resource.rssBytes, effectiveMemoryLimitBytes: 8_000_000_000, heapUsedBytes: resource.heapUsedBytes, heapLimitBytes: 2_000_000_000, cpuPercent: 2.8, cpuCapacityCores: 8, availableMemoryBytes: 8_000_000_000, diskAvailableBytes: 72_000_000_000, unavailable: [], active: variant === 'running' ? { sessionId: 'running', startedAt, elapsedMs: 120_000 } : null }, alerts: [], sampleIntervalMs: 10_000, policy: settings.resources, sampleError: null, persistenceError: false };
  const policy = { schemaVersion: 1, id: 'storybook-policy', version: 1, ready: { chat: [{ id: 'instructions-present', fact: 'input.messageLength', op: 'gte', value: 10 }], patch: [] }, done: { chat: [{ id: 'human-acceptance', fact: 'operator.accepted', op: 'eq', value: true }], patch: [] }, reviewer: { enabled: false, provider: 'codex-cli', maxAttempts: 1 }, rework: { maxAttempts: 3 } };
  const request = { schemaVersion: 1, id: 'request-review', owner: { sessionId: selected, rootTurnId: 'turn-' + selected }, revision: 1, inputRevision: 1, input: { kind: 'chat', title: 'Review the task lifecycle', message: 'Review requirements and report acceptance evidence.', criteria: ['The release checklist includes verification evidence.'] }, inputHash: 'storybook-input', policy, policyDigest: 'storybook-policy', provider: { id: 'codex-cli', model: 'gpt-fixture' }, phase: 'review', assignee: 'operator', createdAt: startedAt, updatedAt: fixtureTime, reworkCount: 0, evaluations: [{ id: 'ready-evaluation', stage: 'ready', inputRevision: 1, inputHash: 'storybook-input', policyDigest: 'storybook-policy', outputDigest: null, at: startedAt, passed: true, facts: { 'input.messageLength': 50 }, rules: [{ ruleId: 'instructions-present', fact: 'input.messageLength', expected: 10, observed: 50, result: 'pass' }] }, { id: 'done-evaluation', stage: 'done', inputRevision: 1, inputHash: 'storybook-input', policyDigest: 'storybook-policy', outputDigest: 'storybook-output', at: fixtureTime, passed: false, facts: { 'operator.accepted': null }, rules: [{ ruleId: 'human-acceptance', fact: 'operator.accepted', expected: true, observed: null, result: 'unknown' }] }], findings: [{ id: 'finding-acceptance', kind: 'gap', message: 'Human acceptance has not been recorded.', source: 'operator', blocking: true, status: 'open', createdAt: fixtureTime }], candidates: [], reviews: [], execution: { turnId: 'turn-completed', runId: 'run-completed', inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', message: 'Illustrative review ready.' }, outputDigest: 'storybook-output', facts: { 'output.nonEmpty': true } }, attestation: null };
  const responses: Record<string, unknown> = { '/status': status, '/monitoring': monitoring, '/api/environment': environment, '/api/repositories': { schemaVersion: 1, ...repositoryStatus }, '/api/history': history, '/api/chat/session': { sessions, chat }, '/api/chat': chat, '/api/sessions': sessions, '/api/settings': settings, '/api/taskboard': board, '/api/definitions': { definitions: [definition] } };
  const readActions: Record<string, string[]> = { '/api/features': ['get'], '/api/resources': ['events'], '/api/integrations': ['plan'], '/api/interactions': ['get', 'turn'], '/api/requests': ['list', 'get', 'policy'], '/api/runs': ['list', 'get', 'analyze', 'export'], '/api/definitions': ['preview'] };
  const mutationPaths = new Set(['/api/repositories', '/api/access', '/api/features', '/api/resources', '/api/integrations', '/api/interactions', '/api/requests', '/api/definitions', '/api/chat', '/api/chat/cancel', '/api/sessions', '/api/settings', '/api/taskboard', '/api/taskboard/action']);
  const fetchFixture: typeof fetch = async (input, init = {}) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (init.method && init.method !== 'GET' && !['/api/taskboard/detail', '/api/providers/check'].includes(path) && !(readActions[path] ?? []).includes(body.action)) {
      if (mutationPaths.has(path)) return Response.json({ error: 'This is an isolated Storybook example. Runtime changes are disabled.' }, { status: 409 });
      throw Error('Missing Worker story fixture: ' + init.method + ' ' + path);
    }
    if (path === '/api/access') return Response.json({ authenticated: variant !== 'locked' });
    if (path === '/api/definitions' && body.action === 'preview') return Response.json({ agents: definition.agents });
    if (path === '/api/features') return Response.json(init.method === 'POST' ? { name: 'release-notes.md', markdown: '# Prepare public release notes\n\nSummarize the release and its verification evidence.', revision: 'storybook-revision', record: null } : features);
    if (path === '/api/resources') return Response.json(init.method === 'POST' ? { schemaVersion: 1, events: [], nextAfter: 0, hasMore: false, gap: false } : resourceReport);
    if (path === '/api/integrations') return Response.json({ schemaVersion: 1, enabled: true, projectDirectory: '/example/project', planId: 'storybook-plan', canApply: false, files: [{ path: '.agents/skills/werk-worker/SKILL.md', state: 'current', action: 'keep', content: 'Use the project worker CLI to manage tasks.' }] });
    if (path === '/api/interactions') {
      const item = records.find(record => record.id === body.sessionId);
      const view = item?.interaction ?? interaction(body.sessionId ?? selected, 'idle');
      return Response.json(body.action === 'turn' ? { ...view.latestTurn, schemaVersion: 1, sessionId: view.sessionId, input: 'Review the task lifecycle.', context: {}, dispatch: { provider: { id: 'codex-cli', model: 'gpt-fixture' }, model: 'gpt-fixture', messages: [] }, dispatchDigest: 'storybook-dispatch', result: null, usage: fixtureUsage, errorCode: variant === 'failed' ? 'interrupted' : null } : view);
    }
    if (path === '/api/requests') {
      if (body.action === 'policy') return Response.json({ schemaVersion: 1, revision: 1, policy, digest: 'storybook-policy' });
      if (body.action === 'get') return Response.json(request);
      if (body.action === 'list') return Response.json({ schemaVersion: 1, rows: [{ ...request, title: request.input.title, kind: 'chat' }], total: 1, nextOffset: null });
    }
    if (path === '/api/runs') {
      if (variant === 'history-error') return Response.json({ error: 'Execution evidence could not be refreshed. The example preserves the last known task state.' }, { status: 503 });
      if (body.action === 'get') return Response.json(run);
      if (body.action === 'analyze') return Response.json({ schemaVersion: 1, scope: 'worker_session_executions', asOf: 1, total: empty ? 0 : 1, completedPairs: variant === 'running' || empty ? 0 : 1, outcomes: { [run.outcome]: 1 }, consumption, duration: { measuredRuns: empty ? 0 : 1, totalMs: run.durationMs, meanMs: run.durationMs }, resources: { scope: 'worker_process_between_snapshots', measuredRuns: 1, cpuUserMicros: 500_000, cpuSystemMicros: 80_000, peakObservedRssBytes: resource.rssBytes }, notes: ['Measurements in this story are illustrative.'] });
      const rows = empty || body.outcome && body.outcome !== run.outcome ? [] : [run];
      return Response.json({ schemaVersion: 1, rows, total: rows.length, nextOffset: null, nextCursor: null, asOf: 1, scope: 'worker_session_executions' });
    }
    if (path === '/api/taskboard/detail') return Response.json(file);
    if (path === '/api/providers/check') return Response.json({ checkedAt: fixtureTime, authentication: 'storybook', message: 'Illustrative sign-in check. No provider login or model request was made.' });
    if (path in responses && (!init.method || init.method === 'GET')) return Response.json(responses[path]);
    throw Error('Missing Worker story fixture: ' + (init.method ?? 'GET') + ' ' + path);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  state.unlocked = false;
  Object.assign(state, clone(initialState), { settings, sessions, board, status, monitoring, environment, history, chat, definitions: [definition], draftEpoch: state.draftEpoch + 1, unlocked: variant !== 'locked', accessChecked: true, paused: true, lastRead: fixtureTime });
  return { state, file, run, resourceReport, definition, fetchFixture };
}
