import { lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inputError, readPrivate } from '../config.mjs';
import { configuredProjectRoot } from './project.mjs';

const owner = kind => import(new URL(`../../../src/${kind}/dist/shared/process/owner.js`, import.meta.url));
const present = path => lstat(path).then(() => true, error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; });
const LOCKS = ['worker.lock', 'runtime.lock'];

/** The project worker's feature folder lock; status stays available when the project configuration is unreadable. */
async function featureLock(options) {
  try {
    const project = await configuredProjectRoot(options), directory = project && (await readPrivate(join(project, '.werk/worker.json'))).features?.directory;
    return typeof directory === 'string' && directory.trim() ? join(resolve(project, directory), '_worker.lock') : null;
  } catch { return null; }
}
/** Whether the file's own record names a process of this host that is provably dead. */
async function deadOwner(module, path) {
  const value = await module.lockOwner(path);
  return value.pid !== null && value.host === module.processHost && await module.processOwnerState(value.pid, value.start) === 'dead';
}
/**
 * Classifies state whose owner did not answer. `record` is portable.json, or the application lock when portable.json is absent.
 * 'stale' requires every listed file to name a process recorded on this host that is provably dead.
 */
export async function ownerStatus(kind, state, options, record, unreachable) {
  const module = await owner(kind), recorded = await module.lockOwner(record), { pid } = recorded, locks = [];
  for (const name of LOCKS) if (join(state, name) !== record && await present(join(state, name))) locks.push(join(state, name));
  const files = [record, ...locks];
  // A PID recorded in a container or on another host (shared project state) proves nothing here.
  if (await deadOwner(module, record) && (await Promise.all(locks.map(path => deadOwner(module, path)))).every(Boolean)) {
    const feature = kind === 'worker' ? await featureLock(options) : null;
    if (feature && await present(feature) && await deadOwner(module, feature)) files.push(feature);
    return { state: 'stale', kind, stateDirectory: state, pid, files, action: `The process that owned this state (PID ${pid}) is no longer running; start, stop and update remove these files automatically.` };
  }
  return { state: 'unreachable', kind, stateDirectory: state, ...(pid ? { pid } : {}), files, action: `${unreachable} Files: ${files.join(', ')}.${pid ? ' ' + module.ownerCheck(pid, recorded.host) : ''}` };
}
/** The PID, host and start identity written into records, so only this host recovers them once their owner is gone. */
export const recordOwner = async kind => (await owner(kind)).ownerRecord;
/** Removes exactly the files a 'stale' status listed, re-checking each file's own owner right before removal. */
export async function recoverStale(stale) {
  const module = await owner(stale.kind), removed = [];
  for (const path of stale.files) {
    if (!await present(path)) continue;
    if (!await deadOwner(module, path)) throw inputError(`${path} changed during recovery. Inspect status before retrying.`);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    removed.push(path);
  }
  if (removed.length) console.error(JSON.stringify({ event: 'stale_state_recovered', pid: stale.pid, removed, reason: `PID ${stale.pid} is no longer running.` }));
  return removed;
}
