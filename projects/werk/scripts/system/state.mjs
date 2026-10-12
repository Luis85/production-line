import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { releaseRoot, privateDirectory, readPrivate, createPrivate, inputError, setup, loadSetup } from '../runtime/config.mjs';
import { validateDefinition } from './definition.mjs';

export const resolveSystemStateDir = (definition, path) => path === undefined ? join(releaseRoot, '.werk-system', definition.id) : resolve(path);
export const tokenEnv = index => `WERK_LINE_SYSTEM_${index + 1}_TOKEN`;
async function existingDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw inputError('System state must be a private real directory.');
}
export async function loadSystem(stateDir) {
  await existingDirectory(stateDir);
  const saved = await readPrivate(join(stateDir, 'system.json'));
  if (!saved || saved.schemaVersion !== 1 || Object.keys(saved).some(key => !['schemaVersion', 'definition'].includes(key))) throw inputError('Invalid saved system configuration. Restore system.json from backup.');
  return validateDefinition(saved.definition);
}
export function sameDefinition(saved, requested) {
  if (JSON.stringify(saved) !== JSON.stringify(requested)) throw inputError('System definition differs from saved configuration. Existing state was preserved; use a new state directory or restore the original definition. Status and stop accept --state-dir without --file.');
}
export async function setupSystem(value, { stateDir } = {}) {
  const definition = validateDefinition(value); stateDir = resolveSystemStateDir(definition, stateDir);
  await privateDirectory(stateDir);
  const lock = join(stateDir, 'setup.lock');
  try { await createPrivate(lock, { pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('System setup is already locked. Verify its owner exited before recovering a stale setup.lock.'); throw error; }
  let created = false;
  try {
    let existing;
    try { existing = await loadSystem(stateDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) sameDefinition(existing, definition);
    else {
      if ((await readdir(stateDir)).some(name => name !== 'setup.lock')) throw inputError('System state exists without system.json. Restore configuration from backup; credentials were not replaced.');
      await createPrivate(join(stateDir, 'system.json'), { schemaVersion: 1, definition }); created = true;
    }
    const factoryDir = join(stateDir, 'factory'); await privateDirectory(factoryDir);
    try { await readFactoryCredentials(stateDir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await readdir(factoryDir)).length) throw inputError('Factory state exists without credentials. Restore factory/credentials.json from backup.');
      await createPrivate(join(factoryDir, 'credentials.json'), { WERK_FACTORY_ADMIN_TOKEN: randomBytes(32).toString('hex') });
    }
    await privateDirectory(join(stateDir, 'lines'));
    for (const line of definition.productionLines) await setup({ stateDir: join(stateDir, 'lines', line.id), project: line.project,
      port: line.orchestrator.port, workerPort: line.workers.statusPort, workers: line.workers.count, runtime: definition.environment, execution: line.workers.execution });
    return { configured: true, created, stateDir, definition };
  } finally { await unlink(lock); }
}
export async function readFactoryCredentials(stateDir) {
  await existingDirectory(join(stateDir, 'factory'));
  const value = await readPrivate(join(stateDir, 'factory', 'credentials.json'));
  if (!value || Object.keys(value).length !== 1 || typeof value.WERK_FACTORY_ADMIN_TOKEN !== 'string' || !/^[a-f0-9]{64}$/.test(value.WERK_FACTORY_ADMIN_TOKEN)) throw inputError('Invalid Factory credentials. Restore factory/credentials.json from backup.');
  return value;
}
export async function factoryCredentials(stateDir, definition) {
  const { WERK_FACTORY_ADMIN_TOKEN: adminToken } = await readFactoryCredentials(stateDir), credentials = {};
  await existingDirectory(join(stateDir, 'lines'));
  for (const [index, line] of definition.productionLines.entries()) {
    const loaded = await loadSetup(join(stateDir, 'lines', line.id));
    const expected = { project: line.project, orchestratorPort: line.orchestrator.port, workerPort: line.workers.statusPort, workers: line.workers.count, runtime: definition.environment, execution: line.workers.execution };
    if (Object.entries(expected).some(([key, value]) => JSON.stringify(loaded.config[key]) !== JSON.stringify(value))) throw inputError('A line configuration differs from the saved system. Restore the original line configuration.');
    credentials[tokenEnv(index)] = loaded.credentials.WERK_ADMIN_TOKEN;
  }
  if (new Set([adminToken, ...Object.values(credentials)]).size !== definition.productionLines.length + 1) throw inputError('Factory and every line must have distinct credentials. Restore the original credentials.');
  return { adminToken, credentials };
}
