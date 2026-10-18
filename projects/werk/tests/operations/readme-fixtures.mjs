import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sourceDigest } from '../../scripts/storybook/source.mjs';
import { renderReadme } from '../../scripts/storybook/readme-source.mjs';

export const readmeHash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readmeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-readme-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await put('package.json', JSON.stringify({ version: '0.12.0' }));
  await put('package-lock.json', '{}');
  for (const path of ['src/worker/webview/App.vue', '.storybook/main.ts', 'storybook/worker.stories.ts', 'scripts/storybook/readme-source.mjs']) await put(path, 'fixture');
  const selection = { schemaVersion: 1, source: 'docs/overview.md', screenshots: [{ file: 'worker-review.png', story: 'worker-review--verified-candidate', viewport: 'desktop', alt: 'Feature review', caption: 'Real UI with sample data.' }] };
  await put('storybook/readme.json', JSON.stringify(selection));
  await put('docs/overview.md', '# Werk\n\n[Setup](how-to/setup.md#first)\n\n<!-- readme-image: worker-review -->\n');
  await put('docs/how-to/setup.md', '# Setup\n\n## First\n');
  await put('README.md', await renderReadme(root));
  await put('.gitignore', 'storybook-static/\nrelease/\nwork/\nempty-hooks/\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(join(root, 'empty-hooks'));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Readme fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${join(root, 'empty-hooks')}`, 'commit', '--quiet', '--allow-empty', '-m', 'Fixture'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const digest = await sourceDigest(root);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const identity = { version: '0.12.0', commit, sourceDigest: digest };
  const manifest = { schemaVersion: 1, ...identity, capturedAt: '2026-10-18T10:00:00.000Z', fixtureTime: '2026-10-15T09:30:00.000Z', stories: ['desktop', 'mobile'].map(viewport => ({ id: selection.screenshots[0].story, viewport, width: 1, height: 1, horizontalOverflow: false, screenshot: `screenshots/${selection.screenshots[0].story}-${viewport}.png` })) };
  const files = new Map([
    ['index.html', Buffer.from('<!doctype html>')],
    ['index.json', Buffer.from('{}')],
    ['handbook/index.html', Buffer.from('<!doctype html>')],
    ['handbook/start.html', Buffer.from('<!doctype html>')],
    ['handbook/catalog.json', Buffer.from(JSON.stringify({ ...identity, pages: [{ id: 'start', path: 'handbook/start.html' }] }))],
    ['storymap/index.html', Buffer.from('<!doctype html>')],
    ['storymap/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ...manifest.stories.map(record => /** @type {[string, Buffer]} */ (['storymap/' + record.screenshot, png])),
  ]);
  const report = { schemaVersion: 1, ...identity, passed: true, errors: [], coverage: { total: 1, covered: 1, missing: [] }, stories: 1, screenshots: 2,
    documentation: { passed: true, pages: 1, results: ['desktop', 'mobile'].map(viewport => ({ viewport, passed: true, pages: 1 })) }, files: [] };
  async function save() {
    files.set('storymap/manifest.json', Buffer.from(JSON.stringify(manifest)));
    for (const [path, bytes] of files) await put('storybook-static/' + path, bytes);
    report.files = [...files].map(([path, bytes]) => ({ path, sha256: readmeHash(bytes) }));
    await put('storybook-static/storymap/qualification.json', JSON.stringify(report));
  }
  await save();
  return { root, put, selection, manifest, files, png, report, save };
}
