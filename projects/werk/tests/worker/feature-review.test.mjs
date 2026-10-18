import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { createWorkerSessions } from '../../src/worker/dist/worker/infrastructure/workspace-services.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { buildFeatureReviewView, currentRequestEvaluation } = await frontend('src/worker/webview/feature-review.ts');
const at = '2026-10-18T12:00:00Z';
/** @returns {import('../../src/worker/application/request-gates').WorkerRequest} */
function request() {
  return { schemaVersion: 1, id: 'request-1', owner: { sessionId: 'session-1', rootTurnId: 'turn-1', taskId: 'task-1' }, revision: 3, inputRevision: 1,
    input: { kind: 'patch', title: 'Implement search', message: 'Search the queue.', criteria: ['Results match the query.'], files: [{ path: 'src/search.ts', bytes: 12 }] }, inputHash: 'input-1', policyDigest: 'policy-1',
    policy: { schemaVersion: 1, id: 'checks', version: 1, ready: { chat: [], patch: [] }, done: { chat: [], patch: [] }, reviewer: { enabled: false, provider: 'same', maxAttempts: 1 }, rework: { maxAttempts: 2 } },
    provider: { id: 'codex-cli', model: 'saved-model', instruction: '' }, phase: 'done', assignee: 'operator', createdAt: at, updatedAt: at, reworkCount: 0,
    evaluations: [], findings: [], candidates: [], reviews: [], attestation: null,
    execution: { turnId: 'turn-1', runId: 'run-1', inputRevision: 1, status: 'completed', outcome: 'completed', result: { type: 'completed', text: 'Search implemented.' }, outputDigest: 'output-1', facts: {} } };
}
/** @param {import('../../src/worker/application/request-gates').GateStage} stage
 * @returns {import('../../src/worker/application/request-gates').GateEvaluation} */
function evaluation(stage = 'done') {
  return { id: 'evaluation-' + stage, stage, inputRevision: 1, inputHash: 'input-1', policyDigest: 'policy-1', outputDigest: stage === 'done' ? 'output-1' : null, at, passed: true, facts: {}, rules: [] };
}
/** @returns {import('../../src/worker/application/workspace-view').LocalTaskDetailView} */
function task() {
  return { id: 'task-1', title: 'Implement search', sessionId: 'session-1', provider: 'codex-cli', model: 'saved-model', repository: '/project', status: 'review', priority: 1, createdAt: at, finishedAt: at, error: null, summary: 'Search implemented.', archived: false, requestId: 'request-1', instruction: 'Search the queue.',
    files: [{ path: 'src/search.ts', content: 'before', existed: true }], patch: 'diff --git a/src/search.ts b/src/search.ts\n', interaction: interaction(),
    implementation: { schemaVersion: 1, mode: 'worktree', baseCommit: 'a'.repeat(40), approvedPaths: ['src/search.ts'], checks: [{ id: 'test', name: 'Tests', fingerprint: 'f'.repeat(64) }] },
    developmentEvidence: { schemaVersion: 1, candidateDigest: 'c'.repeat(64), changedPaths: ['src/search.ts'], updatedAt: at,
      checks: [{ presetId: 'test', presetFingerprint: 'f'.repeat(64), candidateDigest: 'c'.repeat(64), status: 'passed', exitCode: 0, stdout: 'Passed', stderr: '', startedAt: at, finishedAt: at }] } };
}
/** @returns {import('../../src/worker/application/interactions').InteractionView} */
function interaction() {
  return { schemaVersion: 1, sessionId: 'session-1', revision: 3, phase: 'completed', pending: null, turns: [], totalTurns: 1,
    latestTurn: { id: 'turn-1', runId: 'run-1', kind: 'message', status: 'completed', createdAt: at, finishedAt: at, priorTurnId: null } };
}
/** @returns {import('../../src/worker/application/shared-intake-contract').SharedFeatureView} */
function shared() {
  return { feature: { key: 'fr-shared', id: 'search', source: 'shared_git', scope: 'project', sourcePath: 'features/search.md' },
    id: 'search', name: 'search.md', title: 'Implement search', status: 'ready_for_review', owner: 'this-worker', isLocal: true, sourceCommit: 'a'.repeat(40), updatedAt: at,
    ready: { passed: true, issues: [] }, done: { passed: true, issues: [] }, featureBranch: 'werk/search', reviewNote: 'reviews/search.md', publication: 'synced', error: null, taskId: 'task-1' };
}
function complete() { const value = request(); value.evaluations = [evaluation('ready'), evaluation('done')]; return value; }
const stage = (view, id) => view.stages.find(item => item.id === id);

