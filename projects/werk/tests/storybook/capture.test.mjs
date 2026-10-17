import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { assetManifest, calculateCoverage, capture, readStoryEvidence, validateCaptureRecords, validateStoryEvidence } from '../../scripts/storybook/capture.mjs';
import { renderStorymap, routeMatches } from '../../scripts/storybook/render-storymap.mjs';

const components = [
  { name: 'Taskboard', app: 'Worker', path: 'src/worker/webview/components/Taskboard.vue', props: ['{ selected: string }'], events: ['{ select: [id: string] }'] },
  { name: 'AccessPanel', app: 'Shared', path: 'src/shared/webview/components/AccessPanel.vue', props: [], events: [] },
];
const metadata = { app: 'Worker', summary: 'Review retained task evidence.', covers: [components[0].path], route: '/history', journey: 'Review a result', step: 1 };
const story = { id: 'worker-board--review', title: 'Worker/Taskboard', name: 'Review patch', metadata, mounted: [components[0].path], meaningful: true, document: undefined };

test('route examples match known parameterized paths without matching unrelated routes', () => {
  assert.equal(routeMatches('/factories/:id', '/factories/studio?line=alpha#overview'), true);
  assert.equal(routeMatches('/factories/:id', '/factories/'), false);
  assert.equal(routeMatches('/factories/:id', '/factories/studio/tasks'), false);
  assert.equal(routeMatches('/factories/:id', 'https://example.invalid/factories/studio'), false);
  assert.equal(routeMatches('/taskboard', '/taskboard?session=one'), true);
  assert.equal(routeMatches('/taskboard', '/history'), false);
  assert.equal(routeMatches('/a.b', '/axb'), false);
  assert.equal(routeMatches('/', undefined), false);
});

test('coverage counts actual mounted source once across stories and viewports', () => {
  assert.deepEqual(calculateCoverage(components, [story, story]), { total: 2, covered: 1, missing: [components[1].path] });
  assert.deepEqual(calculateCoverage(components, [{ ...story, metadata: { covers: components.map(item => item.path) } }]),
    { total: 2, covered: 1, missing: [components[1].path] });
  assert.deepEqual(calculateCoverage(components, [story, { mounted: [components[1].path] }]), { total: 2, covered: 2, missing: [] });
});

test('declaring a component does not pass qualification until it mounts', () => {
  assert.deepEqual(validateStoryEvidence(story, components), []);
  const invalid = validateStoryEvidence({ ...story, metadata: { ...metadata, covers: [components[1].path] } }, components);
  assert.match(invalid.join('\n'), /declared component was not mounted/);
  const invented = validateStoryEvidence({ ...story, metadata: { ...metadata, covers: ['src/invented.vue'] } }, components);
  assert.match(invented.join('\n'), /unknown component/);
});

test('each story requires exactly one desktop and one mobile screenshot', () => {
  const entries = [{ id: story.id }];
  const desktop = { ...story, viewport: 'desktop' };
  const mobile = { ...story, viewport: 'mobile' };
  assert.deepEqual(validateCaptureRecords(entries, [desktop, mobile]), []);
  assert.match(validateCaptureRecords(entries, [desktop]).join('\n'), /Missing screenshot record: worker-board--review\/mobile/);
  assert.match(validateCaptureRecords(entries, [desktop, desktop, mobile]).join('\n'), /Duplicate screenshot record/);
  assert.match(validateCaptureRecords(entries, [desktop, mobile, { id: 'unknown', viewport: 'desktop' }]).join('\n'), /Unexpected screenshot record/);
});

test('blank interfaces, render errors, missing metadata and untracked mounts fail qualification', () => {
  const blank = validateStoryEvidence({ ...story, meaningful: false, errors: ['Unmocked API request'], mounted: [] }, components);
  assert.match(blank.join('\n'), /did not render a visible, meaningful interface/);
  assert.match(blank.join('\n'), /Unmocked API request/);
  assert.match(blank.join('\n'), /no source components were mounted/);
  assert.match(validateStoryEvidence({ ...story, metadata: undefined }, components).join('\n'), /missing storymap metadata/);
  assert.match(validateStoryEvidence({ ...story, mounted: [...story.mounted, 'src/untracked.vue'] }, components).join('\n'), /absent from the inventory/);
  assert.match(validateStoryEvidence({ ...story, horizontalOverflow: true }, components).join('\n'), /overflows its viewport horizontally/);
});

