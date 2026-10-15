import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { packageStorybook } from '../../scripts/release/storybook-package.mjs';
import { sourceDigest } from '../../scripts/storybook/source.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-storybook-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await put('package.json', JSON.stringify({ name: 'werk-fixture', version: '0.2.0' }));
  await put('package-lock.json', '{}');
  for (const path of ['src/worker/webview/App.vue', '.storybook/main.ts', 'storybook/worker.stories.ts', 'scripts/storybook/source.mjs']) await put(path, 'fixture');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(join(root, 'empty-hooks'));
  execFileSync('git', ['-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${join(root, 'empty-hooks')}`, 'commit', '--quiet', '--allow-empty', '-m', 'Fixture revision'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = new Map([
    ['index.html', '<!doctype html><title>Werk Storybook</title>'],
    ['index.json', '{"v":5,"entries":{"worker--board":{"type":"story"}}}'],
    ['storymap/index.html', '<!doctype html><title>Storymap</title>'],
    ['storymap/manifest.json', '{"stories":["worker--board"]}'],
    ['storymap/screenshots/worker--board-desktop.png', 'fixture desktop screenshot'],
    ['storymap/screenshots/worker--board-mobile.png', 'fixture mobile screenshot'],
    ['assets/app.js', 'console.log("fixture");'],
  ]);
  for (const [path, content] of files) await put(`storybook-static/${path}`, content);
  const report = {
    schemaVersion: 1, version: '0.2.0', commit, sourceDigest: await sourceDigest(root), passed: true,
    coverage: { total: 1, covered: 1, missing: [] }, stories: 1, screenshots: 2, errors: [],
    files: [...files].map(([path, content]) => ({ path, sha256: hash(content) })),
  };
  const save = () => put('storybook-static/storymap/qualification.json', JSON.stringify(report));
  await save();
  return { root, put, report, save };
}

test('packages exact qualified Storybook and screenshots with a separate deterministic checksum', async t => {
  const { root, put, report } = await fixture(t);
  await put('release/SHA256SUMS', 'runtime checksums stay unchanged\n');
  const first = await packageStorybook(root);
  const second = await packageStorybook(root);
  assert.deepEqual(first, second);
  const zip = await readFile(join(root, 'release', first.artifact.name));
  const files = unzipSync(zip);
  assert.equal(first.commit, report.commit);
  assert.equal(first.screenshots, 2);
  assert.ok(Object.keys(files).every(path => path.startsWith('werk-storybook-0.2.0/')));
  assert.deepEqual(JSON.parse(Buffer.from(files['werk-storybook-0.2.0/storymap/qualification.json']).toString()), report);
  assert.equal(await readFile(join(root, 'release/STORYBOOK-SHA256SUMS'), 'utf8'), `${hash(zip)}  werk-storybook-0.2.0.zip\n`);
  assert.equal(await readFile(join(root, 'release/SHA256SUMS'), 'utf8'), 'runtime checksums stay unchanged\n');
});

test('rejects stale source, version and commit evidence before publishing', async t => {
  const { root, report, save, put } = await fixture(t);
  const original = structuredClone(report);
  for (const [change, message] of [
    [{ version: '0.1.0' }, /version is stale/],
    [{ commit: 'a'.repeat(40) }, /commit is stale/],
    [{ sourceDigest: 'b'.repeat(64) }, /source digest is stale/],
  ]) {
    Object.assign(report, original, change); await save();
    await assert.rejects(packageStorybook(root), message);
  }
  Object.assign(report, original); await save();
  await put('src/worker/webview/App.vue', 'changed after qualification');
  await assert.rejects(packageStorybook(root), /source digest is stale/);
  await assert.rejects(readFile(join(root, 'release/STORYBOOK-SHA256SUMS')), { code: 'ENOENT' });
});

test('failed browser checks, incomplete component coverage and missing screenshots cannot publish', async t => {
  const { root, report, save } = await fixture(t);
  const original = structuredClone(report);
  for (const [change, message] of [
    [{ passed: false }, /did not pass/],
    [{ errors: ['browser failed'] }, /did not pass/],
    [{ coverage: { total: 2, covered: 1, missing: ['App.vue'] } }, /component coverage is incomplete/],
    [{ screenshots: 3 }, /screenshot coverage is incomplete/],
    [{ stories: 3 }, /screenshot coverage is incomplete/],
  ]) {
    Object.assign(report, original, change); await save();
    await assert.rejects(packageStorybook(root), message);
  }
});

test('changed, extra and missing generated files invalidate the qualified inventory', async t => {
  const { root, put } = await fixture(t);
  await put('storybook-static/assets/app.js', 'changed');
  await assert.rejects(packageStorybook(root), /file integrity mismatch/);
  await put('storybook-static/assets/app.js', 'console.log("fixture");');
  await put('storybook-static/assets/unqualified.js', 'unqualified');
  await assert.rejects(packageStorybook(root), /qualified inventory differs/);
  await rm(join(root, 'storybook-static/assets/unqualified.js'));
  await rm(join(root, 'storybook-static/assets/app.js'));
  await assert.rejects(packageStorybook(root), /qualified inventory differs/);
});

test('qualified file paths must be unique, contained and hash-valid', async t => {
  const { root, report, save } = await fixture(t);
  const original = structuredClone(report.files);
  for (const invalid of [
    { path: '../outside', sha256: 'a'.repeat(64) },
    { path: '/absolute', sha256: 'a'.repeat(64) },
    { path: 'C:\\outside', sha256: 'a'.repeat(64) },
    original[1],
    { path: original[0].path, sha256: 'invalid' },
  ]) {
    report.files = [invalid, ...original.slice(1)]; await save();
    await assert.rejects(packageStorybook(root), /Invalid Storybook qualified inventory/);
  }
});

test('Storybook packaging rejects symlinks and oversized files before reading payloads', async t => {
  const { root, put } = await fixture(t);
  const link = join(root, 'storybook-static/assets/link.js');
  try { await symlink(join(root, 'package.json'), link); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await assert.rejects(packageStorybook(root), /regular files or directories/);
  await rm(link);
  await put('storybook-static/assets/oversized.js', '');
  await truncate(join(root, 'storybook-static/assets/oversized.js'), 32 * 1024 * 1024 + 1);
  await assert.rejects(packageStorybook(root), /32 MiB/);
});