test('gate matching excludes different input, policy and output generations, including unknown output', () => {
  const value = complete(), saved = currentRequestEvaluation(value, 'done');
  for (const patch of [{ inputRevision: 2 }, { inputHash: 'other' }, { policyDigest: 'other' }, { outputDigest: 'other' }]) {
    value.evaluations.push({ ...evaluation(), ...patch });
    assert.equal(currentRequestEvaluation(value, 'done'), saved);
  }
  value.inputRevision = 2; assert.equal(currentRequestEvaluation(value, 'ready'), undefined);
  value.execution.outputDigest = null;
  value.evaluations.push({ ...evaluation(), inputRevision: 2, outputDigest: null });
  assert.equal(currentRequestEvaluation(value, 'done'), undefined);
  assert.equal(currentRequestEvaluation(null, 'ready'), undefined);
});

test('passed completion checks and a retained patch still require human review', () => {
  const input = { task: task(), request: complete() }, before = JSON.stringify(input);
  const view = buildFeatureReviewView(input);
  assert.equal(view.nextStep.action.kind, 'review_patch');
  assert.equal(view.evidence.done.passed, true); assert.equal(view.evidence.candidate.verified, true);
  assert.match(stage(view, 'handoff').detail, /merge are not tracked/);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(buildFeatureReviewView(structuredClone(input)), view, 'unchanged polling is stable');
});

test('proposal-only requests do not inherit implementation or check success', () => {
  const value = task(); delete value.implementation;
  const view = buildFeatureReviewView({ task: value, request: complete() });
  assert.equal(view.evidence.candidate.verified, false); assert.equal(view.evidence.checks, null);
  assert.match(stage(view, 'handoff').detail, /not been automatically applied or verified/);
});

test('stale candidate checks block review acceptance even when a completion evaluation passed', () => {
  const value = task(); value.developmentEvidence.candidateDigest = 'd'.repeat(64);
  const view = buildFeatureReviewView({ task: value, request: complete() });
  assert.equal(view.evidence.checks.passed, 0); assert.equal(stage(view, 'verification').state, 'blocked');
  assert.equal(view.nextStep.action.kind, 'inspect_checks');
});

test('only an operator-acceptance gate can offer attestation, and verification blockers outrank it', () => {
  const value = complete(); value.phase = 'review';
  value.policy.done.patch.push({ id: 'accept', fact: 'operator.accepted', op: 'eq', value: true });
  const done = value.evaluations[1]; done.passed = false;
  done.rules = [{ ruleId: 'accept', fact: 'operator.accepted', expected: true, observed: false, result: 'fail' }];
  value.findings = [{ id: 'accept-finding', kind: 'gap', message: 'Acceptance required', blocking: true, source: 'deterministic', evaluationId: done.id, ruleId: 'accept', status: 'open' }];
  assert.equal(buildFeatureReviewView({ request: value, task: task() }).nextStep.action.kind, 'attest');
  value.findings.push({ id: 'issue', kind: 'issue', message: 'Broken search', blocking: true, source: 'operator', evaluationId: done.id, status: 'open' });
  assert.equal(buildFeatureReviewView({ request: value, task: task() }).nextStep.action.kind, 'review_request');
  value.findings.pop(); done.rules.push({ ruleId: 'test', fact: 'tests.passed', expected: true, observed: null, result: 'unknown' });
  assert.equal(buildFeatureReviewView({ request: value, task: task() }).nextStep.action.kind, 'review_request');
  value.policy.done.patch = [];
  assert.notEqual(buildFeatureReviewView({ request: value }).nextStep.action.kind, 'attest');
});

test('attestation matches current input and output rather than the existence of an old decision', () => {
  const value = complete(); value.policy.done.patch.push({ id: 'accept', fact: 'operator.accepted', op: 'eq', value: true });
  value.attestation = { actor: 'operator', inputHash: value.inputHash, outputDigest: 'old-output', note: 'Reviewed', at };
  assert.equal(buildFeatureReviewView({ request: value }).evidence.attested, false);
  value.attestation.outputDigest = value.execution.outputDigest;
  assert.equal(buildFeatureReviewView({ request: value }).evidence.attested, true);
  value.inputHash = 'new-input'; assert.equal(buildFeatureReviewView({ request: value }).evidence.attested, false);
});

