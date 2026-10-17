import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
import { developmentCheckFingerprint, developmentVerified } from '../../src/worker/dist/worker/application/development.js';
import { classifyDevelopmentEvidence } from '../../src/worker/dist/worker/application/development-verification.js';
import { projectDevelopmentEvidence, renderDevelopmentEvidence } from '../../src/worker/dist/worker/application/development-notes.js';
const { candidateEvidenceView } = await frontend('src/worker/webview/candidate-evidence.ts');
const digest = 'b'.repeat(64), at = '2026-10-16T12:00:00.000Z';
function fixture() {
  const required = { id: 'test', name: 'Feature tests', executable: '/PRIVATE_COMMAND', args: ['PRIVATE_ARGUMENT'] };
  const check = { ...required, fingerprint: developmentCheckFingerprint(required) };
  const scope = { schemaVersion: 1, mode: 'worktree', baseCommit: 'a'.repeat(40), approvedPaths: ['src/feature.ts'], checks: [check] };
  const candidate = { patch: 'diff --git a/src/feature.ts b/src/feature.ts\n', digest, changedPaths: ['src/feature.ts'] };
  const evidence = { schemaVersion: 1, candidateDigest: digest, changedPaths: [...candidate.changedPaths], updatedAt: at,
    checks: [{ presetId: check.id, presetFingerprint: check.fingerprint, candidateDigest: digest, status: 'passed', exitCode: 0, stdout: 'PRIVATE_OUTPUT', stderr: '', startedAt: at, finishedAt: at }] };
  return { scope, candidate, evidence };
}
function views(value) {
  const { scope, candidate, evidence } = value;
  return {
    classified: classifyDevelopmentEvidence(scope, evidence),
    authority: developmentVerified(scope, candidate, evidence),
    note: projectDevelopmentEvidence(scope, evidence),
    ui: candidateEvidenceView({ id: 'request', status: 'review', files: [], hasPatch: true, implementation: scope, developmentEvidence: evidence }),
  };
}
test('execution, review Markdown and UI share current-candidate check outcomes', () => {
  /** @type {Array<[string, (value: ReturnType<typeof fixture>) => void, boolean, string, string]>} */
  const scenarios = [
    ['passed', () => {}, true, 'passed', 'Passed'],
    ['missing', value => { value.evidence.checks = []; }, false, 'not_run', 'Not run'],
    ['changed candidate', value => { value.evidence.checks[0].candidateDigest = 'c'.repeat(64); }, false, 'stale', 'Needs rerun'],
    ['changed check', value => { value.evidence.checks[0].presetFingerprint = 'c'.repeat(64); }, false, 'stale', 'Needs rerun'],
    ['failed', value => { Object.assign(value.evidence.checks[0], { status: 'failed', exitCode: 1 }); }, false, 'failed', 'Failed'],
    ['interrupted', value => { Object.assign(value.evidence.checks[0], { status: 'interrupted', exitCode: null }); }, false, 'interrupted', 'Interrupted'],
    ['false pass', value => { value.evidence.checks[0].exitCode = 1; }, false, 'failed', 'Failed'],
  ];
  for (const [name, mutate, verified, status, label] of scenarios) {
    const value = fixture(); mutate(value); const result = views(value);
    assert.deepEqual([result.authority, result.classified.verified, result.note.verified, result.ui.verified], [verified, verified, verified, verified], name);
    assert.equal(result.classified.checks[0].status, status, name); assert.equal(result.note.checks[0].status, status, name); assert.equal(result.ui.checks[0].status, label, name);
    assert.doesNotMatch(JSON.stringify(result.note) + renderDevelopmentEvidence(result.note), /PRIVATE_|stdout|stderr|executable/);
  }
});
test('duplicate identities and out-of-scope evidence cannot become a passing display or execution gate', () => {
  /** @type {Array<[string, (value: ReturnType<typeof fixture>) => void]>} */
  const malformed = [
    ['two passes', value => { value.evidence.checks.push({ ...value.evidence.checks[0] }); }],
    ['failure before pass', value => { value.evidence.checks.unshift({ ...value.evidence.checks[0], status: 'failed', exitCode: 1 }); }],
    ['failure after pass', value => { value.evidence.checks.push({ ...value.evidence.checks[0], status: 'failed', exitCode: 1 }); }],
    ['duplicate required ID', value => { value.scope.checks.push({ ...value.scope.checks[0] }); }],
    ['unknown receipt ID', value => { value.evidence.checks.push({ ...value.evidence.checks[0], presetId: 'other' }); }],
    ['unapproved changed path', value => { value.evidence.changedPaths = ['outside.ts']; value.candidate.changedPaths = ['outside.ts']; }],
    ['duplicate changed path', value => { value.evidence.changedPaths.push('src/feature.ts'); value.candidate.changedPaths.push('src/feature.ts'); }],
  ];
  for (const [name, mutate] of malformed) {
    const value = fixture(); mutate(value); const result = views(value);
    assert.deepEqual([result.authority, result.classified.verified, result.note.verified, result.ui.verified], [false, false, false, false], name);
    assert.ok(result.classified.checks.every(check => check.status === 'invalid' && !check.passed), name);
    assert.ok(result.note.checks.every(check => check.status === 'invalid'), name);
    assert.ok(result.ui.checks.every(check => check.status === 'Invalid evidence' && !check.passed), name);
    assert.match(result.ui.description, /inconsistent/); assert.match(renderDevelopmentEvidence(result.note), /Invalid verification evidence/);
  }
});
test('recorded passing checks do not replace private captured-patch and path agreement', () => {
  for (const mutate of [value => { value.candidate.patch = ''; }, value => { value.candidate.digest = 'c'.repeat(64); }, value => { value.candidate.changedPaths = ['different.ts']; }]) {
    const value = fixture(); mutate(value); const result = views(value);
    assert.equal(result.classified.verified, true); assert.equal(result.authority, false);
  }
  for (const mutate of [value => { value.evidence.changedPaths = []; value.candidate.changedPaths = []; }, value => { value.scope.checks = []; value.evidence.checks = []; }]) {
    const value = fixture(); mutate(value); const result = views(value);
    assert.deepEqual([result.authority, result.note.verified, result.ui.verified], [false, false, false]);
  }
});
