import { lstat, opendir, realpath, mkdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { inputError, readPrivate, createPrivate, privateDirectory } from '../config.mjs';
import { stateDirectory, status } from './lifecycle.mjs';

const present = async path => lstat(path).catch(error => { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; return null; });
const populated = async path => {
  const info = await present(path);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw inputError('Worker state must be a real directory: ' + path);
  for await (const _entry of await opendir(path)) return true;
  return false;
};
const markerPath = home => join(home, 'state', 'home.json');
const freshState = home => join(home, 'state', 'worker');
function contained(root, path) { const part = relative(process.platform === 'win32' ? root.toLowerCase() : root, process.platform === 'win32' ? path.toLowerCase() : path); return !part || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); }
async function childDirectories(path) {
  const info = await present(path);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw inputError('Home discovery requires a real directory: ' + path);
  const directories = []; let count = 0;
  for await (const entry of await opendir(path)) {
    if (++count > 256) throw inputError('Home discovery exceeds 256 entries. Use a dedicated Home and inspect legacy worker state before starting.');
    if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(entry.name);
  }
  return directories;
}
/** A bounded inventory only. Never reads credentials or relocates retained paths. */
export async function inspectWorkerHome(home, appRoot, explicitState) {
  home = await realpath(resolve(home));
  const state = await stateDirectory('worker', appRoot, freshState(home));
  const runtime = await realpath(join(home, 'runtime')).catch(error => { if (error.code !== 'ENOENT') throw error; return join(home, 'runtime'); });
  const marker = await readPrivate(markerPath(home)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (marker !== null && (typeof marker !== 'object' || Array.isArray(marker) || marker.schemaVersion !== 1 || marker.homeDir !== home || typeof marker.stateDirectory !== 'string' || !isAbsolute(marker.stateDirectory) || !['central', 'legacy'].includes(marker.layout) || Object.keys(marker).some(key => !['schemaVersion', 'homeDir', 'stateDirectory', 'layout'].includes(key)))) throw inputError('Invalid Home selection. Restore state/home.json and preserve original absolute paths; do not create another worker.');
  const candidates = new Set([join(home, '.werk', 'worker')]);
  for (const name of await childDirectories(home)) if (/^werk-[0-9]/.test(name)) candidates.add(join(home, name, '.werk', 'worker'));
  for (const name of await childDirectories(join(home, 'projects'))) candidates.add(join(home, 'projects', name, '.werk', 'worker'));
  if (marker) candidates.add(marker.stateDirectory);
  if (explicitState) candidates.add(resolve(explicitState));
  const found = [];
  for (const path of candidates) {
    const canonical = await stateDirectory('worker', appRoot, path);
    if (contained(runtime, canonical)) throw inputError('Worker state cannot live inside the replaceable Home/runtime payload. Preserve original state and recover explicitly.');
    if (canonical !== state && await populated(canonical)) {
      if (found.some(item => item.stateDirectory === canonical)) continue;
      const projectInstalled = !!await present(join(dirname(canonical), 'worker-project.json')) || !!await present(join(dirname(canonical), 'worker.json'));
      found.push({ stateDirectory: canonical, ...(await status('worker', canonical)), compatible: !projectInstalled, migration: projectInstalled ? 'Project-installed worker startup configuration is outside retained state. Keep the old runtime and project untouched; use legacy recovery/export before adding a fresh isolated clone in Home.' : 'Stopped standalone state can be adopted at its original absolute location; no files move.' });
    }
  }
  const centralPopulated = await populated(state), selected = marker ? await stateDirectory('worker', appRoot, marker.stateDirectory) : state;
  if ((marker && selected !== marker.stateDirectory) || marker?.layout === 'central' && selected !== state || marker?.layout === 'legacy' && selected === state) throw inputError('Home selection changed physical location. Restore its original paths before starting.');
  if (marker?.layout === 'legacy' && !found.some(item => item.stateDirectory === selected)) throw inputError('Selected legacy state is absent or empty. Restore the original directory; another worker was not created.');
  const conflicts = found.filter(item => item.stateDirectory !== selected);
  if (selected !== state && centralPopulated) conflicts.push({ stateDirectory: state, ...(await status('worker', state)) });
  return { schemaVersion: 1, homeDir: home, stateDirectory: selected, projectsDirectory: join(home, 'projects'), layout: marker?.layout ?? 'central', adopted: !!marker, centralPopulated, legacyCandidates: found, conflicts, migrationRequired: !marker && found.length > 0 };
}
function assertUnambiguous(plan) {
  if (plan.conflicts.length || plan.migrationRequired) throw inputError('Legacy or conflicting worker state was found. Run worker.mjs migration plan, stop the old worker, then explicitly adopt its original --state-dir. No state or checkout was moved.');
}
async function withSelectionLock(home, operation) {
  await privateDirectory(join(home, 'state'));
  const path = join(home, 'state', 'home.lock');
  try { await createPrivate(path, { pid: process.pid }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('Another Home selection holds state/home.lock. Verify it has exited before removing that lock.'); throw error; }
  try { return await operation(); } finally { await unlink(path); }
}
/** @param {string} home @param {string} appRoot @param {{adoptState?: string, initialize?: boolean}} [options] */
export async function selectWorkerHome(home, appRoot, { adoptState, initialize = false } = {}) {
  if (initialize) await mkdir(home, { recursive: true, mode: 0o700 });
  home = await realpath(resolve(home));
  // Reject an app-owned Home before creating even its private selection directory.
  await stateDirectory('worker', appRoot, freshState(home));
  const select = async () => {
    const plan = await inspectWorkerHome(home, appRoot, adoptState);
    if (adoptState) {
      const selected = await stateDirectory('worker', appRoot, resolve(adoptState));
      if (selected === freshState(home) || contained(appRoot, selected)) throw inputError('Migration adoption requires original legacy worker state outside the replaceable runtime.');
      const candidate = plan.legacyCandidates.find(item => item.stateDirectory === selected);
      if (!candidate) throw inputError('The selected legacy worker state is empty or absent; no adoption was recorded.');
      if (!candidate.compatible) throw inputError(candidate.migration);
      if (candidate.state !== 'stopped') throw inputError('Stop and verify the old worker before adoption; active, stale or unverified locks are preserved.');
      if (plan.centralPopulated || plan.legacyCandidates.some(item => item.stateDirectory !== selected)) throw inputError('Multiple populated worker states require explicit manual recovery; no state was selected or moved.');
      const signatures = ['identity.json', 'workspace-settings.json', 'sessions.json', 'managed-projects.json', 'webview-token'];
      if (!(await Promise.all(signatures.map(name => present(join(selected, name))))).some(entry => entry?.isFile() && !entry.isSymbolicLink())) throw inputError('The selected folder has no recognized retained worker state; restore the original worker directory.');
      if (plan.adopted && plan.stateDirectory !== selected) throw inputError('Home already selects another state; preserve both and recover explicitly.');
      if (!plan.adopted) await createPrivate(markerPath(home), { schemaVersion: 1, homeDir: home, stateDirectory: selected, layout: 'legacy' });
    } else {
      assertUnambiguous(plan);
      if (initialize && !plan.adopted) await createPrivate(markerPath(home), { schemaVersion: 1, homeDir: home, stateDirectory: plan.stateDirectory, layout: 'central' });
    }
    return inspectWorkerHome(home, appRoot);
  };
  return initialize || adoptState ? withSelectionLock(home, select) : select();
}
