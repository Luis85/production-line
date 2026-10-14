import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { privateDirectory } from '../config.mjs';
import { runtimeStatus } from '../control.mjs';
import { backupState, restoreState, diskCheck, stateTopology } from '../maintenance/backup.mjs';
import { install } from '../../release/install.mjs';
import { latest, newer } from './remote.mjs';
import { selection, save, activeRoot, manifest, exists, storeFor } from './store.mjs';

const execute = promisify(execFile);
export async function check(store, options = {}) {
  const record = await selection(store), root = await activeRoot(store, record), current = await manifest(root), release = await latest(options);
  return { ok: true, current: current.version, latest: release.version, available: newer(release.version, current.version), automatic: record.automatic, release };
}
export async function stopped(store) {
  if ((await runtimeStatus(store.stateDir)).state !== 'stopped') throw Error('Stop the system before updating. No running release or state was changed.');
  if (await exists(store.stateDir)) {
    const topology = await stateTopology(store.stateDir);
    for (const root of topology.roots) if ((await runtimeStatus(root)).state !== 'stopped') throw Error('Every production line must be stopped before updating.');
  }
}
export async function apply(store, invocation, { fetcher = fetch, log = () => {}, discover = latest } = {}) {
  await stopped(store);
  const record = await selection(store), previousRoot = await activeRoot(store, record), current = await manifest(previousRoot);
  const release = await discover({ fetcher });
  if (!newer(release.version, current.version)) return { ok: true, updated: false, version: current.version };
  await privateDirectory(store.home);
  if (!(await diskCheck(store.home)).ok) throw Error('Insufficient free storage for an update and state backup.');
  await privateDirectory(store.releases);
  let candidate = join(store.releases, `werk-${release.version}`);
  if (!await exists(candidate)) candidate = await install(release, { directory: store.releases }, { fetcher, log });
  // Always verify cached releases too; a failed prior activation may have retained one.
  const { verifyRelease } = await import('../../release/verify.mjs');
  const verified = await verifyRelease(candidate), metadata = await manifest(candidate);
  if (verified.version !== release.version || metadata.updateProtocol !== 1 || metadata.stateFormat !== 1) throw Error('This release is not compatible with automatic update protocol/state format 1. Follow its manual upgrade instructions.');
  let backup = null;
  if (await exists(store.stateDir)) {
    await privateDirectory(store.backups);
    backup = `${current.version}-${randomUUID()}`;
    await backupState(store.stateDir, join(store.backups, backup));
    const args = invocation.kind === 'system' ? ['system', 'doctor'] : ['doctor'];
    // Run the candidate CLI directly: an update preflight must not perform another update.
    const module = invocation.kind === 'system' ? 'system/cli.mjs' : 'runtime/cli.mjs';
    const code = 'const {main}=await import(process.argv[1]); process.exitCode=await main(process.argv.slice(2));';
    const { pathToFileURL } = await import('node:url');
    await execute(process.execPath, ['--input-type=module', '-e', code, pathToFileURL(join(candidate, 'scripts', module)).href, ...args.filter(x => x !== 'system'), '--state-dir', store.stateDir, '--json'], { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true });
  }
  await stopped(store);
  await save(store, { ...record, active: release.version, previous: record.active ?? current.version, backup });
  return { ok: true, updated: true, version: release.version, previous: current.version, backup: backup ? join(store.backups, backup) : null };
}
export async function recover(store, destination) {
  await stopped(store);
  const record = await selection(store);
  if (!record.backup || !record.previous) throw Error('No previous update snapshot is available.');
  destination = resolve(destination);
  const restored = storeFor(store.baseRoot, destination);
  if (await exists(restored.home)) throw Error('Recovery update directory already exists; choose a fresh state destination.');
  const base = await manifest(store.baseRoot);
  const previous = record.previous === base.version ? store.baseRoot : join(store.releases, `werk-${record.previous}`);
  if (previous !== store.baseRoot) {
    const { verifyRelease } = await import('../../release/verify.mjs');
    if ((await verifyRelease(previous)).version !== record.previous) throw Error('Previous release verification failed.');
  }
  await restoreState(join(store.backups, record.backup), destination);
  const recoveryStore = storeFor(previous, destination);
  await save(recoveryStore, { ...await selection(recoveryStore), automatic: false });
  // A fresh restoration is independent. Return the matching immutable release, not
  // a destructive replacement of state that may contain tasks created after update.
  return { ok: true, restored: true, stateDir: destination, releaseRoot: previous, version: record.previous, automatic: false,
    next: 'Start this matching release with --state-dir pointing to the restored directory and --no-update. Keep the original stopped. The original state and update snapshot were preserved.' };
}
