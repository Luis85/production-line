import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm, unlink, statfs, realpath } from 'node:fs/promises';
import { join, resolve, relative, sep, dirname, basename } from 'node:path';
import { inputError, loadConfig, createPrivate } from '../config.mjs';
import { runtimeStatus } from '../control.mjs';
import { freePort } from '../health.mjs';

const MAX_FILES = 10000, MAX_BYTES = 8 * 1024 ** 3, MAX_FILE = 2 * 1024 ** 3;
const hash = value => createHash('sha256').update(value).digest('hex');
const isInside = (parent, child) => child === parent || child.startsWith(parent + sep);
async function privateDir(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw inputError('Maintenance requires a real private directory (0700), without symlinks.');
}
async function canonicalDirectory(path) { await privateDir(resolve(path)); return realpath(resolve(path)); }
async function newDestination(path) { const full = resolve(path); return join(await realpath(dirname(full)), basename(full)); }
async function safeAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw inputError('Maintenance paths must not contain symlink directories.');
    if (current === dirname(current)) break;
  }
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
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
async function inventory(root, excluded = new Set()) {
  const files = []; let totalBytes = 0, entries = 0;
  async function visit(path, depth) {
    if (depth > 32) throw inputError('Backup tree exceeds 32 directory levels.');
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name); if (excluded.has(full)) continue;
      if (++entries > 20000) throw inputError('Backup exceeds 20,000 total filesystem entries.');
      if (!/^[^\\\x00-\x1f\x7f]+$/.test(name)) throw inputError('Backup tree contains an unsupported filename.');
      const info = await lstat(full);
      if (info.isFile() && info.nlink > 1) throw inputError('Backup refuses hard-linked files.');
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw inputError('Backup refuses symlinks and special files.');
      if (info.isDirectory()) { await visit(full, depth + 1); continue; }
      if (name.endsWith('.lock') || name === 'supervisor.json') throw inputError('Backup found an unresolved ownership record. Verify all owners have stopped before recovery.');
      totalBytes += info.size;
      if (info.size > MAX_FILE || totalBytes > MAX_BYTES || files.length >= MAX_FILES) throw inputError('Backup exceeds limits: 10,000 files, 2 GiB per file, 8 GiB total.');
      files.push({ path: relative(root, full).split(sep).join('/'), bytes: info.size });
    }
  }
  await visit(root, 0); return { files, totalBytes };
}
async function transfer(source, target, expectedBytes) {
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let output; const digest = createHash('sha256'); let bytes = 0;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink > 1 || before.size !== expectedBytes) throw inputError('Backup source changed while reading.');
    if (target) { await mkdir(dirname(target), { recursive: true, mode: 0o700 }); output = await open(target, 'wx', 0o600); }
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const result = await input.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
      bytes += result.bytesRead; if (bytes > expectedBytes) throw inputError('Backup source grew while reading.');
      const chunk = buffer.subarray(0, result.bytesRead); digest.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    const after = await input.stat();
    if (bytes !== expectedBytes || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw inputError('Backup source changed while reading.');
    await output?.sync(); return digest.digest('hex');
  } finally { await input.close(); await output?.close(); }
}
export async function backupState(stateDir, destination) {
  stateDir = await canonicalDirectory(stateDir); destination = await newDestination(destination);
  if (isInside(stateDir, destination) || isInside(destination, stateDir)) throw inputError('Backup must be separate from source state.');
  await safeAncestors(dirname(destination));
  const lease = await stoppedLease(stateDir); let created = false;
  try {
    const found = await inventory(stateDir, new Set(lease.held));
    await mkdir(destination, { mode: 0o700 }); created = true;
    await mkdir(join(destination, 'state'), { mode: 0o700 });
    for (const file of found.files) file.sha256 = await transfer(join(stateDir, file.path), join(destination, 'state', file.path), file.bytes);
    const final = await inventory(stateDir, new Set(lease.held));
    if (JSON.stringify(final.files) !== JSON.stringify(found.files.map(({ path, bytes }) => ({ path, bytes })))) throw inputError('State tree changed during backup.');
    const manifest = { schemaVersion: 1, kind: 'werk-stopped-state', createdAt: new Date().toISOString(), files: found.files };
    await createPrivate(join(destination, 'manifest.json'), manifest);
    // Verification reopens every file; checksum integrity does not authenticate an untrusted backup.
    const verified = await verifyBackup(destination);
    return { ok: true, backup: destination, files: verified.files, bytes: verified.bytes, manifestSha256: verified.manifestSha256 };
  } catch (error) { if (created) await rm(destination, { recursive: true, force: true }); throw error; }
  finally { await lease.release(); }
}
async function manifestAt(directory) {
  await safeAncestors(directory); await privateDir(directory); await privateDir(join(directory, 'state'));
  const path = join(directory, 'manifest.json'); const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) throw inputError('Backup manifest must be private, regular and at most 4 MiB.');
  let manifest;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let content;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink > 1 || current.size > 4 * 1024 * 1024) throw inputError('Invalid backup manifest.');
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1); let offset = 0;
    for (;;) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); offset += bytesRead; if (offset > 4 * 1024 * 1024) throw inputError('Backup manifest exceeds 4 MiB.'); if (!bytesRead) break; }
    content = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  try { manifest = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(content)); } catch { throw inputError('Backup manifest is invalid.'); }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'werk-stopped-state' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw inputError('Backup manifest has an unsupported schema.');
  const seen = new Set(); let bytes = 0;
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.length > 4096 || file.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f\x7f]/.test(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE || !/^[0-9a-f]{64}$/.test(file.sha256)) throw inputError('Backup manifest contains an unsafe or duplicate entry.');
    seen.add(file.path); bytes += file.bytes;
  }
  if (bytes > MAX_BYTES) throw inputError('Backup exceeds 8 GiB.');
  return { manifest, bytes, manifestSha256: hash(content) };
}
export async function verifyBackup(directory) {
  directory = await canonicalDirectory(directory); const parsed = await manifestAt(directory);
  const actual = await inventory(join(directory, 'state'));
  const wanted = parsed.manifest.files.map(({ path, bytes }) => ({ path, bytes })).sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(actual.files.sort((a, b) => a.path.localeCompare(b.path))) !== JSON.stringify(wanted)) throw inputError('Backup inventory differs from its manifest.');
  for (const file of parsed.manifest.files) if (await transfer(join(directory, 'state', file.path), undefined, file.bytes) !== file.sha256) throw inputError('Backup checksum verification failed; restore was refused.');
  return { ok: true, files: actual.files.length, bytes: parsed.bytes, manifestSha256: parsed.manifestSha256 };
}
export async function restoreState(directory, destination) {
  directory = await canonicalDirectory(directory); destination = await newDestination(destination);
  if (isInside(directory, destination) || isInside(destination, directory)) throw inputError('Restore destination must be separate from backup.');
  const verified = await verifyBackup(directory); const parsed = await manifestAt(directory);
  if (parsed.manifestSha256 !== verified.manifestSha256) throw inputError('Backup manifest changed during restore.');
  const { manifest } = parsed;
  await safeAncestors(dirname(destination)); let created = false;
  try {
    await mkdir(destination, { mode: 0o700 }); created = true;
    for (const file of manifest.files) if (await transfer(join(directory, 'state', file.path), join(destination, file.path), file.bytes) !== file.sha256) throw inputError('Backup changed during restore.');
    await stateTopology(destination);
    return { ok: true, stateDir: destination, files: verified.files, bytes: verified.bytes, next: 'Keep the original stopped. Start this restored state with its matching release, then run doctor and verify task history and worker identities.' };
  } catch (error) { if (created) await rm(destination, { recursive: true, force: true }); throw error; }
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
