import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inputError } from '../config.mjs';

/**
 * File helpers for footprint and uninstall. They never follow links, never read
 * file contents into output and treat every Git-tracked file as the operator's.
 */
const runFile = promisify(execFile);
const ENTRY_LIMIT = 1000000;
export const missing = error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; };
const info = path => lstat(path).catch(missing);
const fold = path => process.platform === 'win32' ? path.toLowerCase() : path;
/** True when `path` is `base` or below it, compared case-insensitively on Windows. */
export function within(base, path) {
  const inside = relative(fold(base), fold(path));
  return !inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside));
}
/** Project-relative POSIX path, or the absolute path for locations outside the project. */
export const display = (project, path) => within(project, path) && path !== project ? relative(project, path).split(sep).join('/') : path;

/** A location counts as inside the project only when its existing parent resolves inside the project too. */
export async function contained(project, path) {
  if (!within(project, path) || path === project) return false;
  let parent = dirname(path);
  while (!await info(parent)) { if (dirname(parent) === parent) return false; parent = dirname(parent); }
  return within(project, await realpath(parent));
}

async function git(project, args) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  return runFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '--literal-pathspecs', '-C', project, ...args], { env: environment, timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
}
/**
 * Tracked files below the given project-relative paths. A project outside Git has none;
 * a checkout Git cannot read is reported as unknown so nothing is removed.
 */
export async function trackedFiles(project, paths) {
  try {
    const { stdout } = paths.length ? await git(project, ['ls-files', '-z', '--', ...paths]) : await git(project, ['rev-parse', '--git-dir']).then(() => ({ stdout: '' }));
    return { repository: true, files: new Set(stdout.split('\0').filter(Boolean)) };
  } catch {
    for (let ancestor = project; ;) {
      if (await info(join(ancestor, '.git'))) return { repository: null, files: new Set() };
      const parent = resolve(ancestor, '..'); if (parent === ancestor) return { repository: false, files: new Set() }; ancestor = parent;
    }
  }
}
/** Tracked files equal to or below a project-relative path. */
export function trackedBelow(tracked, rel) {
  let count = 0;
  for (const file of tracked) if (file === rel || file.startsWith(rel + '/')) count++;
  return count;
}

/** Existence, type and recursive size without following links or reading contents. */
export async function measure(path) {
  const top = await info(path);
  if (!top) return { exists: false, type: 'missing', size: 0 };
  if (top.isSymbolicLink()) return { exists: true, type: 'link', size: 0 };
  if (top.isFile()) return { exists: true, type: 'file', size: top.size };
  if (!top.isDirectory()) return { exists: true, type: 'special', size: 0 };
  let size = 0, files = 0, links = 0, entries = 0, truncated = false;
  const pending = [path];
  while (pending.length && !truncated) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true }).catch(error => { missing(error); return []; })) {
      if (++entries > ENTRY_LIMIT) { truncated = true; break; }
      const child = join(current, entry.name), stat = await info(child);
      if (!stat) continue;
      if (stat.isSymbolicLink()) links++;
      else if (stat.isDirectory()) pending.push(child);
      else if (stat.isFile()) { files++; size += stat.size; }
    }
  }
  return { exists: true, type: 'directory', size, files, links, ...(truncated ? { truncated: true } : {}) };
}

/** Read a small regular file as text; links and oversized files are not read. */
export async function smallText(path, limit = 65536) {
  const stat = await info(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return undefined;
  return readFile(path, 'utf8');
}
export const lf = text => text?.replace(/\r\n/g, '\n');

/**
 * Remove untracked files below `path`, then directories left empty. Links, special
 * files and tracked files stay; the result counts what stayed and why.
 */
export async function removeUntracked(project, path, tracked) {
  const result = { removed: 0, tracked: 0, links: 0, linkPaths: [], special: 0 };
  let budget = ENTRY_LIMIT;
  async function visit(current) {
    if (--budget < 0) throw inputError('Too many entries to remove safely. Remove the remaining files manually.');
    const stat = await info(current);
    if (!stat) return true;
    if (stat.isSymbolicLink()) { if (result.links++ < 20) result.linkPaths.push(display(project, current)); return false; }
    if (stat.isDirectory()) {
      let empty = true;
      for (const name of await readdir(current)) if (!await visit(join(current, name))) empty = false;
      if (empty) await rmdir(current).catch(error => { if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') empty = false; else missing(error); });
      return empty;
    }
    if (!stat.isFile()) { result.special++; return false; }
    if (tracked.has(display(project, current))) { result.tracked++; return false; }
    await unlink(current).catch(missing); result.removed++;
    return true;
  }
  const gone = await visit(path);
  return { gone, ...result };
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
