import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectLocalTaskSummary, projectLocalTaskDetail } from '../../src/worker/dist/worker/application/local-task-view.js';
import { LocalTaskboard } from '../../src/worker/dist/worker/application/local-tasks.js';
import { defaultGatePolicy } from '../../src/worker/dist/worker/application/request-gates.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const at = '2026-10-16T10:00:00.000Z';
const publicFields = [
  'id', 'title', 'sessionId', 'provider', 'model', 'repository', 'repositoryId',
  'worktree', 'worktreeKey', 'worktreeIdentity', 'baseCommit', 'status', 'priority',
  'createdAt', 'finishedAt', 'error', 'summary', 'archived', 'requestId',
  'changedFileCount', 'runId', 'currentTurnId', 'submissionHash', 'submissionContextHash',
  'gatePolicy', 'criteria', 'definition', 'admissionFailure', 'developmentEvidence',
];
function fixture() {
  const task = {
    id: 'view-fixture', title: 'Review the actual candidate', sessionId: 'local-view-fixture',
    provider: 'openai-api', model: 'fixture-model', repository: '/project', repositoryId: 'project',
    worktree: '/project-worktree', worktreeKey: 'fixture-worktree',
    worktreeIdentity: { dev: '42', ino: '77', birthtimeMs: 100, futureIdentitySecret: 'PRIVATE-IDENTITY-SENTINEL' }, baseCommit: 'a'.repeat(40),
    status: 'needs_rework', priority: 3, createdAt: at, finishedAt: at,
    error: 'The required check failed.', summary: 'The candidate remains available for repair.', archived: false,
    requestId: 'request-fixture', changedFileCount: 2, runId: 'run-fixture', currentTurnId: 'turn-fixture',
    submissionHash: 'b'.repeat(64), submissionContextHash: 'c'.repeat(64),
    gatePolicy: defaultGatePolicy(), criteria: ['The approved change passes its required check.'],
    definition: { definitionId: 'definition-fixture', ref: 'developer', name: 'Developer', digest: 'd'.repeat(64), agent: 'root', instruction: 'Review the approved files.', model: 'fixture-model', provider: 'openai', unsupported: ['agent.tools'], adapted: true },
    admissionFailure: { paths: ['src/existing.ts', 'src/new.ts'], futureFailureSecret: 'PRIVATE-FAILURE-SENTINEL' },
    instruction: 'The approved source and instruction belong only in the explicit detail view.',
    files: [
      { path: 'src/existing.ts', content: 'export const title = "Überprüfung";\n', existed: true, futureFileSecret: 'PRIVATE-FILE-SENTINEL' },
      { path: 'src/new.ts', content: '', existed: false, futureFileSecret: 'PRIVATE-NEW-FILE-SENTINEL' },
    ],
    patch: 'diff --git a/src/existing.ts b/src/existing.ts\n-old\n+new\n',
    implementation: { schemaVersion: 1, mode: 'worktree', baseCommit: 'a'.repeat(40), approvedPaths: ['src/existing.ts', 'src/new.ts'], futureScopeSecret: 'PRIVATE-SCOPE-SENTINEL', checks: [{ id: 'check', name: 'Required check', executable: '/PRIVATE-CHECKER', args: ['PRIVATE-CHECKER-ARG'], fingerprint: 'e'.repeat(64), futureCheckSecret: 'PRIVATE-CHECK-SENTINEL' }] },
    developmentEvidence: { schemaVersion: 1, candidateDigest: 'f'.repeat(64), changedPaths: ['src/existing.ts', 'src/new.ts'], futureEvidenceSecret: 'PRIVATE-EVIDENCE-SENTINEL', checks: [{ presetId: 'check', presetFingerprint: 'e'.repeat(64), candidateDigest: 'f'.repeat(64), status: 'failed', exitCode: 1, stdout: 'The assertion ran against the candidate.\n', stderr: 'Expected the approved value.\n', startedAt: at, finishedAt: at, truncated: false, futureReceiptSecret: 'PRIVATE-RECEIPT-SENTINEL' }], updatedAt: at },
    developmentCompletion: { turnId: 'turn-fixture', runId: 'run-fixture', candidateDigest: 'f'.repeat(64), patchSha256: '1'.repeat(64), evidenceDigest: '2'.repeat(64), verified: false },
    futurePrivateContext: { credential: 'PRIVATE-TOP-LEVEL-SENTINEL' },
  };
  const turn = { id: 'turn-fixture', runId: 'run-fixture', kind: 'message', status: 'completed', createdAt: at, finishedAt: at, priorTurnId: null };
  const interaction = { schemaVersion: 1, sessionId: task.sessionId, revision: 5, phase: 'completed', pending: null, latestTurn: turn, turns: [turn], totalTurns: 1 };
  return { task, interaction, request: { phase: 'needs_rework', revision: 7 } };
}
function expectedCommon(task, interaction) {
  return structuredClone({
    ...Object.fromEntries(publicFields.filter(key => task[key] !== undefined && !['worktreeIdentity', 'admissionFailure', 'developmentEvidence'].includes(key)).map(key => [key, task[key]])),
    ...(task.worktreeIdentity ? { worktreeIdentity: { dev: task.worktreeIdentity.dev, ino: task.worktreeIdentity.ino, birthtimeMs: task.worktreeIdentity.birthtimeMs } } : {}),
    ...(task.admissionFailure ? { admissionFailure: { paths: [...task.admissionFailure.paths] } } : {}),
    ...(task.developmentEvidence ? { developmentEvidence: {
      schemaVersion: 1, candidateDigest: task.developmentEvidence.candidateDigest,
      changedPaths: [...task.developmentEvidence.changedPaths], updatedAt: task.developmentEvidence.updatedAt,
      checks: task.developmentEvidence.checks.map(({ presetId, presetFingerprint, candidateDigest, status, exitCode, stdout, stderr, startedAt, finishedAt, truncated }) => ({ presetId, presetFingerprint, candidateDigest, status, exitCode, stdout, stderr, startedAt, finishedAt, ...(truncated === undefined ? {} : { truncated }) })),
    } } : {}),
    ...(task.implementation ? { implementation: {
      schemaVersion: 1, mode: 'worktree', baseCommit: task.implementation.baseCommit,
      approvedPaths: [...task.implementation.approvedPaths],
      checks: task.implementation.checks.map(({ id, name, fingerprint }) => ({ id, name, fingerprint })),
    } } : {}),
    interaction,
  });
}
function assertPrivateAuthorityAbsent(view) {
  assert.equal(Object.hasOwn(view, 'developmentCompletion'), false);
  assert.equal(Object.hasOwn(view, 'futurePrivateContext'), false);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE-(?:TOP-LEVEL|FILE|NEW-FILE|CHECKER|SCOPE|CHECK|EVIDENCE|RECEIPT|IDENTITY|FAILURE)/);
  for (const check of view.implementation?.checks ?? []) {
    assert.deepEqual(Object.keys(check).sort(), ['fingerprint', 'id', 'name']);
  }
}

