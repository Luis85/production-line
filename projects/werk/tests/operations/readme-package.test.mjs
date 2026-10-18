import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { exportReadme, packageReadme } from '../../scripts/release/readme-package.mjs';
import { sourceDigest } from '../../scripts/storybook/source.mjs';
import { renderReadme } from '../../scripts/storybook/readme-source.mjs';
import { readmeFixture, readmeHash } from './readme-fixtures.mjs';

test('README artifact uses exact qualified PNGs, pinned links and deterministic provenance without source writes', async t => {
  const { root, png, report, files } = await readmeFixture(t);
  const before = await readFile(join(root, 'README.md'));
  const first = await packageReadme(root), second = await packageReadme(root);
  assert.deepEqual(second, first);
  assert.equal(first.screenshots, 1);
  const archive = await readFile(join(root, 'release', first.artifact));
  const entries = unzipSync(archive), prefix = 'werk-readme-0.12.0/';
  assert.deepEqual(Buffer.from(entries[prefix + 'docs/evidence/readme/worker-review.png']), png);
  const markdown = Buffer.from(entries[prefix + 'README.md']).toString();
  assert.ok(markdown.includes(`/blob/${report.commit}/projects/werk/docs/how-to/setup.md#first`));
  assert.ok(markdown.includes('(docs/evidence/readme/worker-review.png)'));
  const provenance = JSON.parse(Buffer.from(entries[prefix + 'docs/evidence/readme/provenance.json']).toString());
  assert.equal(provenance.commit, report.commit);
  assert.equal(provenance.sourceDigest, report.sourceDigest);
  assert.equal(provenance.sampleData, true);
  assert.equal(provenance.screenshots[0].sha256, readmeHash(png));
  assert.equal(await readFile(join(root, 'release/README-SHA256SUMS'), 'utf8'), `${readmeHash(archive)}  ${first.artifact}\n`);
  assert.deepEqual(await readFile(join(root, 'README.md')), before);
  for (const [path, bytes] of files) assert.deepEqual(await readFile(join(root, 'storybook-static', path)), bytes);
  assert.equal(await sourceDigest(root), report.sourceDigest, 'Generating artifacts must not invalidate the source digest');
});

test('README drift and subsequently regenerated source invalidate an earlier screenshot qualification', async t => {
  const { root, put } = await readmeFixture(t);
  await put('docs/overview.md', (await readFile(join(root, 'docs/overview.md'), 'utf8')) + '\nUpdated journey.\n');
  await assert.rejects(packageReadme(root), /differs from its maintained source/);
  await put('README.md', await renderReadme(root));
  await assert.rejects(packageReadme(root), /source digest is stale/);
  await assert.rejects(readFile(join(root, 'release/README-SHA256SUMS')), { code: 'ENOENT' });
});

test('failed, stale and tampered qualification cannot produce README release assets', async t => {
  const { root, report, save, put } = await readmeFixture(t);
  const original = structuredClone(report);
  for (const [change, message] of [
    [{ passed: false }, /did not pass/], [{ commit: 'f'.repeat(40) }, /commit is stale/],
    [{ sourceDigest: 'a'.repeat(64) }, /source digest is stale/], [{ version: '0.11.0' }, /version is stale/],
  ]) {
    Object.assign(report, original, change); await save();
    await assert.rejects(packageReadme(root), message);
  }
  Object.assign(report, original); await save();
  await put('storybook-static/storymap/screenshots/worker-review--verified-candidate-desktop.png', 'tampered');
  await assert.rejects(packageReadme(root), /file integrity mismatch/);
});

test('missing, ambiguous and inconsistent capture metadata cannot be selected', async t => {
  const { root, manifest, save } = await readmeFixture(t);
  const original = structuredClone(manifest);
  const mutations = [
    () => { manifest.commit = 'f'.repeat(40); },
    () => { manifest.stories[0].id = 'unknown--story'; },
    () => { manifest.stories[1] = { ...manifest.stories[0] }; },
    () => { manifest.stories[0].screenshot = '../outside.png'; },
    () => { manifest.stories[0].horizontalOverflow = true; },
    () => { manifest.stories[0].width = 1440; },
  ];
  for (const mutate of mutations) {
    Object.assign(manifest, structuredClone(original)); mutate(); await save();
    await assert.rejects(packageReadme(root), /manifest identity|one qualified capture|capture record|dimensions differ/);
  }
});

test('picture refresh exports to a new scratch directory and preserves the final qualification identity', async t => {
  const { root, report, put } = await readmeFixture(t);
  const destination = join(root, 'work', 'readme-refresh');
  await exportReadme(root, destination);
  assert.equal(await sourceDigest(root), report.sourceDigest);
  await assert.rejects(exportReadme(root, destination), { code: 'EEXIST' });
  await assert.rejects(exportReadme(root, join(root, 'docs/evidence/readme')), /tracked files are never overwritten/);
  await put('docs/evidence/readme/provenance.json', await readFile(join(destination, 'docs/evidence/readme/provenance.json')));
  assert.equal(await sourceDigest(root), report.sourceDigest, 'Evidence is output, not an input hash cycle');
  await assert.rejects(packageReadme(root), /clean source checkout/);
  await assert.rejects(exportReadme(root, join(root, 'work', 'uncommitted-refresh')), /clean source checkout/);
  await put('scripts/storybook/readme-source.mjs', 'generator changed');
  await assert.rejects(packageReadme(root), /source digest is stale/);
});


test('scratch export refuses a symlink that resolves into maintained source', async t => {
  const { root } = await readmeFixture(t);
  await mkdir(join(root, 'work'));
  await symlink(join(root, 'docs'), join(root, 'work', 'source-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportReadme(root, join(root, 'work/source-link/new-directory')), /tracked files are never overwritten/);
  await assert.rejects(readFile(join(root, 'docs/new-directory/README.md')), { code: 'ENOENT' });
});
