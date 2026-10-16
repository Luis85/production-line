import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import '../ui/helpers/frontend-loader.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, 'work'), { recursive: true });
const directory = await mkdtemp(join(root, 'work/story-fixtures-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const modulePath = join(directory, 'portfolio.mjs');
for (const [source, destination] of [['storybook/fixtures/portfolio.ts', 'portfolio.mjs']]) {
  let content = await readFile(join(root, source), 'utf8');
  if (destination === 'portfolio.mjs') content = content.replace('../../src/factory/webview/store', pathToFileURL(join(root, 'src/factory/webview/store.ts')).href).replace('../../src/orchestrator/webview/store', pathToFileURL(join(root, 'src/orchestrator/webview/store.ts')).href);
  const output = ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(join(directory, destination), output);
}
const { factoryFixture, orchestratorFixture } = await import(pathToFileURL(modulePath)).catch(async error => { await rm(directory, { recursive: true, force: true }); throw error; });

function errors(t) {
  const previous = globalThis.__WERK_STORY_ERRORS__;
  globalThis.__WERK_STORY_ERRORS__ = [];
  t.after(() => { if (previous === undefined) delete globalThis.__WERK_STORY_ERRORS__; else globalThis.__WERK_STORY_ERRORS__ = previous; });
  return globalThis.__WERK_STORY_ERRORS__;
}

test('Factory fixture totals match every complete task page and mark partial observations', async () => {
  const store = factoryFixture();
  let total = 0;
  for (const line of store.state.overview.lines) {
    const page = await store.api(`/v1/lines/${line.line.id}/tasks?limit=10`);
    assert.equal(page.hasMore, false);
    assert.equal(page.tasks.length, line.overview.tasks.total);
    total += page.tasks.length;
  }
  assert.equal(store.state.overview.totals.tasks.total, total);
  assert.equal(factoryFixture({ empty: true }).state.overview.totals.tasks.total, 0);
  const partial = factoryFixture({ unavailable: true }).state.overview;
  assert.equal(partial.totals.partial, true);
  assert.equal(partial.totals.tasks.total, partial.lines[0].overview.tasks.total);
  assert.equal(partial.lines[1].overview, null);
});

test('Factory fixture rejects and records unknown requests outside the UI catch boundary', async t => {
  const recorded = errors(t), store = factoryFixture();
  await assert.rejects(store.api('/v1/unexpected'), /no fixture for GET/);
  await assert.rejects(store.api('/v1/lines/alpha/unknown-action', { method: 'POST', body: {} }), /no fixture for POST/);
  assert.equal(recorded.length, 2);
  await assert.rejects(store.api('/v1/lines', { method: 'POST', body: {} }), error => error.status === 405 && /Read-only fixture/.test(error.message));
  assert.equal(recorded.length, 2, 'a documented disabled mutation is intentional, not an unknown request');
});

test('Orchestrator fixture records unknown calls even when the store catches them', async t => {
  const recorded = errors(t), store = orchestratorFixture();
  await assert.rejects(store.api('/v1/unexpected'), /no fixture for GET/);
  await assert.rejects(store.api('/v1/tasks/task-ready/unknown-action', {}, 'POST'), /no fixture for POST/);
  assert.equal(recorded.length, 2);
  await store.refresh();
  assert.equal(store.state.stale, true);
  assert.ok(recorded.some(message => message.includes('GET /v1/overview')));
  const count = recorded.length;
  await assert.rejects(store.api('/v1/tasks', {}, 'POST'), error => error.status === 405 && /Read-only fixture/.test(error.message));
  assert.equal(recorded.length, count);
});