test('visible teleported dialogs qualify while blank, hidden, and Storybook error surfaces do not', () => {
  const element = ({ text = '', width = 0, height = 0, visible = true, excluded = false } = {}) => ({
    innerText: text, textContent: text, getBoundingClientRect: () => ({ width, height }),
    checkVisibility: () => visible, closest: () => excluded ? {} : null, querySelector: () => null,
  });
  const blankRoot = element();
  const dialog = element({ text: 'Connect model session', width: 768, height: 656 });
  function inspect(surfaces, errors = []) {
    return runInNewContext(`(${readStoryEvidence.toString()})()`, {
      window: { __WERK_STORYMAP__: metadata, __WERK_MOUNTED_SOURCES__: new Set([components[0].path]), innerWidth: 1440 },
      document: { querySelectorAll: selector => selector.startsWith('#storybook-root') ? surfaces : errors, documentElement: { scrollWidth: 1440 } },
    });
  }
  assert.equal(inspect([blankRoot, dialog]).meaningful, true);
  assert.equal(inspect([blankRoot]).meaningful, false);
  assert.equal(inspect([blankRoot, element({ text: 'Hidden dialog', width: 768, height: 656, visible: false })]).meaningful, false);
  const error = element({ text: 'Storybook render failure', width: 768, height: 656, excluded: true });
  const failure = inspect([blankRoot, error], [error]);
  assert.equal(failure.meaningful, false);
  assert.match(failure.errors.join('\n'), /Storybook render failure/);
});

test('storymap escapes source text and links source elements only to observed examples', () => {
  const inventory = { version: '0.2.0', commit: 'abc123', sourceDigest: 'a'.repeat(64), components,
    routes: [{ app: 'worker', path: '/history', source: 'src/worker/webview/main.ts' }],
    system: { packages: [{ name: 'Worker', source: 'src/worker/package.json', directory: 'src/worker' }], flows: [{ from: 'Worker', to: 'Human review', purpose: 'Review evidence' }] } };
  const desktop = { ...story, name: '<script>bad()</script>', viewport: 'desktop', width: 1440, height: 1000, screenshot: 'screenshots/review-desktop.png' };
  const mobile = { ...desktop, viewport: 'mobile', width: 390, height: 844, screenshot: 'screenshots/review-mobile.png' };
  const html = renderStorymap(inventory, { coverage: calculateCoverage(components, [story]), stories: [desktop, mobile] });
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>bad()</script>'));
  assert.ok(html.includes('screenshots/review-desktop.png'));
  assert.ok(html.includes('screenshots/review-mobile.png'));
  assert.ok(html.includes('../?path=/story/worker-board--review'));
  assert.ok(html.includes('Work and evidence flow'));
  assert.ok(html.includes('Review a result'));
  assert.ok(html.includes('Route map'));
  const accessRow = html.match(/<tr class="searchable"[^>]+accesspanel[^>]*>[\s\S]*?<\/tr>/)?.[0];
  assert.ok(accessRow);
  assert.ok(!accessRow.includes('href="#story-'));
});

test('artifact manifests cover every file, exclude the self-hash and detect byte changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-storymap-hashes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'storymap'));
  await writeFile(join(directory, 'index.html'), 'first');
  await writeFile(join(directory, 'storymap', 'source.json'), '{}');
  await writeFile(join(directory, 'storymap', 'qualification.json'), '{}');
  const initial = await assetManifest(directory);
  assert.deepEqual(initial.map(item => item.path), ['index.html', 'storymap/source.json']);
  assert.ok(initial.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  await writeFile(join(directory, 'index.html'), 'changed');
  const changed = await assetManifest(directory);
  assert.notEqual(initial[0].sha256, changed[0].sha256);
  assert.equal(initial[1].sha256, changed[1].sha256);
});

test('artifact manifests reject symlink entries', { skip: process.platform === 'win32' ? 'Windows symlinks require elevated OS privileges' : false }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-storymap-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'original.txt'), 'source');
  await symlink('original.txt', join(directory, 'alias.txt'));
  await assert.rejects(assetManifest(directory), /cannot contain symlinks/);
});

test('a failed capture replaces a previous passing qualification with an explicit failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-storymap-failed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'storymap'));
  await writeFile(join(directory, 'storymap', 'qualification.json'), JSON.stringify({ passed: true }));
  await assert.rejects(capture({ root: directory, staticRoot: directory }), /source\.json/);
  const report = JSON.parse(await readFile(join(directory, 'storymap', 'qualification.json'), 'utf8'));
  assert.equal(report.passed, false);
  assert.equal(report.screenshots, 0);
  assert.equal(report.errors.length, 1);
  assert.deepEqual(report.files, []);
});
