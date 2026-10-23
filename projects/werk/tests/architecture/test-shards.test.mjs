import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { collectTestFiles, planTestShards, testPatterns, testShardManifest, testShardArguments } from '../../scripts/quality/test-shard.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));

test('four native-platform shards cover every maintained npm-test file exactly once, deterministically', () => {
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

test('Windows and macOS workflows run every planned shard and retain exact manifests', () => {
  const workflow = parse(readFileSync(new URL('../../src/infrastructure/workflows/check/check.yml', import.meta.url), 'utf8'));
  for (const platform of ['windows', 'macos']) {
    const job = workflow.jobs[platform];
    assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
    assert.equal(job.strategy['fail-fast'], false);
    const commands = job.steps.map(step => step.run ?? '').join('\n');
    assert.match(commands, /npm run build/); assert.match(commands, /npm run check:fast/);
    assert.match(commands, /test-shard\.mjs --shard/); assert.match(commands, /matrix\.shard/); assert.match(commands, /\/4/);
    if (platform === 'windows') assert.match(commands, /exit \$LASTEXITCODE/);
    assert.ok(job.steps.some(step => step.if === 'always()' && step.with?.path?.includes('werk-test-shard.json')));
  }
  assert.deepEqual(workflow.jobs.check.strategy.matrix.os, ['ubuntu-latest']);
});

test('shard failures include assertion diagnostics before a later result is reported', t => {
  const directory = mkdtempSync(join(tmpdir(), 'werk-shard-reporter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'reporter.test.mjs');
  writeFileSync(file, "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('first assertion', () => assert.equal('actual', 'expected'));\ntest('later result', () => {});\n");
  const args = testShardArguments([file]);
  assert.deepEqual(args.filter(arg => arg.startsWith('--test-concurrency=')), ['--test-concurrency=2']);
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { env: environment, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 1);
  assert.match(result.stdout, /TAP version 13/); assert.match(result.stdout, /ERR_ASSERTION/);
  const diagnostic = result.stdout.indexOf('error:'), later = result.stdout.indexOf('ok 2 - later result');
  assert.ok(diagnostic >= 0 && later > diagnostic, 'Failure details must survive cancellation before the suite summary.');
});
