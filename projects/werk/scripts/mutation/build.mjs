import { discoverMutationSources } from './provenance.mjs';
import { stripTypeScriptTypes } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { scope } from './scope.mjs';
import { fileURLToPath } from 'node:url';

// Compile once after Stryker instrumentation, with the production runtime's type stripper.
// This output is separate from runnable app distributions and contains no webview build.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, '.mutation-build');
await rm(output, { recursive: true, force: true });
for (const path of await discoverMutationSources(root)) {
  const target = join(output, path.slice('src/'.length).replace(/\.ts$/, '.js'));
  await mkdir(dirname(target), { recursive: true });
  const code = stripTypeScriptTypes(await readFile(join(root, path), 'utf8'), { mode: 'strip' });
  await writeFile(target, code);
}
// Dedicated suites exercise delivery dependency and quality-profile authority against this isolated source.
// Reuse ordinary queue, SQLite accounting and Ready Check lifecycle contracts too.
await mkdir(join(output, 'tests'), { recursive: true });
const reused = [...scope.reusedTests, ...scope.reusedFixtures];
if (new Set(reused.map(path => basename(path))).size !== reused.length) throw Error('Mutation reused source names must be unique.');
for (const path of reused) {
  const original = await readFile(join(root, path), 'utf8');
  const rewritten = original.replaceAll('../../src/worker/dist/', '../');
  if (rewritten === original) throw Error('Reused test import changed; review mutation mapping: ' + path);
  await writeFile(join(output, 'tests', basename(path)), rewritten);
}
