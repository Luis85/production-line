import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadProjectModelContext } from '../../src/worker/dist/worker/infrastructure/project-model-context.js';
const signal = () => new AbortController().signal;
async function repository(t) {
  const path = await mkdtemp(join(tmpdir(), 'werk-project-context-')); t.after(() => rm(path, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  await mkdir(join(path, '.werk')); await writeFile(join(path, 'README.md'), 'Accepted project conventions');
  const commit = async paths => { await writeFile(join(path, '.werk', 'model-context.json'), JSON.stringify({ schemaVersion: 1, paths })); git('add', '.'); git('commit', '-m', 'context'); return git('rev-parse', 'HEAD'); };
  return { path, git, commit };
}
test('shared project context uses explicit committed allowlist and stays pinned despite dirty local edits', async t => {
  const f = await repository(t), commit = await f.commit(['README.md']);
  const snapshot = await loadProjectModelContext(f.path, commit, signal());
  assert.equal(snapshot.commit, commit); assert.equal(snapshot.files[0].content, 'Accepted project conventions'); assert.match(snapshot.files[0].sha256, /^[a-f0-9]{64}$/);
  await writeFile(join(f.path, 'README.md'), 'Uncommitted conflicting instructions');
  await writeFile(join(f.path, '.werk', 'model-context.json'), JSON.stringify({ schemaVersion: 1, paths: ['secrets.json'] }));
  assert.deepEqual(await loadProjectModelContext(f.path, commit, signal()), snapshot);
  await assert.rejects(loadProjectModelContext(f.path, 'HEAD', signal()), /pinned/);
});
test('project context refuses secret names, missing files, oversize blobs and malformed text', async t => {
  const f = await repository(t);
  await writeFile(join(f.path, 'secrets.json'), '{}'); let commit = await f.commit(['secrets.json']);
  await assert.rejects(loadProjectModelContext(f.path, commit, signal()), /non-secret/);
  commit = await f.commit(['missing.md']); await assert.rejects(loadProjectModelContext(f.path, commit, signal()), /ordinary committed/);
  await writeFile(join(f.path, 'README.md'), 'x'.repeat(32769)); commit = await f.commit(['README.md']);
  await assert.rejects(loadProjectModelContext(f.path, commit, signal()), /32 KiB/);
  await writeFile(join(f.path, 'README.md'), Buffer.from([0xe0, 0x80, 0x80])); commit = await f.commit(['README.md']);
  await assert.rejects(loadProjectModelContext(f.path, commit, signal()), /UTF-8/);
});
test('projects without a committed context manifest have no implicit ambient context', async t => {
  const f = await repository(t); f.git('add', 'README.md'); f.git('commit', '-m', 'initial');
  assert.equal(await loadProjectModelContext(f.path, f.git('rev-parse', 'HEAD'), signal()), null);
});
