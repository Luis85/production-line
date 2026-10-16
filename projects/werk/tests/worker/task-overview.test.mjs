import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../../src/worker/webview/task-overview.ts', import.meta.url), 'utf8');
const javascript = stripTypeScriptTypes(source);
const { buildTaskOverview } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
const at = '2026-10-15T10:00:00.000Z';
const later = '2026-10-15T10:10:00.000Z';
const interaction = (phase = 'idle', extra = {}) => ({ schemaVersion: 1, sessionId: 's', revision: 1, phase, pending: null, latestTurn: null, turns: [], totalTurns: 0, ...extra });
const session = (id, extra = {}) => ({ id, taskId: id, kind: 'chat', title: 'Task ' + id, provider: 'codex-cli', createdAt: at, archived: false, status: 'completed', messages: 2, busy: false, interaction: interaction(), ...extra });
const sessions = (records, currentSessionId = null) => ({ selected: records[0]?.id ?? '', execution: { currentSessionId, queued: 0, maxParallel: 1 }, records });
const file = (id, extra = {}) => ({ id, sessionId: 'local-' + id, title: 'File ' + id, provider: 'codex-cli', model: 'saved-file-model', createdAt: at, finishedAt: later, status: 'review', archived: false, files: [], interaction: interaction(), summary: null, error: null, ...extra });
const board = (...tasks) => ({ tasks, settings: { paused: false }, running: 0, persistenceError: false });
const feature = (id, extra = {}) => ({ id, taskId: 'feature-' + id, sessionId: 'feature-' + id, name: id + '.md', source: 'folder', status: 'completed', submitted: true, createdAt: at, updatedAt: later, inputHash: 'hash', ...extra });
const features = (records, files = []) => ({ enabled: true, directory: '/project/features', records, files, pollMs: 1000, errors: [], error: null });
const history = (...rows) => ({ rows });
const row = (taskId, extra = {}) => ({ taskId, pairId: 'pair-' + taskId, title: 'Assigned ' + taskId, attempt: 1, provider: 'codex', mode: 'mock', startedAt: at, finishedAt: later, outcome: 'simulated', error: null, ...extra });
const run = (sessionId, extra = {}) => ({ id: 'run-' + sessionId, sessionId, taskId: sessionId, sequence: 1, provider: 'claude-cli', model: 'recorded-model', acceptedAt: at, purpose: 'execution', outcome: 'completed', ...extra });
function freeze(value) {
  if (value && typeof value === 'object') { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
  return value;
}

test('file task and session are one review item with their retained identities and a taskboard action', () => {
  const input = freeze({ sessions: sessions([session('local-patch', { kind: 'local' })]), board: board(file('patch')) });
  const result = buildTaskOverview(input);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.id, 'session:local-patch');
  assert.equal(item.taskId, 'patch'); assert.equal(item.localTaskId, 'patch');
  assert.equal(item.sessionId, 'local-patch'); assert.equal(item.sourceLabel, 'Local request');
  assert.equal(item.group, 'attention'); assert.equal(item.status, 'review');
  assert.match(item.summary, /not been applied/);
  assert.deepEqual(item.primaryAction, { kind: 'session', label: 'Open task', sessionId: 'local-patch', href: '/taskboard?session=local-patch' });
  assert.equal(input.sessions.records[0].status, 'completed');
});

test('checkpoint questions and request rework take precedence over a completed turn or old file patch', () => {
  const pending = { id: 'question-1', message: 'Which database should receive the migration?', kind: 'question', turnId: 'turn-1', createdAt: later };
  const result = buildTaskOverview({
    sessions: sessions([
      session('local-patch', { kind: 'local', status: 'waiting_input', interaction: interaction('waiting_input', { pending }) }),
      session('rework', { requestId: 'request-1', requestPhase: 'needs_rework' }),
      session('review', { requestId: 'request-2', requestPhase: 'review' }),
    ]), board: board(file('patch')),
  });
  assert.deepEqual(result.groups.attention.map(item => item.status), ['waiting_input', 'needs_rework', 'review']);
  assert.equal(result.items[0].summary, pending.message);
  assert.equal(result.items[0].primaryAction.label, 'Answer task');
  assert.equal(result.items[1].requestId, 'request-1');
});