test('shared publication is distinct from implemented checks and requires branch plus review note', () => {
  const record = shared(), input = { task: task(), request: complete(), shared: record };
  record.publication = 'pending';
  let view = buildFeatureReviewView(input);
  assert.equal(stage(view, 'verification').state, 'complete'); assert.equal(stage(view, 'handoff').state, 'active'); assert.equal(view.nextStep.actor, 'worker');
  record.publication = 'error'; record.error = 'Push rejected';
  view = buildFeatureReviewView(input); assert.equal(view.nextStep.action.kind, 'review_shared'); assert.equal(stage(view, 'handoff').state, 'blocked');
  record.publication = 'synced'; record.error = null;
  view = buildFeatureReviewView(input); assert.equal(view.nextStep.action.kind, 'review_shared'); assert.match(view.nextStep.description, /person reviews and merges/);
  record.reviewNote = null; assert.equal(stage(buildFeatureReviewView(input), 'handoff').state, 'pending');
});

test('another owner and unclaimed shared requests never acquire local mutation authority', () => {
  const record = shared(); record.isLocal = false;
  let view = buildFeatureReviewView({ shared: record });
  assert.equal(view.ownership.kind, 'shared_other'); assert.equal(view.ownership.readOnly, true); assert.equal(view.nextStep.actor, 'owning_worker');
  record.owner = null; record.status = 'ready'; record.taskId = null; record.featureBranch = null; record.reviewNote = null;
  view = buildFeatureReviewView({ shared: record });
  assert.equal(view.ownership.kind, 'shared_unclaimed'); assert.equal(stage(view, 'handoff').state, 'pending');
  assert.equal(view.nextStep.actor, 'worker'); assert.equal(view.identity.featureKey, record.feature.key);
});

test('pending questions outrank old results; already-published answers do not offer another answer', () => {
  const current = interaction(); current.phase = 'waiting_input'; current.pending = { id: 'question', kind: 'question', message: 'Which index?', createdAt: at, turnId: 'turn-1' };
  const record = shared(); record.status = 'waiting_input';
  let view = buildFeatureReviewView({ request: complete(), interaction: current, shared: record });
  assert.equal(view.nextStep.action.kind, 'answer'); assert.equal(stage(view, 'execution').state, 'blocked');
  record.taskResponse = { sessionId: 'session-1', expectedRevision: 3, pendingId: 'question', turnId: 'turn-1', status: 'ready', error: null };
  view = buildFeatureReviewView({ interaction: current, shared: record });
  assert.equal(view.nextStep.actor, 'worker'); assert.equal(view.nextStep.action, undefined);
  record.taskResponse.status = 'publication_pending'; assert.match(buildFeatureReviewView({ interaction: current, shared: record }).nextStep.description, /Do not submit another answer/);
});

test('shared stop requires a successor while failed retained checkpoints support explicit continuation', () => {
  const current = interaction(), record = shared(); current.phase = 'failed';
  assert.equal(buildFeatureReviewView({ interaction: current, shared: record }).nextStep.action.kind, 'resume');
  current.phase = 'cancelled';
  assert.equal(buildFeatureReviewView({ interaction: current, shared: record }).nextStep.action.kind, 'open_source');
  assert.match(buildFeatureReviewView({ interaction: current, shared: record }).nextStep.title, /successor/);
});

test('stale, unavailable and cross-request reads provide refresh only and do not join unrelated evidence', () => {
  const stale = buildFeatureReviewView({ task: task(), request: complete(), freshness: { stale: true } });
  assert.equal(stale.ownership.readOnly, true); assert.equal(stale.ownership.scopeMutable, false); assert.equal(stale.nextStep.action.kind, 'refresh');
  const value = complete(); value.owner.sessionId = 'another-session';
  const crossed = buildFeatureReviewView({ task: task(), request: value });
  assert.equal(crossed.nextStep.action.kind, 'refresh'); assert.equal(crossed.identity.sessionId, null); assert.equal(crossed.evidence.candidate, null); assert.equal(crossed.evidence.done, null);
  const empty = buildFeatureReviewView({}); assert.equal(empty.nextStep.action.kind, 'refresh'); assert.equal(empty.evidence.approvedFileCount, null);
});

