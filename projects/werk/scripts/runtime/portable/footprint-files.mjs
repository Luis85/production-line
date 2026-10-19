import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inputError } from '../config.mjs';

/**
 * File helpers for footprint and uninstall. They never follow links, never read
 * file contents into output and treat every Git-tracked file as the operator's.
 */
const runFile = promisify(execFile);
const ENTRY_LIMIT = 1000000;
export const missing = error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; };
export const info = path => lstat(path).catch(missing);
const fold = path => process.platform === 'win32' ? path.toLowerCase() : path;
/** True when `path` is `base` or below it, compared case-insensitively on Windows. */
export function within(base, path) {
  const inside = relative(fold(base), fold(path));
  return !inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside));
}
/** Project-relative POSIX path, or the absolute path for locations outside the project. */
export const display = (project, path) => within(project, path) && path !== project ? relative(project, path).split(sep).join('/') : path;

/** A contained target has no linked or non-directory ancestor below the project root. */
export async function contained(project, path) {
  if (!within(project, path) || path === project) return false;
  for (let parent = dirname(path); within(project, parent); parent = dirname(parent)) {
    const stat = await info(parent);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) return false;
    if (fold(parent) === fold(project)) return true;
  }
  return false;
}

async function git(project, args) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  return runFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', project, ...args], { env: environment, timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
}
/** A nested repository remains protected when a configured path names one of its files. */
async function enclosingRepository(project, path) {
  for (let parent = dirname(path); within(project, parent) && fold(parent) !== fold(project); parent = dirname(parent)) {
    const stat = await info(parent);
    if (stat?.isDirectory() && (await readdir(parent)).some(name => name.toLowerCase() === '.git')) return parent;
  }
}
/** Verify the actual private rewrite path before writing credentials there. */
export async function privateRewriteAllowed(project, path) {
  try { await git(project, ['check-ignore', '--quiet', '--no-index', '--', path]); return true; }
  catch (error) {
    if (error.code === 1) return false;
    return (await trackedFiles(project, [])).repository === false;
  }
}
/**
 * Tracked files below the given project-relative paths. A project outside Git has none;
 * a checkout Git cannot read is reported as unknown so nothing is removed. On Windows,
 * and wherever Git ignores case, `Features/a.md` in the index tracks `features/a.md`:
 * pathspecs and comparisons are case-insensitive there.
 */
export async function trackedFiles(project, paths) {
  const exact = path => path;
  try {
    // Exit 1 means the setting is unset (case-sensitive); any other failure counts as caseless, so more files stay tracked.
    const ignoreCase = await git(project, ['config', '--bool', 'core.ignorecase']).then(result => result.stdout.trim() === 'true', error => error.code !== 1);
    const caseless = process.platform === 'win32' || ignoreCase, magic = caseless ? ':(literal,icase)' : ':(literal)';
    const { stdout } = paths.length ? await git(project, ['ls-files', '-z', '--', ...paths.map(path => magic + path)]) : await git(project, ['rev-parse', '--git-dir']).then(() => ({ stdout: '' }));
    const key = caseless ? path => path.toLowerCase() : exact;
    return { repository: true, key, files: new Set(stdout.split('\0').filter(Boolean).map(key)) };
  } catch {
    for (let ancestor = project; ;) {
      if (await info(join(ancestor, '.git'))) return { repository: null, key: exact, files: new Set() };
      const parent = resolve(ancestor, '..'); if (parent === ancestor) return { repository: false, key: exact, files: new Set() }; ancestor = parent;
    }
  }
}
/** Tracked files equal to or below a project-relative path. */
export function trackedBelow(tracked, rel) {
  const prefix = tracked.key(rel);
  let count = 0;
  for (const file of tracked.files) if (file === prefix || file.startsWith(prefix + '/')) count++;
  return count;
}