test('summary preserves its explicit public contract while exposing only approved file hashes', () => {
  const { task, interaction, request } = fixture();
  const summary = projectLocalTaskSummary(task, interaction, request);
  assert.deepEqual(summary, {
    ...expectedCommon(task, interaction),
    files: task.files.map(file => ({ path: file.path, sha256: sha256(file.content) })),
    hasPatch: true, requestPhase: 'needs_rework', requestRevision: 7,
  });
  assert.equal(Object.hasOwn(summary, 'instruction'), false);
  assert.equal(Object.hasOwn(summary, 'patch'), false);
  assertPrivateAuthorityAbsent(summary);
});

test('detail retains approved contents, patch and raw verification output without private execution authority', () => {
  const { task, interaction } = fixture();
  const detail = projectLocalTaskDetail(task, interaction);
  assert.deepEqual(detail, {
    ...expectedCommon(task, interaction), instruction: task.instruction, patch: task.patch,
    files: task.files.map(({ path, content, existed }) => ({ path, content, existed })),
  });
  assert.equal(detail.developmentEvidence.checks[0].stdout, task.developmentEvidence.checks[0].stdout);
  assert.equal(detail.developmentEvidence.checks[0].stderr, task.developmentEvidence.checks[0].stderr);
  assertPrivateAuthorityAbsent(detail);
});

