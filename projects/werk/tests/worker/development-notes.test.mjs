import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import { projectLocalTaskDetail } from '../../src/worker/dist/worker/application/local-task-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { developmentCheckFingerprint } from '../../src/worker/dist/worker/application/development.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';
import { projectDevelopmentEvidence, renderDevelopmentEvidence } from '../../src/worker/dist/worker/application/development-notes.js';
import { projectFeatureTracking, renderFeatureTracking } from '../../src/worker/dist/worker/application/feature-tracking.js';
import { doneEvidence, renderSharedReview } from '../../src/worker/dist/worker/application/shared-feature-notes.js';
import { inspectSharedFeature } from '../../src/worker/dist/worker/status/workspace-features.js';
import { workspaceContext } from './runtime-fixtures.mjs';
import { workerStatus } from '../helpers/worker-status.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { trackingSession, trackingTurn, trackingDispatch, trackingRequest, trackingTask, trackingSharedRecord, trackingWorkspace, interactionView } from './tracking-fixtures.mjs';
import { statusServer } from '../../src/worker/dist/worker/status/server.js';
const at = '2026-10-16T12:00:00.000Z', digest = 'b'.repeat(64), fingerprint = developmentCheckFingerprint({ id: 'test', name: 'Unit | checks', executable: '/PRIVATE_EXECUTABLE', args: ['PRIVATE_ARGUMENT'] }), base = 'a'.repeat(40);
/** @returns {import('../../src/worker/application/development.js').DevelopmentScope} */
const scope = () => ({ schemaVersion: 1, mode: 'worktree', baseCommit: base, approvedPaths: ['src/feature.ts'], checks: [{ id: 'test', name: 'Unit | checks', fingerprint, executable: '/PRIVATE_EXECUTABLE', args: ['PRIVATE_ARGUMENT'] }] });
/** @returns {import('../../src/worker/application/development.js').DevelopmentEvidence} */
const evidence = () => ({ schemaVersion: 1, candidateDigest: digest, changedPaths: ['src/feature.ts'], updatedAt: at, checks: [{ presetId: 'test', presetFingerprint: fingerprint, candidateDigest: digest, status: 'passed', exitCode: 0, stdout: 'PRIVATE_COMMAND_OUTPUT', stderr: 'PRIVATE_ERROR_OUTPUT', startedAt: at, finishedAt: at }] });
const session = () => trackingSession('local-one', { taskId: 'one', kind: 'local', title: 'Implement feature', provider: 'openai-api', status: 'review', messages: 2 });
const turn = (extra = {}) => trackingTurn({ input: 'PRIVATE_APPROVED_CONTENT', dispatch: trackingDispatch('patch', true), result: { type: 'completed', text: 'Implemented the feature and ran its required check.' }, ...extra });
const trackingInput = () => ({ session: session(), local: { instruction: 'Implement the approved feature.', summary: 'Implemented the feature.', error: null, hasPatch: true, paths: ['src/feature.ts'], implementation: scope(), developmentEvidence: evidence() }, turns: [turn()] });

test('tracking projects real candidate checks and plain implementation summaries without publishing private contents or command output', () => {
  const input = trackingInput();
  input.turns.unshift(turn({ id: 'legacy-turn', createdAt: '2026-10-16T11:00:00.000Z', dispatch: trackingDispatch('patch'), result: { type: 'completed', text: JSON.stringify({ summary: 'Earlier legacy proposal.', files: [{ path: 'src/feature.ts', content: 'PRIVATE_REPLACEMENT_CONTENT' }] }) } }));
  const projected = projectFeatureTracking(input), markdown = renderFeatureTracking(projected, { owner: 'worker', digest, updatedAt: at });
  assert.equal(projected.development.verified, true);
  assert.ok(input.turns[1].result.type === 'completed'); assert.equal(projected.result, input.turns[1].result.text);
  assert.match(markdown, /Earlier legacy proposal/); assert.match(markdown, /Implemented the feature and ran/);
  assert.match(markdown, /Worktree candidate/); assert.match(markdown, /Required checks passed for this candidate/);
  assert.match(markdown, /Unit \\\| checks/); assert.ok(markdown.includes(digest)); assert.ok(markdown.includes(fingerprint));
  assert.match(markdown, /human review is still required/);
  assert.doesNotMatch(JSON.stringify(projected) + markdown, /PRIVATE_|executable|stdout|stderr|renderedPrompt/);
});

