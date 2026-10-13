import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPrivate, privateDirectory, readPrivate } from '../config.mjs';
import { verifyRelease } from '../../release/verify.mjs';
import { versionParts } from './remote.mjs';

export async function manifest(root) {
  const path = join(root, 'release-manifest.json'), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw Error('Invalid release manifest file.');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value.name !== 'werk' || value.schemaVersion !== 1) throw Error('Invalid Werk release manifest.');
  if (typeof value.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)) throw Error('Invalid release version.');
  return value;
}
export function storeFor(baseRoot, stateDir) {
  const home = resolve(stateDir) + '.updates';
  return { baseRoot: realpathSync(resolve(baseRoot)), stateDir: resolve(stateDir), home, path: join(home, 'selection.json'), releases: join(home, 'releases'), backups: join(home, 'backups') };
}
export async function selection(store) {
  let value;
  try { value = await readPrivate(store.path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schemaVersion: 1, baseRoot: store.baseRoot, automatic: true, active: null, previous: null, backup: null };
  }
  if (value.schemaVersion !== 1 || value.baseRoot !== store.baseRoot || typeof value.automatic !== 'boolean') throw Error('Update selection belongs to another installation or has invalid settings. Use its original werk.mjs launcher.');
  for (const entry of [value.active, value.previous]) if (entry !== null) versionParts(entry);
  if (value.backup !== null && (typeof value.backup !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(value.backup))) throw Error('Invalid update backup selection.');
  return value;
}
export async function save(store, value) {
  await privateDirectory(store.home);
  const temporary = store.path + '.' + randomUUID();
  await createPrivate(temporary, value);
  try { await rename(temporary, store.path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function lock(store, operation) {
  await privateDirectory(store.home);
  const path = join(store.home, 'operation.lock');
  try { await createPrivate(path, { pid: process.pid, operation }); }
  catch (error) { if (error.code === 'EEXIST') throw Error('This installation/state is already starting, running or updating. Use status/stop and retry after shutdown. After a crash, verify the owner exited before removing operation.lock.'); throw error; }
  return () => unlink(path);
}
export async function activeRoot(store, record) {
  record ??= await selection(store);
  if (record.active === null) return store.baseRoot;
  const root = join(store.releases, `werk-${record.active}`);
  const checked = await verifyRelease(root);
  if (checked.version !== record.active) throw Error('Selected release version does not match its verified payload.');
  return root;
}
export async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
