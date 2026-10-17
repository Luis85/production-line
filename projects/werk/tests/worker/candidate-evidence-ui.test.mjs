import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { candidateEvidenceView } = await frontend('src/worker/webview/candidate-evidence.ts');
const scope = () => ({ schemaVersion: 1, mode: 'worktree', baseCommit: 'b'.repeat(40), approvedPaths: ['src/feature.ts', 'test/feature.test.ts'], checks: [{ id: 'test', name: 'Tests', fingerprint: 't'.repeat(64) }, { id: 'lint', name: 'Lint', fingerprint: 'l'.repeat(64) }] });
const receipt = (id, changes = {}) => ({ presetId: id, presetFingerprint: id === 'test' ? 't'.repeat(64) : 'l'.repeat(64), candidateDigest: 'c'.repeat(64), status: 'passed', exitCode: 0, stdout: 'Passed', stderr: '', startedAt: '2026-10-16T12:00:00Z', finishedAt: '2026-10-16T12:00:01Z', ...changes });
const task = () => ({ id: 'feature', status: 'review', files: [{ path: 'src/feature.ts' }], hasPatch: true, implementation: scope(), developmentEvidence: { schemaVersion: 1, candidateDigest: 'c'.repeat(64), changedPaths: ['src/feature.ts'], checks: [receipt('test'), receipt('lint')], updatedAt: '2026-10-16T12:00:01Z' } });
test('proposal tasks are never upgraded by unrelated verification evidence', () => {
  const value = task(); delete value.implementation;
  const view = candidateEvidenceView(value); assert.equal(view.implementation, false); assert.equal(view.verified, false); assert.equal(view.title, 'Proposed patch'); assert.deepEqual(view.checks, []);
});
test('implemented readiness requires every frozen check on the same nonempty candidate', () => {
  const value = task(); const view = candidateEvidenceView(value);
  assert.equal(view.verified, true); assert.equal(view.title, 'Implemented · checks passed'); assert.match(view.description, /Human review and merge/);
  assert.deepEqual(view.approvedPaths, scope().approvedPaths);
  for (const mutation of [
    item => { item.developmentEvidence.candidateDigest = null; },
    item => { item.developmentEvidence.changedPaths = []; },
    item => { item.developmentEvidence.checks.pop(); },
    item => { item.developmentEvidence.checks[0].candidateDigest = 'a'.repeat(64); },
    item => { item.developmentEvidence.checks[0].presetFingerprint = 'changed'; },
    item => { item.developmentEvidence.checks[0].exitCode = 1; },
    item => { item.implementation.checks = []; },
  ]) { const changed = task(); mutation(changed); assert.equal(candidateEvidenceView(changed).verified, false); }
});
test('failed, interrupted and stale checks stay distinct and block verified handoff', () => {
  const value = task();
  value.developmentEvidence.checks[0] = receipt('test', { status: 'failed', exitCode: 1, stderr: 'Expected 4 but received 3' });
  let view = candidateEvidenceView(value); assert.equal(view.checks[0].status, 'Failed'); assert.match(view.description, /1 of 2/); assert.equal(view.verified, false);
  value.developmentEvidence.checks[0].status = 'interrupted'; assert.equal(candidateEvidenceView(value).checks[0].status, 'Interrupted');
  value.developmentEvidence.candidateDigest = 'z'.repeat(64); view = candidateEvidenceView(value); assert.ok(view.checks.every(check => check.status === 'Needs rerun'));
  delete value.developmentEvidence; view = candidateEvidenceView(value); assert.ok(view.checks.every(check => check.status === 'Not run')); assert.equal(view.title, 'Implementation pending');
});
test('saved checks do not claim a finished handoff for running or failed work, and unchanged polling keeps the same view', () => {
  const value = task(); value.status = 'running';
  const view = candidateEvidenceView(value); assert.equal(view.verified, true); assert.equal(view.title, 'Checks passed · handoff incomplete');
  for (let index = 0; index < 4; index++) assert.deepEqual(candidateEvidenceView(structuredClone(value)), view);
  value.status = 'failed'; assert.equal(candidateEvidenceView(value).title, 'Checks passed · handoff incomplete');
});