test('orchestrator ownership suppresses local scope mutation and never claims implementation', () => {
  const value = complete(); value.owner.remote = { origin: 'http://line', taskId: 'remote-task', attempt: 1, lease: 'lease' };
  const view = buildFeatureReviewView({ request: value });
  assert.equal(view.ownership.kind, 'orchestrator'); assert.equal(view.ownership.scopeMutable, false);
  assert.equal(view.nextStep.actor, 'orchestrator'); assert.match(view.nextStep.description, /simulation does not establish implementation/);
});


test('a saved answer for an earlier checkpoint does not hide a new question', () => {
  const current = interaction(); current.phase = 'waiting_input'; current.pending = { id: 'question-new', kind: 'question', message: 'Which field?', createdAt: at, turnId: 'turn-2' };
  const record = shared(); record.status = 'waiting_input'; record.taskResponse = { sessionId: 'session-1', expectedRevision: 2, pendingId: 'question-old', turnId: 'turn-1', status: 'ready', error: null };
  assert.equal(buildFeatureReviewView({ interaction: current, shared: record }).nextStep.action.kind, 'answer');
  record.taskResponse.expectedRevision = current.revision;
  assert.equal(buildFeatureReviewView({ interaction: current, shared: record }).nextStep.action.kind, 'answer');
});

test('a policy requiring acceptance to remain false does not offer an acceptance mutation', () => {
  const value = complete(); value.policy.done.patch.push({ id: 'no-acceptance', fact: 'operator.accepted', op: 'eq', value: false });
  const view = buildFeatureReviewView({ request: value });
  assert.equal(view.evidence.attestationRequired, false); assert.notEqual(view.nextStep.action.kind, 'attest');
});

test('an unclaimed invalid shared request asks the operator to repair readiness', () => {
  const record = shared(); record.owner = null; record.isLocal = false; record.status = 'ready'; record.taskId = null;
  record.ready = { passed: false, issues: ['Add acceptance criteria.'] };
  const view = buildFeatureReviewView({ shared: record });
  assert.equal(view.nextStep.actor, 'operator'); assert.match(view.nextStep.description, /acceptance criteria/); assert.equal(view.ownership.readOnly, true);
});


test('a shared record owned elsewhere cannot borrow colliding local execution identifiers', () => {
  const record = shared(); record.isLocal = false; record.owner = 'another-worker';
  const view = buildFeatureReviewView({ shared: record, task: task(), request: complete() });
  assert.equal(view.nextStep.action.kind, 'refresh'); assert.equal(view.identity.featureKey, null);
  assert.equal(view.evidence.candidate, null); assert.equal(view.evidence.ready, null);
});


test('real local session catalog aliases join their exact board task without accepting unrelated IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-review-identity-'));
  const settings = new WorkerSettings(directory); await settings.init();
  const sessions = createWorkerSessions(directory, settings); await sessions.init();
  t.after(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }); });
  await sessions.ensureTask('local-task-1', 'local', 'Implement search', 'codex-cli');
  const session = sessions.view().records.find(row => row.id === 'local-task-1'); assert.ok(session);
  assert.equal(session.taskId, session.id, 'the persisted local catalog uses the session ID as its task alias');
  const local = task(), value = complete(); local.sessionId = session.id; local.interaction.sessionId = session.id; value.owner.sessionId = session.id;
  const view = buildFeatureReviewView({ session, task: local, request: value });
  assert.equal(view.identity.taskId, local.id); assert.equal(view.stale, false); assert.equal(view.evidence.candidate.verified, true); assert.equal(view.nextStep.action.kind, 'review_patch');
  const unrelated = buildFeatureReviewView({ session: { ...session, taskId: 'another-task' }, task: local, request: value });
  assert.equal(unrelated.nextStep.action.kind, 'refresh'); assert.equal(unrelated.evidence.candidate, null);
  const wrongSession = buildFeatureReviewView({ session, task: { ...local, sessionId: 'different-session' }, request: value });
  assert.equal(wrongSession.nextStep.action.kind, 'refresh'); assert.equal(wrongSession.evidence.candidate, null);
});