test('the shared executor is the only source of a running card, even across stale snapshots', () => {
  const input = { sessions: sessions([session('a', { status: 'running' }), session('b', { status: 'running' })], 'b') };
  const result = buildTaskOverview(input);
  assert.equal(result.counts.running, 1); assert.equal(result.groups.running[0].sessionId, 'b');
  assert.equal(result.items.find(item => item.sessionId === 'a').status, 'unconfirmed');
  input.sessions.execution.currentSessionId = null;
  assert.equal(buildTaskOverview(input).counts.running, 0);
  assert.equal(buildTaskOverview({ board: board(file('stale', { status: 'running' })) }).counts.running, 0);
});

test('project patch, accepted request and its Markdown file join the same session without duplicate counts', () => {
  const input = { sessions: sessions([session('local-feature-auth', { kind: 'local' })]), board: board(file('feature-auth')),
    features: features([feature('auth', { sessionId: 'local-feature-auth', status: 'review' })], [{ name: 'auth.md', id: 'auth', title: 'Request title', status: 'review' }]), };
  const result = buildTaskOverview(input);
  assert.equal(result.counts.total, 1);
  assert.equal(result.items[0].source, 'project'); assert.equal(result.items[0].featureName, 'auth.md');
  assert.equal(result.items[0].localTaskId, 'feature-auth'); assert.equal(result.items[0].taskId, 'feature-auth');
  const reordered = buildTaskOverview({ ...input, features: features([...input.features.records].reverse(), [...input.features.files].reverse()) });
  assert.equal(result.items[0].id, reordered.items[0].id);
});

test('unadmitted project requests open their file instead of a nonexistent conversation', () => {
  const result = buildTaskOverview({ features: features([feature('waiting', { submitted: false, status: 'waiting' })], [
    { name: 'waiting.md', id: 'waiting', status: 'ready' },
    { name: 'draft.md', title: 'Unadmitted draft', status: 'draft' },
  ]) });
  assert.equal(result.counts.queued, 1); assert.equal(result.counts.draft, 1);
  assert.equal(result.groups.queued[0].primaryAction.kind, 'feature');
  const draft = result.groups.draft[0];
  assert.equal(draft.taskId, ''); assert.equal(draft.sessionId, undefined);
  assert.equal(draft.primaryAction.href, '/history?view=features');
});

test('remote ownership survives project companion metadata and unrelated local ID collisions', () => {
  const result = buildTaskOverview({
    sessions: sessions([session('remote-a', { kind: 'orchestrator', messages: 2, taskState: 'completed' }), session('a', { title: 'Assigned a' })]),
    features: features([feature('remote-a', { source: 'orchestrator', taskId: 'a', sessionId: 'remote-a', name: 'remote-a.md' })]),
    history: history(row('a')),
  });
  assert.equal(result.items.length, 2);
  const remote = result.items.find(item => item.sessionId === 'remote-a');
  assert.equal(remote.remote, true); assert.equal(remote.sourceLabel, 'Assigned');
  assert.equal(remote.taskId, 'a'); assert.equal(remote.featureName, 'remote-a.md');
  assert.equal(remote.primaryAction.kind, 'session');
  assert.equal(result.items.find(item => item.sessionId === 'a').remote, false);
  assert.equal(result.items.find(item => item.sessionId === 'a').source, 'chat');
});

test('latest remote attempt wins and mock simulation is never presented as implemented work', () => {
  const result = buildTaskOverview({ history: history(row('a', { attempt: 1, outcome: 'failed' }), row('a', { attempt: 2 })) });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'simulated');
  assert.equal(result.items[0].statusLabel, 'Simulated · not implemented');
  assert.match(result.items[0].summary, /No implementation/);
  assert.equal(result.items[0].model, null);
  assert.equal(result.items[0].primaryAction.kind, 'history');
});

test('a completed local follow-up is not overwritten by an older remote simulation', () => {
  const result = buildTaskOverview({ sessions: sessions([session('remote-a', { kind: 'orchestrator', messages: 4, interaction: interaction('completed', { latestTurn: { id: 'followup-turn', runId: 'followup-run', kind: 'message', status: 'completed', createdAt: later, finishedAt: later, priorTurnId: null } }) })]), history: history(row('a')) });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].status, 'completed');
  assert.equal(result.items[0].source, 'assigned');
});

test('unknown model stays unknown and recorded provider defaults never borrow current configuration', () => {
  const unknown = buildTaskOverview({ sessions: sessions([session('a')]) }).items[0];
  assert.equal(unknown.model, null); assert.equal(unknown.modelSnapshot, null); assert.equal(unknown.modelBasis, 'unavailable');
  const configured = buildTaskOverview({ board: board(file('a')) }).items[0];
  assert.equal(configured.model, 'saved-file-model'); assert.equal(configured.modelBasis, 'configured');
  const recorded = buildTaskOverview({ board: board(file('a')), runs: [run('local-a', { model: '', sequence: 2 }), run('local-a', { model: 'old-model', sequence: 1 })] }).items[0];
  assert.equal(recorded.provider, 'claude-cli'); assert.equal(recorded.model, null); assert.equal(recorded.modelBasis, 'recorded');
  assert.equal(recorded.modelSnapshot.model, ''); assert.equal(recorded.modelSnapshot.runId, 'run-local-a');
});

