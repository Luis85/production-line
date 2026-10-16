import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrivate, inputError, privateDirectory, readPrivate } from '../config.mjs';
import { exists, restoreSnapshot, snapshotState } from '../maintenance/snapshot.mjs';
import { latest, newer, published, versionParts } from '../update/remote.mjs';
import { status, stop } from './lifecycle.mjs';

/**
 * Guarded self-update for a copied portable app folder (bin/apps/<kind>).
 * The release is verified before anything changes; the app is replaced by two
 * renames inside its parent directory, and the previous folder is retained under
 * bin/apps/.<kind>-update for rollback. State lives outside the app folder and is
 * only read, into a new verified backup. Project files are never written.
 */
const execute = promisify(execFile);
const LOCKS = { worker: 'worker.lock', factory: 'runtime.lock', orchestrator: 'runtime.lock' };
const HISTORY_LIMIT = 50;
export { updateCommands, updateHelp } from './update-commands.mjs';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
// Portable apps carry the installer/verifier beside this module because the release
// packager drops nested "release" directories; source and release trees keep them in scripts/release.
async function releaseModule(name) {
  for (const url of [new URL(`../update/${name}`, import.meta.url), new URL(`../../release/${name}`, import.meta.url)]) {
    if (await exists(fileURLToPath(url))) return import(url.href);
  }
  throw Error(`Missing release tool ${name}. Replace the complete app folder from a release.`);
}
async function locate(root) {
  const app = await realpath(root), name = basename(app), home = join(dirname(app), `.${name}-update`);
  return { app, name, home, lock: join(home, 'update.lock'), history: join(home, 'history.json') };
}
async function outsideApp(app) {
  // A shell or npm --prefix inside the folder holds it open on Windows and would lose its directory.
  // Compare real paths: Windows 8.3 short names and junctions alias the same folder.
  const fold = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const inside = relative(fold(app), fold(await realpath(process.cwd())));
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) throw inputError('Run update from the project directory, not from inside the app folder (for example node bin/apps/worker/cli.mjs update apply).');
}
async function appVersion(app, kind) {
  let info;
  try { info = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')); }
  catch { throw inputError(`${app} is not a complete portable app folder (package.json is missing or invalid).`); }
  // Source checkouts run the same CLI module; only a built app folder may replace itself.
  if (info.name !== `@werk/${kind}-portable`) throw inputError(`update replaces a copied portable ${kind} app folder (bin/apps/${kind}). Source checkouts update with Git.`);
  if (typeof info.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info.version)) throw inputError('Portable app package.json has no valid version.');
  return info.version;
}
async function readHistory(paths) {
  try {
    const value = await readPrivate(paths.history);
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw inputError('Invalid update history. Inspect ' + paths.history);
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, entries: [] }; throw error; }
}
async function prepareHistory(paths, entry) {
  const history = await readHistory(paths);
  const value = { schemaVersion: 1, entries: [...history.entries, entry].slice(-HISTORY_LIMIT) };
  const temporary = `${paths.history}.${randomBytes(4).toString('hex')}`;
  try { await createPrivate(temporary, value); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { commit: () => rename(temporary, paths.history), discard: () => unlink(temporary).catch(() => {}) };
}
async function seedIgnore(directory) {
  // Retained apps and backups (which contain credentials) stay out of project Git without editing project files.
  const path = join(directory, '.gitignore');
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (file) try { await file.writeFile('*\n'); } finally { await file.close(); }
}
async function lockApp(paths) {
  await privateDirectory(paths.home); await seedIgnore(paths.home);
  try { await createPrivate(paths.lock, { pid: process.pid, startedAt: new Date().toISOString() }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError(`Another update of this app folder is in progress. After a crash, verify that process exited before removing ${paths.lock}.`); throw error; }
  return () => unlink(paths.lock);
}
async function move(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      // Windows refuses to rename a folder while an editor, indexer, antivirus scan or exiting process holds a file in it.
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 40) {
        throw Object.assign(Error(`Could not move ${from} (${error.code}). Close terminals, editors or indexers using that folder and retry.`), { code: error.code });
      }
      await delay(250);
    }
  }
}
async function digestFile(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return createHash('sha256').update(await handle.readFile()).digest('hex'); } finally { await handle.close(); }
}
/** The staged folder must equal the release manifest's bin/apps/<kind> entries, byte for byte. */
async function verifyTree(directory, expected) {
  const actual = [];
  async function visit(path) {
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) actual.push(child);
      else throw Error(`Staged app contains a link or special file: ${child}`);
    }
  }
  await visit('');
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.map(file => file.path).sort())) throw Error('Staged app inventory differs from the release manifest.');
  for (const file of expected) if (await digestFile(join(directory, ...file.path.split('/'))) !== file.sha256) throw Error(`Staged app integrity mismatch: ${file.path}`);
}
async function target(options, fetcher) {
  if (options.from) {
    const root = resolve(options.from), { verifyRelease } = await releaseModule('verify.mjs');
    const checked = await verifyRelease(root).catch(error => { throw inputError(`--from is not a verified extracted release: ${error.message}`); });
    versionParts(checked.version);
    if (options.version !== undefined && options.version !== checked.version) throw inputError('--version differs from the --from release.');
    return { version: checked.version, source: 'directory', root };
  }
  if (options.version !== undefined) {
    try { versionParts(options.version); } catch (error) { throw inputError(error.message); }
    return { ...await published(options.version, { fetcher }), source: 'github' };
  }
  return { ...await latest({ fetcher }), source: 'github' };
}
async function releaseApp(kind, root, version) {
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== version) throw Error('Release manifest version mismatch.');
  if (manifest.updateProtocol !== 1 || manifest.stateFormat !== 1) throw Error('This release is not compatible with update protocol/state format 1. Follow its manual upgrade instructions.');
  const prefix = `bin/apps/${kind}/`;
  const files = manifest.files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) }));
  if (!files.some(file => file.path === 'cli.mjs') || !files.some(file => file.path === 'package.json')) throw Error(`The release does not contain a complete ${kind} app.`);
  if (await appVersion(join(root, 'bin/apps', kind), kind) !== version) throw Error('Release app version mismatch.');
  return files;
}
async function launchRecord(kind, state, live, projectDir) {
  let identity = null;
  try { identity = await readPrivate(join(state, 'portable.json')); } catch { /* Older or concurrent shutdown; fall back below. */ }
  const launch = identity?.launch;
  if (launch && ['start', 'run'].includes(launch.mode) && typeof launch.cwd === 'string' && Array.isArray(launch.args) && launch.args.length <= 64 && launch.args.every(value => typeof value === 'string' && !value.includes('\0'))) {
    // Older launch records contain raw arguments, so environment-selected state
    // may be missing. Always restart the selected identity, even from another shell.
    const args = launch.args.filter((value, index, values) => value !== '--state-dir' && values[index - 1] !== '--state-dir');
    args.push('--state-dir', await realpath(state));
    if (!args.includes('--port') && live.url) args.push('--port', new URL(live.url).port);
    return { ...launch, args, environment: launchEnvironment(launch) };
  }
  // Instances started before 0.9 did not record options: reuse state, project and port.
  const port = live.url ? new URL(live.url).port : '';
  return { mode: 'start', cwd: process.cwd(), recorded: false, args: ['--state-dir', state, ...(projectDir ? ['--project-dir', projectDir] : []), ...(port ? ['--port', port] : []), ...(kind === 'orchestrator' && live.project ? ['--project', live.project] : [])] };
}
function launchEnvironment(launch) {
  // Never replay arbitrary environment variables or credentials from metadata.
  const duration = launch.environment?.WERK_WORKER_MAX_RUNTIME_MS;
  if (duration === undefined) return {};
  if (typeof duration !== 'string' || !/^\d+$/.test(duration) || !Number.isSafeInteger(Number(duration)) || Number(duration) < 1000 || Number(duration) > 86400000) throw inputError('Invalid saved execution duration. Repair the launch metadata before updating.');
  return { WERK_WORKER_MAX_RUNTIME_MS: String(Number(duration)) };
}
async function relaunch(app, launch) {
  try {
    const { stdout } = await execute(process.execPath, [join(app, 'cli.mjs'), 'start', ...launch.args], { cwd: launch.cwd, env: { ...process.env, ...launchEnvironment(launch) }, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
    return { restarted: true, ...JSON.parse(stdout) };
  } catch (error) {
    let message = error.message;
    try { message = JSON.parse(error.stderr).error ?? message; } catch { /* Keep the process error. */ }
    return { restarted: false, error: message };
  }
}
/** Stop (when allowed) and lock the selected instance's state; returns what is needed to restart it. */
async function quiesce(kind, state, options, projectDir, log, app) {
  const live = await status(kind, state);
  if (live.state === 'unreachable') throw inputError(live.action);
  let launch = null;
  if (live.state !== 'stopped') {
    if (!options.stop) throw inputError('The app is running. Stop it first, or pass --stop to stop it gracefully and restart it afterwards.');
    launch = await launchRecord(kind, state, live, projectDir);
    log('Stopping the running app gracefully.');
    await stop(kind, state);
  }
  try {
    if (!await exists(state)) return { launch, canonical: null, release: async () => {} };
    const canonical = await realpath(state), lock = join(canonical, LOCKS[kind]);
    // Holding the application lock keeps start/run away while state is copied and the folder is swapped.
    try { await createPrivate(lock, { maintenance: 'update', pid: process.pid }); }
    catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(inputError('The app started again or another owner holds its lock. Nothing was replaced. Inspect status before restarting.'), { recoveryUnsafe: true });
      throw error;
    }
    let released = false;
    return { launch, canonical, lock, release: async () => {
      if (released) return;
      await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
      released = true;
    } };
  } catch (error) {
    // A lock/open failure after shutdown must not silently strand the old app.
    return recover(error, { launch, release: async () => {} }, options, app);
  }
}
async function hasFiles(directory, skip) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (join(directory, entry.name) === skip) continue;
    if (!entry.isDirectory() || await hasFiles(join(directory, entry.name), skip)) return true;
  }
  return false;
}
async function backupState(state, held, version) {
  // A freshly initialized project worker has an empty state directory: nothing to preserve.
  if (!await hasFiles(state.canonical, held)) return null;
  const home = `${state.canonical}.updates`;
  await privateDirectory(home); await seedIgnore(home); await privateDirectory(join(home, 'backups'));
  return snapshotState(state.canonical, join(home, 'backups', `${stamp()}-${version}`), async () => ({ held: [held], release: async () => {} }));
}
async function restartAfter(launch, options, app) {
  if (!launch) return { restarted: false, reason: 'not_running' };
  if (options['no-restart']) return { restarted: false, reason: 'no_restart' };
  if (launch.mode === 'run') return { restarted: false, reason: 'foreground', message: 'It ran in the foreground; start it again from its terminal or service manager.' };
  return relaunch(app, launch);
}
/** After a failure that left the original folder active, bring back an instance this command stopped. */
async function recover(error, owned, options, app) {
  if (error.recoveryUnsafe || !owned?.launch || options['no-restart'] || owned.launch.mode !== 'start') throw error;
  await owned.release().catch(() => {});
  const again = await relaunch(app, owned.launch);
  error.message += again.restarted ? ' The previous version was restarted.' : ` Restarting the previous version failed: ${again.error}`;
  throw error;
}
/** Replace the app folder by two renames on one volume; the outgoing folder is retained for rollback. */
async function swap(paths, incoming, retained) {
  await move(paths.app, join(paths.home, retained));
  try { await move(incoming, paths.app); }
  catch (error) {
    await move(join(paths.home, retained), paths.app).catch(() => { throw Object.assign(Error(`The app could not be activated and the previous folder could not be moved back. The app remains stopped. Rename ${join(paths.home, retained)} to ${paths.app} manually.`), { recoveryUnsafe: true }); });
    throw error;
  }
}

