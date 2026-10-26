import { constants } from 'node:fs';
import { digest } from '../update/remote.mjs';
import { lstat, open, readdir, realpath, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const rootFiles = ['worker.mjs', 'werk.mjs', 'werk-docker.sh', 'werk-docker.ps1', 'README.md', 'AGENTS.md', 'LICENSE', 'CHANGELOG.md', 'release-manifest.json'];
export const ownedName = name => ['runtime', 'docs', ...rootFiles].includes(name);
export async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function ordinary(path, create = false) {
  const existing = await lstat(path).catch(error => { if (create && error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw Error('Home update paths must be ordinary directories without symbolic links.');
  const parent = dirname(path);
  if (create && parent !== path) await ordinary(parent, true);
  // Drive and filesystem roots already exist. Never attempt mkdir on those existing ancestors.
  if (!existing && create && parent !== path) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Home update paths must be ordinary directories without symbolic links.');
  return path;
}
export async function readRegular(path, limit = 32 * 1024 * 1024) {
  const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink()) throw Error('Home update files must be ordinary files without symbolic links.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { const info = await handle.stat(); if (!info.isFile() || info.size > limit) throw Error('Home update metadata or payload is nonregular or exceeds its bound.'); return await handle.readFile(); }
  finally { await handle.close(); }
}
async function verifier() {
  for (const directory of ['../update/', '../../release/']) { const url = new URL(directory + 'verify.mjs', import.meta.url); if (await exists(fileURLToPath(url))) return import(url.href); }
  throw Error('The Home release verifier is missing.');
}
export async function releaseSnapshot(home) {
  const directory = await realpath(resolve(home)); await ordinary(directory);
  const { verifyRelease } = await verifier(), checked = await verifyRelease(directory);
  if (checked.layout !== 'werk-home-v1' || checked.updateProtocol !== 2) throw Error('Use an explicitly verified Werk Home release; legacy project installations require recovery/export, not replacement.');
  const bytes = await readRegular(join(directory, 'release-manifest.json')), manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.stateFormat !== 1 || typeof manifest.version !== 'string') throw Error('Unsupported Home state format or version.');
  return { directory, manifest, bytes: bytes.toString('utf8'), sha256: digest(bytes), version: manifest.version };
}
export async function unchanged(home, snapshot) { const current = await releaseSnapshot(home); if (current.sha256 !== snapshot.sha256) throw Error('The Home manifest changed after update preview. Inspect the current release before retrying.'); return current; }
export function partFiles(snapshot, name) {
  if (!ownedName(name)) throw Error('Home updates cannot claim projects, state or unrelated paths.');
  if (name === 'release-manifest.json') return [{ path: name, bytes: Buffer.byteLength(snapshot.bytes), sha256: snapshot.sha256 }];
  return snapshot.manifest.files.filter(file => file.path === name || file.path.startsWith(name + '/'));
}
export async function partMatches(directory, snapshot, name) {
  const files = partFiles(snapshot, name), expected = new Map(files.map(file => [file.path, file]));
  if (!files.length) return !(await exists(join(directory, name)));
  const seen = new Set();
  async function visit(path) {
    const info = await lstat(join(directory, path)); if (info.isSymbolicLink()) return false;
    if (info.isDirectory()) { for (const child of await readdir(join(directory, path))) if (!await visit(path + '/' + child)) return false; return true; }
    const file = expected.get(path); if (!info.isFile() || !file || info.size !== file.bytes) return false;
    const bytes = await readRegular(join(directory, path)); if (digest(bytes) !== file.sha256) return false; seen.add(path); return true;
  }
  try { return await visit(name) && seen.size === expected.size; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function live(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('A runtime ownership record is invalid. Inspect it before updating.'); try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; } }
async function stopped(home, { stateDirectory, inspectWorker, stopWorker, stop = false } = {}) {
  const leases = join(home, 'state/runtime-leases');
  if (await exists(leases)) {
    await ordinary(leases);
    if ((await readdir(leases)).length) throw Error('A foreground Home component retains a runtime lease. Stop its original launcher; after a crash inspect state/runtime-leases and all component ownership before explicitly removing abandoned leases.');
  }
  if (inspectWorker) {
    let state = await inspectWorker();
    if (state.state === 'running' && stop) { if (!stopWorker) throw Error('Authenticated worker shutdown is unavailable.'); await stopWorker(); state = await inspectWorker(); }
    if (state.state !== 'stopped') throw Error('Stop the Home worker explicitly (or use --stop) and reconcile any uncertain runtime before updating.');
  }
  const roots = new Set([join(home, 'state/worker'), join(home, 'state/system'), join(home, 'state/line'), join(home, 'state/factory'), join(home, 'state/orchestrator'), ...(stateDirectory ? [stateDirectory] : [])]);
  for (const directory of roots) {
    for (const name of ['worker.lock', 'runtime.lock', 'portable.json', 'supervisor.json']) {
      const path = join(directory, name); if (!await exists(path)) continue;
      const record = JSON.parse((await readRegular(path, 1024 * 1024)).toString('utf8'));
      if (live(record.pid)) throw Error('A Home runtime still owns this payload. Stop its worker/Factory/system before updating; stored PIDs are never killed.');
    }
  }
  const inside = relative(join(home, 'runtime'), await realpath(process.cwd()));
  if (!inside || !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)) throw Error('Run Home update from outside runtime/, for example from the Home root.');
}

/** Reserves the same exclusive ownership files used by raw runners after authenticated shutdown. */
export async function withStoppedRuntime(home, options, operation) {
  await stopped(home, options);
  const roots = new Set([join(home, 'state/worker'), join(home, 'state/system'), join(home, 'state/line'), join(home, 'state/factory'), join(home, 'state/orchestrator'), ...(options.stateDirectory ? [options.stateDirectory] : [])]);
  const held = []; let value, failure;
  try {
    for (const directory of roots) {
      await ordinary(directory, true);
      for (const name of ['worker.lock', 'runtime.lock']) {
        const path = join(directory, name), handle = await open(path, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw Error('A runtime acquired ownership during update admission. Inspect it before retrying.'); throw error; });
        held.push({ path, handle }); await handle.writeFile(JSON.stringify({ pid: process.pid, homeUpdate: true })); await handle.sync();
      }
    }
    value = await operation();
  } catch (error) { failure = error; }
  const cleanup = await Promise.allSettled(held.reverse().map(async ({ path, handle }) => { await handle.close(); const owner = JSON.parse((await readRegular(path, 4096)).toString('utf8')); if (owner.pid !== process.pid || owner.homeUpdate !== true) throw Error('Update runtime reservation changed; inspect retained ownership.'); await unlink(path); }));
  const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failure) failures.unshift(failure);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
  return value;
}
