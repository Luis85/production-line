import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latest } from './update/remote.mjs';
import { apply, preview, previewView, rollback, updatePaths, homeUpdateStatus } from './home-update/transaction.mjs';
import { exists } from './home-update/ownership.mjs';
function parse(argv) {
  const [action = 'status', ...args] = argv;
  if (!['check', 'plan', 'apply', 'status', 'rollback'].includes(action)) throw Error('Home update: check|plan|apply|status|rollback.');
  const options = {}, seen = new Set();
  while (args.length) {
    const flag = args.shift(); if (seen.has(flag)) throw Error('Home update options must occur once.'); seen.add(flag);
    if (flag === '--stop' && ['apply', 'rollback'].includes(action)) { options.stop = true; continue; }
    if (!['--from', '--if-match'].includes(flag) || !['plan', 'apply'].includes(action)) throw Error('Unknown Home update option.');
    const value = args.shift(); if (!value || value.startsWith('--')) throw Error('Home update option needs a value.');
    options[flag === '--from' ? 'from' : 'ifMatch'] = value;
  }
  if (action === 'plan' && !options.from) throw Error('update plan requires --from <verified candidate Home>.');
  return { action, options };
}
/** Selective Home upgrade: release-owned paths only; projects and runtime journals are never replaced. */
export async function homeUpdate(homeRoot, argv, ports = {}) {
  const { action, options } = parse(argv), home = resolve(homeRoot);
  if (action === 'status') { const value = await homeUpdateStatus(home); const { before, after, ...result } = value; return result; }
  if (action === 'check') return { home, available: await latest() };
  if (action === 'rollback') { const value = await rollback(home, { ...ports, ...options }); const { before, after, ...result } = value; return result; }
  let candidate = options.from && resolve(options.from);
  if (!candidate) {
    const release = await latest(), paths = await updatePaths(home), directory = await mkdtemp(join(paths.updates, 'candidate-'));
    let installer;
    for (const directory of ['./update/', '../release/']) { const url = new URL(directory + 'install.mjs', import.meta.url); if (await exists(fileURLToPath(url))) { installer = await import(url.href); break; } }
    if (!installer) throw Error('The pinned Home installer is missing.');
    candidate = await installer.install({ ...release, layout: 'werk-home-v1' }, { directory, start: false });
  }
  if (action === 'plan') return previewView(await preview(home, candidate));
  const value = await apply(home, candidate, { ...ports, ...options }); const { before, after, ...result } = value; return result;
}
