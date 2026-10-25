import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeliverySteps } from '../../src/worker/dist/worker/application/delivery-task-steps.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { defaultDeliveryProjectPolicy, validateDeliveryProjectPolicy } from '../../src/worker/dist/worker/application/delivery-policy.js';
import { retainStartPrompt } from '../../src/worker/dist/worker/infrastructure/start-prompt.js';

function dispatch() {
  const model = { configuration: { id: 'claude-cli', model: 'sonnet', instruction: 'Respect the accepted scope.', executable: '/private/claude', apiKey: 'PRIVATE_CONNECTION_SECRET' }, async reply() { return ''; } };
  return prepareModelRequest(model, [{ id: 'u1', role: 'user', state: 'complete', at: '2026-10-25T00:00:00.000Z', text: 'Implement the approved feature.' }], 'patch');
}
const input = () => ({ requestId: 'request-one', runId: 'run-one', inputRevision: 1, inputHash: 'a'.repeat(64), baseline: 'b'.repeat(40), policyDigest: 'c'.repeat(64), dispatch: dispatch() });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'werk-start-prompt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('start prompt ledger preserves the exact approved dispatch and immutable replay without connection credentials', async t => {
  const directory = await fixture(t), accepted = input(), signal = new AbortController().signal;
  const first = await retainStartPrompt(directory, accepted, signal), repeated = await retainStartPrompt(directory, accepted, signal);
  assert.deepEqual(repeated, first);
  const content = await readFile(join(directory, first.path), 'utf8'), document = JSON.parse(content);
  assert.equal(document.prompt, accepted.dispatch.renderedPrompt);
  assert.equal(document.baseline, accepted.baseline); assert.equal(document.provider.id, 'claude-cli');
  assert.equal(document.digest, first.digest); assert.ok(!content.includes('PRIVATE_CONNECTION_SECRET')); assert.ok(!content.includes('/private/claude'));
  await assert.rejects(retainStartPrompt(directory, { ...accepted, dispatch: { ...accepted.dispatch, renderedPrompt: 'Changed instructions' } }, signal), /differs/);
  assert.equal(await readFile(join(directory, first.path), 'utf8'), content);
});
test('start prompt ledger rejects tampering, path escape, reserved folders and symlink destinations', async t => {
  const directory = await fixture(t), accepted = input(), signal = new AbortController().signal;
  for (const path of ['../escaped', '/absolute', 'sessions/prompts', 'projects/prompts']) await assert.rejects(retainStartPrompt(directory, { ...accepted, directory: path }, signal));
  const first = await retainStartPrompt(directory, accepted, signal);
  await writeFile(join(directory, first.path), 'tampered');
  await assert.rejects(retainStartPrompt(directory, accepted, signal), /differs/);
  if (process.platform !== 'win32') {
    await symlink(directory, join(directory, 'linked'));
    await assert.rejects(retainStartPrompt(directory, { ...accepted, directory: 'linked' }, signal));
  }
});
test('release policy requires the approved PR destination and start prompt ledger stays private', () => {
  const policy = defaultDeliveryProjectPolicy();
  assert.equal(validateDeliveryProjectPolicy({ ...policy, startPromptDirectory: 'ledger/prompts' }).startPromptDirectory, 'ledger/prompts');
  assert.throws(() => validateDeliveryProjectPolicy({ ...policy, startPromptDirectory: 'sessions' }));
  const release = { repository: 'team/project', base: 'main', mergeMethod: 'squash', build: { executable: 'node', args: ['build.mjs'], timeoutMs: 1000, artifacts: ['dist/app.zip'] }, tagPrefix: 'v', prerelease: false };
  assert.throws(() => validateDeliveryProjectPolicy({ ...policy, release }), /same approved/);
  const remoteDelivery = { remote: 'origin', repository: 'team/project', base: 'main', push: true, pullRequest: true, draft: true };
  assert.ok(validateDeliveryProjectPolicy({ ...policy, release, remoteDelivery }).release);
  assert.throws(() => validateDeliveryProjectPolicy({ ...policy, release, remoteDelivery: { ...remoteDelivery, base: 'other' } }), /same approved/);
});

test('legacy approved-file execution without a delivery run remains runnable and does not create a start prompt', async () => {
  let calls = 0;
  const accepted = input(), model = { configuration: { id: 'claude-cli', model: 'sonnet', instruction: '' }, async reply() { calls++; return 'Completed legacy patch'; } };
  const task = /** @type {import('../../src/worker/application/local-task-contracts.ts').LocalTask} */ (/** @type {unknown} */ ({ requestId: accepted.requestId, baseCommit: accepted.baseline, repository: '/legacy', runId: 'legacy-invocation' }));
  const host = /** @type {Parameters<typeof runDeliverySteps>[0]} */ (/** @type {unknown} */ ({
    sessions: { requests: { get() { return { id: accepted.requestId, input: { context: {} } }; } } },
    delivery() { return { async startPrompt() { throw Error('Legacy execution cannot invent a delivery identity'); } }; },
    validatedPatch() { return { summary: 'Legacy result', patch: 'diff', changedFileCount: 1 }; },
  }));
  const result = await runDeliverySteps(host, task, model, accepted.dispatch, undefined, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result.valid.patch, 'diff');
});
