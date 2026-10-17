import { stripTypeScriptTypes } from 'node:module';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { scope } from './scope.mjs';
import { fileURLToPath } from 'node:url';

// Compile once after Stryker instrumentation, with the production runtime's type stripper.
// This output is separate from runnable app distributions and contains no webview build.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, '.mutation-build');
await rm(output, { recursive: true, force: true });
async function compile(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['dist', 'node_modules', 'public'].includes(entry.name) || join(source, entry.name) === join(root, 'src/worker/webview')) continue;
    const input = join(source, entry.name), target = join(destination, entry.name);
    if (entry.isDirectory()) await compile(input, target);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const code = stripTypeScriptTypes(await readFile(input, 'utf8'), { mode: 'strip' });
      await writeFile(target.replace(/\.ts$/, '.js'), code);
    }
  }
}
await compile(join(root, 'src/shared'), join(output, 'shared'));
await compile(join(root, 'src/worker'), join(output, 'worker'));
// Run the ordinary queue and real SQLite accounting suites against the instrumented source.
await mkdir(join(output, 'tests'), { recursive: true });
for (const path of scope.reusedTests) {
  const original = await readFile(join(root, path), 'utf8');
  const rewritten = original.replaceAll('../../src/worker/dist/', '../');
  if (rewritten === original) throw Error('Reused test import changed; review mutation mapping: ' + path);
  await writeFile(join(output, 'tests', basename(path)), rewritten);
}
