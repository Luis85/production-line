import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareFeatureExecution } from '../../src/worker/dist/worker/status/workspace-feature-execution.js';
import { submitSharedFeature } from '../../src/worker/dist/worker/status/workspace-features.js';
import { FeatureIntakeBlocked } from '../../src/worker/dist/worker/application/feature-intake-measurement.js';
import { assertLocalMergeBaseline } from '../../src/worker/dist/worker/status/workspace-local-merge-baseline.js';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { cleanup } from './fixture-cleanup.mjs';
prepareNativeProcessFixture();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-baseline-admission-'))), repository = join(directory, 'project'), remote = join(directory, 'remote.git');
  cleanup(t, () => rm(directory, { recursive: true, force: true })); await mkdir(repository); await mkdir(remote);
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'value.txt'), 'baseline\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  git(remote, 'init', '--bare'); git(repository, 'remote', 'add', 'origin', remote); git(repository, 'push', 'origin', 'main');
  const baseline = git(repository, 'rev-parse', 'HEAD'), histories = [], pages = [], admitted = [];
  const journal = {
    list({ after = 0, limit = 100 } = {}) { pages.push(after); const rows = histories.slice(after, after + limit); return { requests: rows, nextAfter: after + rows.length, hasMore: after + rows.length < histories.length }; },
    get(id) { return histories.find(request => request.id === id); },
  };
  const workspace = /** @type {import('../../src/worker/status/workspace-context.ts').WorkspaceContext} */ (/** @type {unknown} */ ({
    acceptingTasks: true, repositoryPreparations: 0, config: { stateDir: directory }, repositoryStop: new AbortController(), sessions: { requests: journal },
    settings: { provider: () => ({ id: 'claude-cli', model: '', effort: 'default' }) }, definitions: { select: () => undefined },
    repositories: { resolve: () => ({ path: repository }) }, board: { async create(_input, reservation) { admitted.push(reservation); } }, featureTracking: { async sync() {} },
  }));
  return { directory, repository, remote, baseline, histories, pages, admitted, workspace };
}

test('a second request prepared before acceptance is fenced again at submission, beyond the first history page', async t => {
  const f = await fixture(t);
  const input = /** @type {import('../../src/worker/application/feature-requests.ts').FeatureInput} */ ({ mode: 'patch', title: 'Second feature', message: 'Implement the second increment.', provider: 'claude-cli', paths: ['value.txt'] });
  const prepared = await prepareFeatureExecution(f.workspace, input, f.repository, 'project-one', f.baseline);
  assert.equal(prepared.selection.provider, 'claude-cli');
  await writeFile(join(f.repository, 'value.txt'), 'first accepted increment\n'); git(f.repository, 'commit', '-am', 'Accepted first increment');
  const merged = git(f.repository, 'rev-parse', 'HEAD');
  for (let index = 0; index < 100; index++) f.histories.push({ id: 'older-' + index, owner: { taskId: 'older-task-' + index }, input: { context: { repositoryId: 'other-project' } } });
  f.histories.push({ id: 'first-increment', owner: { taskId: 'first-task' }, input: { context: { repositoryId: 'project-one' } }, delivery: { localMerge: { operations: [], merged: { mergeCommit: merged } } } });
  const record = /** @type {import('../../src/worker/application/shared-feature-state.ts').SharedFeatureRecord} */ (/** @type {unknown} */ ({ id: 'second-feature', sourcePath: 'features/second.md', accepted: input, taskId: 'second-task', inputHash: 'a'.repeat(64), sourceCommit: f.baseline,
    binding: { repositoryId: 'project-one', remote: 'origin', branch: 'main', workflowPath: 'feature-workflow.json' }, workflow: { policy: {} }, selection: prepared.selection }));
  await assert.rejects(prepareFeatureExecution(f.workspace, input, f.repository, 'project-one', f.baseline), error => error instanceof FeatureIntakeBlocked && error.intakeBlocker.code === 'local_merge_baseline');
  await assert.rejects(submitSharedFeature(f.workspace, record), /Publish or synchronize/); assert.equal(f.admitted.length, 0); assert.ok(f.pages.includes(100)); assert.equal(f.workspace.repositoryPreparations, 0);
  git(f.repository, 'push', 'origin', 'main');
  await assert.rejects(submitSharedFeature(f.workspace, record), /prepared before the merge/); assert.equal(f.admitted.length, 0, 'A newer remote tip cannot bless the retained stale execution source.');
  record.sourceCommit = merged;
  await submitSharedFeature(f.workspace, record); assert.equal(f.admitted.length, 1); assert.equal(f.admitted[0].baseCommit, merged); assert.equal(f.workspace.repositoryPreparations, 0);
});

test('literal ancestry cannot be forged by replace refs and missing merged objects hold admission', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, 'value.txt'), 'first accepted increment\n'); git(f.repository, 'commit', '-am', 'Accepted increment');
  const merged = git(f.repository, 'rev-parse', 'HEAD');
  f.histories.push({ id: 'first-increment', owner: { taskId: 'first-task' }, input: { context: { repositoryId: 'project-one' } }, delivery: { localMerge: { operations: [], merged: { mergeCommit: merged } } } });
  git(f.repository, 'replace', f.baseline, merged);
  await assert.rejects(assertLocalMergeBaseline(f.workspace, f.repository, 'project-one', f.baseline), /Publish or synchronize/);
  f.histories[0].delivery.localMerge.merged.mergeCommit = 'f'.repeat(40);
  await assert.rejects(assertLocalMergeBaseline(f.workspace, f.repository, 'project-one', f.baseline), /cannot be inspected/);
});
