import { statfs, unlink } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { inputError, loadConfig, createPrivate } from '../config.mjs';
import { runtimeStatus } from '../control.mjs';
import { freePort } from '../health.mjs';
import { canonicalDirectory, exists, privateDir, safeAncestors, snapshotState, restoreSnapshot, verifyBackup } from './snapshot.mjs';

// Native runtime topology and owner leases; snapshot.mjs holds the copy/verify core.
export { verifyBackup };
export async function stateTopology(stateDir) {
  stateDir = await canonicalDirectory(stateDir); await safeAncestors(stateDir);
  if (await exists(join(stateDir, 'docker-volume.json'))) throw inputError('Docker volume pointers are not complete state. Stop and back up the owned volume and matching pointer using the Docker backup procedure.');
  let roots, ports, workers;
  if (await exists(join(stateDir, 'system.json'))) {
    const { loadSystem } = await import('../../system/state.mjs');
    const definition = await loadSystem(stateDir);
    if (definition.environment !== 'native') throw inputError('Automated maintenance supports native state. Use the stopped Docker volume/bind backup procedure for Docker.');
    roots = [stateDir, ...definition.productionLines.map(line => join(stateDir, 'lines', line.id))];
    ports = [definition.factory.port]; workers = [];
    for (const root of roots.slice(1)) {
      await privateDir(root); await safeAncestors(root); const config = await loadConfig(root);
      if (config.runtime !== 'native') throw inputError('Every line must use native state for maintenance.');
      ports.push(config.orchestratorPort, ...Array.from({ length: config.workers }, (_, index) => config.workerPort + index));
      workers.push(...Array.from({ length: config.workers }, (_, index) => join(root, 'workers', `worker-${index + 1}`)));
    }
  } else {
    const config = await loadConfig(stateDir);
    if (config.runtime !== 'native') throw inputError('Automated maintenance supports native state. Use the stopped Docker backup procedure for Docker.');
    roots = [stateDir]; ports = [config.orchestratorPort, ...Array.from({ length: config.workers }, (_, index) => config.workerPort + index)];
    workers = Array.from({ length: config.workers }, (_, index) => join(stateDir, 'workers', `worker-${index + 1}`));
  }
  return { roots, ports, workers };
}
async function stoppedLease(stateDir) {
  const topology = await stateTopology(stateDir), held = [];
  try {
    for (const root of topology.roots) {
      if ((await runtimeStatus(root)).state !== 'stopped') throw inputError('State is running or its owner cannot be verified. Stop with the owning launcher; diagnose unreachable ownership before backup.');
      for (const name of ['runtime.lock', 'setup.lock']) { const path = join(root, name); await createPrivate(path, { maintenance: 'backup', pid: process.pid }); held.push(path); }
    }
    for (const worker of topology.workers) if (await exists(worker)) {
      await privateDir(worker); await safeAncestors(worker); const path = join(worker, 'worker.lock'); await createPrivate(path, { maintenance: 'backup', pid: process.pid }); held.push(path);
    }
    for (const port of topology.ports) await freePort(port);
    return { held, release: async () => { for (const path of held.reverse()) await unlink(path); } };
  } catch (error) {
    for (const path of held.reverse()) await unlink(path).catch(() => {});
    if (error.code === 'EEXIST') throw inputError('A setup/runtime/worker owner holds a lock. No lock was removed. Stop its verified owner or follow the crash-recovery procedure.');
    throw error;
  }
}
export async function backupState(stateDir, destination) {
  return snapshotState(stateDir, destination, stoppedLease);
}
export async function restoreState(directory, destination) {
  const result = await restoreSnapshot(directory, destination, stateTopology);
  return { ...result, next: 'Keep the original stopped. Start this restored state with its matching release, then run doctor and verify task history and worker identities.' };
}
export async function diskCheck(stateDir, filesystem = statfs) {
  const info = await filesystem(stateDir, { bigint: true }), availableBytes = info.bavail * info.bsize, capacityBytes = info.blocks * info.bsize;
  const low = availableBytes < 256n * 1024n * 1024n || (capacityBytes > 0n && availableBytes * 100n < capacityBytes * 5n);
  return { name: 'disk-space', ok: !low, availableBytes: Number(availableBytes), ...(low ? { message: 'Free less than 256 MiB or 5%. Expand storage or remove verified expendable release/log artifacts. Do not delete databases, WAL files, worker identities or pending evidence.' } : {}) };
}
export async function diagnose(stateDir) {
  stateDir = resolve(stateDir);
  const checks = []; let topology;
  try { topology = await stateTopology(stateDir); checks.push({ name: 'state-layout', ok: true }); } catch (error) { checks.push({ name: 'state-layout', ok: false, message: error.message }); }
  try { checks.push(await diskCheck(stateDir)); } catch { checks.push({ name: 'disk-space', ok: false, message: 'Cannot inspect storage. Check mount availability and ownership before starting.' }); }
  for (const root of topology?.roots ?? []) {
    let status;
    try { status = await runtimeStatus(root); } catch { status = { state: 'unreachable' }; }
    checks.push({ name: root === resolve(stateDir) ? 'owner' : `owner:${relative(stateDir, root)}`, ok: status.state !== 'unreachable', state: status.state,
      ...(status.state === 'unreachable' ? { message: 'Ownership cannot be authenticated. Retry status; check your service manager and all worker processes. Never kill stored PIDs. After independently proving all writers stopped, preserve a private copy and remove only the stale ownership records named in the recovery guide.' } : {}) });
    for (const name of ['setup.lock']) if (await exists(join(root, name))) checks.push({ name: `lock:${relative(stateDir, join(root, name))}`, ok: false, message: 'Setup may still own this lock. Wait for setup or verify its process exited before manual recovery; no lock was deleted.' });
  }
  for (const worker of topology?.workers ?? []) if (await exists(join(worker, 'worker.lock'))) {
    const root = dirname(dirname(worker)); let stopped = false;
    try { stopped = (await runtimeStatus(root)).state === 'stopped'; } catch {}
    if (stopped) checks.push({ name: `lock:${relative(stateDir, join(worker, 'worker.lock'))}`, ok: false, message: 'Worker ownership remains while its launcher is stopped. Verify the worker process exited before manual lock recovery. Preserve identity and pending evidence.' });
  }
  return { ok: checks.every(check => check.ok), checks, next: 'Use doctor for authenticated worker connectivity. Stop through the owning launcher before maintenance backup. See docs/how-to/upgrade-backup.md for crash recovery.' };
}