const denied = error => ['EACCES', 'EPERM'].includes(error?.code);
/** Existence, type and recursive size without following links or reading contents. */
export async function measure(path) {
  let top;
  try { top = await info(path); } catch (error) { if (denied(error)) return { exists: true, type: 'unreadable', size: 0, error: error.code }; throw error; }
  if (!top) return { exists: false, type: 'missing', size: 0 };
  if (top.isSymbolicLink()) return { exists: true, type: 'link', size: 0 };
  if (top.isFile()) return { exists: true, type: 'file', size: top.size };
  if (!top.isDirectory()) return { exists: true, type: 'special', size: 0 };
  let size = 0, files = 0, links = 0, entries = 0, unreadable = 0, truncated = false;
  const pending = [path];
  while (pending.length && !truncated) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true }).catch(error => { if (denied(error)) unreadable++; else missing(error); return []; })) {
      if (entry.name.toLowerCase() === '.git') continue;
      if (++entries > ENTRY_LIMIT) { truncated = true; break; }
      const child = join(current, entry.name), stat = await info(child).catch(error => { if (!denied(error)) throw error; unreadable++; });
      if (!stat) continue;
      if (stat.isSymbolicLink()) links++;
      else if (stat.isDirectory()) pending.push(child);
      else if (stat.isFile()) { files++; size += stat.size; }
    }
  }
  return { exists: true, type: 'directory', size, files, links, ...(unreadable ? { unreadable } : {}), ...(truncated ? { truncated: true } : {}) };
}

/** Read a small regular file as text; links, oversized and unreadable files are not read. */
export async function smallText(path, limit = 65536) {
  try {
    const stat = await info(path);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return undefined;
    return await readFile(path, 'utf8');
  } catch (error) { if (denied(error)) return undefined; throw error; }
}
export const lf = text => text?.replace(/\r\n/g, '\n');

/**
 * Remove untracked files below `path`, then directories left empty. Links, special
 * files, tracked files and nested Git repositories, submodules or worktrees (any
 * directory with a `.git` entry, in any letter case) stay, and no walk ever enters an
 * entry named `.git`; the result counts what stayed and why. Paths in `skip` (absolute;
 * entries the plan keeps, such as an edited template, and guard files; compared without
 * case where `tracked` is caseless) stay without a count, since the plan reports them
 * itself. With `dryRun` nothing changes and the result predicts the removal. `hold` is the real path of a lock that stays in place
 * for the caller to remove last; a dry run treats it as removable.
 */
export async function removeUntracked(project, path, tracked, { hold, dryRun = false, skip = [] } = {}) {
  const result = { removed: 0, tracked: 0, links: 0, linkPaths: [], special: 0, repositories: [] };
  const held = async current => !!hold && basename(current).toLowerCase() === basename(hold).toLowerCase() && fold(await realpath(current).catch(() => '')) === fold(hold);
  // Compare kept paths the way tracked files are compared: caseless on Windows and wherever Git ignores case.
  const same = path => tracked.key(fold(path)), skipped = new Set(skip.map(same));
  const repository = current => { result.repositories.push(display(project, current)); return false; };
  let budget = ENTRY_LIMIT;
  async function visit(current) {
    if (--budget < 0) throw inputError('Too many entries to remove safely. Remove the remaining files manually.');
    if (skipped.has(same(current))) return false;
    if (basename(current).toLowerCase() === '.git') return repository(dirname(current));
    const stat = await info(current);
    if (!stat) return true;
    if (stat.isSymbolicLink()) { if (result.links++ < 20) result.linkPaths.push(display(project, current)); return false; }
    if (stat.isDirectory()) {
      const names = await readdir(current);
      if (names.some(name => name.toLowerCase() === '.git')) return repository(current);
      let empty = true;
      for (const name of names) if (!await visit(join(current, name))) empty = false;
      if (empty && !dryRun) await rmdir(current).catch(error => { if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') empty = false; else missing(error); });
      return empty;
    }
    if (!stat.isFile()) { result.special++; return false; }
    if (await held(current)) return dryRun;
    if (tracked.files.has(tracked.key(display(project, current)))) { result.tracked++; return false; }
    if (!dryRun) await unlink(current).catch(missing);
    result.removed++;
    return true;
  }
  if (!await contained(project, path)) return { gone: false, ...result, links: 1, linkPaths: [display(project, path)] };
  const nested = await enclosingRepository(project, path);
  if (nested) return { gone: false, ...result, repositories: [display(project, nested)] };
  const gone = await visit(path);
  return { gone, ...result };
}
/** True when the directory exists and holds anything other than the named entries. */
export async function holdsOtherThan(path, names = []) {
  const stat = await info(path);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  return (await readdir(path)).some(name => !names.includes(name));
}

/** Remove now-empty parent directories of a removed path, up to the project root. */
export async function pruneParents(project, path) {
  for (let parent = dirname(path); parent !== project && within(project, parent); parent = dirname(parent)) {
    const stat = await info(parent);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
    const removed = await rmdir(parent).then(() => true, error => { if (['ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) return false; missing(error); return true; });
    if (!removed) return;
  }
}
