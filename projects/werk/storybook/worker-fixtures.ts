import { buildDeliveryMetrics } from '../src/worker/application/delivery-metrics';
import { workerCapacitySnapshot } from '../src/worker/application/worker-capacity';
import { state } from '../src/worker/webview/store';
import { processExample } from './worker-process-fixtures';

/** Fictional, in-memory examples. These fixtures never contact a provider or a runtime. */
export const fixtureTime = '2026-10-15T10:30:00.000Z';
const startedAt = '2026-10-15T10:28:00.000Z';
const initialState = JSON.parse(JSON.stringify(state));
export type WorkerFixture = 'populated' | 'formatted' | 'empty' | 'running' | 'checkpoint' | 'failed' | 'history-error' | 'locked' | 'repository-pending' | 'repository-declined' | 'repository-local' | 'capacity-full' | 'capacity-blocked' | 'capacity-stale' | 'capacity-paused' | 'settings-ready' | 'tracking-read-error' | 'tracking-save-error' | 'admission-failed' | 'file-reply';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** A file-task change set saved verbatim by Werk 0.9.0 and earlier; the transcript must not show it raw. */
export const fileReplyFixture = JSON.stringify({
  summary: 'Changed README.md only. The guidance now names the Taskboard.\n\n[OPEN] Specs belong under ../tests/unit/**/*.spec.ts; src/**/*.spec.ts is excluded from the build. Tests have not run.',
  files: [{ path: 'README.md', content: '# Worker\nOpen the taskboard to add work or follow up on a task.\n' }],
});
/** A synthetic model reply for checking readable Markdown, never release validation evidence. */
export const formattedReplyFixture = [
  '# Release review',
  '',
  '*Illustrative fixture — no model call or verification command was run.*',
  '',
  'The **saved patch** is ready for a human review. Keep the original checkout unchanged until the scope is accepted.',
  '',
  '## Next steps',
  '',
  '1. Inspect the proposed documentation change.',
  '   - Confirm the task instructions are clear.',
  '   - Keep the existing `README.md` content outside the approved scope.',
  '2. Record the review decision before preparing the release.',
  '',
  '> A completed model reply is a proposal. It does not prove that tests ran or that a release was published.',
  '',
  '## Evidence to collect',
  '',
  '| Check | Example status | Next action |',
  '| --- | --- | --- |',
  '| Saved patch | Ready for review | Inspect the diff |',
  '| Verification | Not run in this example | Run the project checks |',
  '| Release | Not published | Confirm the reviewed scope |',
  '',
  '```js',
  'const nextStep = "Review the saved patch";',
  '```',
  '',
  '[Read the worker guide](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/use-worker-webview.md).',
].join('\n');

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
const trackingDirectory = '/example/project/feature-requests/_tasks';
const requestNote = (item: ReturnType<typeof session>) => ({ sessionId: item.id, taskId: item.taskId, filename: item.id + '.md', path: trackingDirectory + '/' + item.id + '.md', revision: 'storybook-note-' + item.id, updatedAt: fixtureTime, status: item.status });
function requestMarkdown(item: ReturnType<typeof session>) {
  const waiting = item.status === 'waiting_input', hasResult = ['completed', 'review'].includes(item.status);
  const progress = ({ waiting_input: 'Waiting for the user to choose the delivery format.', running: 'A model attempt is in progress.', queued: 'Waiting in the execution queue.', draft: 'No work has been submitted yet.', failed: 'The request failed. Inspect its retained context before deciding the next step.' } as Record<string, string>)[item.status] ?? 'A proposed result is ready for human review.';
  return [
    '---', 'type: feature-request', 'session_id: ' + item.id, 'title: ' + JSON.stringify(item.title), 'status: ' + item.status, 'updated: ' + fixtureTime, 'tags: [werk, feature-request]', '---',
    '# ' + item.title, '', '*Illustrative Storybook record. No task, file write, model call or verification command was run.*', '',
    '## Request', '', 'Review the task lifecycle and identify the next step.', '',
    '## Progress', '', '- Request retained under the same session identity.',
    '- ' + progress, '',
    '## Questions', '', waiting ? '**Which delivery format should the release include?**\n\n- Desktop app\n- Browser app' : 'No unanswered question in this example.', '',
    '## Results', '', !hasResult ? 'No final result has been recorded.' : 'Review the saved navigation patch and confirm the release scope. Verification has not been performed in this example.', '',
    '## Attempts', '', ...(item.interaction.latestTurn ? ['| Attempt | Status | Model |', '| --- | --- | --- |', '| 1 | ' + item.status + ' | gpt-fixture |'] : ['No model attempt has been recorded.']), '',
  ].join('\n');
}
export const diagnosticFixture = { workerId: 'storybook-worker', machineId: 'storybook-machine', project: 'Werk release', state: 'standalone', mode: 'mock', maxParallel: 1, activeTasks: [], queuedTasks: [], profiles: [{ id: 'simulation', provider: 'codex', mode: 'mock' }], completedSimulations: 12, completedReviews: 0, heartbeatErrors: 0, lastContact: null, lastError: null, updatedAt: fixtureTime, configurationHash: 'storybook-configuration', lastSnapshot: 'storybook-snapshot', outbox: { pending: 0 } };