test('search, source and archive filters produce matching rows and counts without changing execution identity', () => {
  const input = { sessions: sessions([
    session('running', { status: 'running' }), session('question', { status: 'waiting_input' }),
    session('archived', { status: 'failed', archived: true }), session('queued', { status: 'queued', title: 'Finish MIGRATION' }),
  ], 'running'), board: board(file('review')) };
  const all = buildTaskOverview(input);
  assert.equal(all.counts.total, 4); assert.equal(all.counts.attention, 2);
  const search = buildTaskOverview(input, { search: ' migration ', source: 'chat' });
  assert.equal(search.counts.total, 1); assert.equal(search.counts.queued, 1); assert.equal(search.counts.running, 0);
  assert.equal(search.currentSessionId, 'running');
  const archived = buildTaskOverview(input, { includeArchived: true, search: 'archived' });
  assert.equal(archived.counts.total, 1); assert.equal(archived.items[0].archived, true);
  assert.equal(buildTaskOverview(input, { source: 'file' }).counts.total, 1);
});

test('pending decision, failure and interruption remain attention; stopped work is not labelled complete', () => {
  const result = buildTaskOverview({ sessions: sessions(['escalated', 'failed', 'interrupted', 'cancelled'].map(status => session(status, { status }))) });
  assert.equal(result.counts.attention, 3); assert.equal(result.counts.completed, 1);
  assert.equal(result.groups.completed[0].statusLabel, 'Stopped');
  assert.equal(buildTaskOverview({ features: { enabled: false } }).counts.total, 0);
});


test('a previous model snapshot is not presented as the model of a new active turn', () => {
  const input = { sessions: sessions([session('a', { status: 'running' })], 'a'), runs: [run('a', { model: 'previous-model' })] };
  let item = buildTaskOverview(input).items[0];
  assert.equal(item.model, null); assert.equal(item.modelSnapshot, null);
  input.runs.push(run('a', { id: 'current-run', sequence: 2, outcome: 'running', model: 'current-model' }));
  item = buildTaskOverview(input).items[0];
  assert.equal(item.model, 'current-model'); assert.equal(item.modelSnapshot.runId, 'current-run');
});


test('an original simulated assignment with its real two-message transcript remains explicitly simulated', () => {
  const result = buildTaskOverview({
    sessions: sessions([session('remote-a', { kind: 'orchestrator', messages: 2, taskState: 'completed', interaction: interaction() })]),
    history: history(row('a')),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, 'simulated');
  assert.equal(result.items[0].statusLabel, 'Simulated · not implemented');
  assert.match(result.items[0].summary, /No implementation/);
  assert.equal(result.items[0].primaryAction.kind, 'session');
});

test('an original assignment waiting for another attempt keeps its active taskState above old completion evidence', () => {
  const remote = session('remote-a', { kind: 'orchestrator', messages: 2, taskState: 'queued', status: 'completed' });
  const input = { sessions: sessions([remote]), history: history(row('a')) };
  assert.equal(buildTaskOverview(input).items[0].status, 'queued');
  remote.taskState = 'running';
  assert.equal(buildTaskOverview(input).items[0].status, 'unconfirmed');
  input.sessions.execution.currentSessionId = 'remote-a';
  assert.equal(buildTaskOverview(input).items[0].status, 'running');
});


test('a passed request gate keeps an unapplied file patch in attention for review', () => {
  const result = buildTaskOverview({
    sessions: sessions([session('local-patch', { kind: 'local', status: 'completed', requestPhase: 'done', requestId: 'patch-request' })]),
    board: board(file('patch', { status: 'review', requestPhase: 'done', requestId: 'patch-request' })),
  });
  assert.equal(result.counts.total, 1);
  assert.equal(result.counts.attention, 1);
  assert.equal(result.counts.completed, 0);
  assert.equal(result.items[0].status, 'review');
  assert.equal(result.items[0].statusLabel, 'Review required');
  assert.equal(result.items[0].localTaskId, 'patch');
  assert.match(result.items[0].summary, /not been applied/);
});
