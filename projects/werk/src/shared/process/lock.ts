import { open, unlink } from 'node:fs/promises';
import { lockOwner, ownerCheck, processHost, processOwnerState, type OwnerCheck } from './owner.js';

/** Removes a lock this host's provably dead owner wrote, re-reading it first so a lock a new owner wrote meanwhile is kept. */
async function reclaimDeadLock(path: string, check: OwnerCheck) {
  const owner = await lockOwner(path);
  if (owner.pid === null || owner.host !== processHost || await check(owner.pid, owner.since) !== 'dead') return { reclaimed: false, owner };
  const current = await lockOwner(path);
  if (current.pid !== owner.pid || current.host !== owner.host || current.since !== owner.since) return { reclaimed: false, owner: current };
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { reclaimed: true, owner };
}
/**
 * Creates a lock exclusively. A lock naming this host and a provably dead PID is removed and the create retried once;
 * otherwise `locked` is extended with the lock path, its recorded PID and a concrete check.
 */
export async function createLock(path: string, locked: string, check: OwnerCheck = processOwnerState) {
  for (let retry = true; ; retry = false) {
    try { return await open(path, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw Error(locked); }
    const { reclaimed, owner } = retry ? await reclaimDeadLock(path, check) : { reclaimed: false, owner: await lockOwner(path) };
    if (!reclaimed) throw Error(`${locked} Lock: ${path}; recorded PID: ${owner.pid ?? 'none'}.${owner.pid ? ' ' + ownerCheck(owner.pid, owner.host) : ''}`);
  }
}
