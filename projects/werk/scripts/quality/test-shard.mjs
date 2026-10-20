import { globSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const testPatterns = ['tests/**/*.test.mjs', 'tests/**/*.test.cjs'];
const sorted = files => [...files].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
export function collectTestFiles(root) {
  return sorted(globSync(testPatterns, { cwd: root }).map(path => path.replaceAll('\\', '/')));
}
/** Stable whole-file partitions keep each node:test file and its hooks in one process. */
export function planTestShards(files, count) {
  if (!Number.isInteger(count) || count < 1 || count > 16) throw Error('Use 1–16 test shards.');
  if (!files.length || files.length < count || new Set(files).size !== files.length) throw Error('Test discovery must be nonempty, unique, and cover every shard.');
  const ordered = sorted(files), shards = Array.from({ length: count }, () => []);
  ordered.forEach((path, index) => shards[index % count].push(path));
  const union = sorted(shards.flat());
  if (union.length !== ordered.length || union.some((path, index) => path !== ordered[index])) throw Error('Test shards must cover the complete suite exactly once.');
  return shards;
}
export function testShardManifest(root, index, count) {
  if (!Number.isInteger(index) || index < 1 || index > count) throw Error('Shard index must be between one and the shard count.');
  const files = collectTestFiles(root), shards = planTestShards(files, count);
  return { schemaVersion: 1, shard: index, shards: count, patterns: testPatterns, totalFiles: files.length,
    suiteDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files: shards[index - 1] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), match = /^(\d+)\/(\d+)$/.exec(args[1] ?? '');
  if (args[0] !== '--shard' || !match || ![2, 4].includes(args.length) || args.length === 4 && args[2] !== '--manifest') throw Error('Usage: node scripts/quality/test-shard.mjs --shard 1/4 [--manifest path]');
  const root = fileURLToPath(new URL('../../', import.meta.url)), manifest = testShardManifest(root, Number(match[1]), Number(match[2]));
  if (args[3]) writeFileSync(args[3], JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Test shard ${manifest.shard}/${manifest.shards}: ${manifest.files.length}/${manifest.totalFiles} files; complete suite ${manifest.suiteDigest}`);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...manifest.files], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
