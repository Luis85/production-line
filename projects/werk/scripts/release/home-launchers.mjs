// Root launchers contain no mutable configuration and retain caller-relative arguments.
export const homeWorkerLauncher = String.raw`#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const entry = new URL('./runtime/bin/apps/worker/scripts/runtime/portable/home.mjs', import.meta.url);
if (!existsSync(entry)) throw Error('Werk Home runtime is absent. Preserve projects/state and use a separately verified candidate launcher: node CandidateHome/worker.mjs update rollback --home ActiveHome after inspecting abandoned ownership.');
const { workerHome } = await import(entry.href);
await workerHome(process.argv.slice(2), { homeRoot: fileURLToPath(new URL('./', import.meta.url)) });
`;
export const homeWerkLauncher = String.raw`#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const home = fileURLToPath(new URL('.', import.meta.url)), args = process.argv.slice(2);
if (args[0] === 'update') throw Error('Use node worker.mjs update for the complete Werk Home payload.');
if (args[0] === 'worker') throw Error('Use node worker.mjs start/status/stop for the authoritative central Home worker. Raw project-local worker startup is retired; Factory/system internals retain their explicit runtime entrypoints.');
process.env.WERK_UPDATES = 'external';
const state = name => fileURLToPath(new URL('./state/' + name, import.meta.url));
process.env.WERK_STATE_DIR ||= state(args[0] === 'system' || args[0] === 'up' ? 'system' : 'line');
const { withHomeRuntimeLease } = await import('./runtime/scripts/runtime/home-update/guard.mjs');
async function dispatch() {
  if (['factory', 'orchestrator'].includes(args[0]) && args[1] === 'run') {
    // Preserve the component's existing explicit .env/project selection before supplying a Home fallback.
    const project = args.indexOf('--project-dir', 2), { loadEnvironment } = await import('./runtime/scripts/runtime/portable/environment.mjs');
    await loadEnvironment(args[0], resolve(project < 0 ? process.cwd() : args[project + 1] ?? process.cwd()));
    process.env['WERK_' + args[0].toUpperCase() + '_STATE_DIR'] ||= state(args[0]);
  }
  await import('./runtime/werk.mjs');
}
const launches = ['up', 'start', 'setup'].includes(args[0]) || args[0] === 'system' && ['up', 'start', 'setup'].includes(args[1]) || ['factory', 'orchestrator'].includes(args[0]) && args[1] === 'run';
if (launches) await withHomeRuntimeLease(home, dispatch, { untilExit: true });
else await dispatch();
`;
