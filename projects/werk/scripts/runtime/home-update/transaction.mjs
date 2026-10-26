import { cp, open, rename, unlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { withHomeRuntimeLock } from './guard.mjs';
import { digest } from '../update/remote.mjs';
import { readRegular, exists, ordinary, ownedName, partMatches, partFiles, releaseSnapshot, withStoppedRuntime, unchanged } from './ownership.mjs';
const iso = () => new Date().toISOString();
async function writeRecord(path, value) {
  const temporary = path + '.' + randomUUID(); const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function updatePaths(home) {
  const directory = await realpath(home), state = join(directory, 'state'), updates = join(state, 'updates');
  await ordinary(state, true); await ordinary(updates, true);
  return { home: directory, updates, latest: join(updates, 'latest.json'), lock: join(updates, 'update.lock') };
}
export async function homeUpdateStatus(home) {
  const directory = await realpath(home), path = join(directory, 'state/updates/latest.json');
  if (!await exists(path)) return { status: 'none', home: directory };
  const value = JSON.parse((await readRegular(path, 256 * 1024 * 1024)).toString('utf8'));
  if (value.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || value.home !== directory || !Array.isArray(value.names) || value.names.some(name => !ownedName(name))) throw Error('Retained Home update metadata is invalid. Preserve it for inspection.');
  if (!['pending', 'unknown', 'confirmed', 'rolled_back'].includes(value.status) || new Set(value.names).size !== value.names.length || value.names.length > 12) throw Error('Invalid Home update outcome.');
  for (const snapshot of [value.before, value.after]) {
    if (!snapshot || typeof snapshot.bytes !== 'string' || digest(snapshot.bytes) !== snapshot.sha256 || JSON.stringify(JSON.parse(snapshot.bytes)) !== JSON.stringify(snapshot.manifest) || snapshot.manifest.layout !== 'werk-home-v1' || snapshot.manifest.updateProtocol !== 2 || !Array.isArray(snapshot.manifest.files)) throw Error('Retained update manifest evidence is invalid.');
    for (const file of snapshot.manifest.files) if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || !ownedName(file.path.split('/')[0]) || file.path.startsWith('release-manifest.json/')) throw Error('Retained update claims an invalid Home path.');
  }
  return value;
}
export async function preview(home, candidate) {
  const before = await releaseSnapshot(home), after = await releaseSnapshot(candidate);
  if (before.directory === after.directory) throw Error('The candidate must be separate from the active Home.');
  const id = digest(JSON.stringify([before.directory, after.directory, before.sha256, after.sha256]));
  return { id, home: before.directory, candidate: after.directory, from: before.version, to: after.version, currentManifestSha256: before.sha256, candidateManifestSha256: after.sha256, unchanged: before.sha256 === after.sha256, before, after };
}
async function withLock(paths, run) {
  const lock = await open(paths.lock, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw Error('Another Home update owns the update lock. Inspect status; do not replay an uncertain operation.'); throw error; });
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: iso() })); await lock.sync(); return await run(); }
  finally { await lock.close(); await unlink(paths.lock); }
}
function view(plan) { const { before, after, ...result } = plan; return result; }
export const previewView = view;
async function restore(paths, record) {
  const operation = join(paths.updates, record.id), backup = join(operation, 'backup'), displaced = join(operation, 'displaced');
  await ordinary(backup); await ordinary(displaced, true);
  // Validate the complete rollback before displacing any healthy active file.
  for (const name of record.names) {
    if (await partMatches(paths.home, record.before, name)) continue;
    if (await exists(join(paths.home, name)) && !await partMatches(paths.home, record.after, name)) throw Error('An owned release path changed after the update. Rollback preserves it for inspection.');
    if (partFiles(record.before, name).length && !await partMatches(backup, record.before, name)) throw Error('The retained previous release does not match its immutable manifest.');
    if (await exists(join(paths.home, name)) && await exists(join(displaced, name))) throw Error('An earlier displaced payload needs inspection before rollback can continue.');
  }
  for (const name of [...record.names].reverse()) {
    const active = join(paths.home, name), saved = join(backup, name);
    if (await partMatches(paths.home, record.before, name)) continue;
    if (partFiles(record.before, name).length && !await partMatches(backup, record.before, name)) throw Error('The retained previous release changed during rollback.');
    if (await exists(active)) {
      if (!await partMatches(paths.home, record.after, name)) throw Error('An owned release path changed after the update. Rollback preserves it and all projects/state for inspection.');
      if (await exists(join(displaced, name))) throw Error('An earlier displaced payload needs inspection before rollback can continue.');
      record.intent = { action: 'rollback_remove_new', name }; await writeRecord(paths.latest, record); await rename(active, join(displaced, name));
    }
    if (partFiles(record.before, name).length) {
      if (!await partMatches(backup, record.before, name)) throw Error('The retained previous release does not match its immutable manifest.');
      record.intent = { action: 'rollback_restore_old', name }; await writeRecord(paths.latest, record); await rename(saved, active);
    }
  }
  await unchanged(paths.home, record.before); record.status = 'rolled_back'; record.intent = null; record.updatedAt = iso(); await writeRecord(paths.latest, record); return record;
}
export async function rollback(home, options = {}) {
  const paths = await updatePaths(home);
  return withHomeRuntimeLock(paths.home, () => withLock(paths, async () => { const record = await homeUpdateStatus(home); if (record.status === 'none' || record.status === 'rolled_back') return record; return withStoppedRuntime(paths.home, options, () => restore(paths, record)); }));
}
export async function apply(home, candidate, options = {}) {
  const plan = await preview(home, candidate); if (options.ifMatch && options.ifMatch !== plan.id) throw Error('The Home or candidate changed since preview. Refresh the plan.');
  if (plan.unchanged) return { status: 'already_current', ...view(plan) };
  const paths = await updatePaths(plan.home);
  return withHomeRuntimeLock(paths.home, () => withLock(paths, async () => {
    const prior = await homeUpdateStatus(plan.home); if (['pending', 'unknown'].includes(prior.status)) throw Error('A retained update has an uncertain outcome. Inspect status and explicitly rollback before another apply.');
    await unchanged(plan.home, plan.before); await unchanged(plan.candidate, plan.after);
    const id = randomUUID(), operation = join(paths.updates, id), staged = join(operation, 'staged'), backup = join(operation, 'backup');
    await ordinary(operation, true); await ordinary(staged, true); await ordinary(backup, true);
    const names = [...new Set([...plan.before.manifest.files, ...plan.after.manifest.files].map(file => file.path.split('/')[0]).concat('release-manifest.json'))].sort((a, b) => a === 'release-manifest.json' ? 1 : b === 'release-manifest.json' ? -1 : a.localeCompare(b));
    if (names.some(name => !ownedName(name))) throw Error('An update attempted to claim mutable Home paths.');
    for (const name of names) if (partFiles(plan.after, name).length) await cp(join(plan.candidate, name), join(staged, name), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    for (const name of names) if (!await partMatches(staged, plan.after, name)) throw Error('The staged candidate changed or is incomplete. Nothing was replaced.');
    const record = { schemaVersion: 1, id, home: plan.home, status: 'pending', from: plan.from, to: plan.to, createdAt: iso(), updatedAt: iso(), names, before: plan.before, after: plan.after, intent: null };
    return withStoppedRuntime(plan.home, options, async () => {
    await writeRecord(paths.latest, record);
    try { await unchanged(plan.home, plan.before); await unchanged(plan.candidate, plan.after);
      for (const name of names) {
        if (!await partMatches(plan.home, plan.before, name)) throw Error('The previous payload changed during update.');
        if (partFiles(plan.before, name).length) { record.intent = { action: 'retain_old', name }; await writeRecord(paths.latest, record); await rename(join(plan.home, name), join(backup, name)); }
        if (partFiles(plan.after, name).length) { record.intent = { action: 'activate_new', name }; await writeRecord(paths.latest, record); await rename(join(staged, name), join(plan.home, name)); }
      }
      await unchanged(plan.home, plan.after); record.status = 'confirmed'; record.intent = null; record.updatedAt = iso(); await writeRecord(paths.latest, record); return record;
    } catch (error) {
      try { await restore(paths, record); } catch { record.status = 'unknown'; record.updatedAt = iso(); await writeRecord(paths.latest, record); throw Error('The Home update outcome needs inspection. Preserve projects/state and retained payloads; inspect update status before explicit rollback.'); }
      throw error;
    }
    });
  }));
}
