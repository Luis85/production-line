import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
import { inputError, readPrivate } from '../config.mjs';

const exists = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
/** Normalizes --workflow-dir to a contained, project-relative POSIX path; the workflow layer validates its characters. */
export function workflowDirectoryOption(project, value) {
  if (value === undefined) return undefined;
  const inside = relative(project, resolve(project, String(value)));
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || inside.split(sep).some(part => ['.werk', '.git', 'bin', 'node_modules'].includes(part))) throw inputError('--workflow-dir must name a subfolder inside the project, outside .werk, .git, bin and node_modules. Choose a folder such as Workflows/feature-requests.');
  return inside.split(sep).join('/');
}
export async function configuredProjectRoot(options) {
  const project = await realpath(resolve(options['project-dir'] ?? process.cwd()));
  const directory = await exists(join(project, '.werk'));
  if (!directory) return undefined;
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw inputError('Project metadata must be a regular directory.');
  const marker = await readPrivate(join(project, '.werk/worker-project.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!marker) return undefined;
  if (marker.schemaVersion !== 1 || !Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535) throw inputError('Invalid project worker marker.');
  return project;
}
export async function projectDefaults(options, launching = false) {
  const project = resolve(options['project-dir'] ?? process.cwd());
  const path = join(project, '.werk/worker-project.json');
  const marker = await readPrivate(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!marker) return options;
  if (launching && await exists(join(project, '.werk/feature-folder-change.json'))) throw inputError('Feature folder change is incomplete. Run feature folder get, then repeat feature folder set with the pending destination before starting.');
  if (marker.schemaVersion !== 1 || !Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535) throw inputError('Invalid project worker marker.');
  return { config: join(project, '.werk/worker.json'), 'state-dir': join(project, '.werk/worker'), port: String(marker.port), ...options };
}