test('missing, failed, interrupted or superseded verification never becomes current candidate success', () => {
  const failed = mutate => { const value = evidence(); mutate(value); const projected = projectDevelopmentEvidence(scope(), value); assert.equal(projected.verified, false); assert.match(renderDevelopmentEvidence(projected), /have not all passed for this candidate/); return projected; };
  assert.equal(projectDevelopmentEvidence(scope()).checks[0].status, 'not_run');
  assert.equal(failed(value => { value.candidateDigest = 'd'.repeat(64); }).checks[0].status, 'stale');
  assert.equal(failed(value => { value.checks[0].presetFingerprint = 'd'.repeat(64); }).checks[0].status, 'stale');
  assert.equal(failed(value => { value.checks[0].status = 'failed'; value.checks[0].exitCode = 1; }).checks[0].status, 'failed');
  assert.equal(failed(value => { value.checks[0].status = 'interrupted'; value.checks[0].exitCode = null; }).checks[0].status, 'interrupted');
  failed(value => { value.changedPaths = []; }); failed(value => { value.checks = []; });
  failed(value => { value.checks.push({ ...value.checks[0], status: 'failed', exitCode: 1 }); });
});

function shared() {
  /** @type {import('../../src/worker/application/request-gates.js').GateEvaluation} */
  const evaluation = { id: 'evaluation-one', at, facts: {}, stage: 'done', inputRevision: 1, inputHash: 'input', policyDigest: 'policy', outputDigest: 'output', passed: true, rules: [{ ruleId: 'completed', fact: 'execution.outcome', expected: 'completed', observed: 'completed', result: 'pass' }] };
  const record = trackingSharedRecord({ featureBranch: 'werk/features/feature-one', featureCommit: 'e'.repeat(40), outputDigest: 'output' });
  /** @type {import('../../src/worker/application/shared-feature-state.js').SharedExecution} */
  const execution = { status: 'review', summary: 'Implemented and checked the feature.', patch: 'PRIVATE_PATCH_CONTENT', currentTurnId: 'turn-one', runId: 'run-one', developmentVerified: true, implementation: scope(), developmentEvidence: evidence(), request: trackingRequest({ phase: 'done', evaluations: [evaluation], execution: { status: 'completed', outcome: 'completed', result: { type: 'completed', text: 'Implemented' }, inputRevision: 1, outputDigest: 'output', turnId: 'turn-one', runId: 'run-one', facts: { 'output.verificationPassed': true, 'output.candidateDigest': digest } } }) };
  return { record, execution, evaluation };
}
test('shared review publication requires verified candidate evidence bound to the original source and completed output', () => {
  const current = shared(); assert.deepEqual(doneEvidence(current.record, current.execution), current.evaluation);
  const markdown = renderSharedReview(current.record, current.execution, current.evaluation);
  assert.match(markdown, /does not merge or approve/); assert.match(markdown, /Implemented and checked/); assert.match(markdown, /Verification results/);
  assert.ok(markdown.includes(digest)); assert.ok(markdown.includes(fingerprint)); assert.doesNotMatch(markdown, /PRIVATE_/);
  for (const mutate of [
    value => { value.developmentVerified = false; },
    value => { value.implementation.baseCommit = 'f'.repeat(40); },
    value => { value.developmentEvidence.candidateDigest = 'f'.repeat(64); },
    value => { value.developmentEvidence.checks[0].presetFingerprint = 'f'.repeat(64); },
    value => { value.developmentEvidence.checks[0].status = 'failed'; value.developmentEvidence.checks[0].exitCode = 1; },
    value => { value.developmentEvidence = undefined; },
    value => { value.request.execution.facts['output.verificationPassed'] = false; },
    value => { value.request.execution.facts['output.candidateDigest'] = 'f'.repeat(64); },
  ]) { const { record, execution } = shared(); mutate(execution); assert.equal(doneEvidence(record, execution), undefined); }
  const legacy = shared(); delete legacy.execution.implementation; delete legacy.execution.developmentEvidence; legacy.execution.request.execution.facts = {};
  assert.deepEqual(doneEvidence(legacy.record, legacy.execution), legacy.evaluation, 'saved proposal tasks retain their existing completion contract');
});

