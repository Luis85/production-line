import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReadme, generateReadmes, readmeLink, renderReadme, rewriteReadmeLinks } from '../../scripts/storybook/readme-source.mjs';

import { readmeFixture } from '../operations/readme-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rebase = href => readmeLink(href, 'docs/overview.md', 'README.md');

test('README links preserve code, multiline list indentation, tables and local anchors', () => {
  const input = '# Guide\n\n1. Follow the plan\n   and [Setup](how-to/setup.md#first).\n\n| Resource | Example |\n| --- | --- |\n| [API](reference/api.md) | `[API](reference/api.md)` |\n\n```md\n[Setup](how-to/setup.md)\n```\n\n[Same page](#guide)\n';
  const output = rewriteReadmeLinks(input, rebase);
  assert.ok(output.includes('   and [Setup](docs/how-to/setup.md#first).'));
  assert.ok(output.includes('| [API](docs/reference/api.md) | `[API](reference/api.md)` |'));
  assert.ok(output.includes('```md\n[Setup](how-to/setup.md)\n```'));
  assert.ok(output.includes('[Same page](#guide)'));
});

test('README local destinations stay inside the project while external references remain unchanged', () => {
  assert.equal(rebase('../CHANGELOG.md'), 'CHANGELOG.md');
  assert.equal(rebase('how-to/a%20b.md#step'), 'docs/how-to/a%20b.md#step');
  assert.equal(rebase('https://example.invalid/path'), 'https://example.invalid/path');
  for (const href of ['../../escape.md', '../%2e%2e/escape.md', 'javascript:alert(1)', '//outside.invalid', '..\\secret.md', '/absolute.md', '%00file']) assert.throws(() => rebase(href), /Unsupported|leaves the project/);
  const commit = 'a'.repeat(40);
  assert.equal(readmeLink('reference/api.md', 'docs/overview.md', 'README.md', commit), `https://github.com/Luis85/production-line/blob/${commit}/projects/werk/docs/reference/api.md`);
  assert.equal(readmeLink('evidence/readme/worker-review.png', 'docs/overview.md', 'README.md', commit), 'docs/evidence/readme/worker-review.png');
});

test('the generated overview preserves the worker to Factory journey and matches maintained source', async () => {
  const generated = await checkReadme(root);
  for (const text of ['Connect your worker to an Orchestrator', 'Introduce a Factory', 'Start a complete system from YAML']) assert.ok(generated.includes(text));
  assert.match(generated, /Generated from docs\/overview\.md/);
  assert.match(generated, /worker-metrics\.png/);
  assert.match(generated, /worker-review\.png/);
  assert.equal(generated, await readFile(new URL('../../README.md', import.meta.url), 'utf8'));
});


test('only the exact Forge Git layout generates a second landing page and checks its drift', async t => {
  const { root: repository, put } = await readmeFixture(t);
  const project = join(repository, 'projects/werk');
  for (const path of ['docs/overview.md', 'storybook/readme.json']) {
    await put('projects/werk/' + path, await readFile(join(repository, path)));
  }
  await put('projects/werk/README.md', 'Project placeholder.');
  await put('bin/config.json', JSON.stringify({ schemaVersion: 1, paths: { projects: 'projects' } }));
  await put('bin/forge.js', '// Forge fixture marker.');
  assert.deepEqual(await generateReadmes(project), [join(project, 'README.md'), join(repository, 'README.md')]);
  const landing = await readFile(join(repository, 'README.md'), 'utf8');
  assert.equal(landing, await renderReadme(project, { repository: true }));
  assert.ok(landing.includes('(projects/werk/docs/how-to/setup.md#first)'));
  assert.ok(landing.includes('(projects/werk/docs/evidence/readme/worker-review.png)'));
  await checkReadme(project);
  await writeFile(join(repository, 'README.md'), 'Handwritten drift.');
  await assert.rejects(checkReadme(project), /differs from its maintained source/);
  await rm(join(repository, 'bin/config.json'));
  assert.deepEqual(await generateReadmes(project), [join(project, 'README.md')]);
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'Handwritten drift.');
});

test('standalone fixtures never write a parent README', async t => {
  const { root: fixture } = await readmeFixture(t);
  const outer = join(fixture, 'standalone'); await mkdir(outer);
  for (const path of ['docs/overview.md', 'storybook/readme.json']) {
    const destination = join(outer, path); await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, await readFile(join(fixture, path)));
  }
  await writeFile(join(outer, 'README.md'), 'Placeholder.');
  const parent = await readFile(join(fixture, 'README.md'));
  assert.deepEqual(await generateReadmes(outer), [join(outer, 'README.md')]);
  await checkReadme(outer);
  assert.deepEqual(await readFile(join(fixture, 'README.md')), parent);
});
