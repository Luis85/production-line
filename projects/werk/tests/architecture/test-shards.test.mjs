import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { collectTestFiles, planTestShards, testPatterns, testShardManifest } from '../../scripts/quality/test-shard.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));

test('four Windows shards cover every maintained npm-test file exactly once, deterministically', () => {
  const files = collectTestFiles(root), shards = planTestShards(files, 4);
  const packageInfo = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const patterns = [...packageInfo.scripts.test.matchAll(/"([^"]*\*[^"]*)"/g)].map(match => match[1]);
  assert.deepEqual([...testPatterns].sort(), patterns.sort(), 'sharding and npm test must share every discovery pattern');
  assert.ok(files.length > 100); assert.ok(files.some(path => path.endsWith('.test.cjs'))); assert.ok(files.some(path => path.endsWith('.test.mjs')));
  assert.equal(new Set(shards.flat()).size, files.length); assert.deepEqual(shards.flat().sort(), files);
  assert.deepEqual(planTestShards([...files].reverse(), 4), shards);
  assert.ok(Math.max(...shards.map(shard => shard.length)) - Math.min(...shards.map(shard => shard.length)) <= 1);
  const manifests = [1, 2, 3, 4].map(index => testShardManifest(root, index, 4));
  assert.equal(new Set(manifests.map(manifest => manifest.suiteDigest)).size, 1);
  assert.deepEqual(manifests.flatMap(manifest => manifest.files).sort(), files);
  assert.ok(manifests.every(manifest => manifest.totalFiles === files.length));
});

test('invalid or overlapping discovery cannot silently omit or duplicate a test file', () => {
  for (const count of [0, -1, 1.5, 17]) assert.throws(() => planTestShards(['a.test.mjs'], count));
  assert.throws(() => planTestShards([], 4)); assert.throws(() => planTestShards(['a.test.mjs'], 4));
  assert.throws(() => planTestShards(['a.test.mjs', 'a.test.mjs'], 1));
  for (const index of [0, 5]) assert.throws(() => testShardManifest(root, index, 4));
});

test('Windows workflow runs every planned shard with preserved exit status and retained manifests', () => {
  const workflow = parse(readFileSync(new URL('../../src/infrastructure/workflows/check/check.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.jobs.windows.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(workflow.jobs.windows.strategy['fail-fast'], false);
  const commands = workflow.jobs.windows.steps.map(step => step.run ?? '').join('\n');
  assert.match(commands, /npm run build/); assert.match(commands, /npm run check:fast/);
  assert.match(commands, /test-shard\.mjs --shard/); assert.match(commands, /matrix\.shard/); assert.match(commands, /\/4/); assert.match(commands, /exit \$LASTEXITCODE/);
  assert.ok(workflow.jobs.windows.steps.some(step => step.if === 'always()' && step.with?.path?.includes('werk-test-shard.json')));
  assert.deepEqual(workflow.jobs.check.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
});
