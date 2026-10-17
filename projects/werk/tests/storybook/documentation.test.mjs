import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { documentationCatalog, documentationLink, renderDocumentationMarkdown, renderDocumentationPage } from '../../scripts/storybook/documentation.mjs';
import { validateStoryEvidence } from '../../scripts/storybook/capture.mjs';

const commit = 'a'.repeat(40);
const page = { id: 'start', title: 'Start here', chapter: 'Start here', source: 'docs/handbook.md', markdown: '# Start here\n\n## Choose a path\n\n[Install](how-to/project-worker.md#setup)\n\n<script>alert(1)</script>\n\n| Command | Purpose |\n| --- | --- |\n| `node --version` | Verify Node |\n\n## Choose a path\n' };
const pages = [page, { id: 'install-worker', source: 'docs/how-to/project-worker.md', title: 'Install', chapter: 'Set up your workspace', markdown: '# Install\n\n## Setup' }];

test('maintained links stay local and source-only references are pinned to the release commit', () => {
  assert.equal(documentationLink('how-to/project-worker.md#setup', page.source, pages, commit), 'install-worker.html#setup');
  assert.equal(documentationLink('#choose-a-path', page.source, pages, commit), '#choose-a-path');
  assert.equal(documentationLink('https://example.org/setup', page.source, pages, commit), 'https://example.org/setup');
  assert.equal(documentationLink('../examples/system.yaml', page.source, pages, commit), `https://github.com/Luis85/production-line/blob/${commit}/projects/werk/examples/system.yaml`);
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', '//untrusted.invalid', '../../outside.md', '..\\outside.md']) assert.throws(() => documentationLink(url, page.source, pages, commit), /Unsupported|leaves the project/);
});
test('documentation escapes embedded HTML, deduplicates headings and wraps wide tables', () => {
  const result = renderDocumentationMarkdown(page, pages, commit);
  assert.ok(typeof result.html === 'string', 'Documentation rendering is synchronous');
  assert.ok(!result.html.includes('<script>'));
  assert.ok(result.html.includes('&lt;script&gt;'));
  assert.deepEqual(result.headings.map(heading => heading.id), ['choose-a-path', 'choose-a-path-1']);
  assert.match(result.html, /class="docs-table" role="region"/);
  assert.match(result.html, /href="install-worker.html#setup"/);
});
test('documentation shell exposes release identity, contextual navigation and keyboard entry', () => {
  const html = renderDocumentationPage(page, pages, { version: '0.11.0', commit });
  assert.match(html, /href="#docs-main"/);
  assert.match(html, /id="docs-main" tabindex="-1"/);
  assert.match(html, /href="start.html" aria-current="page"/);
  assert.match(html, /aria-label="On this page"/);
  assert.match(html, /0\.11\.0/);
  assert.match(html, /class="docs-menu" open/);
  assert.match(html, /<script src="documentation-client.js" defer>/);
  assert.ok(!html.includes('type="module"'), 'The extracted handbook must work without an HTTP module loader');
  assert.match(html, /production-line\/blob\/aaaaaaaa/);
});
test('documentation evidence cannot invent pages or claim source component coverage', () => {
  const evidence = { id: 'docs--start', metadata: { app: 'Documentation', kind: 'documentation', document: 'start', summary: 'Choose your setup path', covers: [] }, document: 'start', mounted: [], meaningful: true };
  assert.deepEqual(validateStoryEvidence(evidence, [], pages), []);
  assert.match(validateStoryEvidence({ ...evidence, document: 'another' }, [], pages).join('\n'), /must render an indexed page/);
  assert.match(validateStoryEvidence(evidence, [], []).join('\n'), /must render an indexed page/);
  assert.match(validateStoryEvidence({ ...evidence, mounted: ['src/Example.vue'] }, [], pages).join('\n'), /cannot claim component coverage/);
  assert.match(validateStoryEvidence({ ...evidence, metadata: { ...evidence.metadata, kind: undefined } }, [], pages).join('\n'), /covers must name at least one/);
});
test('the documentation catalog starts with role guidance and gives every maintained page a unique route', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const catalog = await documentationCatalog(root);
  assert.equal(catalog[0].id, 'start');
  assert.equal(new Set(catalog.map(page => page.id)).size, catalog.length);
  assert.ok(catalog.every(page => page.id !== 'index'), 'The index route is reserved for the welcome page');
  assert.ok(catalog.some(page => page.source === 'docs/index.md' && page.id === 'documentation-index'));
  for (const id of ['install-worker', 'team-requests', 'system-setup', 'frontend', 'api', 'releases']) assert.ok(catalog.some(page => page.id === id), id);
  for (const source of ['docs/tutorials', 'docs/how-to', 'docs/reference', 'docs/explanation']) assert.ok(catalog.some(page => page.source.startsWith(source)), source);
  for (const page of catalog) assert.ok(!page.source.includes('/reports/'), 'Historical reports are not current setup instructions');
});
