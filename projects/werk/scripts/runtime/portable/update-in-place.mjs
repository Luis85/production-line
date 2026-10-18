import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, open, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inputError } from '../config.mjs';

/**
 * File-level replacement of a portable app folder for hosts where another process
 * holds a directory handle inside it and the folder cannot be renamed. The folder
 * itself stays in place: its files are copied to the retained location first, then
 * changed and added files are written, files outside the expected inventory are
 * deleted and the result is verified byte for byte. Any failure restores the
 * retained files the same way.
 *
 * The files that identify the installed version are written last when moving to a
 * newer version and first when moving to an older one, so a run killed midway still
 * reports the older version: update apply sees the release as newer and repairs the tree.
 */
const MARKERS = ['cli.mjs', 'package.json'];
const native = path => path.split('/');
const locked = error => process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
async function retry(operation, attempts) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) { if (!locked(error) || attempt >= attempts) throw error; await delay(250); }
  }
}

async function digestFile(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return createHash('sha256').update(await handle.readFile()).digest('hex'); } finally { await handle.close(); }
}

/** SHA-256 of each path; a few reads in parallel because Windows scans freshly written files on open. */
async function digests(directory, paths, absentAsNull = false) {
  const result = Array.from({ length: paths.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
    while (next < paths.length) { const index = next++; result[index] = await digestFile(join(directory, ...native(paths[index]))).catch(error => { if (absentAsNull) return null; throw error; }); }
  }));
  return result;
}

async function walk(directory, special) {
  const found = [];
  async function visit(path) {
    for (const entry of await readdir(join(directory, ...(path ? native(path) : [])), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) found.push(child);
      else throw special(child);
    }
  }
  await visit('');
  return found.sort();
}

/** The folder must equal `expected` ({ path, sha256 } relative to it), byte for byte. Empty directories are allowed. */
export async function verifyTree(directory, expected, label = 'Staged app') {
  const actual = await walk(directory, child => Error(`${label} contains a link or special file: ${child}`));
  const wanted = new Set(expected.map(file => file.path)), present = new Set(actual);
  const extra = actual.filter(path => !wanted.has(path)), missing = [...wanted].filter(path => !present.has(path));
  const sample = paths => paths.slice(0, 5).join(', ') + (paths.length > 5 ? ', ...' : '');
  if (extra.length || missing.length) throw Error(`${label} inventory differs from the expected files${extra.length ? `; extra: ${sample(extra)}` : ''}${missing.length ? `; missing: ${sample(missing)}` : ''}.`);
  const actualDigests = await digests(directory, expected.map(file => file.path));
  const changed = expected.find((file, index) => actualDigests[index] !== file.sha256);
  if (changed) throw Error(`${label} integrity mismatch: ${changed.path}`);
}

/** Every regular file of a folder with its SHA-256; links and special files are refused. */
export async function inventory(directory) {
  const paths = await walk(directory, child => inputError(`${directory} contains a link or special file (${child}). An in-place update copies regular files only; remove it or update without --in-place.`));
  const sums = await digests(directory, paths);
  return paths.map((path, index) => ({ path, sha256: sums[index] }));
}

/**
 * Make `target` contain exactly the `expected` files from `source`. Directories that
 * remain empty but cannot be removed (an open handle) are reported, not fatal.
 * `markers` ('first' | 'last') places the version-identifying files in the write order.
 */
async function syncTree(target, source, expected, markers) {
  const wanted = new Map(expected.map(file => [file.path, file.sha256])), needed = new Set();
  for (const path of wanted.keys()) native(path).slice(0, -1).forEach((_, index, parts) => needed.add(parts.slice(0, index + 1).join('/')));
  const report = { written: 0, removed: 0, emptyDirectoriesLeft: [] };
  async function prune(path) {
    for (const entry of await readdir(join(target, ...(path ? native(path) : [])), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name, full = join(target, ...native(child));
      if (entry.isDirectory()) {
        await prune(child);
        if (needed.has(child)) continue;
        try { await retry(() => rmdir(full), 4); }
        catch (error) {
          if (error.code === 'ENOENT') continue;
          if (wanted.has(child)) throw Object.assign(Error(`Could not remove directory ${full} (${error.code}) to write the file of the same name.`), { code: error.code });
          report.emptyDirectoriesLeft.push(child);
        }
      } else if (!entry.isFile() || !wanted.has(child)) {
        await retry(() => rm(full, { force: true }), 20);
        report.removed++;
      }
    }
  }
  await prune('');
  const marked = MARKERS.filter(path => wanted.has(path)), others = [...wanted.keys()].filter(path => !MARKERS.includes(path));
  const paths = markers === 'first' ? [...marked.toReversed(), ...others] : [...others, ...marked], present = await digests(target, paths, true);
  for (const [index, path] of paths.entries()) {
    const destination = join(target, ...native(path));
    if (present[index] === wanted.get(path)) continue;
    await mkdir(dirname(destination), { recursive: true });
    await retry(() => copyFile(join(source, ...native(path)), destination), 20);
    report.written++;
  }
  return report;
}

/** Copy the app to the retained location and verify the copy; returns the copied inventory. */
async function retain(app, retained) {
  const files = await inventory(app);
  // Created exclusively: an existing folder may be another rollback target and is never merged into or removed.
  await mkdir(retained).catch(error => { throw Object.assign(Error(`Could not create the retained folder ${retained} (${error.code}). Nothing was replaced; check update status and retry.`), { code: error.code }); });
  try {
    // Into the empty folder created above; the copy is verified next.
    await cp(app, retained, { recursive: true, verbatimSymlinks: true });
    await verifyTree(retained, files, 'Retained copy');
  } catch (error) {
    await rm(retained, { recursive: true, force: true }).catch(() => {});
    error.message = `Could not copy ${app} to ${retained}: ${error.message} Nothing was replaced.`;
    throw error;
  }
  return files;
}

/**
 * Replace the app's files with `expected` from `source`, retaining the previous files at
 * `retained`; `history.commit()` records the operation once the new tree is verified.
 * `upgrade` is true when `expected` is the newer version.
 */
export async function replaceInPlace(app, retained, source, expected, history, upgrade) {
  const previous = await retain(app, retained);
  try {
    const report = await syncTree(app, source, expected, upgrade ? 'last' : 'first');
    await verifyTree(app, expected, 'Updated app');
    await history.commit();
    return report;
  } catch (error) {
    try {
      await syncTree(app, retained, previous, upgrade ? 'first' : 'last');
      await verifyTree(app, previous, 'Restored app');
    } catch (restore) {
      throw Object.assign(Error(`The in-place replacement failed (${error.message}) and restoring the previous files failed (${restore.message}). The app remains stopped. The previous files are retained at ${retained}: once no process holds files in ${app}, copy them back over it and delete files the retained folder does not contain.`), { recoveryUnsafe: true });
    }
    await rm(retained, { recursive: true, force: true }).catch(() => {});
    error.message = `The in-place replacement failed and the previous app files were restored and verified. ${error.message}`;
    throw error;
  }
}
