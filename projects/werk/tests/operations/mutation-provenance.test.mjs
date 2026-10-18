import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digestMutationFiles, discoverMutationTests, discoverMutationSources } from '../../scripts/mutation/provenance.mjs';

const digestMutationTests = async (root, paths = []) => digestMutationFiles(root, [...await discoverMutationTests(root), ...paths]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'werk-mutation-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, content) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  await put('scripts/mutation/suites/first.test.mjs', 'first suite');
  return { root, put };
}

test('fresh mutation provenance detects added matched suites while ignoring unrelated files', async t => {
  const f = await fixture(t), original = await digestMutationTests(f.root);
  await f.put('scripts/mutation/suites/README.md', 'suite documentation');
  await f.put('scripts/mutation/suites/helper.mjs', 'unused helper');
  await f.put('scripts/mutation/suites/nested/other.test.mjs', 'outside the immediate suite glob');
  assert.deepEqual(await digestMutationTests(f.root), original);
  await f.put('scripts/mutation/suites/new.test.mjs', 'new suite discovered during analysis');
  const changed = await digestMutationTests(f.root);
  assert.notEqual(changed.digest, original.digest);
  assert.deepEqual(Object.keys(changed.files), ['scripts/mutation/suites/first.test.mjs', 'scripts/mutation/suites/new.test.mjs']);
});

test('mutation provenance detects changed suites and reused helpers and refuses missing evidence', async t => {
  const f = await fixture(t), paths = ['tests/reused.test.mjs', 'tests/helper.mjs'];
  for (const path of paths) await f.put(path, path);
  let previous = await digestMutationTests(f.root, paths);
  for (const path of ['scripts/mutation/suites/first.test.mjs', ...paths]) {
    await f.put(path, path + ' changed');
    const changed = await digestMutationTests(f.root, paths);
    assert.notEqual(changed.digest, previous.digest); assert.notEqual(changed.files[path], previous.files[path]);
    previous = changed;
  }
  await rm(join(f.root, paths[0]));
  await assert.rejects(digestMutationTests(f.root, paths), { code: 'ENOENT' });
  await rm(join(f.root, 'scripts/mutation/suites/first.test.mjs'));
  assert.deepEqual((await digestMutationTests(f.root)).files, {});
});

test('declared source and configuration provenance preserves exact bytes independent of input order', async t => {
  const f = await fixture(t), paths = ['src/source.ts', 'stryker.config.mjs'];
  await f.put(paths[0], 'export const source = "📦";\r\n'); await f.put(paths[1], 'export default {};\n');
  const original = await digestMutationFiles(f.root, paths);
  assert.deepEqual(await digestMutationFiles(f.root, [...paths].reverse()), original);
  assert.equal(original.files[paths[0]], createHash('sha256').update('export const source = "📦";\r\n').digest('hex'));
  for (const path of paths) {
    await f.put(path, 'changed input');
    const changed = await digestMutationFiles(f.root, paths);
    assert.notEqual(changed.digest, original.digest); assert.notEqual(changed.files[path], original.files[path]);
  }
});


test('compiled mutation provenance follows the exact compiler input boundaries', async t => {
  const f = await fixture(t);
  const included = ['src/shared/gate.ts', 'src/shared/webview/polling.ts', 'src/worker/application/input.ts', 'src/worker/infrastructure/helper.ts', 'src/worker/webview-adapter.ts'];
  const excluded = ['src/shared/types.d.ts', 'src/worker/webview/entry.ts', 'src/worker/webview/nested/component.ts',
    'src/shared/dist/gate.ts', 'src/worker/node_modules/dependency.ts', 'src/worker/nested/public/asset.ts', 'src/worker/application/readme.md', 'src/worker/application/runtime.mjs'];
  for (const path of [...included, ...excluded]) await f.put(path, path);
  assert.deepEqual(await discoverMutationSources(f.root), included.sort());
  const before = await digestMutationFiles(f.root, await discoverMutationSources(f.root));
  for (const path of excluded) await f.put(path, 'uncompiled file changed');
  assert.deepEqual(await digestMutationFiles(f.root, await discoverMutationSources(f.root)), before);
});

test('fresh compiled-source provenance detects dependency changes, additions and deletions', async t => {
  const f = await fixture(t), helper = 'src/worker/application/unmutated-helper.ts';
  await f.put('src/shared/gate.ts', 'export const initial = true;'); await f.put(helper, 'export const helper = 1;');
  const digest = async () => digestMutationFiles(f.root, await discoverMutationSources(f.root));
  const original = await digest();
  await f.put(helper, 'export const helper = 2;'); const changed = await digest();
  assert.notEqual(changed.digest, original.digest); assert.notEqual(changed.files[helper], original.files[helper]);
  const added = 'src/worker/application/new-dependency.ts'; await f.put(added, 'export const added = 3;');
  const expanded = await digest(); assert.notEqual(expanded.digest, changed.digest); assert.ok(expanded.files[added]);
  await rm(join(f.root, helper)); const reduced = await digest();
  assert.notEqual(reduced.digest, expanded.digest); assert.equal(Object.hasOwn(reduced.files, helper), false);
});
