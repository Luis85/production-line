import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { references } from './dependency-graph.mjs';

const root = new URL('../../', import.meta.url);

// Source images deliberately omit release packaging: --dist-only never imports it.
// The worker still bundles its offline authoring CLI through a dynamic import.
function buildScriptClosure(sources, app) {
  const pending = ['scripts/build.mjs'], visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    assert.ok(sources.has(file), `${app} Docker build context is missing ${file}`);
    for (const edge of references(file, sources.get(file))) {
      assert.notEqual(edge.specifier, null, `${file}: computed build imports need an explicit context policy`);
      if (!edge.specifier.startsWith('.')) continue; // npm ci supplies external dependencies.
      const dependency = posix.normalize(posix.join(posix.dirname(file), edge.specifier));
      if (edge.kind === 'dynamic-import') {
        if (file === 'scripts/build.mjs' && dependency === 'scripts/release/apps.mjs') continue;
        if (file === 'scripts/build.mjs' && dependency === 'scripts/release/feature-authoring.mjs') {
          if (app !== 'worker') continue;
        } else assert.fail(`${file}: qualify dynamic build dependency ${dependency} for source Docker images`);
      }
      pending.push(dependency);
    }
  }
  return visited;
}

async function copiedBuildScripts(app) {
  const dockerfile = await readFile(new URL(`src/${app}/Dockerfile`, root), 'utf8');
  const buildStage = dockerfile.split(/^FROM\s/m)[1];
  assert.ok(buildStage, `${app}: expected a source build stage`);
  const copied = new Map();
  for (const line of buildStage.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    if (!/^COPY\s/.test(line)) continue;
    const words = line.trim().split(/\s+/).slice(1);
    const destination = words.pop();
    for (const source of words.filter(value => value.startsWith('scripts/'))) {
      assert.match(source, /\.mjs$/, `${app}: extend this context fixture for directory or glob copies`);
      const target = destination.endsWith('/') ? posix.join(destination, posix.basename(source)) : destination;
      assert.equal(target, source, `${app}: build scripts must keep their relative import paths`);
      copied.set(target, await readFile(new URL(source, root), 'utf8'));
    }
  }
  assert.match(buildStage, new RegExp(`RUN node scripts/build\\.mjs ${app} --dist-only(?:\\r?\\n|$)`));
  return copied;
}

for (const app of ['factory', 'orchestrator', 'worker']) {
  test(`${app} source Docker context contains the complete build-script dependency closure`, async () => {
    const copied = await copiedBuildScripts(app);
    const closure = buildScriptClosure(copied, app);
    assert.ok(closure.has('scripts/build-info.mjs'));
    if (app === 'worker') assert.ok(closure.has('scripts/release/feature-authoring.mjs'));
    copied.delete('scripts/build-info.mjs');
    assert.throws(() => buildScriptClosure(copied, app), /missing scripts\/build-info\.mjs/);
  });
}

test('source Docker context guard catches transitive missing helpers and worker-only imports', () => {
  const fixture = new Map([
    ['scripts/build.mjs', "import './helper.mjs';"],
    ['scripts/helper.mjs', "export { value } from './nested.mjs';"],
  ]);
  assert.throws(() => buildScriptClosure(fixture, 'factory'), /missing scripts\/nested\.mjs/);
  fixture.set('scripts/nested.mjs', 'export const value = 1;');
  assert.equal(buildScriptClosure(fixture, 'factory').size, 3);
  fixture.set('scripts/build.mjs', "await import('./release/feature-authoring.mjs');");
  assert.throws(() => buildScriptClosure(fixture, 'worker'), /missing scripts\/release\/feature-authoring\.mjs/);
  assert.equal(buildScriptClosure(fixture, 'factory').size, 1);
});
