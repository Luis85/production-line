import { normalizeExecution } from './execution.mjs';
import { randomBytes } from 'node:crypto';
import { mkdir, open, lstat, readdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseRoot = fileURLToPath(new URL('../../', import.meta.url));
export const resolveStateDir = value => value === undefined ? join(releaseRoot, '.werk') : resolve(value);
export function inputError(message) { return Object.assign(new Error(message), { exitCode: 2 }); }
export function assertNode(version = process.versions.node) { if (Number(version.split('.')[0]) !== 24) throw inputError('Werk requires Node.js 24.x. Install Node 24, then retry.'); }
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw inputError('State must be a real private directory, not a symlink.');
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw inputError('State directory is accessible to other users. Restrict its permissions to 0700 before retrying.');
}
export async function readPrivate(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw inputError('Runtime file must be a regular file, not a symlink or special file.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536 || (process.platform !== 'win32' && (info.mode & 0o077))) throw inputError('Invalid or insufficiently private runtime file; restore its permissions and contents from a trusted backup.');
    const buffer = Buffer.alloc(65537); let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      offset += bytesRead;
      if (offset > 65536) throw inputError('Runtime file exceeds its 64 KiB limit.');
      if (!bytesRead) break;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))); }
    catch { throw inputError('Runtime file contains invalid JSON or UTF-8. Restore valid private configuration from backup.'); }
  } finally { await handle.close(); }
}
export async function createPrivate(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw inputError(`Invalid ${label}; use the documented schema.`);
}
export function validateConfig(value) {
  fields(value, ['schemaVersion', 'project', 'orchestratorPort', 'workerPort', 'workers', 'mode', 'runtime', 'execution'], 'runtime configuration');
  const execution = normalizeExecution(value.execution);
  if (execution && (value.runtime !== 'native' || value.workers !== 1)) throw inputError('Live execution requires native Linux and exactly one worker per line.');
  if (!['native', 'docker'].includes(value.runtime) || value.schemaVersion !== 1 || value.mode !== (execution ? 'cli' : 'mock') || typeof value.project !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.project)) throw inputError('Configuration requires schemaVersion 1, matching execution mode and a valid project identifier.');
  for (const field of ['orchestratorPort', 'workerPort']) if (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 65535) throw inputError(`${field} must be an integer from 1 to 65535.`);
  if (!Number.isInteger(value.workers) || value.workers < 1 || value.workers > 8 || value.workerPort + value.workers - 1 > 65535) throw inputError('workers must be 1–8 and its status port range must fit below 65536.');
  if (value.orchestratorPort >= value.workerPort && value.orchestratorPort < value.workerPort + value.workers) throw inputError('Orchestrator and worker ports must not overlap.');
  return { schemaVersion: 1, project: value.project, orchestratorPort: value.orchestratorPort, workerPort: value.workerPort, workers: value.workers, mode: execution ? 'cli' : 'mock', runtime: value.runtime, ...(execution ? { execution } : {}) };
}
export function validateCredentials(value) {
  const keys = ['WERK_ADMIN_TOKEN', 'WERK_ENROLLMENT_TOKEN']; fields(value, keys, 'credentials');
  if (keys.some(key => typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) || value[keys[0]] === value[keys[1]]) throw inputError('Invalid credentials. Restore credentials.json from backup; do not replace credentials of an existing runtime.');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
export async function loadConfig(stateDir) {
  const info = await lstat(stateDir).catch(error => { if (error.code === 'ENOENT') throw inputError('Runtime is not configured. Run node werk.mjs setup first.'); throw error; });
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw inputError('Runtime state directory must be private and must not be a symlink.');
  try { return validateConfig(await readPrivate(join(stateDir, 'config.json'))); }
  catch (error) { if (error.code === 'ENOENT') throw inputError('Setup files are incomplete. Run setup for a new runtime, or restore missing files from backup for existing state.'); throw error; }
}
/** Service startup needs application secrets; authenticated maintenance uses loadConfig only. */
export async function loadSetup(stateDir) {
  const config = await loadConfig(stateDir);
  try { return { config, credentials: validateCredentials(await readPrivate(join(stateDir, 'credentials.json'))) }; }
  catch (error) { if (error.code === 'ENOENT') throw inputError('Credentials are missing. Restore credentials.json from backup before starting the runtime.'); throw error; }
}
export async function setup({ stateDir = resolveStateDir(), project, port, workerPort, workers, runtime = 'native', execution: rawExecution } = {}) {
  const execution = normalizeExecution(rawExecution);
  await privateDirectory(stateDir);
  const lock = join(stateDir, 'setup.lock');
  try { await createPrivate(lock, { pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('Another setup holds setup.lock. If setup crashed, verify it has exited before removing that lock.'); throw error; }
  try {
    let config;
    try { config = validateConfig(await readPrivate(join(stateDir, 'config.json'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const requested = { project, orchestratorPort: port, workerPort, workers, runtime, execution };
    if (config) {
      if (Object.entries(requested).some(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(config[key]))) throw inputError('Setup already exists with different settings. Existing configuration and credentials were preserved. Stop the runtime before deliberately editing config.json.');
      await loadSetup(stateDir); return { configured: true, created: false, config, stateDir };
    }
    config = validateConfig({ schemaVersion: 1, project: project ?? 'demo', orchestratorPort: port ?? 3000, workerPort: workerPort ?? 4100, workers: workers ?? 1, mode: execution ? 'cli' : 'mock', runtime, ...(execution ? { execution } : {}) });
    // Only a partial first setup may be completed. Any other state requires restoration,
    // including SQLite sidecars, lifecycle records and Windows Docker-volume markers.
    const entries = await readdir(stateDir);
    if (entries.some(name => !['credentials.json', 'setup.lock'].includes(name)))
      throw inputError('State exists without configuration. Restore setup files from backup, or use the Docker launcher for docker-volume.json state.');
    let credentials;
    try { credentials = validateCredentials(await readPrivate(join(stateDir, 'credentials.json'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!credentials) await createPrivate(join(stateDir, 'credentials.json'), { WERK_ADMIN_TOKEN: randomBytes(32).toString('hex'), WERK_ENROLLMENT_TOKEN: randomBytes(32).toString('hex') });
    await createPrivate(join(stateDir, 'config.json'), config);
    return { configured: true, created: true, config, stateDir };
  } finally { await unlink(lock); }
}
