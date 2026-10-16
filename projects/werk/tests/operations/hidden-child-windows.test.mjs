import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../..', import.meta.url));
// Runtime scripts launch their own supervisors and services; application code uses the shared launcher.
const scriptRoots = ['scripts/runtime', 'scripts/system', 'scripts/fleet.mjs', 'scripts/factory-fleet.mjs'];
const launcher = 'src/shared/process/launcher.ts';

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

const importsChildProcess = source => /from ['"](?:node:)?child_process['"]/.test(source);

test('application code starts processes only through the shared launcher', async () => {
  const direct = [];
  for (const file of await sources(join(project, 'src'))) {
    const path = relative(project, file).split('\\').join('/');
    if (path !== launcher && importsChildProcess(await readFile(file, 'utf8'))) direct.push(path);
  }
  assert.deepEqual(direct, [], 'Use launchProcess/runProcess from src/shared/process/launcher.ts');
  const source = await readFile(join(project, launcher), 'utf8');
  assert.equal(launches(source, ['spawn']).length, 1);
  assert.match(launches(source, ['spawn'])[0].text, /windowsHide: true/);
});

test('runtime script launches never open a console window on Windows', async () => {
  const missing = [];
  let checked = 0;
  for (const file of (await Promise.all(scriptRoots.map(root => sources(join(project, root))))).flat()) {
    const source = await readFile(file, 'utf8');
    if (!importsChildProcess(source)) continue;
    // Direct child_process functions plus local promisified aliases (const exec = promisify(execFile)).
    const aliases = [...source.matchAll(/const (\w+) = promisify\((?:execFile|exec)\)/g)].map(match => match[1]);
    for (const call of launches(source, ['spawn', 'spawnSync', 'execFile', 'execFileSync', ...aliases])) {
      checked++;
      if (!/windowsHide:\s*true/.test(call.text)) missing.push(`${relative(project, file)}:${call.line}`);
    }
  }
  assert.ok(checked >= 5, `expected to inspect the runtime launch sites, found ${checked}`);
  assert.deepEqual(missing, [], 'Set windowsHide: true so supervisors and services stay in the background');
});
