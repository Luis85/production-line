import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DomainError } from '../../shared/errors.js';

/** Resolve host aliases at the operator-selected boundary, before deriving private storage paths. */
export function canonicalStateDirectory(value: string): string {
  const selected = resolve(value), missing: string[] = [];
  let ancestor = selected;
  for (;;) {
    let info;
    try { info = lstatSync(ancestor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
      continue;
    }
    if (ancestor === selected && (!info.isDirectory() || info.isSymbolicLink()))
      throw new DomainError('conflict', 'Worker state must use an ordinary directory, not a symbolic link.');
    // The native resolver expands Windows 8.3 names consistently with async
    // realpath, which private-storage identity checks use.
    const canonical = realpathSync.native(ancestor);
    if (!statSync(canonical).isDirectory()) throw new DomainError('conflict', 'Worker state must use an ordinary directory.');
    return join(canonical, ...missing);
  }
}
