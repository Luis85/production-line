import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorkerWorkspace } from '../../src/worker/dist/worker/status/workspace.js';
import { SnapshotJournal } from '../../src/worker/dist/worker/infrastructure/journal/snapshots.js';
import { workerStatus } from '../helpers/worker-status.mjs';
import { workspaceContext } from './runtime-fixtures.mjs';

test('Ready Check answer routing selects only the body project and returns its exact operation acknowledgement', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-ready-answer-route-'))), primary = join(directory, 'primary'), secondary = join(directory, 'secondary'), state = join(directory, 'state');
  for (const path of [primary, secondary, state]) await mkdir(path);
  for (const path of [primary, secondary]) execFileSync('git', ['init', '--quiet'], { cwd: path });
  const journal = new SnapshotJournal(state, 'a'.repeat(64), 'b'.repeat(64)); await journal.init();
  const worker = new WorkerWorkspace({ stateDir: state, projectDir: primary, pollMs: 1000, timeoutMs: 60000 }, journal, workerStatus); await worker.init();
  t.after(async () => { await worker.close(); journal.close(); await rm(directory, { recursive: true, force: true }); });
  await worker.updateSettings({ board: { paused: true }, repositories: { items: [{ id: 'secondary', path: secondary, watch: false }] } });
  const context = workspaceContext(worker), project = context.featureProjects.resolve('secondary'), received = [];
  context.featureProjects.primary.sharedRuntime.intake.answerReadyReview = async () => { assert.fail('The primary project must never receive the secondary answer.'); };
  project.sharedRuntime.intake.answerReadyReview = async value => {
    received.push(value); return { requestId: 'ready-request', operationId: 'answer-ui', status: /** @type {const} */ ('published') };
  };
  const command = { action: 'answer_ready_review', projectId: 'secondary', requestId: 'ready-request', operationId: 'answer-ui', expectedGeneration: 1, expectedReviewOperationId: 'review-one', expectedReviewDigest: 'a'.repeat(64), expectedSourceCommit: 'b'.repeat(40), expectedSourceRevision: 'c'.repeat(64), answer: 'Keep the documented navigation behavior.' };
  const result = await worker.sharedIntakeCommand(command); assert.ok('selectedProjectId' in result && 'readyReviewAnswer' in result); assert.equal(result.selectedProjectId, 'secondary'); assert.deepEqual(result.readyReviewAnswer, { requestId: command.requestId, operationId: command.operationId, status: 'published' }); assert.deepEqual(received, [command]);
  await assert.rejects(worker.sharedIntakeCommand({ ...command, projectId: 'unknown-project' }), /registered project/); assert.equal(received.length, 1);
  context.configurationUpdating = true; await assert.rejects(worker.sharedIntakeCommand(command), /configuration is changing/); assert.equal(received.length, 1); context.configurationUpdating = false;
});
