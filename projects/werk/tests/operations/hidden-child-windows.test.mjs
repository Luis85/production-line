import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../..', import.meta.url));
// Everything a running Factory, orchestrator or worker launches in the background.
const roots = ['src', 'scripts/runtime', 'scripts/system', 'scripts/fleet.mjs', 'scripts/factory-fleet.mjs'];

async function sources(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(error => { if (error.code === 'ENOTDIR') return null; throw error; });
  if (!entries) return /\.(?:ts|mjs)$/.test(path) ? [path] : [];
  const nested = await Promise.all(entries.filter(entry => entry.name !== 'dist' && entry.name !== 'node_modules' && entry.name !== 'webview')
    .map(entry => sources(join(path, entry.name))));
  return nested.flat();
}

/** Return each launch call's full argument text, balancing parentheses. */
function launches(source, names) {
  const calls = [];
  const pattern = new RegExp(`(?<![.\\w])(?:${names.join('|')})\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    let depth = 0, end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push({ line: source.slice(0, match.index).split('\n').length, text: source.slice(match.index, end + 1) });
  }
  return calls;
}

test('background launches never open a console window on Windows', async () => {
  const missing = [];
  let checked = 0;
  for (const file of (await Promise.all(roots.map(root => sources(join(project, root))))).flat()) {
    const source = await readFile(file, 'utf8');
    if (!/from ['"](?:node:)?child_process['"]/.test(source)) continue;
    // Direct child_process functions plus local promisified aliases (const exec = promisify(execFile)).
    const aliases = [...source.matchAll(/const (\w+) = promisify\((?:execFile|exec)\)/g)].map(match => match[1]);
    for (const call of launches(source, ['spawn', 'spawnSync', 'execFile', 'execFileSync', ...aliases])) {
      checked++;
      if (!/windowsHide:\s*true/.test(call.text)) missing.push(`${relative(project, file)}:${call.line}`);
    }
  }
  assert.ok(checked >= 8, `expected to inspect the runtime launch sites, found ${checked}`);
  assert.deepEqual(missing, [], 'Set windowsHide: true so Git, providers and helpers stay in the background');
});
