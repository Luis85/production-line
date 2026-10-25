import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localMergeBaselineHold } from '../../src/worker/dist/worker/application/local-merge-baseline.js';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
import { cleanup } from './fixture-cleanup.mjs';
prepareNativeProcessFixture();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
/** @returns {Pick<import('../../src/worker/application/request-gates.ts').WorkerRequest, 'input' | 'delivery'>} */
const history = (repositoryId, state) => /** @type {any} */ ({ input: { context: { repositoryId } }, delivery: { localMerge: state } });

test('second increment cannot start from an unpublished first increment and resumes after explicit main publication', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-merge-baseline-'))), repository = join(directory, 'project'), remote = join(directory, 'remote.git');
  cleanup(t, () => rm(directory, { recursive: true, force: true })); await mkdir(repository); await mkdir(remote);
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'value.txt'), 'baseline\n'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Baseline');
  git(remote, 'init', '--bare'); git(repository, 'remote', 'add', 'origin', remote); git(repository, 'push', 'origin', 'main');
  const firstBaseline = git(remote, 'rev-parse', 'refs/heads/main');
  await writeFile(join(repository, 'value.txt'), 'accepted first increment\n'); git(repository, 'commit', '-am', 'Accepted increment');
  const mergeCommit = git(repository, 'rev-parse', 'HEAD'), requests = [history('project-one', { operations: [], merged: { mergeCommit } })];
  const contains = async (commit, baseline) => { try { git(repository, 'merge-base', '--is-ancestor', commit, baseline); return true; } catch { return false; } };
  assert.match(await localMergeBaselineHold(requests, 'project-one', firstBaseline, contains), /Publish or synchronize/);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), firstBaseline, 'Admission observation never pushes main.');
  git(repository, 'push', 'origin', 'main');
  const secondBaseline = git(remote, 'rev-parse', 'refs/heads/main');
  assert.equal(await localMergeBaselineHold(requests, 'project-one', secondBaseline, contains), null);
  assert.equal(git(remote, 'show', secondBaseline + ':value.txt'), 'accepted first increment');
});

test('pending acknowledgements block only their project and merged histories all remain authoritative', async () => {
  const pending = history('project-one', { operations: [{ status: 'unknown' }] });
  const calls = [], contains = async (commit, baseline) => { calls.push([commit, baseline]); return commit !== 'unpublished'; };
  assert.match(await localMergeBaselineHold([pending], 'project-one', 'shared', contains), /Reconcile/); assert.deepEqual(calls, []);
  assert.equal(await localMergeBaselineHold([pending], 'other-project', 'shared', contains), null);
  const requests = ['published', 'published', 'unpublished'].map(mergeCommit => history('project-one', { operations: [{ status: 'confirmed' }], merged: { mergeCommit } }));
  assert.match(await localMergeBaselineHold(requests, 'project-one', 'shared', contains), /shared branch/);
  assert.deepEqual(calls, [['published', 'shared'], ['unpublished', 'shared']]);
  calls.length = 0;
  assert.equal(await localMergeBaselineHold([history('project-one', { operations: [{ status: 'failed' }] })], 'project-one', 'shared', contains), null);
  assert.deepEqual(calls, []);
});
