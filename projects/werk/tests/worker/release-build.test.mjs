import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReleaseBuild, releaseArtifactDirectory } from '../../src/worker/dist/worker/infrastructure/release-build.js';
import { releaseOperation } from './release-fixtures.mjs';
import { prepareNativeProcessFixture } from '../helpers/native-process-fixture.mjs';
prepareNativeProcessFixture();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const signal = () => new AbortController().signal;
async function fixture(t, script = "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('out'); writeFileSync('out/app.zip','merged-build');") {
  const directory = await mkdtemp(join(tmpdir(), 'werk-release-build-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository'), remote = join(directory, 'remote.git'), stateDirectory = join(directory, 'state'); await mkdir(repository);
  git(repository, 'init', '-b', 'main'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repository, 'build.mjs'), script); await writeFile(join(repository, 'user.txt'), 'baseline'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Merged fixture');
  const commit = git(repository, 'rev-parse', 'HEAD'); git(directory, 'clone', '--bare', repository, remote); git(repository, 'remote', 'add', 'origin', remote);
  await writeFile(join(repository, 'user.txt'), 'staged'); git(repository, 'add', 'user.txt'); await writeFile(join(repository, 'user.txt'), 'unstaged'); await writeFile(join(repository, 'untracked.txt'), 'preserve');
  const before = { head: git(repository, 'rev-parse', 'HEAD'), index: git(repository, 'write-tree'), status: git(repository, 'status', '--porcelain=v1') };
  const operation = releaseOperation('build'); operation.mergeCommit = commit; operation.target.build.executable = process.execPath;
  return { directory, repository, stateDirectory, operation, before, adapter: createReleaseBuild({ repository, stateDirectory }) };
}
test('release builds the pinned merged commit in isolation and retains immutable checksummed assets without modifying developer files', async t => {
  const f = await fixture(t), receipt = await f.adapter.build(f.operation, signal());
  assert.equal(receipt.commit, f.operation.mergeCommit); assert.equal(receipt.artifacts.length, 3);
  const artifactDirectory = releaseArtifactDirectory(f.stateDirectory, f.operation);
  const app = await readFile(join(artifactDirectory, 'app.zip')); assert.equal(app.toString(), 'merged-build');
  assert.equal(receipt.artifacts[0].sha256, createHash('sha256').update(app).digest('hex'));
  const manifest = JSON.parse(await readFile(join(artifactDirectory, 'werk-release-manifest.json'), 'utf8'));
  assert.equal(manifest.mergedCommit, f.operation.mergeCommit); assert.equal(manifest.candidateCommit, f.operation.candidate.candidateCommit);
  assert.match(await readFile(join(artifactDirectory, 'SHA256SUMS'), 'utf8'), /app.zip/);
  assert.deepEqual(await f.adapter.inspectBuild(f.operation, signal()), receipt);
  assert.deepEqual({ head: git(f.repository, 'rev-parse', 'HEAD'), index: git(f.repository, 'write-tree'), status: git(f.repository, 'status', '--porcelain=v1') }, f.before);
  await assert.rejects(f.adapter.build(f.operation, signal()), /already exists/);
});
test('changed retained artifacts prevent recovered build confirmation and interrupted workspaces never rerun automatically', async t => {
  const f = await fixture(t); await f.adapter.build(f.operation, signal());
  await writeFile(join(releaseArtifactDirectory(f.stateDirectory, f.operation), 'app.zip'), 'tampered');
  await assert.rejects(f.adapter.inspectBuild(f.operation, signal()), /changed/);
  const next = structuredClone(f.operation); next.operationId = 'another-build';
  const directory = join(releaseArtifactDirectory(f.stateDirectory, next), '..'); await mkdir(join(directory, 'worktree'), { recursive: true });
  assert.equal(await f.adapter.inspectBuild(next, signal()), null); await assert.rejects(f.adapter.build(next, signal()), /already exists/);
});
test('failed configured builds retain worktree and cannot manufacture a successful artifact receipt', async t => {
  const f = await fixture(t, 'process.exit(7);');
  await assert.rejects(f.adapter.build(f.operation, signal()), /did not complete successfully/);
  assert.equal(await f.adapter.inspectBuild(f.operation, signal()), null);
  assert.equal(git(f.repository, 'rev-parse', 'HEAD'), f.before.head);
});

test('Git replace refs cannot substitute different source under the approved merged SHA', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, 'build.mjs'), "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('out'); writeFileSync('out/app.zip','wrong-source');");
  git(f.repository, 'add', 'build.mjs'); git(f.repository, 'commit', '-m', 'Replacement source'); const replacement = git(f.repository, 'rev-parse', 'HEAD');
  git(f.repository, 'replace', f.operation.mergeCommit, replacement);
  const receipt = await f.adapter.build(f.operation, signal());
  assert.equal(receipt.commit, f.operation.mergeCommit);
  assert.equal(await readFile(join(releaseArtifactDirectory(f.stateDirectory, f.operation), 'app.zip'), 'utf8'), 'merged-build');
});
test('a build cannot change tracked source and still claim the merged-commit provenance', async t => {
  const f = await fixture(t, "import {mkdirSync,writeFileSync} from 'node:fs'; writeFileSync('user.txt','source changed'); mkdirSync('out'); writeFileSync('out/app.zip','changed');");
  await assert.rejects(f.adapter.build(f.operation, signal()), /source bytes differ/);
  assert.equal(await f.adapter.inspectBuild(f.operation, signal()), null);
});
test('corrupt recovery inventories cannot replace configured artifact names', async t => {
  const f = await fixture(t); await f.adapter.build(f.operation, signal());
  const receiptPath = join(releaseArtifactDirectory(f.stateDirectory, f.operation), '..', 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')); receipt.artifacts[0].name = '../foreign.zip'; await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(f.adapter.inspectBuild(f.operation, signal()), /inventory changed/);
});
