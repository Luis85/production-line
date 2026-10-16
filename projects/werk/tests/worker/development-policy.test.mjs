import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assertDevelopmentPolicy, developmentCheckFingerprint, developmentScopeView,
  developmentVerified, developmentCompletionValid, freezeDevelopmentScope, validateDevelopmentState,
} from '../../src/worker/dist/worker/application/development.js';
import { defaultToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { gateDigest } from '../../src/worker/dist/worker/application/request-gates.js';

const baseCommit = 'a'.repeat(40), digest = 'b'.repeat(64), otherDigest = 'c'.repeat(64);
const startedAt = '2026-10-16T10:00:00.000Z', finishedAt = '2026-10-16T10:00:01.000Z';
const command = (id, extra = {}) => ({ id, name: id === 'build' ? 'Build project' : 'Run project tests', executable: process.execPath, args: ['scripts/check.mjs', id], enabled: true, verification: true, ...extra });
function policy() {
  const value = defaultToolPolicy();
  value.builtins.files = true;
  value.builtins.commands = [command('test'), command('build'), command('optional', { verification: false }), command('disabled', { enabled: false })];
  return value;
}
function fixture() {
  const grants = policy(), paths = ['src/main.ts', 'tests/main.test.mjs'];
  const scope = freezeDevelopmentScope(baseCommit, paths, grants);
  const candidate = { patch: 'diff --git a/src/main.ts b/src/main.ts\n', digest, changedPaths: ['src/main.ts'] };
  const evidence = { schemaVersion: 1, candidateDigest: digest, changedPaths: [...candidate.changedPaths], checks: scope.checks.map(check => ({ presetId: check.id, presetFingerprint: check.fingerprint, candidateDigest: digest, status: 'passed', exitCode: 0, stdout: 'Fixture check passed.\n', stderr: '', startedAt, finishedAt })), updatedAt: finishedAt };
  return { grants, paths, scope, candidate, evidence };
}
const conflict = error => error.code === 'conflict';

test('implementation requires a committed repository, repository file grant and an enabled required check', () => {
  assert.equal(freezeDevelopmentScope(undefined, ['src/main.ts'], policy()), undefined);
  const withoutFiles = policy(); withoutFiles.builtins.files = false;
  assert.equal(freezeDevelopmentScope(baseCommit, ['src/main.ts'], withoutFiles), undefined);
  const withoutRequired = policy(); withoutRequired.builtins.commands.forEach(check => { check.verification = false; });
  assert.equal(freezeDevelopmentScope(baseCommit, ['src/main.ts'], withoutRequired), undefined);
  const disabled = policy(); disabled.builtins.commands.forEach(check => { check.enabled = false; });
  assert.equal(freezeDevelopmentScope(baseCommit, ['src/main.ts'], disabled), undefined);
  assert.equal(freezeDevelopmentScope('d'.repeat(64), ['src/main.ts'], policy()).baseCommit, 'd'.repeat(64));
  assert.throws(() => freezeDevelopmentScope('HEAD', ['src/main.ts'], policy()), conflict);
  assert.throws(() => freezeDevelopmentScope(baseCommit, ['../outside.ts'], policy()), conflict);
});

test('admission snapshots every required check and approved path independently of later policy edits', () => {
  const { grants, paths, scope } = fixture();
  assert.deepEqual(scope.checks.map(check => check.id), ['build', 'test']);
  assert.equal(scope.baseCommit, baseCommit);
  for (const check of scope.checks) {
    assert.equal(check.fingerprint, developmentCheckFingerprint(check));
    assert.match(check.fingerprint, /^[a-f0-9]{64}$/);
  }
  const original = structuredClone(scope);
  grants.builtins.commands[0].args.push('--changed');
  grants.builtins.commands[1].name = 'Different check';
  paths.push('extra.ts');
  assert.deepEqual(scope, original);
});

test('valid command preset IDs and executable paths remain valid when frozen as required checks', () => {
  const grants = policy();
  grants.builtins.commands = [command('Build_Check-2'), command('Z'.repeat(64), { executable: '/' + 'x'.repeat(1100) })];
  const valid = validateToolPolicy(grants);
  const scope = freezeDevelopmentScope(baseCommit, ['src/main.ts'], valid);
  assert.equal(scope.checks.length, 2);
  assert.doesNotThrow(() => validateDevelopmentState(scope));
});

test('the public development scope omits executable paths and fixed command arguments', () => {
  const { scope } = fixture();
  const view = developmentScopeView(scope);
  assert.deepEqual(view.checks, scope.checks.map(({ id, name, fingerprint }) => ({ id, name, fingerprint })));
  assert.equal(JSON.stringify(view).includes(process.execPath), false);
  assert.equal(JSON.stringify(view).includes('scripts/check.mjs'), false);
  view.approvedPaths.push('extra.ts');
  view.checks[0].name = 'Changed view';
  assert.equal(scope.approvedPaths.length, 2);
  assert.equal(scope.checks[0].name, 'Build project');
});

test('continuation refuses removed grants, changed commands and newly required checks', () => {
  const { scope, grants } = fixture();
  const mutations = [
    value => { value.builtins.files = false; },
    value => { value.builtins.commands = value.builtins.commands.filter(check => check.id !== 'test'); },
    value => { value.builtins.commands[0].enabled = false; },
    value => { value.builtins.commands[0].verification = false; },
    value => { value.builtins.commands[0].name = 'Renamed test'; },
    value => { value.builtins.commands[0].executable += '-different'; },
    value => { value.builtins.commands[0].args.push('--other-suite'); },
    value => { value.builtins.commands.push(command('lint')); },
    value => { value.builtins.commands.find(check => check.id === 'optional').verification = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(grants); mutate(changed);
    assert.throws(() => assertDevelopmentPolicy(scope, changed), conflict);
  }
});

test('unrelated grants and command ordering do not invalidate the frozen verification plan', () => {
  const { scope, grants } = fixture();
  grants.revision++;
  grants.builtins.commands.reverse();
  grants.builtins.commands.find(check => check.id === 'optional').args.push('--other');
  grants.builtins.commands.push(command('read-only', { verification: false }));
  grants.builtins.webOrigins = ['https://docs.example.test'];
  grants.mcp = [{ id: 'docs', name: 'Documentation', transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '', secret: '', allowedTools: ['search'], discoveredTools: [{ name: 'search', description: 'Search public documentation', inputSchema: { type: 'object' } }] }];
  assert.doesNotThrow(() => assertDevelopmentPolicy(scope, validateToolPolicy(grants)));
});

test('verification requires every required check to pass for the exact current candidate and command', () => {
  const { scope, candidate, evidence } = fixture();
  assert.equal(developmentVerified(scope, candidate, evidence), true);
  assert.equal(developmentVerified(scope, candidate, undefined), false);
  assert.equal(developmentVerified(scope, { ...candidate, patch: '  \n' }, evidence), false);
  assert.equal(developmentVerified(scope, { ...candidate, changedPaths: [] }, evidence), false);
  assert.equal(developmentVerified(scope, { ...candidate, digest: otherDigest }, evidence), false);
  const mutations = [
    value => { value.checks.pop(); },
    value => { value.candidateDigest = null; },
    value => { value.candidateDigest = otherDigest; },
    value => { value.changedPaths = ['tests/main.test.mjs']; },
    value => { value.checks[0].candidateDigest = otherDigest; },
    value => { value.checks[0].presetFingerprint = otherDigest; },
    value => { value.checks[0].presetId = 'unknown'; },
    value => { value.checks[0].status = 'failed'; value.checks[0].exitCode = 1; },
    value => { value.checks[0].status = 'interrupted'; value.checks[0].exitCode = null; },
    value => { value.checks[0].exitCode = 1; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(evidence); mutate(changed);
    assert.equal(developmentVerified(scope, candidate, changed), false);
  }
});

test('persisted development state accepts incomplete and failed receipts without treating them as verified', () => {
  const { scope, candidate, evidence } = fixture();
  assert.doesNotThrow(() => validateDevelopmentState(scope));
  assert.doesNotThrow(() => validateDevelopmentState(scope, evidence));
  const empty = { schemaVersion: 1, candidateDigest: null, changedPaths: [], checks: [], updatedAt: finishedAt };
  assert.doesNotThrow(() => validateDevelopmentState(scope, empty));
  assert.equal(developmentVerified(scope, candidate, empty), false);
  for (const [status, exitCode] of [['failed', 1], ['interrupted', null]]) {
    const changed = structuredClone(evidence); Object.assign(changed.checks[0], { status, exitCode });
    assert.doesNotThrow(() => validateDevelopmentState(scope, changed));
    assert.equal(developmentVerified(scope, candidate, changed), false);
  }
  const stale = structuredClone(evidence); stale.checks[0].candidateDigest = otherDigest;
  assert.doesNotThrow(() => validateDevelopmentState(scope, stale));
  assert.equal(developmentVerified(scope, candidate, stale), false);
});

test('persisted scope validation rejects malformed authority, altered fingerprints and duplicate checks', () => {
  const { scope } = fixture();
  for (const value of [null, [], {}, { ...scope, mode: 'checkout' }, { ...scope, schemaVersion: 2 }, { ...scope, baseCommit: 'HEAD' }, { ...scope, checks: [] }, { ...scope, checks: [scope.checks[0], scope.checks[0]] }, { ...scope, approvedPaths: ['../outside.ts'] }])
    assert.throws(() => validateDevelopmentState(value), conflict);
  for (const change of [{ id: '../escape' }, { name: '' }, { args: ['bad\0argument'] }, { args: 'not-an-array' }, { executable: '' }, { fingerprint: 'invalid' }, { args: ['changed-after-admission'] }]) {
    const changed = structuredClone(scope); Object.assign(changed.checks[0], change);
    assert.throws(() => validateDevelopmentState(changed), conflict);
  }
});

test('persisted receipt validation rejects forged, out-of-scope and malformed check evidence', () => {
  const { scope, evidence } = fixture();
  for (const value of [null, [], {}, { ...evidence, schemaVersion: 2 }, { ...evidence, candidateDigest: 'bad' }, { ...evidence, changedPaths: ['outside.ts'] }, { ...evidence, changedPaths: ['src/main.ts', 'src/main.ts'] }, { ...evidence, updatedAt: 'not-a-date' }, { ...evidence, checks: 'not-an-array' }])
    assert.throws(() => validateDevelopmentState(scope, value), conflict);
  const mutations = [
    { presetId: 'unknown' }, { presetFingerprint: otherDigest }, { candidateDigest: 'bad' },
    { status: 'skipped' }, { status: 'passed', exitCode: 1 }, { exitCode: 1.5 },
    { stdout: 'x'.repeat(32769) }, { stderr: null }, { startedAt: 'bad' },
    { finishedAt: 'bad' }, { truncated: 'yes' },
  ];
  for (const change of mutations) {
    const changed = structuredClone(evidence); Object.assign(changed.checks[0], change);
    assert.throws(() => validateDevelopmentState(scope, changed), conflict);
  }
  const duplicate = structuredClone(evidence);
  duplicate.checks.push({ ...duplicate.checks[0], status: 'failed', exitCode: 1 });
  assert.throws(() => validateDevelopmentState(scope, duplicate), conflict, 'A previous pass cannot hide a later failure for the same required check.');
});

test('completion recovery binds the current turn and run to the captured patch and exact verified evidence', () => {
  const { scope, candidate, evidence } = fixture();
  const task = {
    implementation: scope, developmentEvidence: evidence, patch: candidate.patch,
    currentTurnId: 'fixture-turn', runId: 'fixture-run',
    developmentCompletion: { turnId: 'fixture-turn', runId: 'fixture-run', candidateDigest: digest, patchSha256: createHash('sha256').update(candidate.patch).digest('hex'), evidenceDigest: gateDigest(evidence), verified: true },
  };
  assert.equal(developmentCompletionValid(task), true);
  const mutations = [
    value => { delete value.implementation; },
    value => { delete value.developmentEvidence; },
    value => { delete value.developmentCompletion; },
    value => { value.patch = null; },
    value => { value.patch += 'Changed retained patch.\n'; },
    value => { value.currentTurnId = 'other-current-turn'; },
    value => { value.runId = 'other-current-run'; },
    value => { value.developmentCompletion.turnId = 'other-receipt-turn'; },
    value => { value.developmentCompletion.runId = 'other-receipt-run'; },
    value => { value.developmentCompletion.verified = false; },
    value => { value.developmentCompletion.patchSha256 = otherDigest; },
    value => { value.developmentCompletion.evidenceDigest = otherDigest; },
    value => { value.developmentCompletion.candidateDigest = otherDigest; },
    value => { value.developmentEvidence.checks[0].stdout += 'Changed retained receipt.'; },
    value => { value.developmentEvidence.checks[0].status = 'failed'; value.developmentEvidence.checks[0].exitCode = 1; value.developmentCompletion.evidenceDigest = gateDigest(value.developmentEvidence); },
    value => { value.developmentEvidence.checks[0].candidateDigest = otherDigest; value.developmentCompletion.evidenceDigest = gateDigest(value.developmentEvidence); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(task); mutate(changed);
    assert.equal(developmentCompletionValid(changed), false);
  }
});