for (const [name, project] of [['summary', projectLocalTaskSummary], ['detail', projectLocalTaskDetail]]) {
  test(`${name} is detached from task and interaction state in both directions`, () => {
    const { task, interaction, request } = fixture();
    const originalTask = structuredClone(task), originalInteraction = structuredClone(interaction);
    const view = project(task, interaction, request), sibling = project(task, interaction, request);
    view.files[0].path = 'modified-by-consumer';
    view.criteria.push('Injected criterion');
    view.definition.unsupported.push('Injected definition change');
    view.gatePolicy.done.patch.length = 0;
    view.admissionFailure.paths.push('unapproved.ts');
    view.worktreeIdentity.ino = 'changed';
    view.implementation.approvedPaths.push('unapproved.ts');
    view.implementation.checks[0].name = 'Changed check';
    view.developmentEvidence.changedPaths.length = 0;
    view.developmentEvidence.checks[0].stdout = 'Changed receipt';
    view.interaction.turns[0].status = 'failed';
    assert.deepEqual(task, originalTask);
    assert.deepEqual(interaction, originalInteraction);
    assert.deepEqual(sibling, project(task, interaction, request));
    const unchangedSibling = structuredClone(sibling);
    task.files[0].content = 'Changed source after projection';
    task.implementation.checks[0].name = 'Changed source check';
    task.developmentEvidence.checks[0].stderr = 'Changed source receipt';
    interaction.latestTurn.status = 'interrupted';
    assert.deepEqual(sibling, unchangedSibling);
  });
}

test('legacy and unfinished tasks preserve nulls and omit absent optional authority and request state', () => {
  const { task, interaction } = fixture();
  for (const key of ['requestId', 'changedFileCount', 'runId', 'currentTurnId', 'submissionHash', 'submissionContextHash', 'gatePolicy', 'criteria', 'definition', 'admissionFailure', 'repositoryId', 'worktree', 'worktreeKey', 'worktreeIdentity', 'baseCommit', 'implementation', 'developmentEvidence', 'developmentCompletion']) delete task[key];
  Object.assign(task, { patch: null, summary: null, error: null, finishedAt: null, status: 'queued' });
  const summary = projectLocalTaskSummary(task, interaction);
  const detail = projectLocalTaskDetail(task, interaction);
  assert.deepEqual(summary, { ...expectedCommon(task, interaction), files: task.files.map(file => ({ path: file.path, sha256: sha256(file.content) })), hasPatch: false });
  assert.deepEqual(detail, { ...expectedCommon(task, interaction), instruction: task.instruction, patch: null, files: task.files.map(({ path, content, existed }) => ({ path, content, existed })) });
  for (const view of [summary, detail]) {
    for (const key of ['implementation', 'developmentEvidence', 'requestPhase', 'requestRevision', 'runId']) assert.equal(Object.hasOwn(view, key), false);
    assert.equal(view.summary, null); assert.equal(view.error, null); assert.equal(view.finishedAt, null);
    assertPrivateAuthorityAbsent(view);
  }
});

test('real taskboard list and detail boundaries redact private authority while trusted execution retains it', () => {
  const { task, interaction, request } = fixture();
  const settings = { value: { board: { paused: true, maxParallel: 1, queueCapacity: 4, orchestratorQueue: 1, order: 'fifo' } } };
  const sessions = {
    interactions: { view: sessionId => { assert.equal(sessionId, task.sessionId); return interaction; } },
    requests: { get: id => { assert.equal(id, task.requestId); return request; } },
  };
  const board = new LocalTaskboard(settings, sessions, {
    model: () => { throw Error('A view must not invoke a provider.'); },
    storage: {}, files: {},
  });
  // Seed the persisted aggregate directly: the boundary under test is projection, not admission.
  board.tasks = [task];
  const summary = board.view().tasks[0], detail = board.detail(task.id), execution = board.executionDetail(task.id);
  assert.deepEqual(summary, projectLocalTaskSummary(task, interaction, request));
  assert.deepEqual(detail, projectLocalTaskDetail(task, interaction));
  assertPrivateAuthorityAbsent(summary); assertPrivateAuthorityAbsent(detail);
  assert.deepEqual(execution.developmentCompletion, task.developmentCompletion);
  assert.equal(execution.implementation.checks[0].executable, '/PRIVATE-CHECKER');
  assert.deepEqual(execution.implementation.checks[0].args, ['PRIVATE-CHECKER-ARG']);
  assert.equal(execution.futurePrivateContext.credential, 'PRIVATE-TOP-LEVEL-SENTINEL');
  execution.implementation.checks[0].args.push('changed');
  detail.files[0].content = 'changed'; summary.developmentEvidence.checks.length = 0;
  assert.deepEqual(board.executionDetail(task.id).implementation.checks[0].args, ['PRIVATE-CHECKER-ARG']);
  assert.equal(board.detail(task.id).files[0].content, task.files[0].content);
  assert.equal(board.view().tasks[0].developmentEvidence.checks.length, 1);
  assert.throws(() => board.detail('missing'), /Task not found/);
  assert.throws(() => board.executionDetail('missing'), /Task not found/);
});
