import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { LaunchMode } from '../process/launcher.js';

/** Use only the caller's PATH: containment needs an absolute app and plain Windows spawning must not search the repository. */
export async function gitExecutable(cwd: string, env: NodeJS.ProcessEnv, _mode: LaunchMode): Promise<string> {
  if (process.platform !== 'win32') return 'git';
  const value = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const extensions = (value('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map(extension => extension.toLowerCase());
  if (extensions.includes('.exe')) for (const entry of (value('PATH') ?? '').split(delimiter)) {
    // Search only configured entries; never add an implicit repository-local executable or shell wrapper.
    if (!entry) continue;
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    const candidate = join(resolve(cwd, directory), 'git.exe');
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, constants.X_OK); return candidate; }
    catch { /* Try the next operator PATH entry. */ }
  }
  throw Error('Native git.exe is unavailable on the configured PATH.');
}
