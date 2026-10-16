import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { commands } from './commands.mjs';

/** npm aliases are generated from the same catalog used by the portable CLI. */
export function workerNpmScripts(project = false) {
  const entry = project ? 'node bin/apps/worker/cli.mjs' : 'node scripts/runtime/portable/npm-entry.mjs';
  const prefix = project ? 'worker:' : '';
  const names = new Set(['help', 'schema', 'init', 'run', 'start', 'status', 'stop', 'api', ...Object.keys(commands('worker'))]);
  return { worker: entry, ...Object.fromEntries([...names].map(command => [prefix + command.replaceAll(' ', ':'), `${entry} ${command}`])) };
}

/** Existing project manifests, including their formatting and scripts, belong to the operator. */
export async function seedWorkerPackage(project) {
  const path = join(project, 'package.json');
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return { path, created: false }; throw error; }
  try {
    await file.writeFile(JSON.stringify({ name: 'werk-project-worker', version: '0.0.0', private: true,
      description: 'Project-local Werk worker commands. Prebuilt runtime; no npm install required.',
      engines: { node: '>=24.0.0 <25' }, scripts: workerNpmScripts(true) }, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  return { path, created: true };
}
