import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
/** Hash the exact declared inputs in stable repository-relative order. */
export async function digestMutationFiles(root, paths) {
  const files = {};
  for (const path of [...new Set(paths)].sort()) files[path] = sha256(await readFile(join(root, path)));
  return { digest: sha256(JSON.stringify(files)), files };
}
/** Rediscover the suite glob on every measurement so added tests cannot escape provenance. */
export async function discoverMutationTests(root) {
  const names = await readdir(join(root, 'scripts/mutation/suites'));
  return names.filter(name => name.endsWith('.test.mjs')).sort().map(name => `scripts/mutation/suites/${name}`);
}

/** Complete input membership shared with the isolated compiler, including unmutated dependencies. */
export async function discoverMutationSources(root) {
  const sources = [];
  async function walk(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const relative = path + '/' + entry.name;
      if (['dist', 'node_modules', 'public'].includes(entry.name) || relative === 'src/worker/webview') continue;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) sources.push(relative);
    }
  }
  await walk('src/shared'); await walk('src/worker');
  return sources.sort();
}
