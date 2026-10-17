import test from 'node:test';
import assert from 'node:assert/strict';
import { assignmentResponse } from '../../src/worker/dist/worker/infrastructure/responses.js';
import { HttpWorkerGateway } from '../../src/worker/dist/worker/infrastructure/orchestrator-client.js';
import { ReportingError } from '../../src/worker/dist/worker/application/errors.js';

/** @returns {import('../../src/shared/domain.js').Task} */
const task = () => ({ id: 'task-1', project: 'demo', title: 'Feature', criteria: ['Done'], wikilinks: [], provider: 'codex', priority: 1,
  status: 'running', attempt: 1, workerId: 'worker-1', lease: 'lease-1', expiresAt: 60000, profile: 'codex-1', createdAt: 0 });
const identity = { id: 'worker-1', project: 'demo', token: 'fixture', url: 'http://orchestrator.invalid', configHash: 'fixture' };
const context = { sha256: 'a'.repeat(64), commit: 'b'.repeat(40), featureId: 'feature-1', path: 'requirements/Feature.md' };
const source = { featureId: 'feature-1', iterationId: 'iteration-1', branch: 'feature/review', commit: 'b'.repeat(40),
  path: 'requirements/Feature.md', iterationPrUrl: 'https://example.com/pull/1', specSha256: 'c'.repeat(64) };
const receipt = { schemaVersion: 1, requestId: 'request-1', revision: 1, inputDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64),
  evaluationId: 'evaluation-1', stage: 'ready', status: 'passed', failedRules: 0, unknownRules: 0 };
const rejected = error => error instanceof ReportingError && error.retryable === false && error.message === 'Invalid orchestrator assignment' && error.cause === undefined;

/** @type {Array<[string, unknown]>} */
const invalidFields = [
  ['repository', { path: '/private/repository' }], ['repository', '../other'], ['repository', ' backend '], ['title', null], ['title', 'x'.repeat(201)],
  ['criteria', 'not-an-array'], ['criteria', [null]], ['criteria', []], ['wikilinks', ['plain text']],
  ['provider', 'unknown'], ['priority', -1], ['executionMode', 'unknown'], ['createdAt', -1], ['createdAt', 0.5],
  ['expiresAt', Infinity], ['attempt', 0], ['project', 'other/project'], ['workerId', ' worker-1 '], ['profile', '../profile'],
  ['requirementRef', '/private/file.md'], ['source', { ...source, path: '../private' }],
  ['context', { ...context, sha256: 'invalid' }], ['requestGate', { ...receipt, status: 'blocked' }],
];

test('assignment adapter rejects malformed consumed fields before returning a Task', () => {
  for (const [key, value] of invalidFields) assert.throws(() => assignmentResponse({ ...task(), [key]: value }), rejected, key);
  for (const key of ['title', 'criteria', 'wikilinks', 'provider', 'priority', 'createdAt']) {
    const missing = task(); delete missing[key];
    assert.throws(() => assignmentResponse(missing), rejected, `missing ${key}`);
  }
});

test('all HTTP assignment entry points reject malformed input and retain a safe nonretryable error', async () => {
  for (const [key, value] of invalidFields) {
    const remote = { ...task(), [key]: value };
    const client = new HttpWorkerGateway(identity.url, '', async (_base, path) =>
      path.endsWith('/current') ? { tasks: [remote] } : path.endsWith('/next') ? { task: remote } : remote).connect(identity);
    await assert.rejects(client.currentAssignments(), rejected, key);
    await assert.rejects(client.claim('claim-1'), rejected, key);
    await assert.rejects(client.heartbeat(task()), rejected, key);
  }
});

test('valid assignments preserve exact values, response extensions and legacy absent execution mode', () => {
  for (const additions of [
    {}, { executionMode: 'mock' }, { executionMode: 'cli' },
    { repository: 'backend', source, context, requestGate: receipt },
    { requirementRef: '[[requirements/Feature]]', criteria: [], wikilinks: [] },
    { title: '  Preserve the accepted title  ', criteria: ['  Preserve accepted text  '] },
  ]) {
    const original = Object.freeze({ ...task(), ...additions, futureExtension: { schemaVersion: 2 } });
    const before = structuredClone(original), validated = assignmentResponse(original);
    assert.strictEqual(validated, original);
    assert.deepEqual(validated, before);
    assert.equal(Object.hasOwn(validated, 'executionMode'), Object.hasOwn(additions, 'executionMode'));
  }
});

test('assignment shape validation does not manufacture ownership or execution authorization', async () => {
  const foreign = { ...task(), project: 'another-project', workerId: 'another-worker', executionMode: 'cli' };
  assert.strictEqual(assignmentResponse(foreign), foreign, 'ownership and installed-mode policy remain application concerns');
  const client = new HttpWorkerGateway(identity.url, '', async (_base, path) => path.endsWith('/next') ? { task: null } : { tasks: [] }).connect(identity);
  assert.equal(await client.claim('claim-empty'), null);
  assert.deepEqual(await client.currentAssignments(), []);
});
