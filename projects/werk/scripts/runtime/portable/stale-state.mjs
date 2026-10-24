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
/**
 * Classifies state whose owner did not answer. `record` is portable.json, or the application lock when portable.json is absent.
 * 'stale' requires proof that the PID recorded on this host is dead, and lists only files naming that PID and host.
 */
export async function ownerStatus(kind, state, options, record, unreachable) {
  const { lockOwner, processOwnerState, ownerCheck, processHost } = await owner(kind);
  const recorded = await lockOwner(record), { pid, since } = recorded, locks = [];
  for (const name of LOCKS) if (join(state, name) !== record && await present(join(state, name))) locks.push(join(state, name));
  const files = [record, ...locks], same = value => value.pid === pid && value.host === processHost;
  // A PID recorded in a container or on another host (shared project state) proves nothing here.
  const owned = pid !== null && same(recorded) && (await Promise.all(locks.map(lockOwner))).every(same);
  if (owned && await processOwnerState(pid, since) === 'dead') {
    const feature = kind === 'worker' ? await featureLock(options) : null;
    if (feature && same(await lockOwner(feature))) files.push(feature);
    return { state: 'stale', kind, stateDirectory: state, pid, files, action: `The process that owned this state (PID ${pid}) is no longer running; start, stop and update remove these files automatically.` };
  }
  return { state: 'unreachable', kind, stateDirectory: state, ...(pid ? { pid } : {}), files, action: `${unreachable} Files: ${files.join(', ')}.${pid ? ' ' + ownerCheck(pid, recorded.host) : ''}` };
}
/** The host and PID namespace written into records, so only this host recovers them. */
export const recordHost = async kind => (await owner(kind)).processHost;
/** Removes exactly the files a 'stale' status listed, re-reading each right before removal so a new owner's file is kept. */
export async function recoverStale(stale) {
  const { lockOwner, processHost } = await owner(stale.kind), removed = [];
  for (const path of stale.files) {
    if (!await present(path)) continue;
    const current = await lockOwner(path);
    if (current.pid !== stale.pid || current.host !== processHost) throw inputError(`${path} changed during recovery. Inspect status before retrying.`);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    removed.push(path);
  }
  console.error(JSON.stringify({ event: 'stale_state_recovered', pid: stale.pid, removed, reason: `PID ${stale.pid} is no longer running.` }));
  return removed;
}