/** Commit the rollback record with activation, reverting the folder swap if persistence fails. */
async function replaceAndRecord(paths, incoming, retained, entry) {
  const history = await prepareHistory(paths, entry);
  try {
    await swap(paths, incoming, retained);
    try { await history.commit(); }
    catch (error) {
      try {
        await move(paths.app, incoming);
        await move(join(paths.home, retained), paths.app);
      } catch {
        throw Object.assign(Error(`Update history could not be saved and automatic recovery failed. The app remains stopped. The previous version is retained at ${join(paths.home, retained)}; inspect ${paths.app} and ${incoming} before restoring that folder manually.`), { recoveryUnsafe: true });
      }
      error.message = `Update history could not be saved; the previous app folder was restored. ${error.message}`;
      throw error;
    }
  } finally { await history.discard(); }
}

export async function checkUpdate(kind, root, options = {}, { fetcher = fetch } = {}) {
  const paths = await locate(root), current = await appVersion(paths.app, kind), found = await target(options, fetcher);
  return { ok: true, application: kind, current, target: found.version, available: newer(found.version, current), source: found.source, ...(found.url ? { release: found.url } : {}) };
}

export async function updateStatus(kind, root, state) {
  const paths = await locate(root), history = await readHistory(paths), live = await status(kind, state);
  const retained = [];
  for (const entry of history.entries) if (typeof entry.retained === 'string' && await exists(join(paths.home, entry.retained))) retained.push({ version: entry.from, directory: join(paths.home, entry.retained) });
  return { ok: true, application: kind, current: await appVersion(paths.app, kind), appDirectory: paths.app, state: live.state, stateDirectory: state, retained, last: history.entries.at(-1) ?? null, updateDirectory: paths.home };
}

