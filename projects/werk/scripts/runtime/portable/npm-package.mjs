import { commands } from './commands.mjs';
import { updateCommands } from './update-commands.mjs';

/** npm aliases are generated from the same catalog used by the portable CLI. */
export function workerNpmScripts(project = false) {
  const entry = project ? 'node bin/apps/worker/cli.mjs' : 'node scripts/runtime/portable/npm-entry.mjs';
  const prefix = project ? 'worker:' : '';
  const names = new Set(['help', 'schema', ...(project ? ['init'] : []), 'env init', 'run', 'start', 'status', 'stop', 'api', 'footprint', 'uninstall', ...Object.keys(updateCommands), ...Object.keys(commands('worker'))]);
  return { worker: entry, ...Object.fromEntries([...names].map(command => [prefix + command.replaceAll(' ', ':'), `${entry} ${command}`])) };
}

/** Exact generated manifest, shared with uninstall ownership verification. */
export function workerProjectManifest() {
  return { name: 'werk-project-worker', version: '0.0.0', private: true,
    description: 'Project-local Werk worker commands. Prebuilt runtime; no npm install required.',
    engines: { node: '>=24.0.0 <25' }, scripts: workerNpmScripts(true) };
}