export function installWorkerFixture(variant: WorkerFixture = 'populated') {
  const running = ['running', 'capacity-full', 'capacity-stale'].includes(variant);
  const admissionFailed = variant === 'admission-failed';
  const admissionFailureReason = 'Request preparation was interrupted and the retained worktree changed. No approved file snapshots were accepted. Inspect the preserved worktree, then create a new request.';
  const settingsReady = variant === 'settings-ready';
  const capturedAt = new Date().toISOString();
  const empty = settingsReady || variant === 'empty' || variant === 'locked' || variant.startsWith('repository-');
  const baseRecords = empty ? [] : [session('decision', 'Confirm the release scope', 'waiting_input'), session('release', 'Prepare the release checklist', 'queued'), session('docs', 'Document interaction states', 'queued'), session('completed', 'Review the task lifecycle', 'completed'), session('draft', 'Explore retry guidance', 'draft'), session('file', 'Review the navigation patch', 'review', 'local')];
  if (running) baseRecords.push(session('running', 'Validate worker restart behavior', 'running'));
  if (variant === 'failed') baseRecords.push(session('failed', 'Inspect the failed request', 'failed'));
  if (admissionFailed) Object.assign(baseRecords.find(item => item.id === 'file')!, { title: 'Recover interrupted request preparation', status: 'failed', messages: 1, interaction: interaction('file', 'idle') });
  const records = baseRecords.map(item => ({ ...item, ...(admissionFailed && item.id === 'file' ? { continuationBlockedReason: admissionFailureReason } : {}), featureRequest: variant === 'tracking-save-error' ? undefined : requestNote(item) }));
  const selected = empty ? '' : admissionFailed || variant === 'file-reply' ? 'file' : variant === 'checkpoint' ? 'decision' : running ? 'running' : variant === 'failed' ? 'failed' : 'completed';
  const current = records.find(item => item.id === selected);
  const providers = [
    { id: 'codex-cli', label: 'Codex CLI', executable: '/example/bin/codex', model: 'gpt-fixture', configured: true, hasApiKey: false, authenticationMode: 'cli-account', authentication: 'Host CLI login; not verified' },
    { id: 'claude-cli', label: 'Claude CLI', executable: '', model: '', configured: false, hasApiKey: false, authenticationMode: 'cli-account', authentication: 'Host CLI login; not verified' },
    { id: 'openai-api', label: 'OpenAI API', executable: '', model: '', configured: false, hasApiKey: false, authenticationMode: 'api-key', authentication: 'Private API key' },
    { id: 'anthropic-api', label: 'Anthropic API', executable: '', model: '', configured: false, hasApiKey: false, authenticationMode: 'api-key', authentication: 'Private API key' },
  ];
  const repositories = { pollMs: 30000, items: empty ? [] : [
    { id: 'web', path: '/example/projects/web', remote: 'origin', branch: 'main', watch: true },
    { id: 'api', path: '/example/projects/api', remote: 'origin', branch: 'main', watch: true },
  ] };
  const discovery = variant.startsWith('repository-') ? { id: 'storybook-repository-discovery', path: '/example/projects/customer-portal/installation-folder-with-a-long-readable-name', currentBranch: 'main', remote: variant === 'repository-local' ? null : 'origin', watch: variant !== 'repository-local', decision: variant === 'repository-declined' ? 'declined' : 'pending' } : null;
  const repositoryStatus = { discovery, pollMs: repositories.pollMs, items: repositories.items.map((item, index) => ({ ...item, state: index ? 'dirty' : 'ready', currentBranch: 'main', head: 'storybook-commit', ahead: 0, behind: index ? 1 : 0, lastCheckedAt: fixtureTime, lastPulledAt: index ? null : fixtureTime, error: index ? 'Local changes were retained. Commit or stash them before pulling.' : null })) };
  const consumptionPolicy = { enabled: variant === 'capacity-blocked', period: 'daily', allowance: variant === 'capacity-blocked' ? 3_168 : 1_000_000, workerPercent: 50, perRunReservation: variant === 'capacity-blocked' ? 1_000 : 10_000 };
  const consumptionStatus = { schemaVersion: 1, policy: consumptionPolicy, periodStart: '2026-10-15T00:00:00.000Z', periodEnd: '2026-10-16T00:00:00.000Z', workerAllowance: 500_000, measuredTokens: 1_584, reservedTokens: 0, chargedTokens: 1_584, remainingTokens: 498_416, activeInvocations: 0, uncertainInvocations: 0, blocked: false, reason: 'disabled', accountingAvailable: true, trackingStartedAt: '2026-10-15T08:00:00.000Z' };
  if (variant === 'capacity-blocked') Object.assign(consumptionStatus, { workerAllowance: 1_584, remainingTokens: 0, blocked: true, reason: 'exhausted' });
  if (running) consumptionStatus.activeInvocations = 1;
  const settings = { defaultProvider: 'codex-cli', consumption: consumptionPolicy, repositories, executionSource: 'saved_settings', resources: { longRunningMs: 3_600_000 }, execution: { maxRuntimeMs: 14_400_000, maxToolCalls: 128, commandTimeoutMs: 300000 }, providers, connection: { enabled: false, url: '', hasEnrollmentToken: false }, board: { paused: settingsReady || variant === 'capacity-paused', maxParallel: 1, queueCapacity: variant === 'capacity-full' ? 3 : 16, orchestratorQueue: 4, order: 'fifo' } };
  const currentSessionId = running ? 'running' : null;
  const sessions = {
    featureTracking: { directory: trackingDirectory, lastSyncedAt: variant === 'tracking-save-error' ? null : fixtureTime, error: variant === 'tracking-save-error' ? 'The Markdown feature request could not be saved. Check directory permissions before retrying.' : null },
    selected, execution: { currentSessionId, queued: records.filter(item => item.status === 'queued').length, maxParallel: 1 }, records,
    capacity: workerCapacitySnapshot({ capturedAt, currentSessionId,
      localUsed: records.filter(item => item.kind !== 'orchestrator' && item.busy).length,
      settings: settings.board, remote: { waiting: 0, running: 0 }, consumption: { blocked: consumptionStatus.blocked, reason: consumptionStatus.reason as 'disabled' | 'exhausted' },
    }),
  };
  const file = { id: 'file-review', title: 'Review the navigation patch', instruction: 'Clarify the task interaction guidance.', sessionId: 'file', provider: 'codex-cli', model: 'gpt-fixture', repository: '/example/project', files: [{ path: 'README.md', content: '# Worker\nOriginal task guidance.\n', existed: true }], status: 'review', priority: 1, createdAt: startedAt, finishedAt: fixtureTime, error: null, summary: 'A proposed documentation change is ready for human review. No checkout changes or tests were performed.', patch: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n # Worker\n-Original task guidance.\n+Open the taskboard to add work or follow up on a task.\n', archived: false, interaction: interaction('file'), changedFileCount: 1, runId: 'run-file' };
  if (admissionFailed) Object.assign(file, { title: 'Recover interrupted request preparation', status: 'failed', files: [], patch: '', changedFileCount: 0, runId: undefined, summary: 'No model call or test was performed. The changed worktree was preserved for inspection.', error: admissionFailureReason, admissionFailure: { paths: ['README.md'] }, worktree: '/example/.werk/worker/worktrees/file-review', interaction: interaction('file', 'idle') });
  const board = { settings: settings.board, tasks: empty ? [] : [{ ...file, files: file.files.map(item => ({ path: item.path, sha256: 'storybook-sha256' })), hasPatch: !!file.patch }], running: 0, persistenceError: false };
  const chat = { sessionId: selected, messages: empty ? [] : [
    { id: 'message-user', role: 'user', state: 'complete', at: startedAt, text: 'Review the task lifecycle and identify the next step.' },
    { id: 'message-model', role: 'assistant', state: running ? 'pending' : variant === 'failed' ? 'error' : 'complete', at: fixtureTime, text: variant === 'formatted' ? formattedReplyFixture : variant === 'file-reply' ? fileReplyFixture : variant === 'failed' ? 'The request was interrupted before a final response was saved. Inspect this attempt before continuing.' : variant === 'checkpoint' ? 'I need one decision before preparing the release checklist.' : '**Review ready — illustrative fixture**\n\nThe saved task context is retained. Review the navigation patch and confirm the release scope.\n\n```js\nconst nextStep = "Review the saved patch";\n```' },
  ], available: true, busy: running, phase: running ? 'running' : 'idle', persistenceError: false };
  if (admissionFailed) chat.messages = [{ id: 'message-user', role: 'user', state: 'complete', at: startedAt, text: file.instruction }];
  const definition = { id: 'release-reviewer', name: 'Release reviewer', digest: 'storybook-definition', createdAt: fixtureTime, agents: [{ name: 'root', description: 'Inspect release acceptance criteria.', instruction: 'Review requirements before proposing work. Ask for missing decisions.', model: 'openai/gpt-fixture', provider: 'openai', unsupported: ['Filesystem tools require instructions-only adaptation.'], requiresAdaptation: true }] };
  const environment = { capturedAt: fixtureTime, repositories: repositoryStatus, hostname: 'example-worker', platform: 'linux', osRelease: 'example', architecture: 'x64', nodeVersion: 'v24.0.0', pid: 1234, uptimeSeconds: 720, memory: { hostTotalBytes: 16_000_000_000, hostFreeBytes: 8_000_000_000, processRssBytes: resource.rssBytes, heapUsedBytes: resource.heapUsedBytes, heapTotalBytes: 64_000_000 }, disk: { totalBytes: 100_000_000_000, freeBytes: 72_000_000_000 }, hostLoad: [0.18, 0.22, 0.15], logicalCpus: 8, chat: { configured: true, provider: 'codex-cli' }, orchestratorUrl: null, stateDirectory: '/example/.werk/worker', projectDirectory: '/example/project', pollMs: 3000, taskTimeoutMs: 14_400_000, retainedPairs: 24 };
  const run = { schemaVersion: 1, id: running ? 'run-running' : 'run-completed', sequence: 1, attempt: 1, purpose: 'execution', sessionId: running ? 'running' : 'completed', taskId: 'task-' + selected, kind: 'chat', title: current?.title ?? 'Review the task lifecycle', provider: 'codex-cli', model: 'gpt-fixture', outcome: running ? 'running' : 'completed', acceptedAt: startedAt, startedAt, before: snapshot('running'), after: running ? null : snapshot('completed'), durationMs: running ? null : 120_000, queueDurationMs: 250, usage: fixtureUsage, resourceDelta: { scope: 'worker_process_between_snapshots', cpuUserMicros: 500_000, cpuSystemMicros: 80_000 } };
  const features = { enabled: true, directory: '/example/project/feature-requests', pollMs: 1000, error: null, errors: [], records: [], files: empty ? [] : [{ name: 'release-notes.md', title: 'Prepare public release notes', status: 'draft', source: 'folder', mode: 'chat', provider: 'codex-cli', revision: 'storybook-revision', archived: false }] };
  const history = { rows: empty ? [] : [{ title: 'Simulate release dispatch', pairId: 'pair-simulated', taskId: 'assigned-release', attempt: 1, project: 'Werk release', provider: 'codex', profile: 'simulation', mode: 'mock', startedAt, finishedAt: fixtureTime, outcome: 'simulated', durationMs: 2000, resources: resource, usage: { ...fixtureUsage, inputTokens: null, outputTokens: null, source: 'unavailable', reason: 'Simulated execution; no provider request or token consumption.' }, quality: { gate: 'not_evaluated' }, provenance: { featureId: null }, review: null, completePair: true, error: null }], errors: [], retainedPairs: 24, scanned: empty ? 0 : 1 };
  const status = { ...diagnosticFixture, ...(running ? { state: 'executing' } : {}) };
  const monitoring = { alerts: [], sampledAt: fixtureTime };
  const toolAccess = { schemaVersion: 1, revision: 0, builtins: { files: false, commands: [], cliTools: [], webOrigins: [] }, mcp: [], canEdit: settingsReady, saveBlockedReason: settingsReady ? null : 'Pause new starts and finish or stop queued and running work before changing tool access.', workerNode: '/example/bin/node' };
  const executionProfiles = { schemaVersion: 1, profiles: [{ id: 'simulation', provider: 'codex', mode: 'mock', maxParallel: 1 }], configurationHash: status.configurationHash, mode: 'mock', allowedProviders: ['claude', 'codex'], maxProfiles: 8, state: 'ready', pending: null, canEdit: settingsReady, saveBlockedReason: settingsReady ? null : 'Pause new starts and finish or stop queued and running work before saving profiles.' };
  const resourceReport = { snapshot: { capturedAt: fixtureTime, rssBytes: resource.rssBytes, effectiveMemoryLimitBytes: 8_000_000_000, heapUsedBytes: resource.heapUsedBytes, heapLimitBytes: 2_000_000_000, cpuPercent: 2.8, cpuCapacityCores: 8, availableMemoryBytes: 8_000_000_000, diskAvailableBytes: 72_000_000_000, unavailable: [], active: running ? { sessionId: 'running', startedAt, elapsedMs: 120_000 } : null }, alerts: [], sampleIntervalMs: 10_000, policy: settings.resources, sampleError: null, persistenceError: false };
  const policy = { schemaVersion: 1, id: 'storybook-policy', version: 1, ready: { chat: [{ id: 'instructions-present', fact: 'input.messageLength', op: 'gte', value: 10 }], patch: [] }, done: { chat: [{ id: 'human-acceptance', fact: 'operator.accepted', op: 'eq', value: true }], patch: [] }, reviewer: { enabled: false, provider: 'codex-cli', maxAttempts: 1 }, rework: { maxAttempts: 3 } };
  const request = { schemaVersion: 1, id: 'request-review', owner: { sessionId: selected, rootTurnId: 'turn-' + selected }, revision: 1, inputRevision: 1, input: { kind: 'chat', title: 'Review the task lifecycle', message: 'Review requirements and report acceptance evidence.', criteria: ['The release checklist includes verification evidence.'] }, inputHash: 'storybook-input', policy, policyDigest: 'storybook-policy', provider: { id: 'codex-cli', model: 'gpt-fixture' }, phase: 'review', assignee: 'operator', createdAt: startedAt, updatedAt: fixtureTime, reworkCount: 0, evaluations: [{ id: 'ready-evaluation', stage: 'ready', inputRevision: 1, inputHash: 'storybook-input', policyDigest: 'storybook-policy', outputDigest: null, at: startedAt, passed: true, facts: { 'input.messageLength': 50 }, rules: [{ ruleId: 'instructions-present', fact: 'input.messageLength', expected: 10, observed: 50, result: 'pass' }] }, { id: 'done-evaluation', stage: 'done', inputRevision: 1, inputHash: 'storybook-input', policyDigest: 'storybook-policy', outputDigest: 'storybook-output', at: fixtureTime, passed: false, facts: { 'operator.accepted': null }, rules: [{ ruleId: 'human-acceptance', fact: 'operator.accepted', expected: true, observed: null, result: 'unknown' }] }], findings: [{ id: 'finding-acceptance', kind: 'gap', message: 'Human acceptance has not been recorded.', source: 'operator', blocking: true, status: 'open', createdAt: fixtureTime }], candidates: [], reviews: [], execution: { turnId: 'turn-completed', runId: 'run-completed', inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', text: 'Illustrative review ready.' }, outputDigest: 'storybook-output', facts: { 'output.nonEmpty': true } }, attestation: null };
  const responses: Record<string, unknown> = { '/status': status, '/monitoring': monitoring, '/api/environment': environment, '/api/repositories': { schemaVersion: 1, ...repositoryStatus }, '/api/history': history, '/api/chat/session': { sessions, chat }, '/api/chat': chat, '/api/sessions': sessions, '/api/settings': settings, '/api/taskboard': board, '/api/definitions': { definitions: [definition] } };
  const readActions: Record<string, string[]> = { '/api/feature-tracking': ['get'], '/api/features': ['get'], '/api/resources': ['events'], '/api/integrations': ['plan'], '/api/interactions': ['get', 'turn'], '/api/requests': ['list', 'get', 'policy', 'metrics', 'delivery_policy', 'delivery_projects', 'publication', 'release', 'execution_recovery'], '/api/runs': ['list', 'get', 'analyze', 'export'], '/api/definitions': ['preview'] };
  const mutationPaths = new Set(['/api/tasks', '/api/shared-intake', '/api/tool-access', '/api/tool-access/discover', '/api/execution-profiles', '/api/repositories', '/api/access', '/api/features', '/api/resources', '/api/integrations', '/api/interactions', '/api/requests', '/api/definitions', '/api/chat', '/api/chat/cancel', '/api/sessions', '/api/settings', '/api/taskboard', '/api/taskboard/action']);
  const fetchFixture: typeof fetch = async (input, init = {}) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (init.method && init.method !== 'GET' && !['/api/taskboard/detail', '/api/providers/check', '/api/providers/account'].includes(path) && !(readActions[path] ?? []).includes(body.action)) {
      if (mutationPaths.has(path)) return Response.json({ error: 'This is an isolated Storybook example. Runtime changes are disabled.' }, { status: 409 });
      throw Error('Missing Worker story fixture: ' + init.method + ' ' + path);
    }
    if (path === '/api/feature-tracking') {
      if (variant === 'tracking-read-error') return Response.json({ error: 'The saved feature request could not be read. The last saved location remains available.' }, { status: 503 });
      if (variant === 'tracking-save-error') return Response.json({ error: 'The Markdown feature request could not be saved. Check directory permissions before retrying.' }, { status: 503 });
      const item = records.find(record => record.id === body.sessionId);
      return item ? Response.json({ ...item.featureRequest, markdown: requestMarkdown(item) }) : Response.json({ error: 'No feature request note exists for this example session.' }, { status: 404 });
    }
    if (path === '/api/shared-intake') return Response.json({ revision: 0, workerId: 'storybook-worker', config: { enabled: false, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 }, canEdit: settingsReady, blockedReason: settingsReady ? null : 'Pause new starts and finish or stop queued and running work before changing shared intake.', state: 'disabled', error: null, lastSyncedAt: null, sourceCommit: null, workflow: null, requests: [] });
    if (path === '/api/providers/account') return Response.json({ id: body.id, signedIn: 'unknown', account: null, email: null, organization: null, subscription: null, authMethod: null, checkedAt: fixtureTime, message: 'Illustrative fixture. No CLI account was checked.' });
    if (path === '/api/managed-projects') return Response.json({ schemaVersion: 1, home: '/example/.werk/worker/projects', projects: [], diagnostics: [] });
    if (path === '/api/consumption') return Response.json(consumptionStatus);
    if (path === '/api/tool-access') return Response.json(toolAccess);
    if (path === '/api/execution-profiles') return Response.json(executionProfiles);
    if (path === '/api/access') return Response.json({ authenticated: variant !== 'locked' });
    if (path === '/api/definitions' && body.action === 'preview') return Response.json({ agents: definition.agents });
    if (path === '/api/features/templates') return Response.json({ projectId: '', configured: false, defaultTemplateId: null, templates: [], reason: 'No committed template registry is configured in this illustrative fixture.' });
    if (path === '/api/features') return Response.json(init.method === 'POST' ? { name: 'release-notes.md', markdown: '# Prepare public release notes\n\nSummarize the release and its verification evidence.', revision: 'storybook-revision', record: null } : features);
    if (path === '/api/processes') return Response.json(processExample(true));
    if (path === '/api/resources') return Response.json(init.method === 'POST' ? { schemaVersion: 1, events: [], nextAfter: 0, hasMore: false, gap: false } : resourceReport);
    if (path === '/api/integrations') return Response.json({ schemaVersion: 1, enabled: true, projectDirectory: '/example/project', planId: 'storybook-plan', canApply: false, files: [{ path: '.agents/skills/werk-worker/SKILL.md', state: 'current', action: 'keep', content: 'Use the project worker CLI to manage tasks.' }] });
    if (path === '/api/interactions') {
      const item = records.find(record => record.id === body.sessionId);
      const view = item?.interaction ?? interaction(body.sessionId ?? selected, 'idle');
      return Response.json(body.action === 'turn' ? { ...view.latestTurn, schemaVersion: 1, sessionId: view.sessionId, input: 'Review the task lifecycle.', context: {}, dispatch: { provider: { id: 'codex-cli', model: 'gpt-fixture' }, model: 'gpt-fixture', messages: [] }, dispatchDigest: 'storybook-dispatch', result: null, usage: fixtureUsage, errorCode: variant === 'failed' ? 'interrupted' : null } : view);
    }
    if (path === '/api/requests') {
      if (body.action === 'execution_recovery') return Response.json({ schemaVersion: 1, runs: [] });
      if (body.action === 'metrics') return Response.json(buildDeliveryMetrics({ requests: [], events: [], runs: [], completeRequestIds: [] }, {}, fixtureTime));
      if (body.action === 'delivery_projects') return Response.json({ schemaVersion: 1, approvalRevision: 0, projects: [] });
      if (body.action === 'delivery_policy') return Response.json({ schemaVersion: 1, baseline: 'a'.repeat(40), configurationDigest: 'example-policy', configuration: { schemaVersion: 1, version: 1, defaultProfile: 'feature', reviewDirectory: 'reviews', profiles: [] }, profile: { id: 'feature', maxRepairAttempts: 2, verificationInputs: [] }, repositoryId: null, approvalRequired: false, approved: true, approvalRevision: 0, machineMaxParallel: 1 });
      if (body.action === 'local_merge') return Response.json({ configured: false, reason: 'No assigned main checkout is available in this illustrative fixture.', candidate: null, target: null, state: { operations: [] }, canMerge: false, canReconcile: false });
      if (body.action === 'release') return Response.json({ configured: false, authorized: false, reason: null, target: null, candidate: null, state: { operations: [] }, canMerge: false, canBuild: false, canPublish: false, canReconcile: false, canConfirmStopped: false });
      if (body.action === 'publication') return Response.json({ configured: false, authorized: false, reason: null, target: null, candidate: null, canPush: false, canCreatePullRequest: false, canReconcile: false, publications: [] });
      if (body.action === 'policy') return Response.json({ schemaVersion: 1, revision: 1, policy, digest: 'storybook-policy' });
      if (body.action === 'get') return Response.json(request);
      if (body.action === 'list') return Response.json({ schemaVersion: 1, rows: [{ ...request, title: request.input.title, kind: 'chat' }], total: 1, nextOffset: null });
    }
    if (path === '/api/runs') {
      if (variant === 'history-error') return Response.json({ error: 'Execution evidence could not be refreshed. The example preserves the last known task state.' }, { status: 503 });
      if (body.action === 'get') return Response.json(run);
      if (body.action === 'analyze') return Response.json({ schemaVersion: 1, scope: 'worker_session_executions', asOf: 1, total: empty ? 0 : 1, completedPairs: running || empty ? 0 : 1, outcomes: { [run.outcome]: 1 }, consumption, duration: { measuredRuns: empty ? 0 : 1, totalMs: run.durationMs, meanMs: run.durationMs }, resources: { scope: 'worker_process_between_snapshots', measuredRuns: 1, cpuUserMicros: 500_000, cpuSystemMicros: 80_000, peakObservedRssBytes: resource.rssBytes }, notes: ['Measurements in this story are illustrative.'] });
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
  Object.assign(state, clone(initialState), { executionProfiles, toolAccess, consumption: consumptionStatus, settings, sessions, board, status, monitoring, environment, history, chat, definitions: [definition], draftEpoch: state.draftEpoch + 1, unlocked: variant !== 'locked', accessChecked: true, paused: false, lastRead: fixtureTime, sessionsReadAt: capturedAt, sessionsStale: variant === 'capacity-stale' });
  return { state, file, run, resourceReport, definition, fetchFixture };
}