export async function applyUpdate(kind, root, state, options = {}, { fetcher = fetch, log = () => {}, projectDir } = {}) {
  const paths = await locate(root), current = await appVersion(paths.app, kind);
  await outsideApp(paths.app);
  const found = await target(options, fetcher);
  if (!newer(found.version, current)) {
    if (found.version !== current && (options.version !== undefined || options.from)) throw inputError(`${found.version} is older than the installed ${current}. Use update rollback to return to a retained folder.`);
    return { ok: true, updated: false, application: kind, version: current, target: found.version };
  }
  const before = await status(kind, state);
  if (before.state === 'unreachable') throw inputError(before.action);
  if (before.state !== 'stopped' && !options.stop) throw inputError('The app is running. Stop it first, or pass --stop to stop it gracefully and restart it afterwards.');
  const unlock = await lockApp(paths);
  let scratch, staging, owned;
  try {
    if (await appVersion(paths.app, kind) !== current) throw inputError('The installed app changed while preparing this update. Check update status and retry.');
    await readHistory(paths); // Refuse invalid recovery metadata before stopping a running app.
    let releaseRoot = found.root;
    if (found.source === 'github') {
      // Download outside the project: indexers and sync clients stay away and paths stay short.
      scratch = await mkdtemp(join(tmpdir(), 'werk-update-'));
      const { install } = await releaseModule('install.mjs');
      releaseRoot = await install(found, { directory: scratch }, { fetcher, log });
    }
    const files = await releaseApp(kind, releaseRoot, found.version);
    staging = join(paths.home, `next-${randomBytes(4).toString('hex')}`);
    await cp(join(releaseRoot, 'bin/apps', kind), staging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await verifyTree(staging, files);
    // Preflight: the staged CLI loads under this Node and identifies the same application.
    const preflight = await execute(process.execPath, [join(staging, 'cli.mjs'), 'schema'], { env: process.env, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }).catch(() => { throw Error('Candidate preflight failed. Nothing was replaced.'); });
    if (JSON.parse(preflight.stdout).application !== kind) throw Error('Candidate preflight reported another application. Nothing was replaced.');
    owned = await quiesce(kind, state, options, projectDir, log, paths.app);
    const backup = owned.canonical ? await backupState(owned, owned.lock, current).catch(error => recover(error, owned, options, paths.app)) : null;
    const retained = `${current}-${stamp()}`;
    await replaceAndRecord(paths, staging, retained, { operation: 'apply', at: new Date().toISOString(), from: current, to: found.version, retained, backup: backup?.backup ?? null }).catch(error => recover(error, owned, options, paths.app));
    staging = undefined;
    await owned.release();
    const restart = await restartAfter(owned.launch, options, paths.app);
    owned = undefined;
    return { ok: !restart.error, updated: true, application: kind, version: found.version, previous: current, retained: join(paths.home, retained), backup: backup?.backup ?? null, restart,
      next: 'Project files and integrations were not changed; review integrations plan for new templates. update rollback swaps the retained folder back.' };
  } finally {
    await owned?.release().catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await unlock().catch(() => {});
  }
}

export async function rollbackUpdate(kind, root, state, options = {}, { log = () => {}, projectDir } = {}) {
  const paths = await locate(root), current = await appVersion(paths.app, kind);
  await outsideApp(paths.app);
  const unlock = await lockApp(paths);
  let owned;
  try {
    if (await appVersion(paths.app, kind) !== current) throw inputError('The installed app changed while preparing rollback. Check update status and retry.');
    const last = (await readHistory(paths)).entries.at(-1);
    if (!last || typeof last.retained !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(last.retained) || !await exists(join(paths.home, last.retained))) throw inputError('No retained app folder is available for rollback.');
    const incoming = join(paths.home, last.retained), version = await appVersion(incoming, kind);
    if (!await exists(join(incoming, 'cli.mjs'))) throw inputError(`Retained folder ${incoming} is incomplete.`);
    owned = await quiesce(kind, state, options, projectDir, log, paths.app);
    const retained = `${current}-${stamp()}`;
    // Rolling back again swaps the newer folder in: each entry retains what it replaced.
    await replaceAndRecord(paths, incoming, retained, { operation: 'rollback', at: new Date().toISOString(), from: current, to: version, retained, backup: null }).catch(error => recover(error, owned, options, paths.app));
    await owned.release();
    const restart = await restartAfter(owned.launch, options, paths.app);
    owned = undefined;
    return { ok: !restart.error, rolledBack: true, application: kind, version, previous: current, retained: join(paths.home, retained), restart,
      ...(last.operation === 'apply' && last.backup ? { backup: last.backup } : {}),
      next: 'State was not changed. If the newer version changed it, stop the app, restore the update backup with update restore --from BACKUP --to NEW_STATE_DIRECTORY, and start with --state-dir NEW_STATE_DIRECTORY.' };
  } finally {
    await owned?.release().catch(() => {});
    await unlock().catch(() => {});
  }
}

export async function restoreBackup(from, to) {
  const result = await restoreSnapshot(resolve(from), resolve(to), async destination => {
    if (await exists(join(destination, 'portable.json'))) throw inputError('Backup contains live ownership metadata; it was not taken from a stopped app.');
  });
  return { ...result, next: 'Keep the original state. Start the matching app with --state-dir pointing to the restored directory and verify tasks and credentials.' };
}