test('authenticated task-detail HTTP response excludes private development commands and completion receipt', async t => {
  const privateTask = trackingTask({ implementation: scope(), developmentEvidence: evidence(), developmentCompletion: { turnId: 'turn-one', runId: 'run-one', candidateDigest: digest, patchSha256: digest, evidenceDigest: 'PRIVATE_COMPLETION_RECEIPT', verified: true } });
  const { workspace, directory } = await trackingWorkspace(t);
  const token = (await readFile(join(directory, 'webview-token'), 'utf8')).trim();
  workspace.board.detail = id => { assert.equal(id, privateTask.id); return projectLocalTaskDetail(privateTask, interactionView(privateTask.sessionId)); };
  const server = await statusServer(workerStatus, '127.0.0.1', 0, undefined, workspace);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch('http://127.0.0.1:' + testListeningAddress(server).port + '/api/taskboard/detail', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: privateTask.id }) });
  assert.equal(response.status, 200); const result = await response.json();
  assert.deepEqual(result.implementation.checks, [{ id: 'test', name: 'Unit | checks', fingerprint }]);
  assert.equal(result.developmentCompletion, undefined); assert.equal(result.developmentEvidence.checks[0].stdout, 'PRIVATE_COMMAND_OUTPUT', 'authorized UI keeps recorded check output; shared Markdown omits it');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EXECUTABLE|PRIVATE_ARGUMENT|PRIVATE_COMPLETION_RECEIPT/);
  assert.equal(privateTask.implementation.checks[0].executable, '/PRIVATE_EXECUTABLE', 'public projection does not mutate frozen runtime authority');
});


test('shared inspection binds publication to the private final patch and current completion receipt', async t => {
  const { record, execution, evaluation } = shared();
  const task = trackingTask({ ...execution, status: 'review', implementation: scope(), requestId: 'request-one', developmentCompletion: {
    turnId: execution.currentTurnId, runId: execution.runId, candidateDigest: digest,
    patchSha256: createHash('sha256').update(execution.patch).digest('hex'), evidenceDigest: gateDigest(execution.developmentEvidence), verified: true,
  } });
  const { workspace } = await trackingWorkspace(t);
  workspace.sessions.requests.get = () => execution.request;
  /** @param {import('../../src/worker/application/local-task-contracts.js').LocalTask} value */
  const inspect = value => {
    workspace.board.executionDetail = () => ({ ...structuredClone(value), interaction: interactionView(value.sessionId) });
    return inspectSharedFeature(workspaceContext(workspace), 'task-one');
  };
  const valid = inspect(task); assert.equal(valid.developmentVerified, true); assert.deepEqual(doneEvidence(record, valid), evaluation);
  assert.equal(Object.hasOwn(valid, 'developmentCompletion'), false); assert.equal(Object.hasOwn(valid.implementation.checks[0], 'executable'), false);
  for (const mutate of [
    value => { value.patch += 'unverified later changes'; },
    value => { value.developmentEvidence.checks[0].stdout += 'altered evidence'; },
    value => { value.currentTurnId = 'different-turn'; },
    value => { value.runId = 'different-run'; },
    value => { delete value.developmentCompletion; },
  ]) { const changed = structuredClone(task); mutate(changed); const projected = inspect(changed); assert.equal(projected.developmentVerified, false); assert.equal(doneEvidence(record, projected), undefined); }
});
